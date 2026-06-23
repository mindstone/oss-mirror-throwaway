---
description: "Playwright screenshot capture guide for product docs — packaging, commands, env setup, output naming, captured surfaces"
last_updated: "2026-05-22"
---

# Screenshots

> **Note:** This doc covers **Playwright-based screenshot capture** for product documentation. For the **global voice hotkey screenshot feature** (which captures what the user is looking at when they press the hotkey), see [GLOBAL_HOTKEY.md](./GLOBAL_HOTKEY.md).

> **Note:** Screenshot capture is only useful if the app instance has realistic-looking data (conversations, spaces, automations, etc.). Consider populating with demo content first.

Guidelines for capturing and organizing product screenshots.

## See Also

- [TESTING_E2E.md](./TESTING_E2E.md) - Full E2E testing documentation (screenshots share the same infrastructure)
- [CHANGELOG_UPDATE_PROCESS.md](./CHANGELOG_UPDATE_PROCESS.md) - Screenshots can accompany changelog entries for releases
- `tests/e2e/screenshots.spec.ts` - Screenshot capture implementation
- `playwright.config.ts` - Project configuration
- `rebel-system/help-for-humans/changelog.md` - User-facing feature history

## Quick Start

```bash
# 1. Package the app (required)
npm run package

# 2. For basic UI screenshots (no API key needed):
npm run capture:screenshots

# 3. For authenticated features (conversations with agent responses):
source .env.test && npm run capture:screenshots

# Screenshots saved directly to: docs/screenshots/
# Filenames include timestamp: yyMMdd_HHmm_description.png
```

## Storage Location

Screenshots are saved directly to `docs/screenshots/` with automatic timestamped naming:

```
yyMMdd_HHmm_[description].png
```

Examples:
- `260106_1423_landing-spark.png`
- `260106_1423_settings-usage.png`
- `260106_1423_conversation-with-response.png`

No manual renaming or moving is required.

## Screenshot Capture Commands

| Command | What it captures | API keys needed? |
|---------|------------------|------------------|
| `npm run capture:screenshots` | All UI surfaces in guest mode | No |
| `source .env.test && npm run capture:screenshots` | All UI + conversation screenshots | Yes |

**Note:** Screenshot capture is separated from the E2E test suite. Running `npm run test:e2e` does NOT run screenshot capture.

## Environment Setup (.env.test)

For authenticated screenshots (conversations with agent responses), create `.env.test`:

```bash
# Required for conversation screenshots
TEST_CLAUDE_API_KEY=sk-ant-...

# One of these for voice (optional but recommended)
TEST_OPENAI_API_KEY=sk-...
# OR
TEST_ELEVENLABS_API_KEY=...
```

The file is gitignored and should never be committed. See [TESTING_E2E.md](./TESTING_E2E.md#environment-setup) for detailed setup instructions.

## What Gets Captured

### Guest Mode (always runs)
- Landing page with The Spark
- Empty conversation view
- Use Cases panel
- Automations panel
- Inbox panel
- Library panel
- Settings tabs (General, Connectors, Usage, Safety, Voice)
- Sidebar history
- Skills browser
- Library `Show: Memory` lens
- What's New dialog
- Scratchpad dialog

### Authenticated Mode (requires API keys)
- Conversation with agent response
- Thinking indicator during agent turn

## Adding New Screenshots

Edit `tests/e2e/screenshots.spec.ts`:

```typescript
// In the appropriate test.describe block:

test('Capture my new feature', async () => {
  // Navigate to the feature
  await window.locator('[data-testid="some-button"]').click();
  await window.waitForTimeout(500);

  // Optional: highlight an element before capture
  await window.evaluate(() => {
    const el = document.querySelector('[data-testid="highlight-me"]');
    if (el) el.style.outline = '3px solid #ff6b00';
  });

  // Capture (timestamp added automatically)
  await screenshot('descriptive-name');

  // Optional: remove highlight
  await window.evaluate(() => {
    const el = document.querySelector('[data-testid="highlight-me"]');
    if (el) el.style.outline = '';
  });
});
```

### Element Highlighting

To draw attention to specific UI elements:

```typescript
// Add a highlight before screenshot
await window.evaluate(() => {
  const el = document.querySelector('.my-element');
  if (el) {
    el.style.outline = '3px solid #ff6b00';
    el.style.outlineOffset = '2px';
  }
});

await screenshot('feature-highlighted');

// Clean up
await window.evaluate(() => {
  const el = document.querySelector('.my-element');
  if (el) el.style.outline = '';
});
```

## Manual Screenshot Tips

When capturing screenshots manually:

1. **Use a clean profile** - Start with fresh userData or use guest mode
2. **Consistent window size** - 1280x800 or 1440x900 are good defaults
3. **Light and dark mode** - Capture both if the feature has visual differences
4. **Hide sensitive data** - Use demo/test data, blur API keys if visible
5. **Crop thoughtfully** - Include enough context but focus on the feature

### Quick Manual Capture

```bash
# Launch app with isolated userData (won't affect your real settings)
REBEL_TEST_USER_DATA_DIR=auto npm run dev
```

Then use system screenshot tools (Cmd+Shift+4 on macOS).

## Screenshot Checklist for Releases

Before major releases, capture screenshots of:

- [ ] Landing page / The Spark
- [ ] Conversation view (with messages)
- [ ] Library panel (`Show` chips + `View as` chips)
- [ ] Automations panel
- [ ] Inbox panel
- [ ] Settings dialog (General, Connectors, Usage, Safety, Voice)
- [ ] Scratchpad dialog
- [ ] What's New dialog
- [ ] Any new/redesigned features from the changelog

> Follow-up note (Library lens unification): recapture Library screenshots whenever `Show`/`View as` chip labels or layouts change so visual docs stay aligned with the current lens UI.

## Video Recording (Future)

Playwright supports video recording via `video: 'on'` in config. Currently not enabled by default, but can be added for specific captures:

```typescript
// In playwright.config.ts, for the screenshots project:
use: {
  video: 'on' // Records .webm files
}
```

Videos require ffmpeg to convert to mp4 for sharing.

## Architecture Notes

Screenshot capture uses Playwright's `screenshots` project (configured in `playwright.config.ts`). This is deliberately separated from the `e2e` project so screenshots don't run during normal test runs.

- `npm run test:e2e` runs project `e2e` (excludes screenshots)
- `npm run capture:screenshots` runs project `screenshots` (only screenshots)

This separation uses Playwright's project feature with `testIgnore`/`testMatch` patterns rather than `test.skip()`, making the intent explicit in config.
