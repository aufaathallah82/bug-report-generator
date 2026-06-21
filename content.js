(function installBugReportGeneratorContentScript() {
  const GLOBAL_KEY = "__BUG_REPORT_GENERATOR_CONTENT_STATE__";
  const PAGE_EVENT_NAME = "bug-report-generator:page-event";
  const RECORDING_STATE_KEY = "bugReportGenerator.recordingState";
  const DEBUG_PREFIX = "[BugReportGenerator][content]";
  const MAX_TEXT_LENGTH = 160;
  const MAX_VALUE_LENGTH = 160;
  const MAX_ATTRIBUTES = 30;
  const HTML_SNIPPET_MAX_LENGTH = 1000;
  const MAX_HTML_ATTRIBUTE_LENGTH = 160;
  const MAX_HTML_CLASS_NAMES = 4;
  const TRACKED_KEYS = new Set(["Enter", "Tab"]);
  const SENSITIVE_FIELD_TOKENS = ["password", "token", "secret", "api_key", "api-key", "apikey", "authorization", "credential"];
  const TEST_ID_ATTRIBUTES = ["data-testid", "data-test", "data-qa", "data-cy"];
  const HTML_SNIPPET_FORM_ATTRIBUTES = [
    ...TEST_ID_ATTRIBUTES,
    "id",
    "name",
    "type",
    "placeholder",
    "aria-label",
    "role",
    "value",
    "checked",
    "selected",
    "disabled",
    "readonly",
    "required",
    "autocomplete"
  ];

  const state = window[GLOBAL_KEY] || {
    installed: false,
    isRecording: false,
    activeSessionId: "",
    activeTabId: null,
    cleanups: [],
    lastKnownUrl: window.location.href,
    navigationIntervalId: null,
    lastUserAction: null,
    messageListener: null,
    storageListener: null,
    pageEventListener: null,
    resourceErrorListener: null
  };

  window[GLOBAL_KEY] = state;

  attachMessageListener();
  attachStorageListener();
  attachPageBridge();
  attachResourceErrorCapture();
  injectPageLogger();
  notifyContentReady();

  if (!state.installed) {
    state.installed = true;
    console.log(`${DEBUG_PREFIX} installed`, { url: window.location.href });
  } else {
    console.debug(`${DEBUG_PREFIX} reinitialized without duplicate listeners`, { url: window.location.href });
  }

  function injectPageLogger() {
    if (document.documentElement?.querySelector?.('script[data-bug-report-generator="page-logger"]')) {
      return;
    }

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("pageLogger.js");
    script.async = false;
    script.dataset.bugReportGenerator = "page-logger";

    const parent = document.documentElement || document.head || document.body;

    if (!parent) {
      window.setTimeout(injectPageLogger, 0);
      return;
    }

    parent.appendChild(script);
    script.remove();
  }

  function attachMessageListener() {
    if (state.messageListener) {
      chrome.runtime.onMessage.removeListener(state.messageListener);
    }

    state.messageListener = (message, _sender, sendResponse) => {
      if (message?.type === "PING" || message?.type === "PING_BUG_REPORT_GENERATOR") {
        sendResponse({ ok: true, source: "content.js", recording: state.isRecording });
        return false;
      }

      if (message?.type === "START_RECORDING" || message?.type === "START_CAPTURE") {
        activateRecording(message.sessionId, message.tabId, "start");
        sendResponse({ ok: true, status: "recording-started" });
        return false;
      }

      if (message?.type === "RESUME_RECORDING" || message?.type === "RESUME_CAPTURE") {
        activateRecording(message.sessionId, message.tabId, "resume");
        sendResponse({ ok: true, status: "recording-resumed" });
        return false;
      }

      if (message?.type === "STOP_RECORDING" || message?.type === "STOP_CAPTURE") {
        stopRecordingWithoutStorageUpdate();
        sendResponse({ ok: true, status: "recording-stopped" });
        return false;
      }

      if (message?.type === "GET_PAGE_CONTEXT") {
        sendResponse({ ok: true, context: collectPageContext() });
        return false;
      }

      return false;
    };

    chrome.runtime.onMessage.addListener(state.messageListener);
  }

  function attachStorageListener() {
    if (state.storageListener) {
      chrome.storage.onChanged.removeListener(state.storageListener);
    }

    state.storageListener = (changes, areaName) => {
      if (areaName !== "local") {
        return;
      }

      const recordingChange = changes[RECORDING_STATE_KEY];

      if (!recordingChange) {
        return;
      }

      const nextState = recordingChange.newValue;

      if (
        nextState &&
        nextState.isRecording === false &&
        nextState.sessionId &&
        nextState.sessionId === state.activeSessionId
      ) {
        stopRecordingWithoutStorageUpdate();
      }
    };

    chrome.storage.onChanged.addListener(state.storageListener);
  }

  function attachPageBridge() {
    if (state.pageEventListener) {
      window.removeEventListener(PAGE_EVENT_NAME, state.pageEventListener, true);
    }

    state.pageEventListener = (event) => {
      const detail = event.detail;

      if (!detail || typeof detail !== "object") {
        return;
      }

      if (detail.category === "navigation") {
        recordNavigation(detail.source || "spa");
        return;
      }

      if (!state.isRecording || !state.activeSessionId) {
        return;
      }

      const evidence = {
        ...detail,
        id: detail.id || crypto.randomUUID(),
        timestamp: detail.timestamp || new Date().toISOString(),
        pageUrl: window.location.href,
        title: document.title || "",
        sessionId: state.activeSessionId,
        lastUserAction: state.lastUserAction ? compactAction(state.lastUserAction) : null
      };

      sendRuntimeMessage({
        type: "RECORD_EVIDENCE",
        sessionId: state.activeSessionId,
        evidence
      });
    };

    window.addEventListener(PAGE_EVENT_NAME, state.pageEventListener, true);
  }

  function attachResourceErrorCapture() {
    if (state.resourceErrorListener) {
      window.removeEventListener("error", state.resourceErrorListener, true);
    }

    state.resourceErrorListener = (event) => {
      if (!state.isRecording || !state.activeSessionId) {
        return;
      }

      const target = event.target;

      if (!target || target === window || !(target instanceof HTMLElement)) {
        return;
      }

      const source = getElementSource(target);
      const tag = target.tagName.toLowerCase();

      sendRuntimeMessage({
        type: "RECORD_EVIDENCE",
        sessionId: state.activeSessionId,
        evidence: {
          id: crypto.randomUUID(),
          category: "network-error",
          transport: "resource",
          requestUrl: source || "",
          method: "GET",
          status: 0,
          statusText: "",
          failureReason: `Failed to load ${tag}${source ? `: ${source}` : ""}`,
          timestamp: new Date().toISOString(),
          pageUrl: window.location.href,
          title: document.title || "",
          lastUserAction: state.lastUserAction ? compactAction(state.lastUserAction) : null
        }
      });
    };

    window.addEventListener("error", state.resourceErrorListener, true);
  }

  function activateRecording(sessionId, tabId, reason) {
    if (!sessionId) {
      return;
    }

    if (state.isRecording && state.activeSessionId === sessionId) {
      sendPageSnapshot(reason);
      return;
    }

    stopRecordingWithoutStorageUpdate();
    state.isRecording = true;
    state.activeSessionId = sessionId;
    state.activeTabId = typeof tabId === "number" ? tabId : null;
    state.lastKnownUrl = window.location.href;

    addCaptureListener(document, "click", handleClick, true);
    addCaptureListener(document, "input", handleInput, true);
    addCaptureListener(document, "change", handleChange, true);
    addCaptureListener(document, "submit", handleSubmit, true);
    addCaptureListener(document, "keydown", handleKeydown, true);
    addCaptureListener(window, "hashchange", () => recordNavigation("hashchange"));
    addCaptureListener(window, "popstate", () => recordNavigation("popstate"));

    state.navigationIntervalId = window.setInterval(checkForUrlChange, 500);
    sendPageSnapshot(reason);

    console.log(`${DEBUG_PREFIX} recording ${reason === "resume" ? "resumed" : "started"}`, {
      sessionId,
      tabId,
      url: window.location.href
    });
  }

  function stopRecordingWithoutStorageUpdate() {
    const wasRecording = state.isRecording;
    state.isRecording = false;
    state.activeSessionId = "";
    state.activeTabId = null;

    for (const cleanup of state.cleanups.splice(0)) {
      cleanup();
    }

    if (state.navigationIntervalId !== null) {
      window.clearInterval(state.navigationIntervalId);
      state.navigationIntervalId = null;
    }

    if (wasRecording) {
      console.log(`${DEBUG_PREFIX} recording stopped`, { url: window.location.href });
    }
  }

  function addCaptureListener(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    state.cleanups.push(() => target.removeEventListener(type, listener, options));
  }

  function handleClick(event) {
    if (event.isTrusted === false) {
      return;
    }

    const element = getInteractiveElement(event.target);

    if (!element) {
      return;
    }

    saveAction("click", element);
  }

  function handleInput(event) {
    if (event.isTrusted === false) {
      return;
    }

    const element = getEditableElement(event.target);

    if (!element) {
      return;
    }

    saveAction("input", element, getSafeElementValue(element));
  }

  function handleChange(event) {
    if (event.isTrusted === false) {
      return;
    }

    const element = getEditableElement(event.target);

    if (!element) {
      return;
    }

    saveAction("change", element, getSafeElementValue(element));
  }

  function handleSubmit(event) {
    if (event.isTrusted === false || !(event.target instanceof HTMLFormElement)) {
      return;
    }

    saveAction("submit", event.target);
  }

  function handleKeydown(event) {
    if (event.isTrusted === false || !TRACKED_KEYS.has(event.key)) {
      return;
    }

    const element =
      getInteractiveElement(event.target) ||
      (document.activeElement instanceof HTMLElement ? document.activeElement : document.documentElement);
    const type = event.key === "Enter" ? "enter_key" : "tab_key";
    saveAction(type, element, event.key);
  }

  function checkForUrlChange() {
    if (!state.isRecording || window.location.href === state.lastKnownUrl) {
      return;
    }

    recordNavigation("url-change");
  }

  function recordNavigation(source) {
    if (!state.isRecording || !state.activeSessionId || window.location.href === state.lastKnownUrl) {
      return;
    }

    state.lastKnownUrl = window.location.href;
    const action = buildNavigationAction(source);
    state.lastUserAction = action;

    sendRuntimeMessage({
      type: "RECORD_ACTION",
      sessionId: state.activeSessionId,
      action
    });

    sendPageSnapshot(source);
  }

  function saveAction(type, element, value) {
    if (!state.isRecording || !state.activeSessionId) {
      return;
    }

    const action = buildAction(type, element, value);
    state.lastUserAction = action;

    sendRuntimeMessage({
      type: "RECORD_ACTION",
      sessionId: state.activeSessionId,
      action
    });
  }

  function buildAction(type, element, value) {
    const elementContext = describeElement(element, value);
    const description = describeAction(type, elementContext, value);

    return {
      id: crypto.randomUUID(),
      step: 0,
      type,
      timestamp: new Date().toISOString(),
      url: window.location.href,
      pageUrl: window.location.href,
      title: document.title || "",
      sessionId: state.activeSessionId,
      tabId: state.activeTabId,
      key: type === "enter_key" ? "Enter" : type === "tab_key" ? "Tab" : "",
      value,
      htmlSnippet: elementContext.element.htmlSnippet || "",
      element: elementContext.element,
      locators: elementContext.locators,
      target: {
        tagName: elementContext.element.tag,
        selector: elementContext.locators.best?.value || elementContext.element.domPath || elementContext.element.tag,
        label:
          elementContext.element.accessibleLabel ||
          elementContext.element.text ||
          elementContext.element.placeholder ||
          elementContext.element.attributes?.name ||
          elementContext.element.tag,
        inputType: elementContext.element.attributes?.type
      },
      targetKey: `${window.location.href}:${elementContext.locators.best?.strategy || "dom"}:${elementContext.locators.best?.value || elementContext.element.domPath}`,
      description,
      text: description
    };
  }

  function buildNavigationAction(source) {
    const description = source === "url-change" ? `URL changed to ${window.location.href}` : `Navigated to ${window.location.href}`;

    return {
      id: crypto.randomUUID(),
      step: 0,
      type: "navigation",
      timestamp: new Date().toISOString(),
      url: window.location.href,
      pageUrl: window.location.href,
      title: document.title || "",
      sessionId: state.activeSessionId,
      tabId: state.activeTabId,
      source,
      element: {
        tag: "document",
        text: document.title || "",
        accessibleLabel: "page",
        placeholder: "",
        value: "",
        attributes: {},
        domPath: "document",
        nearbyText: "",
        parentContext: ""
      },
      locators: {
        candidates: [
          {
            strategy: "url",
            value: window.location.href,
            score: 80,
            reason: "Current page URL",
            uniqueness: "page",
            stabilityNotes: "Useful for page-level reproduction, not an element locator."
          }
        ],
        best: {
          strategy: "url",
          value: window.location.href,
          score: 80,
          reason: "Current page URL",
          uniqueness: "page",
          stabilityNotes: "Useful for page-level reproduction, not an element locator."
        }
      },
      target: {
        tagName: "document",
        selector: "document",
        label: "page"
      },
      targetKey: `navigation:${window.location.href}`,
      description,
      text: description
    };
  }

  function describeAction(type, context, value) {
    const label =
      context.element.accessibleLabel ||
      context.element.text ||
      context.element.placeholder ||
      context.element.attributes?.name ||
      context.element.tag;

    if (type === "click") {
      return `Clicked ${label}`;
    }

    if (type === "submit") {
      return `Submitted ${label}`;
    }

    if (type === "enter_key") {
      return `Pressed Enter on ${label}`;
    }

    if (type === "tab_key") {
      return `Pressed Tab on ${label}`;
    }

    if (type === "change") {
      return value ? `Changed ${label} to ${formatValueForDescription(value)}` : `Changed ${label}`;
    }

    return value ? `Typed ${formatValueForDescription(value)} into ${label}` : `Typed into ${label}`;
  }

  function formatValueForDescription(value) {
    return value === "[REDACTED]" ? value : `"${value}"`;
  }

  function describeElement(element, value) {
    const tag = element.tagName.toLowerCase();
    const text = getElementText(element);
    const accessibleLabel = getAccessibleLabel(element);
    const attributes = getSafeAttributes(element);
    const domPath = getDomPath(element);
    const nearbyText = getNearbyText(element);
    const parentContext = getParentContext(element);
    const safeValue = value || getStaticSafeElementValue(element);
    const htmlSnippet = getCleanHtmlSnippet(element);
    const locators = generateLocatorCandidates(element, {
      tag,
      text,
      accessibleLabel,
      attributes,
      domPath,
      nearbyText
    });

    return {
      element: {
        tag,
        text,
        accessibleLabel,
        placeholder: element.getAttribute("placeholder") || "",
        value: safeValue,
        attributes,
        domPath,
        nearbyText,
        parentContext,
        htmlSnippet
      },
      locators: htmlSnippet
        ? {
            ...locators,
            html: htmlSnippet
          }
        : locators
    };
  }

  function generateLocatorCandidates(element, context) {
    const candidates = [];
    const tag = context.tag;

    for (const attribute of TEST_ID_ATTRIBUTES) {
      const value = element.getAttribute(attribute);

      if (value) {
        addCandidate(candidates, {
          strategy: attribute,
          value: `[${attribute}="${escapeCssString(value)}"]`,
          score: 98,
          reason: `${attribute} is designed for testing and automation.`,
          uniqueness: getSelectorUniqueness(`[${attribute}="${escapeCssString(value)}"]`),
          stabilityNotes: "Preferred stable test attribute."
        });
      }
    }

    if (element.id) {
      const generated = looksGeneratedValue(element.id);
      addCandidate(candidates, {
        strategy: "id",
        value: `#${escapeCssIdentifier(element.id)}`,
        score: generated ? 58 : 94,
        reason: generated ? "ID exists but looks generated." : "Stable id attribute.",
        uniqueness: getSelectorUniqueness(`#${escapeCssIdentifier(element.id)}`),
        stabilityNotes: generated ? "Penalized because the id looks dynamic." : "Good if application keeps ids stable."
      });
    }

    const name = element.getAttribute("name");

    if (name) {
      const selector = `${tag}[name="${escapeCssString(name)}"]`;
      addCandidate(candidates, {
        strategy: "name",
        value: selector,
        score: 88,
        reason: "Readable name attribute.",
        uniqueness: getSelectorUniqueness(selector),
        stabilityNotes: "Usually stable for form fields."
      });
    }

    const ariaLabel = element.getAttribute("aria-label");

    if (ariaLabel) {
      const selector = `${tag}[aria-label="${escapeCssString(ariaLabel)}"]`;
      addCandidate(candidates, {
        strategy: "aria-label",
        value: selector,
        score: 84,
        reason: "Accessible label is readable.",
        uniqueness: getSelectorUniqueness(selector),
        stabilityNotes: "Stable if accessibility copy is controlled."
      });
    }

    const role = element.getAttribute("role") || getImplicitRole(element);

    if (role && (context.accessibleLabel || context.text)) {
      addCandidate(candidates, {
        strategy: "role",
        value: `role=${role}; name="${escapeLocatorText(context.accessibleLabel || context.text)}"`,
        score: 82,
        reason: "Semantic role and accessible name.",
        uniqueness: "not checked",
        stabilityNotes: "Readable and portable to Playwright-style locators."
      });
    }

    const placeholder = element.getAttribute("placeholder");

    if (placeholder) {
      const selector = `${tag}[placeholder="${escapeCssString(placeholder)}"]`;
      addCandidate(candidates, {
        strategy: "placeholder",
        value: selector,
        score: 78,
        reason: "Readable placeholder text.",
        uniqueness: getSelectorUniqueness(selector),
        stabilityNotes: "Can change with UX copy."
      });
    }

    const labelText = getAssociatedLabelText(element);

    if (labelText) {
      addCandidate(candidates, {
        strategy: "label",
        value: `label="${escapeLocatorText(labelText)}"`,
        score: 80,
        reason: "Field can be identified by nearby label text.",
        uniqueness: getTextUniqueness(labelText),
        stabilityNotes: "Good for manual reproduction and accessible automation."
      });
    }

    if (context.text && context.text.length <= 80) {
      addCandidate(candidates, {
        strategy: "visible text",
        value: `text="${escapeLocatorText(context.text)}"`,
        score: 70,
        reason: "Visible text is readable.",
        uniqueness: getTextUniqueness(context.text),
        stabilityNotes: "Text locators can be ambiguous or copy-sensitive."
      });
    }

    const cssSelector = generateStableCssSelector(element);

    if (cssSelector) {
      const score = scoreCssSelector(cssSelector);
      addCandidate(candidates, {
        strategy: "css",
        value: cssSelector,
        score,
        reason: score >= 75 ? "Generated CSS selector with stable attributes." : "Generated CSS fallback.",
        uniqueness: getSelectorUniqueness(cssSelector),
        stabilityNotes: cssSelector.includes(":nth-of-type") ? "Penalized because it uses indexes." : "Prefer shorter selectors."
      });
    }

    const relativeXPath = generateRelativeXPath(element);

    if (relativeXPath) {
      addCandidate(candidates, {
        strategy: "relative xpath",
        value: relativeXPath,
        score: scoreXPath(relativeXPath),
        reason: "Relative XPath fallback.",
        uniqueness: getXPathUniqueness(relativeXPath),
        stabilityNotes: relativeXPath.includes("[") ? "May be index-sensitive." : "Relative XPath avoids full DOM root."
      });
    }

    const xpath = generateXPath(element);

    if (xpath) {
      addCandidate(candidates, {
        strategy: "xpath",
        value: xpath,
        score: 38,
        reason: "Absolute XPath fallback.",
        uniqueness: getXPathUniqueness(xpath),
        stabilityNotes: "Penalized because absolute XPath is brittle."
      });
    }

    if (context.nearbyText) {
      addCandidate(candidates, {
        strategy: "nearby text",
        value: `near("${escapeLocatorText(context.nearbyText)}") >> ${tag}`,
        score: 62,
        reason: "Nearby text provides reproduction context.",
        uniqueness: "not checked",
        stabilityNotes: "Useful for AI/debugging, weaker as a direct selector."
      });
    }

    const uniqueCandidates = dedupeCandidates(candidates).sort((left, right) => right.score - left.score);

    return {
      candidates: uniqueCandidates,
      best: uniqueCandidates[0] || null
    };
  }

  function addCandidate(candidates, candidate) {
    candidates.push({
      strategy: candidate.strategy,
      value: candidate.value,
      score: clamp(candidate.score, 0, 100),
      reason: candidate.reason,
      uniqueness: candidate.uniqueness,
      stabilityNotes: candidate.stabilityNotes
    });
  }

  function dedupeCandidates(candidates) {
    const seen = new Set();
    const result = [];

    for (const candidate of candidates) {
      const key = `${candidate.strategy}:${candidate.value}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      result.push(candidate);
    }

    return result;
  }

  function scoreCssSelector(selector) {
    let score = 68;

    if (TEST_ID_ATTRIBUTES.some((attribute) => selector.includes(`[${attribute}=`))) {
      score += 20;
    }

    if (selector.includes("#") && !looksGeneratedValue(selector)) {
      score += 12;
    }

    if (selector.length > 120) {
      score -= 18;
    }

    if (selector.includes(":nth-of-type") || selector.includes(":nth-child")) {
      score -= 16;
    }

    if (selector.split(">").length > 5) {
      score -= 12;
    }

    return clamp(score, 20, 90);
  }

  function scoreXPath(xpath) {
    let score = xpath.startsWith("//*[@") ? 64 : 58;

    if (xpath.startsWith("/html")) {
      score -= 25;
    }

    if ((xpath.match(/\[\d+\]/g) || []).length > 2) {
      score -= 18;
    }

    if (xpath.length > 140) {
      score -= 14;
    }

    return clamp(score, 20, 76);
  }

  function getInteractiveElement(target) {
    if (!(target instanceof Element)) {
      return null;
    }

    return (
      target.closest(
        [
          "button",
          "a[href]",
          "input",
          "select",
          "textarea",
          "label",
          "summary",
          "form",
          "[role='button']",
          "[role='link']",
          "[role='checkbox']",
          "[role='radio']",
          "[role='textbox']",
          "[role='combobox']",
          "[contenteditable='true']"
        ].join(",")
      ) || (target instanceof HTMLElement ? target : null)
    );
  }

  function getEditableElement(target) {
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return target;
    }

    if (target instanceof HTMLElement && target.isContentEditable) {
      return target;
    }

    return null;
  }

  function getSafeElementValue(element) {
    if (isSensitiveElement(element)) {
      return "[REDACTED]";
    }

    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox" || element.type === "radio") {
        return element.checked ? "checked" : "not checked";
      }

      if (element.type === "file") {
        return element.files && element.files.length > 0 ? "[FILE SELECTED]" : "[NO FILE SELECTED]";
      }

      return trimValue(element.value);
    }

    if (element instanceof HTMLTextAreaElement) {
      return trimValue(element.value);
    }

    if (element instanceof HTMLSelectElement) {
      const selectedOption = element.selectedOptions[0];
      return trimValue(selectedOption?.textContent || element.value);
    }

    return trimValue(element.textContent || "");
  }

  function getStaticSafeElementValue(element) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
      return "";
    }

    return getSafeElementValue(element);
  }

  function isSensitiveElement(element) {
    if (element instanceof HTMLInputElement && element.type.toLowerCase() === "password") {
      return true;
    }

    const searchableValue = [
      element.getAttribute("name"),
      element.id,
      element.getAttribute("placeholder"),
      element.getAttribute("aria-label"),
      element.getAttribute("autocomplete"),
      ...TEST_ID_ATTRIBUTES.map((attribute) => element.getAttribute(attribute))
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return SENSITIVE_FIELD_TOKENS.some((token) => searchableValue.includes(token));
  }

  function trimValue(value) {
    const normalized = normalizeText(value);

    if (!normalized) {
      return "blank";
    }

    return normalized.length > MAX_VALUE_LENGTH ? `${normalized.slice(0, MAX_VALUE_LENGTH)}...` : normalized;
  }

  function getSafeAttributes(element) {
    const attributes = {};

    for (const attribute of Array.from(element.attributes || []).slice(0, MAX_ATTRIBUTES)) {
      const name = attribute.name;

      if (/^on/i.test(name) || name === "style") {
        continue;
      }

      if (name === "value" && isSensitiveElement(element)) {
        attributes[name] = "[REDACTED]";
        continue;
      }

      attributes[name] = trimAttribute(attribute.value);
    }

    return attributes;
  }

  function getCleanHtmlSnippet(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    const source = String(element.outerHTML || "").trim();

    if (!source) {
      return "";
    }

    const template = document.createElement("template");
    template.innerHTML = source;

    const clone = template.content.firstElementChild;

    if (!clone) {
      return truncateHtmlSnippet(normalizeSnippetWhitespace(source));
    }

    cleanHtmlSnippetNode(clone, element, true);

    let snippet = normalizeSnippetWhitespace(clone.outerHTML);

    if (snippet.length > HTML_SNIPPET_MAX_LENGTH && clone.children.length) {
      collapseSnippetChildren(clone);
      snippet = normalizeSnippetWhitespace(clone.outerHTML);
    }

    return truncateHtmlSnippet(snippet);
  }

  function cleanHtmlSnippetNode(node, sourceElement, isRoot) {
    if (!(node instanceof Element)) {
      return;
    }

    cleanHtmlSnippetAttributes(node, sourceElement, isRoot);

    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
        continue;
      }

      if (child.nodeType === Node.TEXT_NODE) {
        const text = String(child.textContent || "").replace(/\s+/g, " ");
        child.textContent = text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH - 3)}...` : text;
        continue;
      }

      if (child.nodeType === Node.ELEMENT_NODE) {
        cleanHtmlSnippetNode(child, null, false);
      }
    }
  }

  function cleanHtmlSnippetAttributes(element, sourceElement, isRoot) {
    const tag = element.tagName.toLowerCase();
    const isFormControl = ["input", "textarea", "select", "button", "option"].includes(tag);
    const allowedFormAttributes = new Set(HTML_SNIPPET_FORM_ATTRIBUTES);
    const isSensitive =
      (isRoot && sourceElement instanceof Element && isSensitiveElement(sourceElement)) ||
      isSensitiveSnippetElement(element);

    for (const attribute of Array.from(element.attributes || [])) {
      const name = attribute.name.toLowerCase();

      if (/^on/i.test(name) || name === "style") {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (name === "class") {
        if (isFormControl) {
          element.removeAttribute(attribute.name);
        } else {
          sanitizeHtmlClassAttribute(element, attribute.name, attribute.value);
        }

        continue;
      }

      if (isFormControl && !allowedFormAttributes.has(name)) {
        element.removeAttribute(attribute.name);
        continue;
      }

      if (name === "value" && isSensitive) {
        element.setAttribute(attribute.name, "[REDACTED]");
        continue;
      }

      if (isSensitiveHtmlAttributeName(name)) {
        element.setAttribute(attribute.name, "[REDACTED]");
        continue;
      }

      element.setAttribute(attribute.name, trimHtmlAttribute(attribute.value));
    }

    if (
      isRoot &&
      isSensitive &&
      sourceElement instanceof HTMLInputElement &&
      sourceElement.value &&
      !["button", "submit", "reset"].includes(sourceElement.type.toLowerCase())
    ) {
      element.setAttribute("value", "[REDACTED]");
    }

    orderHtmlSnippetAttributes(element);
  }

  function sanitizeHtmlClassAttribute(element, attributeName, value) {
    const classNames = String(value || "")
      .split(/\s+/)
      .filter(Boolean);
    const stableClassNames = classNames
      .filter((className) => !looksGeneratedValue(className))
      .slice(0, MAX_HTML_CLASS_NAMES);

    if (!stableClassNames.length) {
      element.removeAttribute(attributeName);
      return;
    }

    element.setAttribute(attributeName, stableClassNames.join(" "));
  }

  function isSensitiveSnippetElement(element) {
    const searchableValue = [
      element.getAttribute("type"),
      element.getAttribute("name"),
      element.id,
      element.getAttribute("placeholder"),
      element.getAttribute("aria-label"),
      element.getAttribute("autocomplete"),
      ...TEST_ID_ATTRIBUTES.map((attribute) => element.getAttribute(attribute))
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return searchableValue.includes("password") || SENSITIVE_FIELD_TOKENS.some((token) => searchableValue.includes(token));
  }

  function isSensitiveHtmlAttributeName(name) {
    return /(?:token|secret|api[-_]?key|authorization|credential)/i.test(name);
  }

  function orderHtmlSnippetAttributes(element) {
    const preferredOrder = [...HTML_SNIPPET_FORM_ATTRIBUTES, "href", "title", "alt", "for", "class"];
    const attributes = Array.from(element.attributes || []).map((attribute, index) => ({
      name: attribute.name,
      value: attribute.value,
      index
    }));

    if (attributes.length < 2) {
      return;
    }

    attributes.sort((left, right) => {
      const leftRank = preferredOrder.includes(left.name) ? preferredOrder.indexOf(left.name) : preferredOrder.length + left.index;
      const rightRank = preferredOrder.includes(right.name) ? preferredOrder.indexOf(right.name) : preferredOrder.length + right.index;
      return leftRank - rightRank;
    });

    for (const attribute of Array.from(element.attributes || [])) {
      element.removeAttribute(attribute.name);
    }

    for (const attribute of attributes) {
      element.setAttribute(attribute.name, attribute.value);
    }
  }

  function collapseSnippetChildren(element) {
    const text = normalizeText(element.textContent || "");

    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }

    if (text) {
      element.appendChild(document.createTextNode(text));
    }
  }

  function trimHtmlAttribute(value) {
    const normalized = normalizeSnippetWhitespace(value);
    return normalized.length > MAX_HTML_ATTRIBUTE_LENGTH
      ? `${normalized.slice(0, MAX_HTML_ATTRIBUTE_LENGTH - 3)}...`
      : normalized;
  }

  function truncateHtmlSnippet(value) {
    const text = String(value || "").trim();
    return text.length > HTML_SNIPPET_MAX_LENGTH ? `${text.slice(0, HTML_SNIPPET_MAX_LENGTH - 3)}...` : text;
  }

  function normalizeSnippetWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function trimAttribute(value) {
    const normalized = normalizeText(value);
    return normalized.length > MAX_TEXT_LENGTH ? `${normalized.slice(0, MAX_TEXT_LENGTH)}...` : normalized;
  }

  function getElementText(element) {
    const tag = element.tagName.toLowerCase();

    if (element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type)) {
      return normalizeText(element.value || element.getAttribute("value") || "");
    }

    if (tag === "img") {
      return normalizeText(element.getAttribute("alt") || "");
    }

    return normalizeText(element.innerText || element.textContent || "");
  }

  function getAccessibleLabel(element) {
    return normalizeText(
      getAssociatedLabelText(element) ||
        getAriaLabelledByText(element) ||
        element.getAttribute("aria-label") ||
        element.getAttribute("alt") ||
        element.getAttribute("title") ||
        ""
    );
  }

  function getAssociatedLabelText(element) {
    if (element.tagName.toLowerCase() === "label") {
      return normalizeText(element.innerText || element.textContent || "");
    }

    const wrappingLabel = element.closest("label");

    if (wrappingLabel) {
      return normalizeText(wrappingLabel.innerText || wrappingLabel.textContent || "");
    }

    if (!element.id) {
      return "";
    }

    try {
      const labels = Array.from(document.querySelectorAll(`label[for="${escapeCssString(element.id)}"]`));
      return normalizeText(labels.map((label) => label.innerText || label.textContent || "").join(" "));
    } catch (_error) {
      return "";
    }
  }

  function getAriaLabelledByText(element) {
    const labelledBy = element.getAttribute("aria-labelledby");

    if (!labelledBy) {
      return "";
    }

    return normalizeText(
      labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "")
        .join(" ")
    );
  }

  function getNearbyText(element) {
    const nearby = [];
    const previous = element.previousElementSibling;
    const next = element.nextElementSibling;
    const parent = element.parentElement;

    if (previous) {
      nearby.push(previous.innerText || previous.textContent || "");
    }

    if (next) {
      nearby.push(next.innerText || next.textContent || "");
    }

    if (parent) {
      nearby.push(parent.innerText || parent.textContent || "");
    }

    return normalizeText(nearby.join(" ")).slice(0, MAX_TEXT_LENGTH);
  }

  function getParentContext(element) {
    const parent = element.parentElement;

    if (!parent) {
      return "";
    }

    return normalizeText(
      [
        parent.tagName.toLowerCase(),
        parent.id ? `#${parent.id}` : "",
        parent.getAttribute("class") || "",
        parent.getAttribute("role") || "",
        parent.getAttribute("aria-label") || ""
      ].join(" ")
    );
  }

  function generateStableCssSelector(element) {
    const tag = element.tagName.toLowerCase();
    const simpleSelectors = [];

    for (const attribute of TEST_ID_ATTRIBUTES) {
      const value = element.getAttribute(attribute);

      if (value) {
        simpleSelectors.push(`${tag}[${attribute}="${escapeCssString(value)}"]`);
        simpleSelectors.push(`[${attribute}="${escapeCssString(value)}"]`);
      }
    }

    if (element.id) {
      simpleSelectors.push(`#${escapeCssIdentifier(element.id)}`);
      simpleSelectors.push(`${tag}#${escapeCssIdentifier(element.id)}`);
    }

    for (const attribute of ["name", "aria-label", "placeholder", "role"]) {
      const value = element.getAttribute(attribute);

      if (value) {
        simpleSelectors.push(`${tag}[${attribute}="${escapeCssString(value)}"]`);
      }
    }

    for (const selector of simpleSelectors) {
      if (isUniqueSelector(selector)) {
        return selector;
      }
    }

    const parts = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      parts.unshift(buildCssPathSegment(current));
      const selector = parts.join(" > ");

      if (isUniqueSelector(selector)) {
        return selector;
      }

      if (current === document.documentElement) {
        break;
      }

      current = current.parentElement;
    }

    return parts.join(" > ");
  }

  function buildCssPathSegment(element) {
    const tag = element.tagName.toLowerCase();

    if (element.id) {
      return `${tag}#${escapeCssIdentifier(element.id)}`;
    }

    for (const attribute of [...TEST_ID_ATTRIBUTES, "name", "aria-label", "placeholder", "role"]) {
      const value = element.getAttribute(attribute);

      if (value) {
        return `${tag}[${attribute}="${escapeCssString(value)}"]`;
      }
    }

    const classSegment = getStableClassSegment(element);
    let selector = `${tag}${classSegment}`;
    const parent = element.parentElement;

    if (parent) {
      const sameTagSiblings = Array.from(parent.children).filter((sibling) => sibling.tagName === element.tagName);

      if (sameTagSiblings.length > 1) {
        selector += `:nth-of-type(${sameTagSiblings.indexOf(element) + 1})`;
      }
    }

    return selector;
  }

  function getStableClassSegment(element) {
    const classNames = Array.from(element.classList || [])
      .filter((className) => !looksGeneratedValue(className))
      .slice(0, 2);

    return classNames.length ? `.${classNames.map(escapeCssIdentifier).join(".")}` : "";
  }

  function getDomPath(element) {
    const segments = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;

      if (!parent) {
        segments.unshift(tag);
        break;
      }

      const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
      const index = sameTagSiblings.indexOf(current) + 1;
      segments.unshift(sameTagSiblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
      current = parent;
    }

    return segments.join(" > ") || element.tagName.toLowerCase();
  }

  function generateXPath(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const parts = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      const tag = current.tagName.toLowerCase();
      let index = 1;
      let sibling = current.previousElementSibling;

      while (sibling) {
        if (sibling.tagName.toLowerCase() === tag) {
          index += 1;
        }

        sibling = sibling.previousElementSibling;
      }

      parts.unshift(`${tag}[${index}]`);
      current = current.parentElement;
    }

    return `/${parts.join("/")}`;
  }

  function generateRelativeXPath(element) {
    if (element.id && !looksGeneratedValue(element.id)) {
      return `//*[@id=${toXPathLiteral(element.id)}]`;
    }

    for (const attribute of [...TEST_ID_ATTRIBUTES, "name", "aria-label", "placeholder"]) {
      const value = element.getAttribute(attribute);

      if (value) {
        return `//${element.tagName.toLowerCase()}[@${attribute}=${toXPathLiteral(value)}]`;
      }
    }

    const text = getElementText(element);

    if (text && text.length <= 80) {
      return `//${element.tagName.toLowerCase()}[normalize-space()=${toXPathLiteral(text)}]`;
    }

    return "";
  }

  function getSelectorUniqueness(selector) {
    try {
      const count = document.querySelectorAll(selector).length;
      return count === 1 ? "unique" : `${count} matches`;
    } catch (_error) {
      return "invalid selector";
    }
  }

  function getXPathUniqueness(xpath) {
    try {
      const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return result.snapshotLength === 1 ? "unique" : `${result.snapshotLength} matches`;
    } catch (_error) {
      return "invalid xpath";
    }
  }

  function getTextUniqueness(text) {
    const normalized = normalizeText(text).toLowerCase();
    const count = Array.from(document.body?.querySelectorAll("*") || []).filter(
      (element) => normalizeText(element.textContent || "").toLowerCase() === normalized
    ).length;

    return count === 1 ? "unique" : `${count} text matches`;
  }

  function isUniqueSelector(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (_error) {
      return false;
    }
  }

  function getImplicitRole(element) {
    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute("type") || "";

    if (tag === "a" && element.getAttribute("href")) {
      return "link";
    }

    if (tag === "button") {
      return "button";
    }

    if (tag === "select") {
      return element.multiple ? "listbox" : "combobox";
    }

    if (tag === "textarea") {
      return "textbox";
    }

    if (tag === "input") {
      if (["button", "submit", "reset"].includes(type)) {
        return "button";
      }

      if (type === "checkbox") {
        return "checkbox";
      }

      if (type === "radio") {
        return "radio";
      }

      return "textbox";
    }

    return "";
  }

  function looksGeneratedValue(value) {
    const text = String(value || "");
    return (
      text.length > 24 ||
      /[0-9a-f]{8,}/i.test(text) ||
      /\b[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\b/i.test(text) ||
      /(?:^|[-_])(ng|ember|react|vue|css|sc|jss)[-_]?[a-z0-9]{5,}/i.test(text)
    );
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
  }

  function escapeCssIdentifier(value) {
    if (window.CSS?.escape) {
      return window.CSS.escape(value);
    }

    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function escapeCssString(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\A ");
  }

  function escapeLocatorText(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function toXPathLiteral(value) {
    const text = String(value);

    if (!text.includes('"')) {
      return `"${text}"`;
    }

    if (!text.includes("'")) {
      return `'${text}'`;
    }

    return `concat("${text.replace(/"/g, '", \'"\', "')}")`;
  }

  function getElementSource(element) {
    if (element instanceof HTMLImageElement || element instanceof HTMLScriptElement) {
      return element.src || "";
    }

    if (element instanceof HTMLLinkElement) {
      return element.href || "";
    }

    if (element instanceof HTMLIFrameElement || element instanceof HTMLSourceElement) {
      return element.src || "";
    }

    return "";
  }

  function compactAction(action) {
    return {
      id: action.id,
      step: action.step,
      type: action.type,
      timestamp: action.timestamp,
      url: action.url,
      description: action.description,
      bestLocator: action.locators?.best || null
    };
  }

  function collectPageContext() {
    return {
      url: window.location.href,
      title: document.title || "",
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio
      },
      screen: {
        width: window.screen.width,
        height: window.screen.height,
        availWidth: window.screen.availWidth,
        availHeight: window.screen.availHeight,
        colorDepth: window.screen.colorDepth
      },
      language: navigator.language,
      platform: navigator.platform,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || ""
    };
  }

  function sendPageSnapshot(reason) {
    if (!state.activeSessionId) {
      return;
    }

    window.setTimeout(() => {
      sendRuntimeMessage({
        type: "PAGE_LOAD_SNAPSHOT",
        sessionId: state.activeSessionId,
        snapshot: {
          id: crypto.randomUUID(),
          reason,
          ...collectPageContext()
        }
      });
    }, 50);
  }

  function notifyContentReady() {
    sendRuntimeMessage({
      type: "CONTENT_SCRIPT_READY",
      url: window.location.href,
      title: document.title || ""
    });
  }

  function sendRuntimeMessage(message) {
    try {
      chrome.runtime.sendMessage(message, () => {
        const runtimeError = chrome.runtime.lastError;

        if (runtimeError?.message) {
          console.debug(`${DEBUG_PREFIX} sendMessage failed`, runtimeError.message);
        }
      });
    } catch (error) {
      console.debug(`${DEBUG_PREFIX} sendMessage threw`, error);
    }
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
