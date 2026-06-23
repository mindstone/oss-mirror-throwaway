---
description: "Custom URL protocol reference — rebel:// navigation, library links, media and tutorial schemes, parser and resolver code"
last_updated: "2026-05-15"
---

# URL Protocol Reference (`rebel://`)

Mindstone Rebel uses custom URL protocols for internal linking. This document describes the supported protocols and their behavior.

## See Also

- [UI_OVERVIEW.md](UI_OVERVIEW.md) — High-level UI layout and navigation patterns
- [UI_NAVIGATION.md](UI_NAVIGATION.md) — Unified navigation system and `useAppNavigation()` API
- [CONVERSATION_MENTIONS.md](CONVERSATION_MENTIONS.md) — How conversation references work in the composer
- [LIBRARY_AND_FILE_ACCESS.md](LIBRARY_AND_FILE_ACCESS.md) — Library/workspace configuration and file access
- [ARCHITECTURE_IPC.md](ARCHITECTURE_IPC.md) — IPC contract system; `rebel://library/` resolution uses workspace IPC handlers
- [PUBLIC_SHARING.md](PUBLIC_SHARING.md) — Public share links (HTTPS) vs in-app `rebel://` links; `/app/open` launcher bridging

**Code:**
- `src/shared/navigation/urlParser.ts` — `parseNavigationUrl`, `formatNavigationUrl`, `formatLibraryUrl`, the `KNOWN_REBEL_HOSTS` allowlist mirrored across surfaces
- `src/core/navigation/` — platform-agnostic resolver (`resolveLink`), share-link generator (`generateShareLink`), and preprocessor helper (`toBestFileLink`)
- `packages/shared/src/utils/markdownLinkHandler.ts` — sync click dispatcher (`createMarkdownLinkHandler`) for React `onClick` contexts
- `cloud-service/src/routes/open.ts` — `/app/open?u=...` HTTPS launcher page
- `src/renderer/components/MessageMarkdown.tsx` — URL rendering implementation; preprocessors call `toBestFileLink`

**Plans:**
- [251219_unified_navigation_system.md](../plans/finished/251219_unified_navigation_system.md) — Extends URL scheme to all app surfaces (settings tabs, automations, inbox)
- [260416_centralize_cross_surface_links.md](../plans/260416_centralize_cross_surface_links.md) — Three-layer cross-surface link architecture (shared parser / core resolver / surface dispatchers)
- [260418_finish_cross_surface_links_closeout.md](../plans/260418_finish_cross_surface_links_closeout.md) — Close-out work (`toBestFileLink`, Stage J doc updates)
- [251226_command_palette_action_registry.md](../plans/obsolete/251226_command_palette_action_registry.md) — Action registry that uses navigation URLs internally


## Supported Protocols

| Protocol | Format | Purpose |
|----------|--------|---------|
| `rebel://` | Various (see below) | Internal navigation, resource references, and Library file links |
| `rebel://library/` | `rebel://library/{url-encoded-path}` | Canonical Library file reference (e.g. `rebel://library/rebel-system%2Fhelp-for-humans%2Ffoo.md`) |
| `library://` | `library://{relative-path}` | **Legacy.** Reader-accepted for back-compat (historical conversation content, third-party pastes). **Do not generate new `library://` URLs** — emit `rebel://library/…` instead. |
| `workspace://` | `workspace://{relative-path}` | **Legacy.** Reader-accepted for back-compat. **Do not generate new `workspace://` URLs.** |
| `rebel-media://` | `rebel-media://resources/{file}` | Video streaming with range request support (Electron protocol) |
| `rebel-tutorial://` | `rebel-tutorial://tutorials/{file}` | HTML tutorial rendering in sandboxed iframe (Electron protocol) |


## `rebel-media://` Protocol (Video Streaming)

**This is intentionally a separate protocol from `rebel://`.** Do not attempt to unify them.

### Why Separate?

