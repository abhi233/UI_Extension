const statusText = document.getElementById("statusText");
const eventCountValue = document.getElementById("eventCountValue");
const modeValue = document.getElementById("modeValue");
const statusPill = document.getElementById("statusPill");
const modeHint = document.getElementById("modeHint");
const validationSummary = document.getElementById("validationSummary");
const message = document.getElementById("message");
const commandHint = document.getElementById("commandHint");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const clearBtn = document.getElementById("clearBtn");
const exportBtn = document.getElementById("exportBtn");
const pickValidationBtn = document.getElementById("pickValidationBtn");
const addCommandBtn = document.getElementById("addCommandBtn");
const listenBtn = document.getElementById("listenBtn");

const commandInput = document.getElementById("commandInput");
const modeSingleBtn = document.getElementById("modeSingleBtn");
const modeTableBtn = document.getElementById("modeTableBtn");
const nlCommandInput = document.getElementById("nlCommandInput");

const singleConfig = document.getElementById("singleConfig");
const validationType = document.getElementById("validationType");
const attributeField = document.getElementById("attributeField");
const attributeName = document.getElementById("attributeName");
const expectedValue = document.getElementById("expectedValue");

const tableBulkConfig = document.getElementById("tableBulkConfig");
const tableRowStrategy = document.getElementById("tableRowStrategy");
const rowRangeFields = document.getElementById("rowRangeFields");
const rowStart = document.getElementById("rowStart");
const rowEnd = document.getElementById("rowEnd");
const tableColumns = document.getElementById("tableColumns");
const tableKeyColumn = document.getElementById("tableKeyColumn");

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;

let currentValidationMode = "single";
let speechRecognition = null;
let isListening = false;
let lastCommandSource = "text";

function titleCase(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function setMessage(text, tone = "") {
  message.textContent = text;
  message.className = "message";
  if (tone) {
    message.classList.add(tone);
  }
}

function setCommandHint(text) {
  commandHint.textContent = text;
}

function sendMessage(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      resolve(response);
    });
  });
}

function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      if (!tab?.id) {
        reject(new Error("No active tab found."));
        return;
      }
      resolve(tab);
    });
  });
}

function sendToActiveTab(type, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id;
      if (!tabId) {
        reject(new Error("No active tab found."));
        return;
      }

      chrome.tabs.sendMessage(tabId, { type, payload }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error("Open or reload the page where you want to record."));
          return;
        }
        resolve(response);
      });
    });
  });
}

function updateStatusPill(status) {
  statusPill.className = "status-pill";
  statusPill.classList.add(status);
  if (status === "recording") {
    statusPill.textContent = "Recording";
    return;
  }
  if (status === "error") {
    statusPill.textContent = "Error";
    return;
  }
  statusPill.textContent = "Idle";
}

function syncTableRowStrategyUI() {
  const isRange = tableRowStrategy.value === "row_range";
  rowRangeFields.classList.toggle("hidden", !isRange);
}

function syncSingleValidationUI() {
  attributeField.classList.toggle("hidden", validationType.value !== "attribute");
}

function updateValidationSummary() {
  if (currentValidationMode === "table_bulk") {
    const rowScope =
      tableRowStrategy.value === "row_range"
        ? `rows ${rowStart.value || "1"} to ${rowEnd.value || rowStart.value || "1"}`
        : "all rows";
    const columns = tableColumns.value.trim() || "all columns";
    validationSummary.textContent = `Table bulk will capture ${rowScope} using ${columns}.`;
    return;
  }

  const assertion = titleCase(validationType.value);
  const expected = expectedValue.value.trim();
  validationSummary.textContent = expected
    ? `${assertion} validation will assert "${expected}".`
    : `${assertion} validation will use the current page value if needed.`;
}

