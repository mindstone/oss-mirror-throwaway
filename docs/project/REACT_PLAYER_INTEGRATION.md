---
description: "Deep-dive reference for react-player v3 integration — media embeds, API changes, provider support, troubleshooting"
last_updated: "2026-05-14"
---

# react-player Integration

## Overview

Mindstone Rebel uses [react-player](https://github.com/cookpete/react-player) v3.x to embed multimedia content (YouTube, Vimeo, Twitch, TikTok, Spotify, SoundCloud, and direct video/audio files) directly in conversation messages. This creates a richer experience when agents return media URLs from web searches or MCPs.


## See Also

- [react-player GitHub](https://github.com/cookpete/react-player) — Official repository (now maintained by Mux)
- [react-player v3 Migration Guide](https://github.com/cookpete/react-player/blob/master/MIGRATING.md) — **Critical**: Documents breaking changes from v2 to v3
- [react-player npm](https://www.npmjs.com/package/react-player) — Package info and version history
- [react-player Demo](https://cookpete.github.io/react-player/) — Interactive demo of supported providers
- `src/renderer/components/MediaEmbed.tsx` — Our wrapper component
- `src/renderer/utils/youtubeUtils.ts` — URL detection utilities
- `src/renderer/components/MessageMarkdown.tsx` — Integration point (paragraph-level detection)
- `docs/plans/finished/251226_react_player_multimedia_embed.md` — Original implementation plan


## Critical: v3.x API Changes

**react-player v3 is NOT backwards compatible with v2.** The most commonly referenced documentation online (blog posts, Stack Overflow, tutorials) refers to v2 API.

### Prop Renames (v2 → v3)

| v2 Prop | v3 Prop | Notes |
|---------|---------|-------|
| `url` | `src` | **Most common gotcha** — online docs show `url` but v3 uses `src` |
| `playsinline` | `playsInline` | camelCase to match HTMLMediaElement |
| `progressInterval` | *removed* | Deprecated |
| `stopOnUnmount` | *removed* | Deprecated |
| `wrapper` | `wrapper` | Now `undefined` by default (was `div`) |

### Callback Renames (v2 → v3)

| v2 Callback | v3 Callback |
|-------------|-------------|
| `onProgress` | `onTimeUpdate` and `onProgress` |
| `onDuration` | `onDurationChange` |
| `onPlaybackRateChange` | `onRateChange` |
| `onSeek` | `onSeeking` and `onSeeked` |
| `onBuffer` | `onWaiting` |
| `onBufferEnd` | `onPlaying` |
| `onEnablePIP` | `onEnterPictureInPicture` |
| `onDisablePIP` | `onLeavePictureInPicture` |

### Provider Support in v3

Not all providers from v2 are supported in v3 yet. As of December 2025:

**Supported in v3:**
- YouTube
- Vimeo
- Mux
- Wistia
- TikTok
- Direct video/audio files (mp4, webm, mp3, etc.)
- HLS streams (.m3u8)
- DASH streams (.mpd)

**Not yet supported in v3 (use v2 if needed):**
- Dailymotion
- SoundCloud
- Streamable
- Twitch
- Facebook
- Mixcloud
- Kaltura


## Our Implementation

### Component: `MediaEmbed.tsx`

Located at `src/renderer/components/MediaEmbed.tsx`:

```tsx
import ReactPlayer from 'react-player';

<ReactPlayer
  src={url}           // NOT url={url} — this is v3!
  width="100%"
  height="100%"
  controls
  onError={handleError}
/>
```

Key features:
- **Error fallback**: Falls back to plain `<a>` link if player errors (handles CSP, offline, etc.)
- **Audio detection**: Uses shorter container height for Spotify/SoundCloud/audio files
- **Memoized**: Uses `React.memo` for performance

### URL Detection: `youtubeUtils.ts`

Located at `src/renderer/utils/youtubeUtils.ts`:

- Uses regex patterns from react-player's internal `patterns.js` for consistency
- `isYouTubeUrl()`, `isVimeoUrl()`, `isTwitchUrl()`, etc.
- `isEmbeddableMediaUrl()` — aggregate check for all supported providers
- `getMediaType()` — returns provider name for styling decisions

### Integration: `MessageMarkdown.tsx`

Paragraph-level detection in the `p` component renderer:

1. Check if paragraph has exactly 1 child
2. Verify child is a link element (via `node.tagName === 'a'` or `href` prop)
3. Confirm it's an http/https URL (security: reject internal protocols like `rebel://`, `rebel://library/`, `library://`, `workspace://`, `file://`)
4. Check link text equals href (bare URL only, not `[custom text](url)`)
5. Verify URL matches `isEmbeddableMediaUrl()`
6. Return `<MediaEmbed>` instead of `<p>`


## Common Gotchas

### 1. Using `url` prop instead of `src`

**Wrong (v2 API):**
```tsx
<ReactPlayer url="https://youtube.com/watch?v=..." />
```

**Correct (v3 API):**
```tsx
<ReactPlayer src="https://youtube.com/watch?v=..." />
```

### 2. YouTube postMessage origin errors

In development (localhost), you may see console warnings:
```
Failed to execute 'postMessage' on 'DOMWindow': The target origin ('https://www.youtube.com') does not match...
```

This is a known issue with YouTube's iframe API in non-https contexts. Options:
- **Ignore in dev**: Videos still play despite the warning
- **Add origin config**: `config={{ youtube: { origin: window.location.origin } }}` (only for http/https origins)

### 3. Autoplay blocked by browser

Modern browsers block autoplay unless:
- Video is muted (`muted={true}`)
- User has previously interacted with the domain

We don't autoplay embeds, so this isn't an issue for our use case.

### 4. Custom `a` renderer breaks type detection

When using react-markdown with a custom `a` component, `child.type === 'a'` won't work because the type is the custom component function, not the string `'a'`. Instead, check:
```tsx
const isLink = childProps.node?.tagName === 'a' || typeof childProps.href === 'string';
```


## Testing

Unit tests are in `src/renderer/components/__tests__/MediaEmbed.test.ts`:
- Tests URL detection utilities (pure functions)
- Does NOT test component rendering (repo uses Vitest with `environment: 'node'`, no jsdom)

To run:
```bash
npm test -- --run src/renderer/components/__tests__/MediaEmbed.test.ts
```


## STOP — YouTube Embeds Require the Localhost Wrapper Server

> **If you are adding YouTube video playback anywhere in the app, you MUST use the localhost wrapper server (`tutorialPlayerServer.ts`) via IPC. Do NOT use ReactPlayer, raw `<iframe>`, or any other mechanism to embed YouTube directly. It will work in dev mode but break in production builds.**

This is a fundamental Electron limitation, not a bug we can fix with iframe attributes or configuration.

### The Problem

YouTube embeds fail with "Error 153: Video playback configuration error" in production Electron builds but work in development mode.

**Root Cause:** YouTube iframe embeds require a valid HTTP `Referer` header. In production, Electron loads the app from the `file://` protocol (via `mainWindow.loadFile()`), and **`file://` protocol fundamentally cannot send valid Referer headers** — this is a browser security limitation, not something that can be fixed with iframe attributes.

### Why Standard Fixes Don't Work

| Attempted Fix | Why It Fails |
|---------------|--------------|
| `referrerPolicy="strict-origin-when-cross-origin"` | `file://` has no origin to send |
| `origin=https://www.youtube-nocookie.com` parameter | Technically incorrect; origin should match the embedding page |
| Using `youtube-nocookie.com` domain | Same underlying Referer issue |
| `enablejsapi=1` parameter | Addresses different concern (postMessage API) |
| Using react-player library | Same fundamental issue — it still creates an iframe from `file://` |

### Our Solution: Localhost HTTP Wrapper Server

Since the app page is served from `file://` and cannot send Referer headers, we serve a small wrapper HTML page from `http://127.0.0.1` that embeds YouTube. The wrapper CAN send proper Referer headers because it's served over HTTP.

**Implementation:**
1. **`tutorialPlayerServer.ts`** — Lightweight localhost HTTP server (port 18770)
2. **Wrapper page** — Minimal HTML that embeds YouTube with correct `origin` parameter
3. **IPC channel** — `app:get-tutorial-player-url` returns the localhost URL for a video ID
4. **Security** — Auth token per session, validates video ID format, localhost-only binding

**Flow (used by both TutorialsModal and MediaEmbed):**
```
Any component → window.appApi.getTutorialPlayerUrl(youtubeId)
                          ↓ IPC
             tutorialPlayerServer → generates wrapper URL
                          ↓
             http://127.0.0.1:18770/tutorial-player?videoId=xxx&token=yyy
                          ↓
             Wrapper HTML embeds YouTube with proper Referer headers
```

**Files:**
- `src/main/services/tutorialPlayerServer.ts` — The localhost server
- `src/main/ipc/appHandlers.ts` — IPC handler for `app:get-tutorial-player-url`
- `src/main/index.ts` — Server startup and `will-frame-navigate` exception
- `src/shared/ipc/channels/app.ts` — IPC channel definition

**Why not serve the entire app from localhost?** This would be a major architectural change affecting all features. The localhost wrapper is surgical — it only affects YouTube embeds (tutorials and chat).

### Alternative Approaches (Not Implemented)

1. **Serve entire app from `http://127.0.0.1`** — Works but requires significant changes to window loading, resource paths, and CSP configuration
2. **Separate BrowserWindow for videos** — Opens YouTube in a dedicated window (not embedded)
3. **"Open on YouTube" fallback only** — Already implemented as fallback; poor UX if used as primary

### Testing in Production

1. Run `npm run build` or `npm run package`
2. Open the packaged app (not `npm run dev`)
3. **Tutorials:** Navigate to Help → Tutorials → verify videos load and autoplay
4. **Chat embeds:** Paste a bare YouTube URL on its own line in a conversation → verify the video loads (without autoplay)

### Related Files

- `src/renderer/features/tutorials/components/TutorialsModal.tsx` — Tutorial modal UI
- `src/shared/config/tutorialVideos.ts` — Video configuration

### Current Consumers

The localhost wrapper is used by two components:

| Consumer | File | Autoplay | Notes |
|----------|------|----------|-------|
| **TutorialsModal** | `src/renderer/features/tutorials/components/TutorialsModal.tsx` | Yes (`&autoplay=1`) | Modal for browsing tutorial videos |
| **MediaEmbed** | `src/renderer/components/MediaEmbed.tsx` | No (default) | Inline YouTube embeds in chat conversations |

`MediaEmbed` detects YouTube URLs in production (`!import.meta.env.DEV`), extracts the video ID via `extractYouTubeId()`, fetches the wrapper URL via IPC, and renders an iframe. In dev mode, it uses ReactPlayer directly (which works fine from `http://localhost`).

### Autoplay Control

The wrapper server accepts an `autoplay` query parameter (`0` or `1`, default `0`). Consumers append `&autoplay=1` to the wrapper URL when autoplay is desired. The `generatePlayerHtml` function passes this through to the YouTube embed URL.

### Adding YouTube Embeds Anywhere Else in the App

**This is the only supported way to embed YouTube in Rebel.** If you need to embed YouTube videos in a new context, follow these steps:

1. **Use the existing `tutorialPlayerServer`** — It's already running; just call `getTutorialPlayerUrl(youtubeId)` via IPC
2. **Add frame navigation exception if needed** — If embedding from a new context, ensure `will-frame-navigate` in `index.ts` allows it
3. **Handle postMessage events** — Listen for messages from `http://127.0.0.1:*` origins (the wrapper forwards YouTube events)
4. **Provide fallback UX** — If the server returns `null`, show a fallback link
5. **Autoplay** — Append `&autoplay=1` to the wrapper URL if desired

**Example usage in a React component:**
```tsx
const [playerUrl, setPlayerUrl] = useState<string | null>(null);

useEffect(() => {
  window.appApi.getTutorialPlayerUrl(youtubeId)
    .then(url => setPlayerUrl(url))
    .catch(() => setPlayerUrl(null));
}, [youtubeId]);

// Use playerUrl as iframe src, or show fallback if null
```

**Key points:**
- Works in both dev (`http://localhost:5173`) and production (`file://`)
- Server starts automatically on app ready
- Auth token regenerates each session
- No changes needed to CSP or window loading

---

## Troubleshooting

### Video shows player UI but doesn't play

1. **Check prop name**: Ensure using `src={url}` not `url={url}`
2. **Check console**: Look for CSP errors, origin errors, or player initialization errors
3. **Check URL format**: Some URL formats may not be recognized

### Embed not appearing at all

1. **Check MessageMarkdown integration**: Verify the paragraph-level detection logic
2. **Check URL protocol**: Only http/https URLs are auto-embedded (security)
3. **Check link format**: Must be bare URL (link text === href), not custom text

### Player errors / falls back to link

The `onError` handler triggers fallback. Check:
1. Network connectivity
2. Video availability (may be private/removed)
3. Region restrictions


## Future Considerations

- **v3 provider support**: Monitor react-player releases for SoundCloud, Twitch support
- **youtube-nocookie.com**: Could add for enhanced privacy (requires URL transformation)
- **Thumbnail preview**: Could add `light={true}` prop to show thumbnail before loading player
- **Lazy loading**: Currently loads full react-player; could use dynamic imports per provider


## Maintenance

When updating react-player:
1. Check [MIGRATING.md](https://github.com/cookpete/react-player/blob/master/MIGRATING.md) for breaking changes
2. Verify prop names haven't changed
3. Test all supported providers manually
4. Update this doc if API changes
