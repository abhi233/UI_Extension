const voiceStatus = document.getElementById("voiceStatus");
const commandLabelText = document.getElementById("commandLabelText");
const voiceCommandInput = document.getElementById("voiceCommandInput");
const startVoiceBtn = document.getElementById("startVoiceBtn");
const stopVoiceBtn = document.getElementById("stopVoiceBtn");
const addVoiceCommandBtn = document.getElementById("addVoiceCommandBtn");
const voiceHint = document.getElementById("voiceHint");
const voiceMessage = document.getElementById("voiceMessage");

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const { parseNaturalLanguageCommand, buildNaturalLanguageEvent } = window.UIRecorderCommandUtils;

const searchParams = new URLSearchParams(window.location.search);
const commandLabel = searchParams.get("commandLabel") || "add validation";
const targetTabId = Number.parseInt(searchParams.get("tabId") || "", 10);

let speechRecognition = null;
let isListening = false;

function setVoiceMessage(text, tone = "") {
  voiceMessage.textContent = text;
  voiceMessage.className = "message";
  if (tone) {
    voiceMessage.classList.add(tone);
  }
}

function setVoiceStatus(status) {
  voiceStatus.className = "status-badge";
  voiceStatus.classList.add(status);
  if (status === "listening") {
    voiceStatus.textContent = "Listening";
    return;
  }
  if (status === "error") {
    voiceStatus.textContent = "Error";
    return;
  }
  voiceStatus.textContent = "Idle";
}

function sendMessage(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      resolve(response);
    });
  });
}

function getTargetTab() {
  return new Promise((resolve, reject) => {
    if (Number.isNaN(targetTabId)) {
      reject(new Error("Voice window is missing the target tab reference."));
      return;
    }

    chrome.tabs.get(targetTabId, (tab) => {
      if (chrome.runtime.lastError || !tab?.id) {
        reject(new Error("Unable to reach the original browser tab."));
        return;
      }
      resolve(tab);
    });
  });
}

function updateHint() {
  const parsed = parseNaturalLanguageCommand(voiceCommandInput.value);
  if (!parsed) {
    voiceHint.textContent = "Supported now: validate title, validate title contains X, validate current url, validate current url contains X.";
    return;
  }

  const subject = parsed.assertionType === "document_title" ? "page title" : "current URL";
  const expectation = parsed.explicitExpectedValue
    ? `"${parsed.explicitExpectedValue}"`
    : "the current page value";
  voiceHint.textContent = `Recognized as ${subject} ${parsed.comparison} ${expectation}.`;
}

function updateListeningButtons() {
  startVoiceBtn.disabled = isListening || !speechRecognition;
  stopVoiceBtn.disabled = !isListening || !speechRecognition;
}

async function addVoiceCommandEvent() {
  const commandShape = parseNaturalLanguageCommand(voiceCommandInput.value);
  if (!commandShape) {
    setVoiceMessage("Unsupported command. Use title or URL validations for now.", "error");
    return;
  }

  try {
    const response = await sendMessage("GET_STATE");
    if (!response?.ok || !response.state?.isRecording) {
      setVoiceMessage("Start recording in the main popup before adding voice commands.", "error");
      return;
    }

    const activeTab = await getTargetTab();
    const logResponse = await sendMessage(
      "LOG_EVENT",
      buildNaturalLanguageEvent(commandShape, activeTab, commandLabel, "voice")
    );

    if (!logResponse?.ok) {
      setVoiceMessage(logResponse?.error || "Unable to add command event.", "error");
      return;
    }

    setVoiceMessage("Voice command event added to the session.", "success");
    voiceCommandInput.value = "";
    updateHint();
  } catch (error) {
    setVoiceMessage(String(error.message || error), "error");
  }
}

function initializeSpeechRecognition() {
  commandLabelText.textContent = commandLabel;

  if (!SpeechRecognitionCtor) {
    startVoiceBtn.disabled = true;
    stopVoiceBtn.disabled = true;
    addVoiceCommandBtn.disabled = false;
    setVoiceStatus("error");
    setVoiceMessage("Voice recognition is not available in this Chrome context. You can still type the command here.", "error");
    return;
  }

  speechRecognition = new SpeechRecognitionCtor();
  speechRecognition.lang = "en-US";
  speechRecognition.continuous = false;
  speechRecognition.interimResults = false;
  speechRecognition.maxAlternatives = 1;

  speechRecognition.onstart = () => {
    isListening = true;
    setVoiceStatus("listening");
    updateListeningButtons();
    setVoiceMessage("Listening for a command.", "success");
  };

  speechRecognition.onend = () => {
    isListening = false;
    setVoiceStatus("idle");
    updateListeningButtons();
  };

  speechRecognition.onerror = (event) => {
    isListening = false;
    setVoiceStatus("error");
    updateListeningButtons();
    setVoiceMessage(`Voice recognition failed: ${event.error}`, "error");
  };

  speechRecognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0]?.transcript || "")
      .join(" ")
      .trim();

    if (!transcript) {
      return;
    }

    voiceCommandInput.value = transcript;
    updateHint();
    setVoiceMessage("Transcript captured. Review it and add the command event.", "success");
  };

  updateListeningButtons();
}

function startListening() {
  if (!speechRecognition) {
    setVoiceMessage("Voice recognition is not available here. Type the command instead.", "error");
    return;
  }

  try {
    speechRecognition.start();
  } catch (error) {
    setVoiceMessage(String(error.message || error), "error");
  }
}

function stopListening() {
  if (speechRecognition && isListening) {
    speechRecognition.stop();
  }
}

voiceCommandInput.addEventListener("input", updateHint);
startVoiceBtn.addEventListener("click", startListening);
stopVoiceBtn.addEventListener("click", stopListening);
addVoiceCommandBtn.addEventListener("click", addVoiceCommandEvent);

initializeSpeechRecognition();
updateHint();
setVoiceMessage("Speak or type a supported command, then add it to the current recording session.", "");