function setValidationMode(mode) {
  currentValidationMode = mode;
  modeSingleBtn.classList.toggle("active", mode === "single");
  modeTableBtn.classList.toggle("active", mode === "table_bulk");
  singleConfig.classList.toggle("hidden", mode !== "single");
  tableBulkConfig.classList.toggle("hidden", mode !== "table_bulk");
  modeValue.textContent = mode === "table_bulk" ? "Table Bulk" : "Single";
  modeHint.textContent =
    mode === "table_bulk"
      ? "Capture one table locator plus row and column scope so your converter can generate bulk validation logic."
      : "Record one element assertion such as text, visible, value, or attribute.";
  syncSingleValidationUI();
  syncTableRowStrategyUI();
  updateValidationSummary();
}

function normalizeCommandText(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.?!]+$/g, "");
}

function stripWrappingQuotes(value) {
  const text = String(value || "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function parseNaturalLanguageCommand(rawCommand) {
  const cleaned = normalizeCommandText(rawCommand);
  if (!cleaned) {
    return null;
  }

  const patterns = [
    {
      regex: /^(?:validate|verify|check) (?:the )?(?:page )?title(?: contains) (.+)$/i,
      assertionType: "document_title",
      comparison: "contains"
    },
    {
      regex: /^(?:validate|verify|check) (?:the )?(?:page )?title(?: is| equals)? (.+)$/i,
      assertionType: "document_title",
      comparison: "equals"
    },
    {
      regex: /^(?:validate|verify|check) (?:the )?(?:page )?title$/i,
      assertionType: "document_title",
      comparison: "equals"
    },
    {
      regex: /^(?:validate|verify|check) (?:the )?(?:current )?url(?: contains) (.+)$/i,
      assertionType: "document_url",
      comparison: "contains"
    },
    {
      regex: /^(?:validate|verify|check) (?:the )?(?:current )?url(?: is| equals)? (.+)$/i,
      assertionType: "document_url",
      comparison: "equals"
    },
    {
      regex: /^(?:validate|verify|check) (?:the )?(?:current )?url$/i,
      assertionType: "document_url",
      comparison: "equals"
    }
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern.regex);
    if (match) {
      return {
        rawCommand: cleaned,
        normalizedCommand: cleaned.toLowerCase(),
        assertionType: pattern.assertionType,
        comparison: pattern.comparison,
        explicitExpectedValue: stripWrappingQuotes(match[1] || "")
      };
    }
  }

  return null;
}

function getDocumentField(assertionType) {
  return assertionType === "document_title" ? "title" : "url";
}

function getDocumentActualValue(tab, assertionType) {
  return assertionType === "document_title" ? String(tab.title || "") : String(tab.url || "");
}

function buildDocumentTarget(tab, assertionType) {
  const documentField = getDocumentField(assertionType);
  const currentValue = getDocumentActualValue(tab, assertionType);

  return {
    targetType: "document",
    documentField,
    tagName: "document",
    id: "",
    dataTestId: "",
    name: "",
    selector: "",
    xpath: "",
    primaryLocator: {
      type: "document",
      value: documentField,
      stability: "strong"
    },
    locatorCandidates: [
      {
        type: "document",
        value: documentField,
        stability: "strong"
      }
    ],
    text: currentValue
  };
}

function buildNaturalLanguageEvent(commandShape, tab, source) {
  const actualValue = getDocumentActualValue(tab, commandShape.assertionType);
  const expectedValue = commandShape.explicitExpectedValue || actualValue;

  return {
    type: "validation",
    action: "validate",
    command: commandInput.value.trim() || "add validation",
    url: tab.url || "",
    title: tab.title || "",
    target: buildDocumentTarget(tab, commandShape.assertionType),
    details: {
      validation: {
        mode: "single",
        assertionType: commandShape.assertionType,
        comparison: commandShape.comparison,
        expectedValue,
        actualValue,
        source
      },
      naturalLanguage: {
        rawCommand: commandShape.rawCommand,
        normalizedCommand: commandShape.normalizedCommand,
        source
      }
    }
  };
}

