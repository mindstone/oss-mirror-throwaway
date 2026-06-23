# @rebel/browser-extension

MV3 Chromium extension that connects browser tabs to Rebel through the Rebel App Bridge.
It powers browser-page tools and the embedded side-panel chat.

## Current invariants

- Embedded chat is scoped to the active tab/page. Switching to a tab with no scoped chat starts empty.
- The service worker owns active-scope resolution and broadcasts `scope-changed` events to the side panel.
- Browser DOM tools are bound to the Rebel conversation's registered tab context; they must not silently fall back to whatever tab is active later.
- Install uses the boot-token flow prepared by `rebel_bridge_prepare_install`; there is no user-facing code-entry path in the normal setup flow.

## Layout

```text
packages/browser-extension/
├── src/
│   ├── manifest.json
│   ├── background/serviceWorker.ts
│   ├── offscreen/offscreen.ts
│   ├── popup/popup.tsx
│   ├── sidepanel/
│   ├── hooks/useSidePanelChatController.ts
│   ├── lib/chatState.ts
│   ├── lib/chatScope.ts
│   ├── lib/intents.ts
│   └── lib/logger.ts
└── tests/unit/*.test.ts
```

## Development

```bash
cd packages/browser-extension
npm install
npm run typecheck
npm run test
npm run build
```

For manual side-loading, drag `packages/browser-extension/dist` into the browser extensions page with Developer Mode enabled. The normal Rebel setup flow prepares and reveals the managed extension folder for users via `rebel_bridge_prepare_install`.

## Plan docs

- [`docs/plans/260418_rebel_app_bridge_and_browser_extension.md`](../../docs/plans/260418_rebel_app_bridge_and_browser_extension.md)
- [`docs/plans/260425_embedded_office_browser_delight.md`](../../docs/plans/260425_embedded_office_browser_delight.md)
