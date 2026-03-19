const statusText = document.getElementById("statusText");
const eventCountValue = document.getElementById("eventCountValue");
const selectedTargetLabel = document.getElementById("selectedTargetLabel");
const statusPill = document.getElementById("statusPill");
const modeHint = document.getElementById("modeHint");
const validationSummary = document.getElementById("validationSummary");
const message = document.getElementById("message");
const commandHint = document.getElementById("commandHint");

const startUrlInput = document.getElementById("startUrlInput");
const targetSelect = document.getElementById("targetSelect");

const launchChromeBtn = document.getElementById("launchChromeBtn");
const connectChromeBtn = document.getElementById("connectChromeBtn");
const startSessionBtn = document.getElementById("startSessionBtn");
const stopSessionBtn = document.getElementById("stopSessionBtn");
const clearSessionBtn = document.getElementById("clearSessionBtn");
const pickValidationBtn = document.getElementById("pickValidationBtn");
const addCommandBtn = document.getElementById("addCommandBtn");
const listenBtn = document.getElementById("listenBtn");
const exportBtn = document.getElementById("exportBtn");

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
const { parseNaturalLanguageCommand, buildNaturalLanguageEvent } = window.UIRecorderCommandUtils;

let currentValidationMode = "single";
let currentState = null;
let speechRecognition = null;
let isListening = false;
let refreshTimer = null;
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

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({ error: "Request failed." }));
    throw new Error(errorPayload.error || "Request failed.");
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
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
  rowRangeFields.classList.toggle("hidden", tableRowStrategy.value !== "row_range");
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
  modeHint.textContent =
    mode === "table_bulk"
      ? "Pick one table locator plus row and column scope for bulk validation generation."
      : "Pick one element and record a single assertion like visible, text, value, or attribute.";
  syncSingleValidationUI();
  syncTableRowStrategyUI();
  updateValidationSummary();
}

function populateTargetSelect(targets, selectedTargetId) {
  const previousValue = targetSelect.value;
  targetSelect.innerHTML = "";

  if (!targets.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No browser pages connected";
    targetSelect.appendChild(option);
    targetSelect.disabled = true;
    return;
  }

  targetSelect.disabled = false;
  for (const target of targets) {
    const option = document.createElement("option");
    option.value = target.id;
    option.textContent = `${target.title} | ${target.url}`;
    targetSelect.appendChild(option);
  }

  const nextValue = selectedTargetId || previousValue || targets[0].id;
  targetSelect.value = nextValue;
}

function getSelectedTarget(state) {
  return state?.targets?.find((target) => target.id === state.selectedTargetId) || null;
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

function updateListeningUi() {
  listenBtn.textContent = isListening ? "Stop Listening" : "Start Listening";
  listenBtn.disabled = !currentState?.session?.isRecording || !speechRecognition;
}

function applyState(state) {
  currentState = state;
  const isRecording = Boolean(state?.session?.isRecording);
  const browserConnected = Boolean(state?.browser?.connected);
  const events = state?.session?.events?.length || 0;
  const selectedTarget = getSelectedTarget(state);

  statusText.textContent = isRecording ? "Recording" : browserConnected ? "Ready" : "Disconnected";
  eventCountValue.textContent = String(events);
  selectedTargetLabel.textContent = selectedTarget ? selectedTarget.title : "None";
  updateStatusPill(browserConnected ? (isRecording ? "recording" : "idle") : "error");

  populateTargetSelect(state.targets || [], state.selectedTargetId);

  startSessionBtn.disabled = !browserConnected || isRecording || !(state.targets || []).length;
  stopSessionBtn.disabled = !isRecording;
  clearSessionBtn.disabled = events === 0;
  pickValidationBtn.disabled = !isRecording || !selectedTarget;
  addCommandBtn.disabled = !isRecording || !selectedTarget;
  exportBtn.disabled = events === 0;
  launchChromeBtn.disabled = false;
  connectChromeBtn.disabled = false;

  updateListeningUi();
}

async function refreshState() {
  try {
    const state = await apiRequest("/api/state");
    applyState(state);
  } catch (error) {
    updateStatusPill("error");
    setMessage(String(error.message || error), "error");
  }
}

function startRefreshLoop() {
  if (refreshTimer) {
    return;
  }
  refreshTimer = window.setInterval(() => {
    void refreshState();
  }, 2000);
}

async function launchChrome() {
  try {
    await apiRequest("/api/browser/launch", {
      method: "POST",
      body: { startUrl: startUrlInput.value.trim() || "about:blank" }
    });
    setMessage("Chrome launched. Wait a moment for pages to appear in the target list.", "success");
    await refreshState();
  } catch (error) {
    setMessage(String(error.message || error), "error");
  }
}

async function connectChrome() {
  try {
    await apiRequest("/api/browser/connect", { method: "POST" });
    setMessage("Connected to Chrome on port 9222.", "success");
    await refreshState();
  } catch (error) {
    setMessage(String(error.message || error), "error");
  }
}

async function selectTarget() {
  if (!targetSelect.value) {
    return;
  }

  try {
    await apiRequest("/api/target/select", {
      method: "POST",
      body: { targetId: targetSelect.value }
    });
    await refreshState();
  } catch (error) {
    setMessage(String(error.message || error), "error");
  }
}

async function startSession() {
  try {
    await apiRequest("/api/session/start", { method: "POST" });
    setMessage("Recording started for the selected Chrome page set.", "success");
    await refreshState();
  } catch (error) {
    setMessage(String(error.message || error), "error");
  }
}

async function stopSession() {
  try {
    await apiRequest("/api/session/stop", { method: "POST" });
    setMessage("Recording stopped. Export or clear the captured session.", "success");
    await refreshState();
  } catch (error) {
    setMessage(String(error.message || error), "error");
  }
}

async function clearSession() {
  try {
    await apiRequest("/api/session/clear", { method: "POST" });
    setMessage("Session events cleared.", "success");
    await refreshState();
  } catch (error) {
    setMessage(String(error.message || error), "error");
  }
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
    await apiRequest("/api/validation/pick", {
      method: "POST",
      body: { config: buildValidationPayload() }
    });
    setMessage("Picker is active in the selected browser page. Click the target element or press Esc to cancel.", "success");
  } catch (error) {
    setMessage(String(error.message || error), "error");
  }
}