`rebel-media://` is registered as an Electron protocol with full HTTPS-equivalent privileges, which enables:
- HTTP range requests for video seeking (206 Partial Content)
- Proper `Content-Range` headers for HTML5 `<video>` elements
- Streaming without loading entire file into memory
- Chromium's media pipeline to function correctly

Navigation URLs (`rebel://settings`, `rebel://conversation/...`) are handled by the renderer's navigation context - they're declarative intents, not resource fetches. Mixing these would cause protocol handler collisions where navigation URLs get intercepted by the main process.

See `docs/plans/finished/251219_unified_navigation_system.md` Stage 8 Part B for full rationale.

### Format

```
rebel-media://resources/rebel-intro.mp4     # Bundled app resources
rebel-media://C:/Users/path/to/video.mp4    # Windows absolute path
rebel-media:///Users/path/to/video.mp4      # Unix absolute path
```

### Implementation

- **Registration**: `src/main/index.ts` - `protocol.registerSchemesAsPrivileged()` with full privileges:
  ```typescript
  { scheme: 'rebel-media', privileges: {
    standard: true,      // Enables standard URL parsing
    secure: true,        // Treated as secure origin (like https://)
    supportFetchAPI: true,  // Required for fetch/XHR
    corsEnabled: true,   // Enables CORS for media requests
    stream: true         // Enables streaming responses for range requests
  }}
  ```
- **Handler**: `src/main/index.ts` - `protocol.handle('rebel-media', ...)` with explicit byte-range handling
- **Usage**: `src/renderer/features/usecases/TheSparkPanel.tsx` - intro video sources

**Note**: These privileges make the scheme work like `https://` for Chromium's media pipeline. The `stream: true` alone is insufficient; all five privileges are required for video playback with seeking support.

### Usage

```tsx
<video src="rebel-media://resources/intro.mp4" controls />
```

The protocol handler reads the file and returns a proper streaming response with `Content-Range` headers for seeking support.

### Packaged-context verification (media previews)

`rebel-media://` is also how the document editor previews **PDFs** (and images/audio/video): the file streams over this protocol rather than a renderer-created `blob:` URL. That choice is load-bearing. A `blob:`/`createObjectURL` URL is scoped to the renderer's origin, and under the packaged app's `file://` origin it left the in-app PDF preview a blank panel — undiscovered for 102 days, because dev's `http://localhost` origin renders it fine (PM [`260619_pdf_preview_blank_blob_file_origin`](../../docs-private/postmortems/260619_pdf_preview_blank_blob_file_origin_postmortem.md); the same `dev_works_packaged_fails` origin asymmetry as `251208`).

**Review focus — a change to any media-preview render path (PDF / video / audio / image) must be verified in a packaged (`file://`) context, not dev (`http`) alone, or carry a packaged-smoke assertion.** Dev's origin does not exercise the failure mode. Two enforcement nets back this up:

- The packaged boot-smoke's **PDF-render gate** (`scripts/check-packaged-app-boot-smoke.ts`) proves a packaged `file://` renderer can obtain a PDF over `rebel-media://` (full + `Range` request) — the property no unit test or dev E2E can see.
- A `no-restricted-syntax` ban on `URL.createObjectURL` across `src/renderer/features/document-editor/**` (`eslint.config.mjs`) stops the preview code regressing back to a renderer blob (which the smoke, fetching a synthetic URL, would not catch).


## `rebel-tutorial://` Protocol (HTML Tutorial Rendering)

Serves HTML tutorials from `rebel-system/help-for-humans/` in a secure, sandboxed manner for display in the Document Preview Drawer.

### Why Separate From `rebel-media://`?

While both are Electron protocol handlers, they serve different purposes:
- `rebel-media://` requires streaming and range request support for video playback
- `rebel-tutorial://` serves static files with strict CSP headers for security

### Format

```
rebel-tutorial://tutorials/251023b_rebel_getting_started.html    # Tutorial HTML
rebel-tutorial://diagrams/251023a_company_os_architecture.svg    # Diagram asset
```

### Security

