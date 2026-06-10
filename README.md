# Bug Report Generator

Chrome Extension MV3 MVP for generating structured bug reports from the active tab.

## Features

- Captures the current tab URL and page title.
- Captures a screenshot of the visible active tab.
- Captures browser and page environment information.
- Captures page `console.error`, runtime errors, unhandled promise rejections, and resource load failures.
- Generates a structured bug report with title, description, reproduction steps, expected result, actual result, and environment information.
- Stores reports locally in `chrome.storage.local`; no cloud database or remote API is used.

## Development

```bash
npm install
npm run build
```

For watch mode while developing:

```bash
npm run dev
```

## Load in Chrome

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select `\IdeaProjects\BugReportGenerator\dist`, the`dist` folder.

## Notes

- Screenshots and reports are stored locally only.
- The preview `Copy Markdown` button copies the currently shown report.
- Clicking a saved report copies that saved report's Markdown and shows `Markdown copied to clipboard.` in the popup status.
- Chrome internal pages such as `chrome://extensions` restrict extension injection and screenshot capture, so reports for those pages may include capture warnings.
- Console capture starts after the content script/page logger is injected; errors emitted before injection may not be available.
