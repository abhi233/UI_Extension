(function () {
  if (window.__uiRecorderStandaloneLoaded) {
    return;
  }
  window.__uiRecorderStandaloneLoaded = true;

  const HIGHLIGHT_CLASS = "ui-recorder-highlight";
  const STYLE_ID = "ui-recorder-style";
  const NOTICE_ID = "ui-recorder-notice";

  let state = {
    isRecording: false,
    sessionId: null
  };
  let pageLoadRecordedSessionId = null;
  let isPickerActive = false;
  let pickerConfig = null;
  let highlightedElement = null;
  let noticeTimeoutId = null;
  let elementKeyCounter = 0;

  const dirtyFieldElements = new Map();
  const lastFieldEventByKey = new Map();
  const elementKeys = new WeakMap();

  function emit(payload) {
    if (typeof window.uiRecorderEmit === "function") {
      window.uiRecorderEmit(JSON.stringify(payload));
    }
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
    return `concat(${parts.join(", \"'\", ")})`;
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

  function getElementKey(element) {
    if (!element || typeof element !== "object") {
      return "";
    }
    const existingKey = elementKeys.get(element);
    if (existingKey) {
      return existingKey;
    }
    elementKeyCounter += 1;
    const nextKey = `field-${elementKeyCounter}`;
    elementKeys.set(element, nextKey);
    return nextKey;
  }

  function getEventSourceElement(event) {
    if (event && typeof event.composedPath === "function") {
      const eventPath = event.composedPath();
      for (const pathItem of eventPath) {
        if (pathItem && pathItem.nodeType === Node.ELEMENT_NODE) {
          return pathItem;
        }
      }
    }

    return event?.target && event.target.nodeType === Node.ELEMENT_NODE ? event.target : null;
  }

  function getDeepActiveElement(root) {
    let activeElement = root?.activeElement || null;
    while (activeElement?.shadowRoot?.activeElement) {
      activeElement = activeElement.shadowRoot.activeElement;
    }
    return activeElement;
  }

  function isRecordableFormElement(element) {
    return Boolean(element && ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName));
  }

  function shouldTrackKeyup(event) {
    const ignoredKeys = new Set([
      "Shift",
      "Control",
      "Alt",
      "Meta",
      "CapsLock",
      "Escape",
      "Tab",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "PageUp",
      "PageDown",
      "Home",
      "End",
      "Insert"
    ]);

    return !ignoredKeys.has(String(event?.key || ""));
  }

  function getFieldAction(element) {
    return element?.tagName === "SELECT" ? "select" : "type";
  }

  function buildFieldDetails(element) {
    return {
      value: readElementValue(element),
      inputType: (element?.getAttribute?.("type") || "").toLowerCase()
    };
  }

  function shouldSkipDuplicateFieldEvent(element, action, details) {
    const elementKey = getElementKey(element);
    const previous = lastFieldEventByKey.get(elementKey);
    const signature = JSON.stringify({
      action,
      value: details.value,
      inputType: details.inputType
    });

    if (previous && previous.signature === signature && Date.now() - previous.at < 1200) {
      return true;
    }

    lastFieldEventByKey.set(elementKey, {
      signature,
      at: Date.now()
    });
    return false;
  }

  function commitFieldEvent(element) {
    if (!state.isRecording || !isRecordableFormElement(element)) {
      return;
    }

    const elementKey = getElementKey(element);
    const details = buildFieldDetails(element);
    const action = getFieldAction(element);
    if (shouldSkipDuplicateFieldEvent(element, action, details)) {
      dirtyFieldElements.delete(elementKey);
      return;
    }

    dirtyFieldElements.delete(elementKey);
    recordEvent("change", action, element, details);
  }

  function clearDirtyField(element) {
    const elementKey = getElementKey(element);
    if (!dirtyFieldElements.has(elementKey)) {
      return;
    }
    dirtyFieldElements.delete(elementKey);
  }

  function markFieldDirty(element) {
    if (!state.isRecording || !isRecordableFormElement(element)) {
      return;
    }

    const elementKey = getElementKey(element);
    dirtyFieldElements.set(elementKey, element);
  }

  function flushDirtyFieldEvents() {
    for (const [elementKey, element] of dirtyFieldElements.entries()) {
      dirtyFieldElements.delete(elementKey);
      commitFieldEvent(element);
    }
  }

  function flushActiveFieldEvent() {
    const activeElement = getDeepActiveElement(document);
    if (!isRecordableFormElement(activeElement)) {
      return;
    }
    if (!dirtyFieldElements.has(getElementKey(activeElement))) {
      return;
    }
    commitFieldEvent(activeElement);
  }

  function recordEvent(type, action, element, details) {
    if (!state.isRecording) {
      return;
    }
    emit({
      eventType: "recorder-event",
      payload: {
        type,
        action,
        url: window.location.href,
        title: document.title,
        target: buildTarget(element),
        details: details || {}
      }
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

  function getTableRows(table) {
    const bodyRows = table ? Array.from(table.querySelectorAll("tbody tr")) : [];
    if (bodyRows.length) {
      return bodyRows;
    }
    return table ? Array.from(table.querySelectorAll("tr")) : [];
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

    const tableScope = { rowStrategy };
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
    if ((config?.validationMode || "single") === "table_bulk") {
      return buildTableBulkValidation(config, element);
    }
    return buildSingleValidation(config, element);
  }

  function buildClickWaitHints(linkTarget) {
    const after = [
      {
        type: "dom_settled",
        timeoutMs: 1000
      }
    ];

    if (linkTarget) {
      after.push({
        type: "optional_navigation",
        timeoutMs: 10000,
        expectedUrl: linkTarget
      });
    }

    return {
      before: [],
      after
    };
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .${HIGHLIGHT_CLASS} {
        outline: 2px solid #ff7a00 !important;
        outline-offset: 2px !important;
        cursor: crosshair !important;
      }

      #${NOTICE_ID} {
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

      #${NOTICE_ID}.visible {
        opacity: 1;
        transform: translateY(0);
      }
    `;
    document.documentElement.appendChild(style);
  }

  function showNotice(message) {
    ensureStyles();
    let notice = document.getElementById(NOTICE_ID);
    if (!notice) {
      notice = document.createElement("div");
      notice.id = NOTICE_ID;
      document.documentElement.appendChild(notice);
    }
    notice.textContent = message;
    notice.classList.add("visible");
    window.clearTimeout(noticeTimeoutId);
    noticeTimeoutId = window.setTimeout(() => {
      notice.classList.remove("visible");
    }, 2200);
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
    const target = getEventSourceElement(event);
    if (!target || target === document.documentElement || target === document.body) {
      return;
    }
    highlight(target);
  }

  function onPickerClick(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const selectedElement = getEventSourceElement(event);
    if (!selectedElement) {
      return;
    }
    const { validation, targetElement } = buildValidation(pickerConfig, selectedElement);
    if (validation.mode === "table_bulk" && !validation.tableFound) {
      showNotice("Select a table or any cell inside a table.");
      return;
    }
    emit({
      eventType: "recorder-event",
      payload: {
        type: "validation",
        action: "validate",
        command: validation.command,
        url: window.location.href,
        title: document.title,
        target: buildTarget(targetElement),
        details: { validation }
      }
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
    ensureStyles();
    isPickerActive = true;
    pickerConfig = config || {};
    document.body.style.cursor = "crosshair";
    document.addEventListener("mousemove", onPickerMove, true);
    document.addEventListener("click", onPickerClick, true);
    document.addEventListener("keydown", onPickerKeydown, true);
  }

  function recordPageLoad() {
    if (!state.isRecording || !state.sessionId) {
      return;
    }
    if (pageLoadRecordedSessionId === state.sessionId) {
      return;
    }
    pageLoadRecordedSessionId = state.sessionId;
    recordEvent("page_loaded", "load", document.documentElement, {
      referrer: document.referrer
    });
  }

  function handleClick(event) {
    if (isPickerActive) {
      return;
    }
    flushActiveFieldEvent();
    flushDirtyFieldEvents();
    const element = getEventSourceElement(event);
    const anchor = element?.closest?.("a[href]");
    recordEvent("click", "click", element, {
      button: event.button,
      text: safeText(element?.innerText || element?.textContent || ""),
      linkTarget: anchor?.href || "",
      waitHints: buildClickWaitHints(anchor?.href || "")
    });
  }

  function handleFocusOut(event) {
    if (isPickerActive) {
      return;
    }
    const element = getEventSourceElement(event);
    if (!isRecordableFormElement(element)) {
      return;
    }
    if (!dirtyFieldElements.has(getElementKey(element))) {
      return;
    }
    commitFieldEvent(element);
  }

  function handleChange(event) {
    if (isPickerActive) {
      return;
    }
    const element = getEventSourceElement(event);
    if (!isRecordableFormElement(element)) {
      return;
    }
    if (!dirtyFieldElements.has(getElementKey(element))) {
      return;
    }
    commitFieldEvent(element);
  }

  function handleInput(event) {
    if (isPickerActive) {
      return;
    }
    const element = getEventSourceElement(event);
    if (!isRecordableFormElement(element)) {
      return;
    }
    markFieldDirty(element);
  }

  function handleKeyUp(event) {
    if (isPickerActive || !shouldTrackKeyup(event)) {
      return;
    }

    const element = getEventSourceElement(event) || getDeepActiveElement(document);
    if (!isRecordableFormElement(element)) {
      return;
    }

    markFieldDirty(element);
  }

  function handleSubmit(event) {
    if (isPickerActive) {
      return;
    }
    flushActiveFieldEvent();
    flushDirtyFieldEvents();
    recordEvent("submit", "submit", getEventSourceElement(event), {});
  }

  document.addEventListener("click", handleClick, true);
  document.addEventListener("input", handleInput, true);
  document.addEventListener("keyup", handleKeyUp, true);
  document.addEventListener("change", handleChange, true);
  document.addEventListener("focusout", handleFocusOut, true);
  document.addEventListener("submit", handleSubmit, true);
  window.addEventListener("beforeunload", flushDirtyFieldEvents, true);
  window.addEventListener("pageshow", recordPageLoad);

  window.__uiRecorderSetState = function (nextState) {
    if (state.isRecording && !Boolean(nextState?.isRecording)) {
      flushActiveFieldEvent();
      flushDirtyFieldEvents();
    }
    state = {
      isRecording: Boolean(nextState?.isRecording),
      sessionId: nextState?.sessionId || null
    };
    recordPageLoad();
  };

  window.__uiRecorderStartPicker = function (config) {
    startPicker(config || {});
  };

  window.__uiRecorderStopPicker = function () {
    stopPicker();
  };
})();
