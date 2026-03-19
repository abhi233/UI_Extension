const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const HOST = "127.0.0.1";
const APP_PORT = 4791;
const CHROME_DEBUG_PORT = 9222;
const BINDING_NAME = "uiRecorderEmit";
const SCHEMA_VERSION = "1.0.0";

const ROOT_DIR = path.resolve(__dirname, "..");
const STANDALONE_DIR = __dirname;
const PROFILE_ROOT_DIR = path.join(STANDALONE_DIR, ".chrome-profile");
const injectedSource = fs.readFileSync(path.join(STANDALONE_DIR, "injected-recorder.js"), "utf8");

const recorderState = {
  isRecording: false,
  sessionId: null,
  recordingName: "",
  recordingTargetId: null,
  startedAt: null,
  endedAt: null,
  events: [],
  lastUpdatedAt: null
};

const browserState = {
  connected: false,
  debugPort: CHROME_DEBUG_PORT,
  chromePath: null,
  launchError: null,
  process: null,
  profileDir: null
};

const trackedTargets = new Map();
let selectedTargetId = null;
let discoverTimer = null;

function nowIso() {
  return new Date().toISOString();
}

function generateSessionId() {
  return `session-${Date.now()}`;
}

function generateEventId() {
  return `event-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function buildNavigationWaitHints(nextUrl) {
  return {
    before: [],
    after: [
      {
        type: "url_matches",
        match: "equals",
        value: nextUrl,
        timeoutMs: 15000
      },
      {
        type: "document_ready_state",
        value: "complete",
        timeoutMs: 15000
      }
    ]
  };
}

function touchState() {
  recorderState.lastUpdatedAt = nowIso();
}

function normalizeEvent(rawEvent) {
  return {
    id: generateEventId(),
    recordedAt: nowIso(),
    sessionId: recorderState.sessionId,
    pageTargetId: rawEvent.pageTargetId || null,
    url: rawEvent.url || "",
    title: rawEvent.title || "",
    type: rawEvent.type || "unknown",
    action: rawEvent.action || rawEvent.type || "unknown",
    command: rawEvent.command || null,
    target: rawEvent.target || null,
    details: rawEvent.details || {}
  };
}

function logEvent(rawEvent) {
  if (!recorderState.isRecording) {
    return { ok: false, error: "Recording is not active." };
  }
  if (recorderState.recordingTargetId && rawEvent?.pageTargetId && rawEvent.pageTargetId !== recorderState.recordingTargetId) {
    return { ok: false, ignored: true };
  }
  recorderState.events.push(normalizeEvent(rawEvent || {}));
  touchState();
  return { ok: true, count: recorderState.events.length };
}

function getEventsForSelectedTarget(targetId) {
  const effectiveTargetId = targetId || recorderState.recordingTargetId || null;
  if (!effectiveTargetId) {
    return recorderState.events;
  }
  return recorderState.events.filter((event) => !event.pageTargetId || event.pageTargetId === effectiveTargetId);
}

function buildExportData(targetId) {
  const events = getEventsForSelectedTarget(targetId);
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: recorderState.sessionId,
    recordingName: recorderState.recordingName,
    recordingTargetId: recorderState.recordingTargetId,
    startedAt: recorderState.startedAt,
    endedAt: recorderState.endedAt,
    exportedAt: nowIso(),
    eventCount: events.length,
    events
  };
}

function isUiRecorderUrl(url) {
  return typeof url === "string" && url.startsWith(`http://${HOST}:${APP_PORT}`);
}

function isTrackableTarget(target) {
  return (
    target &&
    target.type === "page" &&
    target.webSocketDebuggerUrl &&
    !isUiRecorderUrl(target.url || "") &&
    !(target.url || "").startsWith("devtools://")
  );
}

function getChromeCandidates() {
  return [
    process.env.UI_RECORDER_CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env.PROGRAMFILES || "", "Google\\Chrome\\Application\\chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Google\\Chrome\\Application\\chrome.exe")
  ].filter(Boolean);
}

function findChromeExecutable() {
  for (const candidate of getChromeCandidates()) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response.json();
}

