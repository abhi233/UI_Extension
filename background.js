const STORAGE_KEY = "codexRecorderState";
const SCHEMA_VERSION = "1.0.0";

const INITIAL_STATE = {
  isRecording: false,
  sessionId: null,
  startedAt: null,
  endedAt: null,
  events: [],
  lastUpdatedAt: null
};

let stateCache = null;
let lastKnownTabUrls = {};

function nowIso() {
  return new Date().toISOString();
}

function generateSessionId() {
  return `session-${Date.now()}`;
}

function generateEventId() {
  return `event-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

async function loadState() {
  if (stateCache) {
    return stateCache;
  }
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  stateCache = { ...INITIAL_STATE, ...(stored[STORAGE_KEY] || {}) };
  return stateCache;
}

async function saveState() {
  stateCache.lastUpdatedAt = nowIso();
  await chrome.storage.local.set({ [STORAGE_KEY]: stateCache });
}

async function broadcastRecordingState() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id) {
      continue;
    }
    chrome.tabs.sendMessage(
      tab.id,
      {
        type: "SYNC_RECORDING_STATE",
        payload: {
          isRecording: stateCache.isRecording,
          sessionId: stateCache.sessionId
        }
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  }
}

function normalizeEvent(rawEvent) {
  return {
    id: generateEventId(),
    recordedAt: nowIso(),
    sessionId: stateCache.sessionId,
    url: rawEvent.url || "",
    title: rawEvent.title || "",
    type: rawEvent.type || "unknown",
    action: rawEvent.action || rawEvent.type || "unknown",
    command: rawEvent.command || null,
    target: rawEvent.target || null,
    details: rawEvent.details || {}
  };
}

async function startRecording(sendResponse) {
  await loadState();
  stateCache.isRecording = true;
  stateCache.sessionId = generateSessionId();
  stateCache.startedAt = nowIso();
  stateCache.endedAt = null;
  stateCache.events = [];
  const tabs = await chrome.tabs.query({});
  lastKnownTabUrls = {};
  for (const tab of tabs) {
    if (tab.id && tab.url) {
      lastKnownTabUrls[tab.id] = tab.url;
    }
  }
  await saveState();
  await broadcastRecordingState();
  sendResponse({ ok: true, state: stateCache });
}

async function stopRecording(sendResponse) {
  await loadState();
  stateCache.isRecording = false;
  stateCache.endedAt = nowIso();
  await saveState();
  await broadcastRecordingState();
  sendResponse({ ok: true, state: stateCache });
}

async function getState(sendResponse) {
  await loadState();
  sendResponse({ ok: true, state: stateCache });
}

async function clearEvents(sendResponse) {
  await loadState();
  stateCache.events = [];
  await saveState();
  sendResponse({ ok: true, state: stateCache });
}

async function logEvent(payload, sendResponse) {
  await loadState();
  if (!stateCache.isRecording) {
    sendResponse({ ok: false, error: "Recording is not active." });
    return;
  }
  stateCache.events.push(normalizeEvent(payload || {}));
  await saveState();
  sendResponse({ ok: true, count: stateCache.events.length });
}

async function getExportData(sendResponse) {
  await loadState();
  sendResponse({
    ok: true,
    data: {
      schemaVersion: SCHEMA_VERSION,
      sessionId: stateCache.sessionId,
      startedAt: stateCache.startedAt,
      endedAt: stateCache.endedAt,
      exportedAt: nowIso(),
      eventCount: stateCache.events.length,
      events: stateCache.events
    }
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await loadState();
  await saveState();
});

async function recordNavigationEvent(tabId, tab) {
  await loadState();
  if (!stateCache.isRecording) {
    return;
  }

  const toUrl = tab?.url || "";
  if (!toUrl || (!toUrl.startsWith("http://") && !toUrl.startsWith("https://"))) {
    return;
  }

  const fromUrl = lastKnownTabUrls[tabId] || null;
  if (fromUrl === toUrl) {
    return;
  }

  stateCache.events.push(
    normalizeEvent({
      type: "navigation",
      action: "navigate",
      url: toUrl,
      title: tab?.title || "",
      details: {
        tabId,
        fromUrl,
        toUrl
      }
    })
  );
  lastKnownTabUrls[tabId] = toUrl;
  await saveState();
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    void recordNavigationEvent(tabId, {
      ...tab,
      url: changeInfo.url
    });
    return;
  }
  if (changeInfo.status === "complete") {
    void recordNavigationEvent(tabId, tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete lastKnownTabUrls[tabId];
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const requestType = message?.type;

  (async () => {
    switch (requestType) {
      case "START_RECORDING":
        await startRecording(sendResponse);
        break;
      case "STOP_RECORDING":
        await stopRecording(sendResponse);
        break;
      case "GET_STATE":
        await getState(sendResponse);
        break;
      case "CLEAR_EVENTS":
        await clearEvents(sendResponse);
        break;
      case "LOG_EVENT":
        await logEvent(message.payload, sendResponse);
        break;
      case "GET_EXPORT_DATA":
        await getExportData(sendResponse);
        break;
      default:
        sendResponse({ ok: false, error: "Unknown message type." });
        break;
    }
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error) });
  });

  return true;
});