async function addCommandEvent() {
  const parsed = parseNaturalLanguageCommand(nlCommandInput.value);
  if (!parsed) {
    setMessage("Unsupported command. Use title or URL validations for now.", "error");
    return;
  }

  const selectedTarget = getSelectedTarget(currentState);
  if (!selectedTarget) {
    setMessage("Select a browser page first.", "error");
    return;
  }

  try {
    const event = buildNaturalLanguageEvent(
      parsed,
      {
        title: selectedTarget.title,
        url: selectedTarget.url
      },
      commandInput.value.trim() || "add validation",
      lastCommandSource
    );

    await apiRequest("/api/log-event", {
      method: "POST",
      body: { event }
    });

    nlCommandInput.value = "";
    lastCommandSource = "text";
    updateNaturalLanguageSummary();
    setMessage("Command event added to the session.", "success");
    await refreshState();
  } catch (error) {
    setMessage(String(error.message || error), "error");
  }
}

function initializeSpeechRecognition() {
  if (!SpeechRecognitionCtor) {
    listenBtn.disabled = true;
    listenBtn.textContent = "Voice Unsupported";
    setCommandHint("Voice input is not available in this browser. Text commands still work.");
    return;
  }

  speechRecognition = new SpeechRecognitionCtor();
  speechRecognition.lang = "en-US";
  speechRecognition.continuous = false;
  speechRecognition.interimResults = false;
  speechRecognition.maxAlternatives = 1;

  speechRecognition.onstart = () => {
    isListening = true;
    updateListeningUi();
    setMessage("Listening for a command.", "success");
  };

  speechRecognition.onend = () => {
    isListening = false;
    updateListeningUi();
  };

  speechRecognition.onerror = (event) => {
    isListening = false;
    updateListeningUi();
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
    setMessage("Voice recognition is not available in this browser.", "error");
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
  try {
    const response = await fetch("/api/export");
    if (!response.ok) {
      throw new Error("Unable to export JSON.");
    }
    const payload = await response.text();
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const filename = `ui-recorder-${currentState?.session?.sessionId || Date.now()}.json`;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage("JSON export started.", "success");
  } catch (error) {
    setMessage(String(error.message || error), "error");
  }
}

launchChromeBtn.addEventListener("click", launchChrome);
connectChromeBtn.addEventListener("click", connectChrome);
targetSelect.addEventListener("change", selectTarget);
startSessionBtn.addEventListener("click", startSession);
stopSessionBtn.addEventListener("click", stopSession);
clearSessionBtn.addEventListener("click", clearSession);
pickValidationBtn.addEventListener("click", pickValidationTarget);
addCommandBtn.addEventListener("click", addCommandEvent);
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
updateNaturalLanguageSummary();
setMessage("Launch or connect to Chrome, start recording, then capture actions and validations.", "");
startRefreshLoop();
void refreshState();