function updateNaturalLanguageSummary() {
  const parsed = parseNaturalLanguageCommand(nlCommandInput.value);
  if (!parsed) {
    setCommandHint("Supported now: validate title, validate title contains X, validate current url, validate current url contains X.");
    return;
  }

  const subject = parsed.assertionType === "document_title" ? "page title" : "current URL";
  const expectation = parsed.explicitExpectedValue
    ? `"${parsed.explicitExpectedValue}"`
    : "the current page value";
  setCommandHint(`Recognized as ${subject} ${parsed.comparison} ${expectation}.`);
}

function applyRecorderState(state) {
  const isRecording = Boolean(state?.isRecording);
  const events = state?.events?.length || 0;

  statusText.textContent = isRecording ? "Recording" : "Idle";
  eventCountValue.textContent = String(events);
  updateStatusPill(isRecording ? "recording" : "idle");

  startBtn.disabled = isRecording;
  stopBtn.disabled = !isRecording;
  pickValidationBtn.disabled = !isRecording;
  addCommandBtn.disabled = !isRecording;
  exportBtn.disabled = events === 0;
  clearBtn.disabled = events === 0;

  if (!isRecording && isListening && speechRecognition) {
    speechRecognition.stop();
  }

  if (speechRecognition) {
    listenBtn.disabled = !isRecording;
  }
}

async function refreshState() {
  const response = await sendMessage("GET_STATE");
  if (!response?.ok) {
    statusText.textContent = "Error";
    eventCountValue.textContent = "?";
    updateStatusPill("error");
    return;
  }
  applyRecorderState(response.state);
}

async function startRecording() {
  const response = await sendMessage("START_RECORDING");
  if (!response?.ok) {
    setMessage(response?.error || "Unable to start recording.", "error");
    return;
  }
  setMessage("Recording started. The current page is now part of the session.", "success");
  await refreshState();
}

async function stopRecording() {
  const response = await sendMessage("STOP_RECORDING");
  if (!response?.ok) {
    setMessage(response?.error || "Unable to stop recording.", "error");
    return;
  }
  setMessage("Recording stopped. You can export or clear the captured session.", "success");
  await refreshState();
}

async function clearEvents() {
  const response = await sendMessage("CLEAR_EVENTS");
  if (!response?.ok) {
    setMessage(response?.error || "Unable to clear events.", "error");
    return;
  }
  setMessage("Events cleared. Start a new session when ready.", "success");
  await refreshState();
}

function buildValidationPayload() {
  const payload = {
    command: commandInput.value.trim() || "add validation",
    validationMode: currentValidationMode
  };

  if (currentValidationMode === "table_bulk") {
    payload.tableRowStrategy = tableRowStrategy.value;
    payload.rowStart = rowStart.value;
    payload.rowEnd = rowEnd.value;
    payload.tableColumns = tableColumns.value.trim();
    payload.tableKeyColumn = tableKeyColumn.value.trim();
    return payload;
  }

  payload.validationType = validationType.value;
  payload.attributeName = attributeName.value.trim();
  payload.expectedValue = expectedValue.value.trim();
  return payload;
}

async function pickValidationTarget() {
  try {
    const response = await sendToActiveTab("PICK_VALIDATION_TARGET", buildValidationPayload());
    if (!response?.ok) {
      setMessage(response?.error || "Unable to start element picker.", "error");
      return;
    }

    setMessage("Picker is active in the page. Click the target element or press Esc to cancel.", "success");
  } catch (error) {
    setMessage(String(error.message || error), "error");
  }
}

async function addNaturalLanguageCommandEvent() {
  const commandShape = parseNaturalLanguageCommand(nlCommandInput.value);
  if (!commandShape) {
    setMessage("Unsupported command. Use title or URL validations for now.", "error");
    return;
  }

  try {
    const activeTab = await getActiveTab();
    const response = await sendMessage(
      "LOG_EVENT",
      buildNaturalLanguageEvent(commandShape, activeTab, lastCommandSource)
    );

    if (!response?.ok) {
      setMessage(response?.error || "Unable to add command event.", "error");
      return;
    }

    nlCommandInput.value = "";
    lastCommandSource = "text";
    updateNaturalLanguageSummary();
    setMessage("Command event added to the session.", "success");
    await refreshState();
  } catch (error) {
    setMessage(String(error.message || error), "error");
  }
}

