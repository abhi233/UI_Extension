let recorderState = {
  isRecording: false,
  sessionId: null
};

let isPickerActive = false;
let pickerConfig = null;
let highlightedElement = null;
let pageLoadRecordedSessionId = null;
let pickerNoticeTimeoutId = null;

const HIGHLIGHT_CLASS = "codex-recorder-highlight";
const injectedStyleId = "codex-recorder-style";
const pickerNoticeId = "codex-recorder-notice";

function sendToBackground(type, payload) {
  chrome.runtime.sendMessage({ type, payload }, () => {
    void chrome.runtime.lastError;
  });
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value || "").replace(/["\\]/g, "\\$&");
}

function safeText(value) {
  return (value || "").replace(/\s+/g, " ").trim().slice(0, 200);
}

function escapeForXpath(value) {
  const input = String(value || "");
  if (!input.includes("'")) {
    return `'${input}'`;
  }
  if (!input.includes('"')) {
    return `"${input}"`;
  }
  const parts = input.split("'").map((part) => `'${part}'`);
  return `concat(${parts.join(', "\'", ')})`;
}

function findStableAnchor(element) {
  let current = element?.parentElement;
  while (current) {
    if (current.id || current.getAttribute("data-testid") || current.getAttribute("name")) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function buildCssSegment(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }
  if (element.id) {
    return `#${cssEscape(element.id)}`;
  }

  const tag = element.tagName.toLowerCase();
  const testId = element.getAttribute("data-testid") || element.getAttribute("data-test");
  if (testId) {
    return `${tag}[data-testid="${cssEscape(testId)}"]`;
  }

  const name = element.getAttribute("name");
  if (name) {
    return `${tag}[name="${cssEscape(name)}"]`;
  }

  const siblings = Array.from(element.parentNode?.children || []).filter(
    (node) => node.tagName === element.tagName
  );
  if (siblings.length > 1) {
    const index = siblings.indexOf(element) + 1;
    return `${tag}:nth-of-type(${index})`;
  }
  return tag;
}

function buildRelativeCss(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }
  if (element.id) {
    return `#${cssEscape(element.id)}`;
  }

  const anchor = findStableAnchor(element);
  const pathParts = [];
  let current = element;

  while (current && current.nodeType === Node.ELEMENT_NODE && current !== anchor && pathParts.length < 5) {
    pathParts.unshift(buildCssSegment(current));
    current = current.parentElement;
  }

  if (anchor) {
    const anchorSelector = buildCssSegment(anchor);
    if (!pathParts.length) {
      return anchorSelector;
    }
    return `${anchorSelector} ${pathParts.join(" > ")}`;
  }

  return pathParts.join(" > ");
}

function buildAnchorXpath(anchor) {
  if (!anchor) {
    return "";
  }
  if (anchor.id) {
    return `//*[@id=${escapeForXpath(anchor.id)}]`;
  }
  const testId = anchor.getAttribute("data-testid") || anchor.getAttribute("data-test");
  if (testId) {
    return `//*[@data-testid=${escapeForXpath(testId)}]`;
  }
  const name = anchor.getAttribute("name");
  if (name) {
    return `//${anchor.tagName.toLowerCase()}[@name=${escapeForXpath(name)}]`;
  }
  return `//${anchor.tagName.toLowerCase()}`;
}

function buildXpathStep(element) {
  const tag = element.tagName.toLowerCase();
  const siblings = Array.from(element.parentElement?.children || []).filter(
    (node) => node.tagName === element.tagName
  );
  if (siblings.length <= 1) {
    return tag;
  }
  const index = siblings.indexOf(element) + 1;
  return `${tag}[${index}]`;
}

function buildRelativeXpath(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }
  if (element.id) {
    return `//*[@id=${escapeForXpath(element.id)}]`;
  }

  const testId = element.getAttribute("data-testid") || element.getAttribute("data-test");
  if (testId) {
    return `//*[@data-testid=${escapeForXpath(testId)}]`;
  }

  const name = element.getAttribute("name");
  if (name) {
    return `//${element.tagName.toLowerCase()}[@name=${escapeForXpath(name)}]`;
  }

  const anchor = findStableAnchor(element);
  if (anchor) {
    const anchorPath = buildAnchorXpath(anchor);
    const parts = [];
    let current = element;
    while (current && current !== anchor && parts.length < 6) {
      parts.unshift(buildXpathStep(current));
      current = current.parentElement;
    }
    if (!parts.length) {
      return anchorPath;
    }
    return `${anchorPath}//${parts.join("/")}`;
  }

  return `//${buildXpathStep(element)}`;
}

