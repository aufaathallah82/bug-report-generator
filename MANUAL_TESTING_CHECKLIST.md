# Manual Testing Checklist

Target: `https://www.saucedemo.com/`

## Scenario

1. Open SauceDemo.
2. Start Bug Recording from the popup.
3. Click the username field.
4. Type username.
5. Click the password field.
6. Type password.
7. Click Login.
8. Confirm recording continues after navigation to the inventory page.
9. Click Add to Cart.
10. Open cart.
11. Refresh the page.
12. Confirm recording continues.
13. Close the popup.
14. Continue interacting with the website.
15. Reopen the popup.
16. Confirm recording status and event count are preserved.
17. Capture a manual screenshot.
18. Export JSON.
19. Export Markdown.
20. Confirm exported reports include actions before and after navigation.

## Regression Checks

- Start Recording then clicking the page does not stop recording.
- Popup close does not stop recording.
- Page refresh does not stop recording.
- URL change does not stop recording.
- Normal navigation does not stop recording.
- SPA navigation is recorded when detectable.
- Content script reinjection does not create duplicate event listeners.
- Exported report contains actions before and after navigation.
- Exported report contains console errors when present.
- Exported report contains console warnings when present.
- Exported report contains JavaScript runtime errors when present.
- Exported report contains unhandled promise rejections when present.
- Exported report contains network errors when detectable.
- Exported report contains screenshots when supported.
- Stop Recording only happens from explicit user action.
- Clear Session removes the active session and does not resurrect from page clicks.
