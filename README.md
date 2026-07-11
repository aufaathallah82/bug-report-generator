# BugReportGenerator

**BugReportGenerator** is a plain JavaScript Chrome Extension that helps non-technical users, QA testers, and developers turn testing activity into structured bug evidence and exportable bug reports.

This project was created from a real QA workflow problem: in some projects, bugs or findings can be skipped or poorly documented because team members may struggle to write clear, complete, and reproducible bug reports. BugReportGenerator reduces that friction by recording user actions, collecting page evidence, capturing environment details, and exporting the result as JSON, Markdown, or TXT.

The project is forked from `AI-Test-Automation-Generator` and keeps its proven recorder lifecycle pattern: the popup only starts and stops recording commands, while the content script keeps page listeners alive after the popup closes.

BugReportGenerator extends that foundation with a background/storage layer so an active recording can survive service worker restarts, page reloads, URL changes, normal navigation, and detectable SPA navigation.

---

## Purpose

BugReportGenerator is designed to help with:

* Turning manual testing sessions into reproducible bug reports.
* Helping non-technical users report bugs with clearer evidence.
* Supporting QA teams who need consistent steps, screenshots, logs, and environment data.
* Reducing missing or incomplete bug reports when QA resources are limited.
* Creating AI-ready QA evidence that can later be used for automated bug report generation or test automation workflows.

---

## Key Features

* Start and stop browser-based bug recording.
* Record user actions such as clicks, input changes, form submits, Enter/Tab keys, navigation, reloads, and SPA URL changes.
* Keep recording even after the extension popup closes.
* Resume recording after page reloads, URL changes, and navigation.
* Capture console warnings/errors, runtime errors, unhandled promise rejections, failed resources, failed fetch/XHR requests, and HTTP error responses.
* Capture screenshots automatically when recording stops.
* Store session state locally using `chrome.storage.local`.
* Add bug report metadata:

    * Bug title
    * Description
    * Expected result
    * Actual result
    * Additional notes
* Capture device and environment information.
* Export reports as:

    * JSON
    * Markdown
    * TXT
    * DOCX
* Include locator hints and DOM context for recorded elements.
* Provide AI-ready QA evidence for future bug analysis or automation workflows.

---

## Load Unpacked

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this repository's root folder.

No Vite, React, TypeScript build, or bundler is required for the active extension entry files.

`npm run build` is available as a lightweight validation step for the root extension files.

```bash
npm install
npm run build
```

---

## Architecture

The active extension uses a root-level plain JavaScript architecture:

* `manifest.json` - MV3 extension manifest.
* `background.js` - service worker, canonical recording state, tab lifecycle handling, automatic stop screenshot capture, save, JSON/Markdown/TXT export.
* `content.js` - idempotent page recorder, action capture, locator generation, DOM context, SPA URL detection, and page evidence bridge.
* `pageLogger.js` - page-world bridge for `console.warn`, `console.error`, runtime errors, unhandled rejections, `fetch`, `XMLHttpRequest`, and History API navigation.
* `popup.html`, `popup.js`, `styles.css` - popup controller UI.
* `scripts/validate-extension.js` - npm build validation for manifest and JavaScript syntax.
* `examples/` - example JSON and Markdown bug report exports.
* `MANUAL_TESTING_CHECKLIST.md` - SauceDemo regression checklist.

Legacy Vite/TypeScript files may still exist in the repository history, but the active load-unpacked extension is the root plain-JS architecture above.

---

## Preserved Recording Lifecycle

BugReportGenerator keeps the working recording lifecycle from `AI-Test-Automation-Generator`.

* Recording state is stored in `chrome.storage.local` under `bugReportGenerator.recordingState`.
* The popup reads state from storage/background and never owns the recording session in popup memory.
* The background service worker creates, stops, clears, resumes, saves, and exports sessions.
* The content script installs capture listeners only once per page context and removes/replaces old listeners on reinjection.
* Tab updates and `webNavigation` events trigger content-script reinjection/resume when recording is active.
* Content-side SPA detection uses History API events from `pageLogger.js`, `popstate`, `hashchange`, and a URL polling fallback.
* Recording stops only from explicit popup commands:

    * `Stop Recording`
    * `Clear Session`

The popup can close safely while recording continues in the page context.

---

## Captured Data

BugReportGenerator can capture the following evidence during a recording session.

### User Actions

* Click
* Input
* Change
* Submit
* Enter key
* Tab key
* Navigation
* Reload
* URL change
* Detectable SPA navigation

### Page and Session Context

* Current URL
* Page title
* Timestamp
* Tab ID
* Session ID
* User agent
* Viewport size
* Screen size
* Platform
* Language
* Timezone
* Visited pages
* Page-load snapshots

### Element Context

For interacted elements, the extension captures:

* Tag
* Visible text
* Accessible label
* Placeholder
* Safe value
* Attributes
* DOM path
* Nearby text
* Parent context
* Locator candidates
* Best locator
* Locator score
* Locator reason
* Uniqueness notes
* Stability notes

### Runtime Evidence