class CDPTargetSession {
  constructor(targetInfo) {
    this.id = targetInfo.id;
    this.type = targetInfo.type || "page";
    this.title = targetInfo.title || "";
    this.url = targetInfo.url || "";
    this.webSocketDebuggerUrl = targetInfo.webSocketDebuggerUrl;
    this.attachedAt = Date.now();
    this.lastNavigationUrl = this.url || "";
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.connected = false;
    this.childSessions = new Map();
  }

  async connect() {
    if (this.connected) {
      return;
    }

    await new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.webSocketDebuggerUrl);

      this.socket.addEventListener("open", () => {
        this.connected = true;
        resolve();
      });

      this.socket.addEventListener("error", (error) => {
        reject(error);
      });

      this.socket.addEventListener("message", (event) => {
        this.handleMessage(event.data);
      });

      this.socket.addEventListener("close", () => {
        this.connected = false;
        for (const pending of this.pending.values()) {
          pending.reject(new Error("CDP socket closed."));
        }
        this.pending.clear();
      });
    });

    await this.initialize();
  }

  async initialize() {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    });
    try {
      await this.send("Runtime.addBinding", { name: BINDING_NAME });
    } catch (error) {
      void error;
    }
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: injectedSource });
    await this.send("Runtime.evaluate", { expression: injectedSource });
    await applyRecorderStateToTarget(this);
  }

  send(method, params = {}, sessionId = null) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Socket is not open for target ${this.id}.`));
    }

    const id = this.nextId++;
    const payload = JSON.stringify({
      id,
      method,
      params,
      ...(sessionId ? { sessionId } : {})
    });

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(payload);
    });
  }

  async evaluateFunction(functionName, args = [], sessionId = null) {
    const expression = `(() => {
      const fn = window[${JSON.stringify(functionName)}];
      if (typeof fn === "function") {
        return fn.apply(window, ${JSON.stringify(args)});
      }
      return null;
    })()`;

    return this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
  }

  async initializeAttachedSession(sessionId) {
    await this.send("Page.enable", {}, sessionId).catch(() => null);
    await this.send("Runtime.enable", {}, sessionId);
    try {
      await this.send("Runtime.addBinding", { name: BINDING_NAME }, sessionId);
    } catch (error) {
      void error;
    }
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: injectedSource }, sessionId).catch(() => null);
    await this.send("Runtime.evaluate", { expression: injectedSource }, sessionId).catch(() => null);
    await applyRecorderStateToTarget(this, sessionId);
  }

  async startPicker(config) {
    await this.evaluateFunction("__uiRecorderStartPicker", [config || {}]);
    await Promise.all(
      Array.from(this.childSessions.keys()).map((sessionId) =>
        this.evaluateFunction("__uiRecorderStartPicker", [config || {}], sessionId).catch(() => null)
      )
    );
  }

  handleMessage(rawMessage) {
    const message = JSON.parse(rawMessage);

    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "Unknown CDP error."));
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (message.method === "Runtime.bindingCalled" && message.params?.name === BINDING_NAME) {
      this.handleBindingEvent(message.params.payload, message.sessionId || null);
      return;
    }

    if (message.method === "Page.frameNavigated") {
      const frame = message.params?.frame;
      if (message.sessionId && frame) {
        const childSession = this.childSessions.get(message.sessionId);
        if (childSession) {
          childSession.url = frame.url || childSession.url;
          childSession.title = frame.name || childSession.title;
        }
      }
      if (frame && !frame.parentId && !message.sessionId) {
        this.handleMainFrameNavigation(frame.url || "");
      }
    }

    if (message.method === "Target.attachedToTarget") {
      this.handleAttachedToTarget(message.params);
      return;
    }

    if (message.method === "Target.detachedFromTarget") {
      this.childSessions.delete(message.params?.sessionId);
    }
  }

  async handleAttachedToTarget(params) {
    const sessionId = params?.sessionId;
    const targetInfo = params?.targetInfo;
    if (!sessionId || !targetInfo || targetInfo.type !== "iframe") {
      return;
    }

    this.childSessions.set(sessionId, {
      sessionId,
      targetId: targetInfo.targetId || null,
      type: targetInfo.type,
      url: targetInfo.url || "",
      title: targetInfo.title || ""
    });

    try {
      await this.initializeAttachedSession(sessionId);
    } catch (error) {
      void error;
    }
  }

  handleBindingEvent(rawPayload, sessionId = null) {
    let bindingMessage;
    try {
      bindingMessage = JSON.parse(rawPayload);
    } catch (error) {
      return;
    }

    if (bindingMessage?.eventType === "recorder-event") {
      const childSession = sessionId ? this.childSessions.get(sessionId) : null;
      if (childSession) {
        childSession.url = bindingMessage.payload?.url || childSession.url;
        childSession.title = bindingMessage.payload?.title || childSession.title;
      } else {
        this.url = bindingMessage.payload?.url || this.url;
        this.title = bindingMessage.payload?.title || this.title;
      }
      logEvent({
        ...bindingMessage.payload,
        pageTargetId: this.id,
        details: {
          ...(bindingMessage.payload?.details || {}),
          ...(childSession
            ? {
                frameContext: {
                  sessionId,
                  targetId: childSession.targetId,
                  type: childSession.type,
                  url: childSession.url || bindingMessage.payload?.url || ""
                }
              }
            : {})
        }
      });
    }
  }

  handleMainFrameNavigation(nextUrl) {
    if (!recorderState.isRecording) {
      this.lastNavigationUrl = nextUrl;
      return;
    }
    if (!nextUrl || nextUrl === this.lastNavigationUrl) {
      return;
    }

    logEvent({
      type: "navigation",
      action: "navigate",
      pageTargetId: this.id,
      url: nextUrl,
      title: this.title || "",
      details: {
        targetId: this.id,
        fromUrl: this.lastNavigationUrl || null,
        toUrl: nextUrl,
        waitHints: buildNavigationWaitHints(nextUrl)
      }
    });
    this.lastNavigationUrl = nextUrl;
    this.url = nextUrl;
  }

  close() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.close();
    }
  }
}

async function applyRecorderStateToTarget(target, sessionId = null) {
  try {
    await target.evaluateFunction("__uiRecorderSetState", [
      {
        isRecording: recorderState.isRecording && (!recorderState.recordingTargetId || recorderState.recordingTargetId === target.id),
        sessionId: recorderState.sessionId
      }
    ], sessionId);
  } catch (error) {
    void error;
  }
}

async function applyRecorderStateToAllTargets() {
  await Promise.all(
    Array.from(trackedTargets.values()).map(async (target) => {
      await applyRecorderStateToTarget(target);
      await Promise.all(
        Array.from(target.childSessions.keys()).map((sessionId) => applyRecorderStateToTarget(target, sessionId))
      );
    })
  );
}

function getTargetSummaries() {
  const sortedTargets = Array.from(trackedTargets.values()).sort((left, right) => right.attachedAt - left.attachedAt);
  const limitedTargets = [];

  if (selectedTargetId) {
    const selectedTarget = trackedTargets.get(selectedTargetId);
    if (selectedTarget) {
      limitedTargets.push(selectedTarget);
    }
  }

  for (const target of sortedTargets) {
    if (limitedTargets.some((candidate) => candidate.id === target.id)) {
      continue;
    }
    limitedTargets.push(target);
    if (limitedTargets.length >= 10) {
      break;
    }
  }

  return limitedTargets.map((target) => ({
      id: target.id,
      title: target.title || "(untitled page)",
      url: target.url || "",
      selected: target.id === selectedTargetId
    }));
}

async function discoverTargets() {
  try {
    const targets = await fetchJson(`http://${HOST}:${browserState.debugPort}/json`);
    browserState.connected = true;
    browserState.launchError = null;

    const seen = new Set();
    const filteredTargets = targets.filter(isTrackableTarget);

    for (const targetInfo of filteredTargets) {
      seen.add(targetInfo.id);
      const existing = trackedTargets.get(targetInfo.id);
      if (existing) {
        existing.title = targetInfo.title || existing.title;
        existing.url = targetInfo.url || existing.url;
        existing.webSocketDebuggerUrl = targetInfo.webSocketDebuggerUrl;
        continue;
      }

      const target = new CDPTargetSession(targetInfo);
      trackedTargets.set(target.id, target);
      if (!selectedTargetId) {
        selectedTargetId = target.id;
      }
      void target.connect().catch(() => {
        trackedTargets.delete(target.id);
      });
    }

    for (const [targetId, target] of trackedTargets.entries()) {
      if (!seen.has(targetId)) {
        target.close();
        trackedTargets.delete(targetId);
        if (selectedTargetId === targetId) {
          selectedTargetId = null;
        }
      }
    }

    if (!selectedTargetId && trackedTargets.size) {
      selectedTargetId = Array.from(trackedTargets.keys())[0];
    }
  } catch (error) {
    browserState.connected = false;
    browserState.launchError = String(error.message || error);
  }
}

