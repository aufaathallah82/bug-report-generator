# BugReportGenerator

Plain JavaScript Chrome Extension forked from `AI-Test-Automation-Generator`.

The project keeps the original recorder lifecycle pattern: the popup only starts/stops commands, while the content script keeps page listeners alive after the popup closes. BugReportGenerator adds a background/storage layer so an active recording can survive service worker restarts, page reloads, URL changes, normal navigation, and detectable SPA navigation.

## Load Unpacked

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this repository's root folder.

No Vite, React, TypeScript build, npm build, or bundler is required for the extension entry files.

## Architecture

- `manifest.json` - MV3 extension manifest.
- `background.js` - service worker, canonical recording state, tab lifecycle, screenshot capture, JSON/Markdown export.
- `content.js` - idempotent page recorder, action capture, locator generation, DOM context, SPA URL detection, page evidence bridge.
- `pageLogger.js` - page-world bridge for `console.warn`, `console.error`, runtime errors, unhandled rejections, `fetch`, `XMLHttpRequest`, and History API navigation.
- `popup.html`, `popup.js`, `styles.css` - popup controller UI.
- `examples/` - example JSON and Markdown bug report exports.
- `MANUAL_TESTING_CHECKLIST.md` - SauceDemo regression checklist.

Legacy Vite/TypeScript files may still exist in the repository history, but the active load-unpacked extension is the root plain-JS architecture above.

## Preserved Recording Lifecycle

- Recording state is stored in `chrome.storage.local` under `bugReportGenerator.recordingState`.
- The popup reads state from storage/background and never owns the session in popup memory.
- The background service worker creates, stops, clears, resumes, and exports sessions.
- The content script installs capture listeners only once per page context and removes/replaces old listeners on reinjection.
- Tab updates and `webNavigation` events trigger content-script reinjection/resume when recording is active.
- Content-side SPA detection uses History API events from `pageLogger.js`, `popstate`, `hashchange`, and a URL polling fallback.
- Recording stops only from explicit popup commands: `Stop Recording` or `Clear Session`.

## Captured Data

- User actions: click, input, change, submit, Enter key, Tab key, navigation, reload, URL change, and detectable SPA navigation.
- Page/session context: current URL, title, timestamp, tab ID, session ID, user agent, viewport, screen, platform, language, timezone, visited pages, and page-load snapshots.
- Element context: tag, visible text, accessible label, placeholder, safe value, attributes, DOM path, nearby text, parent context, locator candidates, best locator, score, reason, uniqueness, and stability notes.
- Evidence: console warnings/errors, runtime errors, unhandled promise rejections, failed resource loads, failed `fetch`/XHR requests, HTTP error status responses, last action before error, and screenshots.

## Locator Strategy

Locator candidates are generated for interacted elements using:

- `data-testid`, `data-test`, `data-qa`, `data-cy`
- stable `id`
- `name`
- `aria-label`
- role plus accessible name
- visible text
- placeholder
- label-based locator
- CSS selector
- relative XPath
- absolute XPath fallback
- nearby text/context

Scoring prefers stable test attributes and readable semantic locators. It penalizes generated IDs/classes, long selectors, absolute XPath, index-heavy selectors, and brittle DOM paths.

## Exports

The popup can export:

- JSON: `bug-report-session-YYYYMMDD-HHMMSS.json`
- Markdown: `bug-report-YYYYMMDD-HHMMSS.md`

Exports include project metadata, source project metadata, session/environment data, visited pages, reproduction steps, actions, locator hints, console/runtime/promise/network evidence, screenshots, AI notes, severity/priority suggestions, and raw events.

## SauceDemo Manual Flow

Use `https://www.saucedemo.com/` for manual verification:

1. Start Bug Recording.
2. Enter username and password.
3. Click Login.
4. Confirm recording continues on the inventory page.
5. Add an item to the cart.
6. Open cart.
7. Refresh the page.
8. Confirm recording continues.
9. Close and reopen the popup.
10. Confirm status and counts persist.
11. Export JSON and Markdown.

See `MANUAL_TESTING_CHECKLIST.md` for the full regression checklist.