* Console warnings
* Console errors
* Runtime errors
* Unhandled promise rejections
* Failed resource loads
* Failed `fetch` requests
* Failed XHR requests
* HTTP error status responses
* Last action before error
* Screenshots

---

## Locator Strategy

Locator candidates are generated for interacted elements using:

* `data-testid`
* `data-test`
* `data-qa`
* `data-cy`
* Stable `id`
* `name`
* `aria-label`
* Role plus accessible name
* Visible text
* Placeholder
* Label-based locator
* CSS selector
* Relative XPath
* Absolute XPath fallback
* Nearby text/context

Scoring prefers stable test attributes and readable semantic locators.

It penalizes:

* Generated IDs/classes
* Long selectors
* Absolute XPath
* Index-heavy selectors
* Brittle DOM paths

---

## Bug Report Metadata

Each session can include editable bug report fields:

* Bug title
* Description
* Expected result
* Actual result
* Additional notes

These fields are saved locally with the current session and included in exports.

---

## Environment Information

Exports include device and environment details such as:

* Page URL
* Browser/user agent
* OS/platform
* Screen size
* Viewport size
* Device pixel ratio
* Language
* Timezone
* Timestamp
* Extension version when available

This helps developers reproduce bugs more accurately.

---

## Exports

The popup can export the recorded session as:

* JSON: `bug-report-[sessionId].json`
* Markdown: `bug-report-[sessionId].md`
* TXT: `bug-report-[sessionId].txt`

Exports can include:

* Project metadata
* Bug report metadata
* Source project metadata
* Session/environment data
* Visited pages
* Reproduction steps
* Recorded actions
* Locator hints
* Console errors
* Runtime errors
* Promise rejection evidence
* Network evidence
* Screenshots
* AI notes
* Severity/priority suggestions
* Raw events

---

## Example Markdown Export Structure

```markdown
# Bug Report: [Bug Title]

## Description
...

## Steps to Reproduce
1. Clicked Username field
2. Typed "standard_user" into Username field
3. Clicked Password field
4. Typed [REDACTED] into Password field
5. Clicked Login button

## Expected Result
...

## Actual Result
...

## Environment
- URL:
- Browser:
- User Agent:
- OS/Platform:
- Screen Size:
- Viewport:
- Language:
- Timezone:
- Timestamp:

## Console Errors
...

## Network Errors
...

## Screenshots
- Screenshot count:
- Captured at:

## Session
- Session ID:
- Started At:
- Stopped At:
```

---

## SauceDemo Manual Flow

Use `https://www.saucedemo.com/` for manual verification.

1. Start Bug Recording.
2. Enter username.
3. Enter password.
4. Click Login.
5. Confirm recording continues on the inventory page.
6. Add an item to the cart.
7. Open the cart.
8. Refresh the page.
9. Confirm recording continues.
10. Close and reopen the popup.
11. Confirm status and counts persist.
12. Stop recording.
13. Confirm screenshot is captured automatically.
14. Fill bug report metadata.
15. Export JSON, Markdown, and TXT.

See `MANUAL_TESTING_CHECKLIST.md` for the full regression checklist.

---

## Expected SauceDemo Timeline

Example expected recorded steps:

1. Clicked Username field
2. Typed `standard_user` into Username field
3. Clicked Password field
4. Typed `[REDACTED]` into Password field
5. Clicked Login button
6. Navigated to `https://www.saucedemo.com/inventory.html`
7. Clicked Add to Cart button
8. Opened Cart
9. Reloaded page
10. Continued recording after reload

---

## Development Notes

For local validation:

```bash
npm run build
```

This validates the root extension files and checks basic JavaScript syntax.

For manual testing:

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Reload the unpacked extension.
4. Refresh the test website tab.
5. Start a recording session.
6. Perform actions.
7. Stop recording.
8. Export the report.

---

## Roadmap

Possible future improvements:

* AI-generated bug summary.
* AI-generated severity and priority suggestions.
* Jira/GitHub/Linear issue export.
* Better screenshot preview and attachment handling.
* Video or session replay support.
* Team sharing workflow.
* Report templates for different QA workflows.
* Chrome Web Store packaging.
* Integration with `AI-Test-Automation-Generator` exports for automated test generation.

---

## Project Relationship

This project is related to:

### AI-Test-Automation-Generator

A Chrome Extension that scans DOM elements, records user interactions/dynamic UI, rates locator quality, and exports an AI-ready JSON model for test automation generation.

### BugReportGenerator

A Chrome Extension that records manual testing activity, captures QA evidence, and exports structured bug reports.

Together, these projects explore a workflow where manual testing evidence can support both:

1. Better bug reporting.
2. Future test automation generation.

```text
Manual Testing
↓
BugReportGenerator
↓
Structured Bug Evidence
↓
Bug Report / QA Documentation

Manual Testing + DOM Scanning
↓
AI-Test-Automation-Generator
↓
AI-ready Locator Model
↓
Automated Test Generation
```

---

## Status

This project is currently an experimental local-first Chrome Extension prototype.

The current focus is:

* Stable recording lifecycle.
* Reliable local evidence capture.
* Clear exportable bug reports.
* Portfolio-ready QA automation tooling.