function updateListeningUI() {
  listenBtn.textContent = isListening ? "Stop Listening" : "Start Listening";
}

function initializeSpeechRecognition() {
  if (!SpeechRecognitionCtor) {
    listenBtn.disabled = true;
    listenBtn.textContent = "Voice Unsupported";
    setCommandHint("Voice input is not available in this Chrome context. Text commands still work.");
    return;
  }

  speechRecognition = new SpeechRecognitionCtor();
  speechRecognition.lang = "en-US";
  speechRecognition.continuous = false;
  speechRecognition.interimResults = false;
  speechRecognition.maxAlternatives = 1;

  speechRecognition.onstart = () => {
    isListening = true;
    updateListeningUI();
    setMessage("Listening for a command.", "success");
  };

  speechRecognition.onend = () => {
    isListening = false;
    updateListeningUI();
  };

  speechRecognition.onerror = (event) => {
    isListening = false;
    updateListeningUI();
    setMessage(`Voice recognition failed: ${event.error}`, "error");
  };

  speechRecognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0]?.transcript || "")
      .join(" ")
      .trim();

    if (!transcript) {
      return;
    }

    nlCommandInput.value = transcript;
    lastCommandSource = "voice";
    updateNaturalLanguageSummary();
    setMessage("Voice command captured. Review it and add the command event.", "success");
  };
}

function toggleListening() {
  if (!speechRecognition) {
    setMessage("Voice input is not available in this Chrome context.", "error");
    return;
  }

  if (isListening) {
    speechRecognition.stop();
    return;
  }

  try {
    speechRecognition.start();
  } catch (error) {
    setMessage(String(error.message || error), "error");
  }
}

async function exportJson() {
  const response = await sendMessage("GET_EXPORT_DATA");
  if (!response?.ok) {
    setMessage(response?.error || "Unable to export JSON.", "error");
    return;
  }

  const payload = JSON.stringify(response.data, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const filename = `ui-recorder-${response.data.sessionId || Date.now()}.json`;

  chrome.downloads.download({ url, filename, saveAs: true }, (downloadId) => {
    URL.revokeObjectURL(url);
    if (chrome.runtime.lastError) {
      setMessage(chrome.runtime.lastError.message, "error");
      return;
    }
    if (!downloadId) {
      setMessage("Export did not start.", "error");
      return;
    }
    setMessage("JSON export started. Use the file as input for your automation prompt.", "success");
  });
}

startBtn.addEventListener("click", startRecording);
stopBtn.addEventListener("click", stopRecording);
clearBtn.addEventListener("click", clearEvents);
pickValidationBtn.addEventListener("click", pickValidationTarget);
addCommandBtn.addEventListener("click", addNaturalLanguageCommandEvent);
listenBtn.addEventListener("click", toggleListening);
exportBtn.addEventListener("click", exportJson);

modeSingleBtn.addEventListener("click", () => setValidationMode("single"));
modeTableBtn.addEventListener("click", () => setValidationMode("table_bulk"));

tableRowStrategy.addEventListener("change", () => {
  syncTableRowStrategyUI();
  updateValidationSummary();
});

validationType.addEventListener("change", () => {
  syncSingleValidationUI();
  updateValidationSummary();
});

[
  commandInput,
  validationType,
  attributeName,
  expectedValue,
  rowStart,
  rowEnd,
  tableColumns,
  tableKeyColumn
].forEach((element) => {
  element.addEventListener("input", updateValidationSummary);
});

nlCommandInput.addEventListener("input", () => {
  lastCommandSource = "text";
  updateNaturalLanguageSummary();
});

setValidationMode("single");
initializeSpeechRecognition();
updateListeningUI();
updateNaturalLanguageSummary();
setMessage("Start recording, capture actions, add validations, then export the session.", "");
refreshState();