- **Path containment**: Only files within `rebel-system/help-for-humans/` can be served
- **CSP headers**: HTML responses include strict Content-Security-Policy:
  - `script-src 'none'` - No JavaScript execution
  - `connect-src 'none'` - No network requests
  - `style-src 'unsafe-inline'` - Allow inline styles (tutorials use them)
  - `img-src rebel-tutorial: data:` - Only local images and data URIs
- **Sandboxed iframe**: Rendered in `<iframe sandbox="">` with no permissions

### Implementation

- **Registration**: `src/main/index.ts` - `protocol.registerSchemesAsPrivileged()` with minimal privileges
- **Handler**: `src/main/index.ts` - `protocol.handle('rebel-tutorial', ...)` with path validation
- **Consumer**: `src/renderer/features/document-editor/components/UnifiedDocumentEditor.tsx`

### Usage

In messages, agents can link to tutorials using `rebel://help/tutorials/{filename}`:

```markdown
Check out the [Getting Started Tutorial](rebel://help/tutorials/251023b_rebel_getting_started.html).
```

Clicking the link opens the tutorial in the Document Preview Drawer, rendered in a sandboxed iframe. The "Open in Browser" button provides full-fidelity viewing (with syntax highlighting and clickable links).


## `rebel://` URL Scheme (Unified Navigation)

