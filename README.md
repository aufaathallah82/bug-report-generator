# Bug Report Generator

Chrome Extension MV3 tool for generating structured bug reports from the active tab.

## Features

- Starts and stops a local user-action capture session from the popup.
- Records clicks, typed input/change events, form submits, and best-effort navigation changes.
- Keeps recording after the popup closes by storing capture state and actions in `chrome.storage.local`.
- Merges repeated input events on the same field into one readable step.
- Redacts sensitive field values for password fields and fields whose name, ID, placeholder, aria label, or autocomplete contains `password`, `token`, `secret`, `api_key`, `authorization`, or `credential`.
- Shows an editable action timeline after capture stops.
- Lets users edit, delete, add, and reorder steps with Move Up and Move Down controls.
- Adds manual bug context fields for Bug Summary, Expected Result, Actual Result, and Additional Notes.
- Captures the current tab URL, browser/page environment, screenshot, console errors, runtime errors, unhandled promise rejections, and resource load failures.
- Generates a structured report locally from the edited steps and manual context.
- Stores reports locally in `chrome.storage.local`; no cloud database or remote API is used.

## Main Flow

1. Click `Start Capture` in the extension popup.
2. Reproduce the bug in the active tab.
3. Open the popup again and click `Stop Capture`.
4. Edit the generated action timeline.
5. Fill in Bug Summary, Expected Result, Actual Result, and Additional Notes.
6. Click `Generate Bug Report`.
7. Use `Copy Markdown` from the report preview when needed.

## Development

```bash
npm install
npm run build
```

The build writes stable extension entry files to `dist/background.js`, `dist/contentScript.js`, and `dist/pageLogger.js`. `npm run build` also verifies that `dist/manifest.json` exists, required MV3 permissions are present, and the content script file referenced by the background exists in `dist`.

For watch mode while developing:

```bash
npm run dev
```

## Load or Reload in Chrome

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable `Developer mode`.
4. For first install, click `Load unpacked` and select `C:\Users\User\IdeaProjects\BugReportGenerator\dist`.
5. For later changes, click `Reload` on the Bug Report Generator extension card.
6. Open a normal website tab.
7. Click the extension icon and click `Start Capture`.
8. Interact with the webpage. The popup may close; recording should continue.
9. Open the popup again. It should show `Recording`.
10. Click `Refresh timeline` to view saved actions while recording, or click `Stop Capture` to edit the saved timeline.

Quick verification flow:

1. Reload the extension in `chrome://extensions`.
2. Open `https://example.com`.
3. Refresh the page.
4. Click `Start Capture`.
5. Click or type on the page.
6. Open the popup again.
7. Check `Action Timeline`.

### Test A - Popup Closes

1. Run `npm run build`.
2. Reload the extension in `chrome://extensions`.
3. Open `https://example.com`.
4. Click the extension icon and click `Start Capture`.
5. Click on the webpage so the popup closes.
6. Interact with the page.
7. Open the popup again.
8. Verify actions are still recorded.

### Test B - Navigation

1. Start capture on a normal website.
2. Click a link or change URL in the same tab.
3. Wait for page load.
4. Continue clicking or typing.
5. Open the popup.
6. Verify actions before and after navigation are both present.
7. Verify a navigation step appears in the timeline.

### Test C - Stop

1. Click `Stop Capture`.
2. Interact with the page.
3. Open the popup.
4. Verify no new actions are recorded after stopping.

## Debugging Capture

Use `chrome://extensions` -> Bug Report Generator -> `Inspect views` to inspect the service worker and popup. Use the page DevTools console to inspect content-script logs.

Useful log markers:

- `[BugReportGenerator][popup] START_CAPTURE sent`
- `[BugReportGenerator][background] START_CAPTURE sent`
- `[BugReportGenerator][content] START_CAPTURE received`
- `[BugReportGenerator][content] action recorded`
- `[BugReportGenerator][content] actions saved to storage`
- `[BugReportGenerator][content] STOP_CAPTURE received`

## Notes

- Everything remains local-first.
- Screenshots, capture sessions, and reports are stored only in local Chrome extension storage.
- The preview `Copy Markdown` button copies the currently shown report.
- Clicking a saved report copies that saved report's structured report text and shows `Markdown copied to clipboard.` in the popup status.
- Chrome internal pages such as `chrome://extensions` restrict extension injection and screenshot capture, so reports for those pages may include capture warnings.
- Capture cannot start on unsupported pages such as `chrome://`, `edge://`, `about:`, `chrome-extension://`, or the Chrome Web Store.
- Console capture starts after the content script/page logger is injected; errors emitted before injection may not be available.
