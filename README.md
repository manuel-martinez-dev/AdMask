# AdMask

Chrome extension (MV3) that detects ads missed by your adblocker and replaces them with a grey placeholder. Works alongside your adblocker — it handles network blocking, AdMask handles visual masking.

## Loading the extension

No build step required.

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `AdMask` folder
4. After changing a content script or popup: reload the extension from `chrome://extensions`, then refresh the target page
5. After changing `background.js`: click the service worker inspect link on the extension card

## How it works

The service worker (`background.js`) fetches EasyList and EasyPrivacy filter lists, parses them into CSS rules, snippet rules, and tracker domains, and writes per-hostname subsets to session storage on each navigation. Three content scripts consume that data:

| Script | Role |
|---|---|
| `tracker-guard.js` | Detects third-party trackers via EasyPrivacy; reports to popup, never blocks DOM |
| `content.js` | CSS selector matching, snippet marker pickup, placeholder replacement |
| `content-main.js` | ABP snippet rules that require page JS access (property interception, XPath, text matching) |

Detection runs in phases:

- **Phase 1** — EasyList CSS element hiding
- **Phase 2** — ABP snippet rules (hide-if-contains, property interception, XHR patching)
- **Phase 3** — DNR network blocking (not yet implemented)

## Popup

Click the extension icon to see hit counts per source (CSS, tracker, snippet), a scrollable hit list, and a **Download report** button that saves a `.md` summary of all detections on the current page.

## Bypass list

AdMask is completely inactive on these domains — no scanning:

- `facebook.com`
- `youtube.com`
- `google.com`

To add a domain, edit `BYPASS_HOSTNAMES` in `config.js`.

## Known issues

- **ABP + AdMask timing race** — sites using postMessage-style ad verification can occasionally trigger "adblock detected" when both extensions run together. The popup's hit list (selector + phase) is the starting point for isolating the cause.
- **Snippet rules run at document_idle** — `content-main.js` only affects scripts that execute after DOMContentLoaded. Synchronous `<head>` scripts are unaffected.
- **tracker-guard uses DOM-level detection** — EasyPrivacy was designed for network blocking. Some domains in the list serve both tracking and legitimate CDN assets. If a site breaks, check the popup for tracker hits and compare against the allowlist in `tracker-guard.js`.