function getLocatorStability(type, value) {
  if (type === "id" || type === "data-testid") {
    return "strong";
  }
  if (type === "name") {
    return "medium";
  }
  if (!value) {
    return "weak";
  }
  if (value.includes("nth-of-type(") || /\[\d+\]/.test(value)) {
    return "weak";
  }
  return "medium";
}

function pushLocatorCandidate(candidates, type, value) {
  if (!value) {
    return;
  }
  const exists = candidates.some((candidate) => candidate.type === type && candidate.value === value);
  if (exists) {
    return;
  }
  candidates.push({
    type,
    value,
    stability: getLocatorStability(type, value)
  });
}

function buildLocatorMetadata(element) {
  const candidates = [];
  const id = element.id || "";
  const testId = element.getAttribute("data-testid") || element.getAttribute("data-test") || "";
  const name = element.getAttribute("name") || "";
  const selector = buildRelativeCss(element);
  const xpath = buildRelativeXpath(element);

  pushLocatorCandidate(candidates, "id", id);
  pushLocatorCandidate(candidates, "data-testid", testId);
  pushLocatorCandidate(candidates, "name", name);
  pushLocatorCandidate(candidates, "css", selector);
  pushLocatorCandidate(candidates, "xpath", xpath);

  return {
    primaryLocator: candidates[0] || null,
    locatorCandidates: candidates
  };
}

function readElementValue(element) {
  if (!element) {
    return "";
  }
  const tag = element.tagName.toLowerCase();
  if (tag === "input") {
    const inputType = (element.getAttribute("type") || "text").toLowerCase();
    if (inputType === "password") {
      return "__masked__";
    }
    if (inputType === "checkbox" || inputType === "radio") {
      return String(Boolean(element.checked));
    }
    return String(element.value ?? "");
  }
  if (tag === "textarea" || tag === "select") {
    return String(element.value ?? "");
  }
  return safeText(element.textContent);
}

function buildTarget(element) {
  if (!element) {
    return null;
  }
  const locatorMetadata = buildLocatorMetadata(element);
  return {
    tagName: element.tagName.toLowerCase(),
    id: element.id || "",
    dataTestId: element.getAttribute("data-testid") || element.getAttribute("data-test") || "",
    name: element.getAttribute("name") || "",
    selector: buildRelativeCss(element),
    xpath: buildRelativeXpath(element),
    primaryLocator: locatorMetadata.primaryLocator,
    locatorCandidates: locatorMetadata.locatorCandidates,
    text: safeText(element.innerText || element.textContent || "")
  };
}

function recordEvent(type, action, element, details) {
  if (!recorderState.isRecording) {
    return;
  }
  sendToBackground("LOG_EVENT", {
    type,
    action,
    url: window.location.href,
    title: document.title,
    target: buildTarget(element),
    details: details || {}
  });
}