The `rebel://` scheme supports navigation to all app surfaces. URLs are parsed by `src/shared/navigation/urlParser.ts`; desktop dispatches via `useAppNavigation()`; mobile and cloud surfaces dispatch via surface-specific helpers built on the same parser. See [Three-Layer Architecture](#three-layer-architecture) below for how desktop, mobile, cloud, and the web companion share one schema.

### Supported URLs

| URL Format | Target | Description |
|------------|--------|-------------|
| `rebel://settings` | Settings dialog | Opens settings to default tab |
| `rebel://settings/{tab}` | Settings tab | Opens specific tab (system, spaces, meetings, tools, agents, safety, diagnostics, usage) |
| `rebel://settings/{tab}#{section}` | Settings section | Opens tab and scrolls to section |
| `rebel://conversation/{id}` | Conversation | Opens specific conversation session |
| `rebel://sessions` | Sessions surface | Switches to sessions/conversations view |
| `rebel://sessions/{id}` | Conversation | Alias for `rebel://conversation/{id}` |
| `rebel://library` | Library surface | Switches to Library file browser |
| `rebel://library/{path}` | Library file | Opens specific file in Library (path is workspace-relative) |
| `rebel://library/{path}?type=folder` | Library folder | Navigates to folder in Library |
| `rebel://space/{spaceName}/{path}` | Space file | Portable, cross-user reference to a file inside a shareable space (URI-encoded space name; path is space-relative). Resolves locally via the `SpaceResolver` boundary — see [Space Links](#space-links-rebelspace) below. |
| `rebel://space/{spaceName}/{path}?type=folder` | Space folder | Portable folder reference inside a shareable space |
| `rebel://space/{spaceName}` | Space root | Opens the space's root folder in the library |
| `rebel://workspace` | Library surface | Legacy alias for `rebel://library` |
| `rebel://workspace/{path}` | Library file | Legacy alias for `rebel://library/{path}` |
| `rebel://automations` | Automations surface | Switches to automations view |
| `rebel://automations/{id}` | Automation | Opens specific automation |
| `rebel://tasks` | Tasks surface | Switches to inbox/tasks view |
| `rebel://tasks/{approvalId}` | Tasks with focus | Opens inbox and focuses a specific approval (e.g. from a widget tap). `?focusApprovalId={id}` query form also accepted. |
| `rebel://usecases` | Use cases surface | Switches to The Spark view |
| `rebel://insights/{turnId}` | Behind the scenes drawer | Opens "Behind the scenes" for specific turn |
| `rebel://media/{resourcePath}` | Media resource | Reference to media content |
| `rebel://action/{verb}` | Widget/automation intent | Fires a side-effect (e.g. `start-voice`, `start-meeting-recording`, `stop-meeting-recording`). Verb is open-ended; per-surface dispatcher decides what it does. |
| `rebel://plugin/{pluginId}[/{tabId}][?...]` | Plugin surface | Opens a plugin panel, optionally at a specific tab, with query params |
| `rebel://feedback[/{bug\|improvement}][?...]` | Feedback dialog | Opens bug report / improvement dialog, optionally pre-filled via query params (`description`, `stepsToReproduce`, `expectedBehavior`) |
| `rebel://help/tutorials/{filename}` | Tutorial preview | Opens HTML tutorial in Document Preview Drawer (renderer-only, not parsed by `urlParser.ts`) |

### Navigation vs Action Intents

- `rebel://{surface}[/...]` — **navigation**. Opens a screen or drawer. Safe, idempotent to re-trigger.
- `rebel://action/{verb}` — **intent**. Performs a side-effect (start recording, etc.). Emitted primarily by widgets/automations.

The split keeps "open a link" and "fire a button" conceptually separate and lets surfaces decide which actions they support (e.g. widget verbs like `start-voice` are mobile-only today; desktop surfaces a warning toast).

### Legacy Aliases

- `rebel:///start-voice`, `rebel:///start-meeting-recording`, `rebel:///stop-meeting-recording` — iOS widget pre-schema URLs. Map to the canonical `rebel://action/{verb}` form via an empty-host branch in `parseNavigationUrl`. Kept working for at least one stable-release cycle after widget binaries emit the canonical form. See [260416_centralize_cross_surface_links.md](../plans/260416_centralize_cross_surface_links.md).
- `rebel:///inbox-item/{id}` — widget tap on an action item. Maps to `{ type: 'tasks', focusApprovalId: id }` (navigation, not an action verb) because the intent is "land me on this approval," not "fire a side-effect." Canonical replacement is `rebel://tasks/{id}`.

### Settings Section IDs

Deep-link to specific settings sections using hash fragments:

```
rebel://settings/agents#voiceAudio
rebel://settings/system#coreDirectory
rebel://settings/diagnostics#developerDebug
```

**Available sections by tab:**
- **agents**: `model`, `voiceAudio`
- **system**: `coreDirectory`, `appearance`, `scratchpad`
- **diagnostics**: `systemHealth`, `appUpdates`, `analytics`, `onboarding`, `frequentTools`, `demoMode`, `developerDebug`, `advancedOverrides`

### Programmatic Navigation

```typescript
import { useAppNavigation } from '@renderer/hooks/useAppNavigation';

const { navigate } = useAppNavigation();

// Navigate by URL string
navigate('rebel://settings/agents#voiceAudio');

// Navigate by target object
navigate({ type: 'settings', tab: 'agents', section: 'voiceAudio' });
```

See [UI_NAVIGATION.md](UI_NAVIGATION.md) for full API documentation.


## Three-Layer Architecture

Every `rebel://` URL flows through the same three layers regardless of whether it originates on desktop, mobile, cloud, or the web companion. Centralising emission + validation + dispatch avoids the historical "each surface reimplements a bit of URL parsing" drift.

1. **Shared parser (`src/shared/navigation/urlParser.ts`)** — the only place URLs are parsed and formatted. Exports `parseNavigationUrl`, `formatNavigationUrl`, `formatLibraryUrl`, and the host allowlist mirrored into `markdownLinkHandler` and the cloud launcher. Pure, sync, no I/O — safe to import on any surface.
2. **Core resolver (`src/core/navigation/`)** — platform-agnostic dispatcher used by async, side-effect flows (space resolution IPC, share-link generation, deep-link handling). Pure + async; Electron-free. Exports:
   - `resolveLink(urlOrTarget, ctx)` — turns a `rebel://` URL into a terminal `NavigationAction` that any surface can execute without re-validating.
   - `generateShareLink(resource, ctx)` — produces both a canonical `rebel://` URL and an optional `https://.../app/open?u=...` launcher URL for cross-surface sharing.
   - `toBestFileLink(path, ctx, kind)` — pure + sync helper that chooses between `rebel://space/{space}/...` (shareable) and `rebel://library/...` (private/local) for file references embedded in chat messages.
3. **Surface dispatchers** — each surface converts the shared parser output into concrete side-effects:
   - **Desktop** — `createMarkdownLinkHandler` in `packages/shared/src/utils/markdownLinkHandler.ts` for sync React `onClick`/`onPress` contracts; `NavigationContext` + `useAppNavigation` for programmatic navigation; `resolveLink` for async IPC flows.
   - **Mobile (Expo Router)** — `linkDispatcher` + `+native-intent.ts` route deep-link URLs through the same parser before handing off to the relevant screen.
   - **Cloud service** — `/app/open?u=...` (see [Cross-Surface Launcher](#cross-surface-launcher-appopen) below) reuses the parser to validate inbound launcher URLs.
   - **Web companion** — `ConversationScreen` embeds `createMarkdownLinkHandler` to intercept `rebel://` URLs pasted or rendered in-page.

See [260416_centralize_cross_surface_links.md](../plans/260416_centralize_cross_surface_links.md) for the full architectural rationale and [UI_NAVIGATION.md](UI_NAVIGATION.md#sync-vs-async-click-handling) for the sync-vs-async decision tree.


## `rebel://action/` — Widget and Automation Intents

Action URLs fire a side-effect instead of opening a screen. Verb is open-ended; each surface dispatcher decides which verbs it accepts and surfaces an observable "unsupported" state for the rest — never silently succeeds.

### Known Verbs

| Verb | Emitter | Surface | Behaviour |
|------|---------|---------|-----------|
| `start-voice` | iOS widget, automations | Mobile | Opens the voice composer in listen mode |
| `start-meeting-recording` | iOS widget | Mobile | Kicks off a meeting recording session |
| `stop-meeting-recording` | iOS widget | Mobile | Stops the active meeting recording |

Desktop surfaces currently do not dispatch any action verb and show a "this action runs on mobile" toast. Adding new verbs requires (a) teaching the relevant dispatcher to handle it and (b) documenting it here.

### Canonical + Legacy Forms

- **Canonical**: `rebel://action/{verb}` — preferred. Emitted by new widget binaries and by `generateShareLink` for action-type resources.
- **Legacy three-slash**: `rebel:///{verb}` — pre-schema iOS widget form. `parseNavigationUrl` maps it to the canonical target via an empty-host branch. Kept working for at least one stable release cycle after widget binaries flip.


## Space Links (`rebel://space/...`)

Space links are the portable, cross-user form for referencing files that live inside a shareable space (e.g. a team's shared drive). `rebel://library/...` is workspace-relative and only resolves on the emitter's own machine; `rebel://space/...` resolves on any machine that has the same space configured.

### Format

```
rebel://space/{encoded-spaceName}/{encoded-spaceRelativePath}[?type=folder]
```

- `spaceName` is the space's **canonical display name** (see `getCanonicalSpaceName` in `@core/services/spacePathMatcher`) — URL-encoded so spaces and special characters survive.
- The path is **space-relative** (`memory/Q1.md`), not workspace-relative.
- Private spaces (`type === 'chief-of-staff'` or `frontmatter.sharing === 'private'`) are never emitted as space links — emitters fall back to `rebel://library/...` so private content never leaks to other users.

### Emission

`toBestFileLink` in `@core/navigation` is the single emission helper. It picks `rebel://space/...` when the path matches a shareable space and the spaces cache has loaded; otherwise it fails closed to `rebel://library/...`. All four MessageMarkdown preprocessor sites plus `remarkLibraryLinks` call this helper so every file reference in chat messages uses the best form automatically. See [UI_NAVIGATION.md](UI_NAVIGATION.md#file-link-emission-in-markdown) for where to wire new preprocessors.

### Resolution

Click dispatch uses the core resolver (`resolveLink`), which calls the `SpaceResolver` boundary to translate a `{spaceName, filePath}` target into a workspace-relative library action. Missing spaces surface as `{ kind: 'error', code: 'space-not-found' }` so dispatchers can show a helpful toast rather than silently dropping the navigation.


## Share-Link Generation (`generateShareLink`)

`generateShareLink(resource, ctx)` in `@core/navigation` is the canonical way to produce a shareable URL for any resource (conversation, space file, task, action). It always returns the canonical `rebel://` URL and, when the context supplies a cloud origin, an HTTPS launcher URL.

### Dual Output

```ts
const result = await generateShareLink(
  { kind: 'library-file', absolutePath: '/…/Exec/Q1.md' },
  { spaceResolver, cloudBaseUrl: 'https://cloud.getrebel.com' },
);

// result.ok === true
// result.rebel === 'rebel://space/Exec/Q1.md'           (in-app link)
// result.https === 'https://cloud.getrebel.com/app/open?u=rebel%3A%2F%2Fspace%2FExec%2FQ1.md'
// result.preferred === 'space'
```

- **`rebel`**: the in-app URL. Works only for recipients who have Rebel installed *and* the relevant space (or session) synced locally.
- **`https`**: the public launcher. Present when the caller passes `cloudBaseUrl`. Attempts the `rebel://` deep-link on the recipient's device, then falls back to `https://getrebel.mindstone.com` if Rebel isn't installed.

Library files that don't resolve to a shareable space return `{ ok: false, reason: 'private-space' | 'not-in-workspace' | 'unsupported-resource' }` — callers should disable the "Copy shareable link" UI rather than emit a `rebel://library/...` URL that won't work for other users.

### Where It's Used

- **Desktop context menu** — "Copy shareable link" in the Library context menu (landed in commit `40725a5b9`) copies the `https` form by default so recipients without Rebel still land somewhere useful. Mobile and web-companion copy flows are deferred (see [the close-out plan](../plans/260418_finish_cross_surface_links_closeout.md)).
- **Public sharing** — see [PUBLIC_SHARING.md](PUBLIC_SHARING.md) for the separate read-only share-token system. Public share tokens and `generateShareLink` are orthogonal: one grants unauthenticated access, the other produces a navigation URL for users who already have access.


## Cross-Surface Launcher (`/app/open`)

`GET /app/open?u=<rebel://...>` (cloud service, handler in `cloud-service/src/routes/open.ts`) is the HTTPS bridge for `rebel://` URLs. Visiting the URL in any browser:

1. Validates `u` as a `rebel://` URL whose host is on `KNOWN_REBEL_HOSTS` (prevents open-redirect abuse).
2. Renders a minimal HTML page that attempts `window.location = rebelUrl` — browsers that recognise the scheme hand off to Rebel.
3. After ~1.2 s, falls back to `https://getrebel.mindstone.com` so recipients without Rebel installed land on the install/web CTA.

The launcher has no auth requirement — it's the public counterpart to the desktop "Copy web link" action. All validation is driven by the shared parser (`parseNavigationUrl`) so the launcher can't disagree with dispatchers about what counts as a valid URL.


## `rebel://conversation/{id}`

References a conversation session by its unique ID.

> **Reading conversation contents**: For the complete guide on retrieving conversation data from a `rebel://conversation/{id}` link (session JSON + Claude SDK JSONL), see [READ_REBEL_CONVERSATION.md](READ_REBEL_CONVERSATION.md).

### Format

```
rebel://conversation/abc123-def456-ghi789
```

The `{id}` is the session's unique identifier (UUID format).

### Usage Contexts

**In composer (as @-mention)**:
```markdown
@[Meeting Notes](rebel://conversation/abc123)
```

Inserted via autocomplete when user selects a conversation from the `@` dropdown.

**In message content**:
Rendered as a clickable pill that navigates to the referenced conversation.

### Resolution

When included in a message being sent to the agent:
1. URL is extracted via regex: `/rebel:\/\/conversation\/([a-zA-Z0-9_-]+)/g`
2. Session is looked up in `agentSessions`
3. Transcript is formatted as a `TextFileAttachmentPayload`
4. Agent receives the conversation context as a text attachment

### Click Behavior

When a `rebel://conversation/{id}` link is clicked in a rendered message:
1. Check for unsaved draft (warn user if present)
2. Navigate to the referenced session in history
3. If session not found, show toast error

### Error Handling

- **Missing session**: Link remains clickable; error toast on click
- **Malformed URL**: Treated as plain text, not rendered as link

### Finding Logs for a Conversation (AI Agents)

To find logs for a conversation ID from a `rebel://conversation/{id}` link:

1. **Session file**: `grep -l "{id}" ~/Library/Application\ Support/mindstone-rebel/sessions/*.json`
2. **Turn logs**: `ls ~/Library/Application\ Support/mindstone-rebel/logs/sessions/*{id}*.log`

Log filenames contain the conversation ID (truncated) as `renderer-{id-prefix}`. The full session data is in `sessions/{session-id}.json` where the conversation ID appears inside the JSON.


## `rebel://library/` Protocol — Canonical Library File References

References files within the user's configured Library directory. **This is the canonical form — new emitters must use this.**

### Format

```
rebel://library/rebel-system%2Fhelp-for-humans%2Ftutorials.md
rebel://library/src%2Fcomponents%2FButton.tsx
rebel://library/notes%2F2026-04%2Fstandup.md#action-items
```

Path component is **URL-encoded** (slashes → `%2F`). Anchors (`#fragment`) and query params (`?q=…`) are preserved verbatim. The canonical formatter is `formatLibraryUrl()` in `src/shared/navigation/urlParser.ts`; the canonical reader is `getLibraryProtocol()` / `extractLibraryPath()` in `packages/shared/src/utils/libraryUrls.ts`.

### Resolution

Resolved by the main process, which:
1. URL-decodes the path component
2. Joins with `coreDirectory` to get absolute path
3. Validates path is within workspace (security check)
4. Reads file content for agent context

### Click Behavior

When clicked in rendered messages, opens in the in-app document preview drawer. Falls back to revealing in the file manager via `window.appApi.revealPath()`.

### Legacy forms (reader-accepted, do not emit)

`library://{relative-path}` and `workspace://{relative-path}` are **legacy** URL forms. Reader code paths (`MessageMarkdown`, `remarkLibraryLinks`, `TipTapImageView`, `markdownLinkHandler`, `libraryUrls.ts`, `urlParser.ts`) accept all three forms indefinitely for back-compat so historical conversations, user notes, and third-party pastes keep working.

**Do not generate new legacy URLs.** The ESLint rule in `eslint.config.mjs` blocks hand-built `library://` and `workspace://` template literals in TypeScript code. Help docs, skill prompts, and the agent system prompt were all migrated to canonical form in 2026-04 (see `docs/plans/260416_finish_library_url_cleanup.md`).


## Adding New Protocols

To add a new `rebel://` resource type:

1. **Define the URL format** in planning doc (e.g., `rebel://memory/{id}`, `rebel://inbox/{id}`)

2. **Add extraction regex** in the relevant mentions hook:
   ```typescript
   const NEW_URL_REGEX = /rebel:\/\/newtype\/([a-zA-Z0-9_-]+)/g;
   ```

3. **Add resolution logic** to prepare attachments for agent context

4. **Update MessageMarkdown.tsx** to handle click navigation:
   ```typescript
   if (href.startsWith('rebel://newtype/')) {
     // Handle navigation
   }
   ```

5. **Update this doc** with the new protocol


## Implementation Notes

### Security

- All `rebel://library/` paths (and legacy `library://` / `workspace://`) are URL-decoded and validated to stay within the workspace root
- `rebel://` IDs are validated against known session IDs
- No arbitrary file system or network access via URL protocols

### Rendering

URLs are rendered in `MessageMarkdown.tsx` using custom link components:
- Protocol-specific icons (MessageSquare for conversations, FileText for files)
- Consistent pill styling across all internal link types
- Accessibility: proper `aria-label` for screen readers