function ensureDiscoverLoop() {
  if (discoverTimer) {
    return;
  }
  discoverTimer = setInterval(() => {
    void discoverTargets();
  }, 2000);
}

function resetTrackedTargets() {
  for (const target of trackedTargets.values()) {
    target.close();
  }
  trackedTargets.clear();
  selectedTargetId = null;
}

function cleanupManagedProfiles() {
  try {
    if (!fs.existsSync(PROFILE_ROOT_DIR)) {
      return;
    }

    for (const entry of fs.readdirSync(PROFILE_ROOT_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const entryPath = path.join(PROFILE_ROOT_DIR, entry.name);
      try {
        fs.rmSync(entryPath, { recursive: true, force: true });
      } catch (error) {
        void error;
      }
    }
  } catch (error) {
    void error;
  }
}

async function stopManagedChrome() {
  if (!browserState.process || browserState.process.killed) {
    return;
  }

  browserState.process.kill();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  browserState.process = null;
}

async function launchChrome(startUrl) {
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error("Chrome executable was not found. Set UI_RECORDER_CHROME_PATH or update the common paths.");
  }

  await stopManagedChrome();
  resetTrackedTargets();
  cleanupManagedProfiles();

  const profileDir = path.join(PROFILE_ROOT_DIR, `profile-${Date.now()}`);
  fs.mkdirSync(profileDir, { recursive: true });

  browserState.chromePath = chromePath;
  browserState.profileDir = profileDir;
  browserState.launchError = null;

  const args = [
    `--remote-debugging-port=${browserState.debugPort}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--new-window",
    startUrl || "about:blank"
  ];

  browserState.process = spawn(chromePath, args, {
    stdio: "ignore"
  });

  ensureDiscoverLoop();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await discoverTargets();
      if (browserState.connected) {
        return;
      }
    } catch (error) {
      void error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("Chrome did not open a DevTools endpoint in time.");
}

async function startSession(recordingName) {
  if (!selectedTargetId || !trackedTargets.has(selectedTargetId)) {
    throw new Error("Select a browser page before starting the session.");
  }
  recorderState.isRecording = true;
  recorderState.sessionId = generateSessionId();
  recorderState.recordingName = String(recordingName || "").trim() || "UI Recording";
  recorderState.recordingTargetId = selectedTargetId;
  recorderState.startedAt = nowIso();
  recorderState.endedAt = null;
  recorderState.events = [];
  touchState();
  await applyRecorderStateToAllTargets();
  return recorderState;
}

async function stopSession() {
  recorderState.isRecording = false;
  recorderState.endedAt = nowIso();
  touchState();
  await applyRecorderStateToAllTargets();
  return recorderState;
}

function clearSession() {
  recorderState.events = [];
  recorderState.recordingTargetId = null;
  touchState();
  return recorderState;
}

function deleteEvent(eventId) {
  const previousLength = recorderState.events.length;
  recorderState.events = recorderState.events.filter((event) => event.id !== eventId);
  if (recorderState.events.length === previousLength) {
    return { ok: false, error: "Event was not found." };
  }
  touchState();
  return { ok: true, count: recorderState.events.length };
}

function updateEvent(eventId, nextEvent) {
  const eventIndex = recorderState.events.findIndex((event) => event.id === eventId);
  if (eventIndex < 0) {
    return { ok: false, error: "Event was not found." };
  }

  if (!nextEvent || typeof nextEvent !== "object") {
    return { ok: false, error: "Updated event payload is invalid." };
  }

  const currentEvent = recorderState.events[eventIndex];
  recorderState.events[eventIndex] = {
    ...currentEvent,
    ...nextEvent,
    id: currentEvent.id,
    sessionId: currentEvent.sessionId,
    recordedAt: currentEvent.recordedAt
  };
  touchState();
  return { ok: true, event: recorderState.events[eventIndex] };
}

async function startPicker(config) {
  const target = trackedTargets.get(selectedTargetId);
  if (!target) {
    throw new Error("No page target selected.");
  }
  await target.startPicker(config || {});
}

function getStateResponse() {
  return {
    browser: {
      connected: browserState.connected,
      debugPort: browserState.debugPort,
      chromePath: browserState.chromePath,
      launchError: browserState.launchError,
      profileDir: browserState.profileDir
    },
    session: recorderState,
    targets: getTargetSummaries(),
    selectedTargetId
  };
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    request.on("data", (chunk) => {
      buffer += chunk;
    });
    request.on("end", () => {
      if (!buffer) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(buffer));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, data) {
  const payload = JSON.stringify(data);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store"
  });
  response.end(payload);
}

function sendText(response, statusCode, contentType, text) {
  response.writeHead(statusCode, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Content-Length": Buffer.byteLength(text)
  });
  response.end(text);
}

function resolveStaticPath(requestPath) {
  if (requestPath === "/" || requestPath === "/index.html") {
    return path.join(STANDALONE_DIR, "index.html");
  }
  if (requestPath === "/client.css") {
    return path.join(STANDALONE_DIR, "client.css");
  }
  if (requestPath === "/client.js") {
    return path.join(STANDALONE_DIR, "client.js");
  }
  if (requestPath === "/command-utils.js") {
    return path.join(ROOT_DIR, "command-utils.js");
  }
  return null;
}

function getContentType(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html";
  }
  if (filePath.endsWith(".css")) {
    return "text/css";
  }
  if (filePath.endsWith(".js")) {
    return "application/javascript";
  }
  return "text/plain";
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${HOST}:${APP_PORT}`);

  try {
    if (request.method === "GET" && requestUrl.pathname === "/api/state") {
      sendJson(response, 200, getStateResponse());
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/browser/launch") {
      const body = await readRequestBody(request);
      await launchChrome(body.startUrl);
      sendJson(response, 200, { ok: true, state: getStateResponse() });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/browser/connect") {
      ensureDiscoverLoop();
      await discoverTargets();
      sendJson(response, 200, { ok: true, state: getStateResponse() });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/target/select") {
      const body = await readRequestBody(request);
      if (!trackedTargets.has(body.targetId)) {
        sendJson(response, 404, { ok: false, error: "Target was not found." });
        return;
      }
      selectedTargetId = body.targetId;
      sendJson(response, 200, { ok: true, state: getStateResponse() });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/session/start") {
      const body = await readRequestBody(request);
      await startSession(body.recordingName);
      sendJson(response, 200, { ok: true, state: getStateResponse() });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/session/stop") {
      await stopSession();
      sendJson(response, 200, { ok: true, state: getStateResponse() });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/session/clear") {
      clearSession();
      sendJson(response, 200, { ok: true, state: getStateResponse() });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/validation/pick") {
      const body = await readRequestBody(request);
      await startPicker(body.config || {});
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/log-event") {
      const body = await readRequestBody(request);
      const result = logEvent({
        ...(body.event || {}),
        pageTargetId: body.event?.pageTargetId || selectedTargetId || recorderState.recordingTargetId
      });
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/event/delete") {
      const body = await readRequestBody(request);
      const result = deleteEvent(body.eventId);
      sendJson(response, result.ok ? 200 : 404, result);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/event/update") {
      const body = await readRequestBody(request);
      const result = updateEvent(body.eventId, body.event);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/export") {
      const targetId = requestUrl.searchParams.get("targetId") || selectedTargetId || recorderState.recordingTargetId;
      const payload = JSON.stringify(buildExportData(targetId), null, 2);
      sendText(response, 200, "application/json", payload);
      return;
    }

    if (request.method === "GET") {
      const filePath = resolveStaticPath(requestUrl.pathname);
      if (!filePath || !fs.existsSync(filePath)) {
        sendText(response, 404, "text/plain", "Not found");
        return;
      }
      sendText(response, 200, getContentType(filePath), fs.readFileSync(filePath, "utf8"));
      return;
    }

    sendText(response, 405, "text/plain", "Method not allowed");
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: String(error.message || error)
    });
  }
});

server.listen(APP_PORT, HOST, () => {
  cleanupManagedProfiles();
  ensureDiscoverLoop();
  void discoverTargets();
  console.log(`UI-Recorder standalone server running at http://${HOST}:${APP_PORT}`);
});
