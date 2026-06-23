# Meeting Bot Spike Tests

Minimal HTML files to validate core assumptions about Recall.ai's Output Media API before implementing interactive meeting bot features.

## Purpose

These tests validate critical assumptions that, if wrong, would require significant architecture changes:

| Test | What It Validates | Why It Matters |
|------|------------------|----------------|
| `static-avatar.html` | Output Media displays webpage at all | Foundation for everything else |
| `audio-autoplay.html` | Audio plays without user gesture | Required for TTS/voice features |
| `fragment-test.html` | URL fragment (`#token=`) preserved | Required for secure token passing |
| `audio-level.html` | `getUserMedia()` captures meeting audio | Required for audio-reactive avatar |

## How to Run

### 1. Deploy to Cloudflare Pages

```bash
# From repo root
cd tests/meeting-bot-spike

# Option A: Use wrangler (if you have it)
npx wrangler pages deploy . --project-name=rebel-spike-tests

# Option B: Manual upload via Cloudflare dashboard
# Go to Pages > Create > Direct Upload > Upload this folder
```

Note the deployment URL (e.g., `https://rebel-spike-tests.pages.dev`)

### 2. Create Test Bot

Use the Recall API or your existing bot creation flow. The key is setting the Output Media URL:

```json
{
  "meeting_url": "https://zoom.us/j/your-test-meeting",
  "bot_name": "Spike Test Bot",
  "output_media": {
    "camera": {
      "kind": "webpage",
      "config": {
        "url": "https://rebel-spike-tests.pages.dev/static-avatar.html?name=Josh"
      }
    }
  }
}
```

### 3. Run Each Test

#### Test 1: Static Avatar
- **URL:** `https://your-domain.pages.dev/static-avatar.html?name=Josh`
- **Expected:** Bot tile shows animated avatar with "Josh's Rebel" text
- **Pass if:** Avatar is visible in meeting

#### Test 2: Audio Autoplay
- **URL:** `https://your-domain.pages.dev/audio-autoplay.html`
- **Expected:** Beep sound plays automatically when bot joins
- **Pass if:** Sound is heard by meeting participants without any clicks
- **Fail if:** No sound, or browser console shows autoplay blocked

#### Test 3: URL Fragment Preservation
- **URL:** `https://your-domain.pages.dev/fragment-test.html#token=test123`
- **Expected:** Page displays "✓ FRAGMENT PRESERVED" and shows token value
- **Pass if:** Token `test123` is readable via `location.hash`
- **Fail if:** Fragment is stripped (common with some URL handlers)

#### Test 4: Audio Level Detection
- **URL:** `https://your-domain.pages.dev/audio-level.html`
- **Expected:** Avatar turns green when someone speaks in meeting
- **Pass if:** Audio level meter responds to meeting audio
- **Fail if:** `getUserMedia()` fails or no audio detected

## Expected Results

| Platform | Static Avatar | Audio Autoplay | Fragment | Audio Level |
|----------|---------------|----------------|----------|-------------|
| Zoom | ✅ Expected | ✅ Expected | ✅ Expected | ✅ Expected |
| Google Meet | ✅ Expected | ✅ Expected | ✅ Expected | ✅ Expected |
| MS Teams | ✅ Expected | ✅ Expected | ✅ Expected | ✅ Expected |
| Webex | ✅ Expected | ✅ Expected | ✅ Expected | ✅ Expected |
| Slack Huddles | ❌ Not supported | ❌ N/A | ❌ N/A | ❌ N/A |

## Fallback Plans

### If Audio Autoplay Fails
Research Recall's **Output Audio API** which provides raw PCM audio output:
- [Recall Output Audio Docs](https://docs.recall.ai/docs/output-audio-in-meetings)
- This bypasses browser autoplay restrictions entirely

### If Fragment Is Stripped
Options:
1. Pass token via query param (less secure, logged by servers)
2. Have avatar fetch token via authenticated API call after load
3. Embed token in a custom URL path segment

### If getUserMedia Fails
The avatar can still work in "passive mode":
1. No audio-reactive states (always idle or fixed animation)
2. Desktop controls state transitions via relay messages
3. Less responsive but still functional

## Debugging

Recall's bot Chromium may not expose DevTools directly. Options:

1. **Console logging:** All tests log to `console.log('[Spike Test] ...')` - check Recall's bot logs if available
2. **Visual indicators:** Tests display pass/fail status on the page itself
3. **Debug info:** Each test shows relevant data in a debug panel at bottom of page

## Next Steps After Validation

If all tests pass:
1. Proceed to Phase 1 (animated avatar with CSS animations)
2. Add pre-recorded voice clips (Phase 2a)
3. Implement WebSocket relay (Phase 2b)

If any test fails:
1. Document the failure in the planning doc
2. Research the fallback approach
3. Update architecture if needed before implementation