function isVisible(element) {
  if (!element) {
    return false;
  }
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function handleClick(event) {
  if (isPickerActive) {
    return;
  }
  const element = event.target;
  const anchor = element?.closest?.("a[href]");
  recordEvent("click", "click", element, {
    button: event.button,
    text: safeText(element?.innerText || element?.textContent || ""),
    linkTarget: anchor?.href || ""
  });
}

function handleChange(event) {
  if (isPickerActive) {
    return;
  }
  const element = event.target;
  if (!element || !["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) {
    return;
  }
  recordEvent("change", element.tagName === "SELECT" ? "select" : "type", element, {
    value: readElementValue(element),
    inputType: (element.getAttribute("type") || "").toLowerCase()
  });
}

function handleSubmit(event) {
  if (isPickerActive) {
    return;
  }
  recordEvent("submit", "submit", event.target, {});
}

function ensurePickerStyles() {
  if (document.getElementById(injectedStyleId)) {
    return;
  }
  const style = document.createElement("style");
  style.id = injectedStyleId;
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      outline: 2px solid #ff7a00 !important;
      outline-offset: 2px !important;
      cursor: crosshair !important;
    }

    #${pickerNoticeId} {
      position: fixed;
      top: 16px;
      right: 16px;
      z-index: 2147483647;
      max-width: 320px;
      padding: 10px 12px;
      border-radius: 8px;
      background: rgba(17, 24, 39, 0.94);
      color: #ffffff;
      font: 12px/1.4 "Segoe UI", Tahoma, sans-serif;
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.25);
      opacity: 0;
      transform: translateY(-6px);
      transition: opacity 120ms ease, transform 120ms ease;
      pointer-events: none;
    }

    #${pickerNoticeId}.visible {
      opacity: 1;
      transform: translateY(0);
    }
  `;
  document.documentElement.appendChild(style);
}

function removeHighlight() {
  if (highlightedElement) {
    highlightedElement.classList.remove(HIGHLIGHT_CLASS);
    highlightedElement = null;
  }
}

function highlight(element) {
  if (highlightedElement === element) {
    return;
  }
  removeHighlight();
  highlightedElement = element;
  highlightedElement.classList.add(HIGHLIGHT_CLASS);
}

function showPickerNotice(message) {
  ensurePickerStyles();
  let notice = document.getElementById(pickerNoticeId);
  if (!notice) {
    notice = document.createElement("div");
    notice.id = pickerNoticeId;
    document.documentElement.appendChild(notice);
  }
  notice.textContent = message;
  notice.classList.add("visible");
  window.clearTimeout(pickerNoticeTimeoutId);
  pickerNoticeTimeoutId = window.setTimeout(() => {
    notice.classList.remove("visible");
  }, 2200);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function parseCsvList(value) {
  if (!value) {
    return [];
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getTableRows(table) {
  const bodyRows = table ? Array.from(table.querySelectorAll("tbody tr")) : [];
  if (bodyRows.length) {
    return bodyRows;
  }
  return table ? Array.from(table.querySelectorAll("tr")) : [];
}

function buildSingleValidation(config, element) {
  const assertionType = config?.validationType || "visible";
  const attributeName = config?.attributeName || "";
  let expectedValue = (config?.expectedValue || "").trim();
  let actualValue = "";

  if (assertionType === "text") {
    actualValue = safeText(element.innerText || element.textContent || "");
    if (!expectedValue) {
      expectedValue = actualValue;
    }
  } else if (assertionType === "value") {
    actualValue = readElementValue(element);
    if (!expectedValue) {
      expectedValue = actualValue;
    }
  } else if (assertionType === "attribute") {
    actualValue = element.getAttribute(attributeName) || "";
    if (!expectedValue) {
      expectedValue = actualValue;
    }
  } else {
    actualValue = String(isVisible(element));
    if (!expectedValue) {
      expectedValue = "true";
    }
  }

  return {
    validation: {
      mode: "single",
      command: config?.command || "add validation",
      assertionType,
      attributeName,
      expectedValue,
      actualValue
    },
    targetElement: element
  };
}

function buildTableBulkValidation(config, element) {
  const table = element?.closest?.("table") || (element?.tagName === "TABLE" ? element : null);
  const targetElement = table || element;

  const rowStrategy = config?.tableRowStrategy || "all_rows";
  const rowStart = parsePositiveInt(config?.rowStart, 1);
  const rowEndRaw = parsePositiveInt(config?.rowEnd, rowStart);
  const rowEnd = rowEndRaw < rowStart ? rowStart : rowEndRaw;
  const columns = parseCsvList(config?.tableColumns);
  const keyColumn = (config?.tableKeyColumn || "").trim();

  const tableScope = {
    rowStrategy
  };
  if (rowStrategy === "row_range") {
    tableScope.rowStart = rowStart;
    tableScope.rowEnd = rowEnd;
  }
  if (columns.length) {
    tableScope.columns = columns;
  }
  if (keyColumn) {
    tableScope.keyColumn = keyColumn;
  }

  const rowCount = table ? getTableRows(table).length : 0;

  return {
    validation: {
      mode: "table_bulk",
      command: config?.command || "add validation",
      tableScope,
      tableFound: Boolean(table),
      rowCountPreview: rowCount
    },
    targetElement
  };
}

function buildValidation(config, element) {
  const mode = config?.validationMode || "single";
  if (mode === "table_bulk") {
    return buildTableBulkValidation(config, element);
  }
  return buildSingleValidation(config, element);
}

function stopPicker() {
  isPickerActive = false;
  pickerConfig = null;
  document.body.style.cursor = "";
  document.removeEventListener("mousemove", onPickerMove, true);
  document.removeEventListener("click", onPickerClick, true);
  document.removeEventListener("keydown", onPickerKeydown, true);
  removeHighlight();
}

function onPickerMove(event) {
  const target = event.target;
  if (!target || target === document.documentElement || target === document.body) {
    return;
  }
  highlight(target);
}

function onPickerClick(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const selectedElement = event.target;
  const { validation, targetElement } = buildValidation(pickerConfig, selectedElement);
  if (validation.mode === "table_bulk" && !validation.tableFound) {
    showPickerNotice("Select a table or any cell inside a table.");
    return;
  }
  sendToBackground("LOG_EVENT", {
    type: "validation",
    action: "validate",
    command: validation.command,
    url: window.location.href,
    title: document.title,
    target: buildTarget(targetElement),
    details: { validation }
  });
  stopPicker();
}

function onPickerKeydown(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    stopPicker();
  }
}

function startPicker(config) {
  if (isPickerActive) {
    return;
  }
  ensurePickerStyles();
  isPickerActive = true;
  pickerConfig = config || {};
  document.body.style.cursor = "crosshair";
  document.addEventListener("mousemove", onPickerMove, true);
  document.addEventListener("click", onPickerClick, true);
  document.addEventListener("keydown", onPickerKeydown, true);
}

function recordPageLoad() {
  if (!recorderState.isRecording || !recorderState.sessionId) {
    return;
  }
  if (pageLoadRecordedSessionId === recorderState.sessionId) {
    return;
  }
  pageLoadRecordedSessionId = recorderState.sessionId;
  recordEvent("page_loaded", "load", document.documentElement, {
    referrer: document.referrer
  });
}

function init() {
  document.addEventListener("click", handleClick, true);
  document.addEventListener("change", handleChange, true);
  document.addEventListener("submit", handleSubmit, true);
  window.addEventListener("pageshow", recordPageLoad);

  chrome.runtime.sendMessage({ type: "GET_STATE" }, (response) => {
    if (response?.ok) {
      recorderState = {
        isRecording: Boolean(response.state.isRecording),
        sessionId: response.state.sessionId || null
      };
      recordPageLoad();
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SYNC_RECORDING_STATE") {
    recorderState = {
      isRecording: Boolean(message.payload?.isRecording),
      sessionId: message.payload?.sessionId || null
    };
    recordPageLoad();
    sendResponse({ ok: true });
    return;
  }

  if (message?.type === "PICK_VALIDATION_TARGET") {
    if (!recorderState.isRecording) {
      sendResponse({ ok: false, error: "Start recording first." });
      return;
    }
    startPicker(message.payload || {});
    sendResponse({ ok: true });
  }
});

init();
