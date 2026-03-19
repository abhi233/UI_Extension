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

const { parseNaturalLanguageCommand, buildNaturalLanguageEvent } = window.UIRecorderCommandUtils;

let currentValidationMode = "single";

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

function updateNaturalLanguageSummary() {
  const parsed = parseNaturalLanguageCommand(nlCommandInput.value);
  if (!parsed) {
    setCommandHint("Supported now: validate title, validate title contains X, validate current url, validate current url contains X. Voice opens in a dedicated window.");
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
  listenBtn.disabled = !isRecording;
  exportBtn.disabled = events === 0;
  clearBtn.disabled = events === 0;
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
      buildNaturalLanguageEvent(commandShape, activeTab, commandInput.value.trim(), "text")
    );

    if (!response?.ok) {
      setMessage(response?.error || "Unable to add command event.", "error");
      return;
    }

    nlCommandInput.value = "";
    updateNaturalLanguageSummary();
    setMessage("Command event added to the session.", "success");
    await refreshState();
  } catch (error) {
    setMessage(String(error.message || error), "error");
  }
}

async function openVoiceCapture() {
  const response = await sendMessage("GET_STATE");
  if (!response?.ok || !response.state?.isRecording) {
    setMessage("Start recording before opening voice capture.", "error");
    return;
  }

  let activeTab;
  try {
    activeTab = await getActiveTab();
  } catch (error) {
    setMessage(String(error.message || error), "error");
    return;
  }

  const commandLabel = encodeURIComponent(commandInput.value.trim() || "add validation");
  const url = chrome.runtime.getURL(
    `voice.html?commandLabel=${commandLabel}&tabId=${encodeURIComponent(String(activeTab.id))}`
  );
  chrome.windows.create(
    {
      url,
      type: "popup",
      width: 460,
      height: 640
    },
    () => {
      if (chrome.runtime.lastError) {
        setMessage(chrome.runtime.lastError.message, "error");
        return;
      }
      setMessage("Voice capture opened in a dedicated window.", "success");
    }
  );
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
listenBtn.addEventListener("click", openVoiceCapture);
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

nlCommandInput.addEventListener("input", updateNaturalLanguageSummary);

setValidationMode("single");
updateNaturalLanguageSummary();
setMessage("Start recording, capture actions, add validations, then export the session.", "");
refreshState();
