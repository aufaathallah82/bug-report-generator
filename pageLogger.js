(function installBugReportGeneratorPageLogger() {
  const EVENT_NAME = "bug-report-generator:page-event";
  const LOGGER_FLAG = "__BUG_REPORT_GENERATOR_PAGE_LOGGER_INSTALLED__";
  const MAX_SERIALIZED_LENGTH = 2000;

  if (window[LOGGER_FLAG]) {
    return;
  }

  window[LOGGER_FLAG] = true;

  const originalConsoleError = console.error ? console.error.bind(console) : undefined;
  const originalConsoleWarn = console.warn ? console.warn.bind(console) : undefined;
  const originalFetch = window.fetch ? window.fetch.bind(window) : undefined;
  const OriginalXMLHttpRequest = window.XMLHttpRequest;
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  patchConsole();
  patchRuntimeErrors();
  patchUnhandledRejections();
  patchFetch();
  patchXMLHttpRequest();
  patchHistory();

  function patchConsole() {
    if (originalConsoleError) {
      console.error = function patchedConsoleError(...args) {
        emit("console", {
          level: "console.error",
          message: args.map(serializeValue).join(" "),
          arguments: args.map(serializeValue),
          stack: new Error().stack
        });
        originalConsoleError(...args);
      };
    }

    if (originalConsoleWarn) {
      console.warn = function patchedConsoleWarn(...args) {
        emit("console", {
          level: "console.warn",
          message: args.map(serializeValue).join(" "),
          arguments: args.map(serializeValue),
          stack: new Error().stack
        });
        originalConsoleWarn(...args);
      };
    }
  }

  function patchRuntimeErrors() {
    window.addEventListener("error", (event) => {
      if (!event.message || event.target !== window) {
        return;
      }

      emit("javascript-error", {
        level: "runtime-error",
        message: event.message,
        source: event.filename || "",
        line: event.lineno || 0,
        column: event.colno || 0,
        stack: event.error instanceof Error ? event.error.stack : ""
      });
    });
  }

  function patchUnhandledRejections() {
    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;

      emit("promise-rejection", {
        level: "unhandled-rejection",
        message: reason instanceof Error ? reason.message : serializeValue(reason),
        stack: reason instanceof Error ? reason.stack || "" : ""
      });
    });
  }

  function patchFetch() {
    if (!originalFetch) {
      return;
    }

    window.fetch = function patchedFetch(input, init) {
      const request = normalizeFetchRequest(input, init);
      const startedAt = new Date().toISOString();

      return originalFetch(input, init)
        .then((response) => {
          if (!response.ok) {
            emit("network-error", {
              transport: "fetch",
              requestUrl: request.url,
              method: request.method,
              status: response.status,
              statusText: response.statusText,
              failureReason: `HTTP ${response.status}`,
              startedAt,
              endedAt: new Date().toISOString()
            });
          }

          return response;
        })
        .catch((error) => {
          emit("network-error", {
            transport: "fetch",
            requestUrl: request.url,
            method: request.method,
            status: 0,
            statusText: "",
            failureReason: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack || "" : "",
            startedAt,
            endedAt: new Date().toISOString()
          });
          throw error;
        });
    };
  }

  function patchXMLHttpRequest() {
    if (!OriginalXMLHttpRequest) {
      return;
    }

    const originalOpen = OriginalXMLHttpRequest.prototype.open;
    const originalSend = OriginalXMLHttpRequest.prototype.send;

    OriginalXMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__bugReportGeneratorRequest = {
        method: String(method || "GET").toUpperCase(),
        url: String(url || ""),
        startedAt: ""
      };
      return originalOpen.call(this, method, url, ...rest);
    };

    OriginalXMLHttpRequest.prototype.send = function patchedSend(...args) {
      const request = this.__bugReportGeneratorRequest || {
        method: "GET",
        url: "",
        startedAt: ""
      };
      request.startedAt = new Date().toISOString();
      this.__bugReportGeneratorRequest = request;

      const emitFailure = (reason) => {
        emit("network-error", {
          transport: "xmlhttprequest",
          requestUrl: request.url,
          method: request.method,
          status: this.status || 0,
          statusText: this.statusText || "",
          failureReason: reason,
          startedAt: request.startedAt,
          endedAt: new Date().toISOString()
        });
      };

      this.addEventListener("loadend", () => {
        if (this.status >= 400) {
          emitFailure(`HTTP ${this.status}`);
        }
      });
      this.addEventListener("error", () => emitFailure("Network error"));
      this.addEventListener("timeout", () => emitFailure("Request timeout"));
      this.addEventListener("abort", () => emitFailure("Request aborted"));

      return originalSend.apply(this, args);
    };
  }

  function patchHistory() {
    history.pushState = function patchedPushState(...args) {
      const result = originalPushState.apply(this, args);
      emitNavigation("pushState");
      return result;
    };

    history.replaceState = function patchedReplaceState(...args) {
      const result = originalReplaceState.apply(this, args);
      emitNavigation("replaceState");
      return result;
    };

    window.addEventListener("popstate", () => emitNavigation("popstate"));
    window.addEventListener("hashchange", () => emitNavigation("hashchange"));
  }

  function emitNavigation(source) {
    window.setTimeout(() => {
      emit("navigation", {
        source,
        url: window.location.href,
        title: document.title || ""
      });
    }, 0);
  }

  function normalizeFetchRequest(input, init) {
    if (input instanceof Request) {
      return {
        url: input.url,
        method: String(init?.method || input.method || "GET").toUpperCase()
      };
    }

    return {
      url: String(input || ""),
      method: String(init?.method || "GET").toUpperCase()
    };
  }

  function emit(category, detail) {
    window.dispatchEvent(
      new CustomEvent(EVENT_NAME, {
        detail: {
          id: crypto.randomUUID(),
          category,
          timestamp: new Date().toISOString(),
          pageUrl: window.location.href,
          title: document.title || "",
          ...detail
        }
      })
    );
  }

  function serializeValue(value) {
    if (value instanceof Error) {
      return `${value.name}: ${value.message}`;
    }

    if (value instanceof Element) {
      return trimSerialized(value.outerHTML);
    }

    if (typeof value === "string") {
      return trimSerialized(value);
    }

    if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
      return String(value);
    }

    try {
      return trimSerialized(JSON.stringify(value, getCircularReferenceReplacer()));
    } catch (_error) {
      return Object.prototype.toString.call(value);
    }
  }

  function trimSerialized(value) {
    return String(value || "").length > MAX_SERIALIZED_LENGTH
      ? `${String(value).slice(0, MAX_SERIALIZED_LENGTH)}...`
      : String(value || "");
  }

  function getCircularReferenceReplacer() {
    const seen = new WeakSet();

    return function replaceCircularReference(_key, value) {
      if (typeof value !== "object" || value === null) {
        return value;
      }

      if (seen.has(value)) {
        return "[Circular]";
      }

      seen.add(value);
      return value;
    };
  }
})();
