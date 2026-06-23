---
description: "Public sharing architecture for conversations and library files — share tokens, HTTPS links, cloud APIs, web viewer"
last_updated: "2026-04-18"
---

# Public Sharing

Public sharing lets users generate unauthenticated URLs that grant read-only access to conversations and library files. Links are live (always show the latest synced version), optionally password-protected, and optionally time-limited. Cloud continuity must be active for the resource being shared.

> **Public sharing vs in-app `rebel://` links are two different features.** See [Public vs In-App Links](#public-vs-in-app-links) below before assuming one is a subset of the other.

## See Also

- **Planning docs**: [`docs/plans/260313_share_conversation_via_url.md`](../plans/260313_share_conversation_via_url.md) (original conversation sharing), [`docs/plans/260314_share_conversation_hardening.md`](../plans/260314_share_conversation_hardening.md) (password/expiry/rate-limiting), [`docs/plans/260413_library_file_public_sharing.md`](../plans/260413_library_file_public_sharing.md) (file sharing extension), [`docs/plans/260416_centralize_cross_surface_links.md`](../plans/260416_centralize_cross_surface_links.md) (cross-surface link centralisation — see the "Copy shareable link" flow below)
- **URL protocol**: [URL_PROTOCOL.md](URL_PROTOCOL.md) — the `rebel://` scheme, `generateShareLink` dual output, and `/app/open` launcher
- **Cloud architecture**: [CLOUD_ARCHITECTURE.md](CLOUD_ARCHITECTURE.md) — cloud service deployment, auth model, workspace sync
- **IPC contracts**: [`src/shared/ipc/channels/cloud.ts`](../../src/shared/ipc/channels/cloud.ts) — `cloud:share-create`, `cloud:share-update`, `cloud:share-list`, `cloud:share-revoke`
- **Cloud-client API**: [`cloud-client/src/cloudClient.ts`](../../cloud-client/src/cloudClient.ts) — `fetchSharedResource`, `unlockSharedResource`, `getSharedFileDownloadUrl`, `createShareLink`, `revokeShareLink`, `getShareStatus`
- **Cloud-client types**: [`cloud-client/src/types.ts`](../../cloud-client/src/types.ts) — `SharedSession`, `SharedFile`, `SharedResource`, `SharedMessage`
- **Share-link generator**: [`src/core/navigation/generateShareLink.ts`](../../src/core/navigation/generateShareLink.ts) — produces the dual `rebel://` + HTTPS launcher URL surfaced by the desktop "Copy shareable link" action

## Public vs In-App Links

Rebel produces **two distinct kinds of sharable URL**. They look similar on a copy-paste but solve different problems.

| Kind | Example | Recipient requirements | Where it comes from |
|------|---------|-----------------------|---------------------|
| **In-app link** (`rebel://`) | `rebel://space/Exec/Q1.md`, `rebel://conversation/{id}` | Must have Rebel installed *and* be paired with the relevant space (or own the session) | `generateShareLink(...)` → `.rebel`; emitted automatically by markdown preprocessors via `toBestFileLink` |
| **Public share link** (HTTPS) | `https://cloud.getrebel.com/app/shared/{shareId}` | Anyone with the URL (and the password, if set) can view in a browser | Created via the share dialog; backed by the cloud service share-token store described in this doc |
| **Public launcher link** (HTTPS, deep-link bridge) | `https://cloud.getrebel.com/app/open?u={encoded rebel://...}` | Works for anyone — attempts to open Rebel on the recipient's device, falls back to the install/web CTA if Rebel isn't installed | `generateShareLink(..., { cloudBaseUrl })` → `.https`; see [URL_PROTOCOL.md § Cross-Surface Launcher](URL_PROTOCOL.md#cross-surface-launcher-appopen) |

**In-app links** navigate the app and give access to whatever the recipient already has synced. They do **not** grant access to resources the recipient doesn't otherwise have — a `rebel://space/...` URL for a space the recipient isn't paired with surfaces a "that space isn't set up on your machine" toast rather than exposing the content.

**Public share links** are the read-only web view backed by share tokens (the rest of this document). They work for anyone, are independent of the recipient's Rebel setup, and are explicit cloud-hosted shares with optional password/expiry.

**Public launcher links** bridge the two: they start as HTTPS so any recipient can click them, then attempt a `rebel://` deep-link handoff. Recipients with Rebel installed land in-app; recipients without Rebel land on the install/web CTA.

### `generateShareLink` Dual Output

`generateShareLink` in [`src/core/navigation/generateShareLink.ts`](../../src/core/navigation/generateShareLink.ts) is the single helper that produces both forms. When called with a `cloudBaseUrl` context, the result includes both a `rebel` URL (for recipients already inside Rebel) and an `https` URL (the launcher form for external channels like email and Slack). Callers choose which to put on the clipboard based on the sharing context.

### "Copy shareable link" — Desktop Context Menu

The desktop Library context menu's **"Copy shareable link"** action (landed in commit `40725a5b9` as Stage G of the cross-surface links plan) calls `generateShareLink` and surfaces both forms so users can pick the right one for the recipient:

- **In-app link** — copy the `rebel://` URL for colleagues who already have the space paired.
- **Web link** — copy the HTTPS launcher URL for anyone else (survives install-less recipients via the `/app/open` fallback).

Library files that don't resolve to a shareable space (private spaces, Chief-of-Staff, files outside any space) disable the action rather than emit an in-app link that won't work for anyone else. For those cases users should fall back to the explicit **"Share publicly..."** flow below, which creates an unauthenticated HTTPS share via a cloud share-token — a different mechanism with its own password/expiry controls.

Mobile and web-companion "Copy shareable link" flows are deferred (see the [cross-surface close-out plan](../plans/260418_finish_cross_surface_links_closeout.md)).


## Architecture Overview

Public sharing spans four stacks:

| Stack | Location | Role |
|-------|----------|------|
| **Cloud service** | `cloud-service/src/routes/share.ts` | Share token store, authenticated CRUD, unauthenticated public endpoints, file streaming, rate limiting |
| **IPC contracts + desktop handlers** | `src/shared/ipc/channels/cloud.ts`, `src/main/ipc/cloudHandlers.ts` | Discriminated union contracts (`cloud:share-*`), desktop → cloud bridge, force-sync before file shares |
| **Cloud-client** | `cloud-client/src/cloudClient.ts`, `cloud-client/src/types.ts` | Shared API helpers and types consumed by web companion and mobile |
| **Web companion** | `web-companion/src/App.tsx`, `web-companion/src/screens/Shared*.tsx` | `SharedResourceRouter` → `SharedConversationScreen` / `SharedFileScreen` |

**Data flow (share creation):**
1. User clicks "Share publicly..." in desktop UI (session menu or library context menu)
2. `ShareConversationDialog` opens → user sets expiry/password → submits
3. Renderer calls `cloud:share-create` IPC with `resourceType` + identifier
4. Desktop handler: for files, calls `forceWorkspaceSync()` first (fail-closed), then POSTs to cloud service
5. Cloud service generates token, stores in `share-links.json`, returns `shareId`
6. Desktop copies `${cloudUrl}/app/shared/${shareId}` to clipboard

**Data flow (public access):**
1. Visitor opens `https://<cloud-host>/app/shared/<shareId>` in browser
2. Web companion SPA loads, `SharedResourceRouter` fetches `GET /api/shared/:shareId`
3. Cloud service looks up share entry, validates expiry/password, returns resource data
4. Router discriminates on `resourceType` → renders `SharedConversationScreen` or `SharedFileScreen`

## Share Store

**File**: `${REBEL_USER_DATA}/share-links.json`

A flat JSON map keyed by resource identifier:

```
{
  "<sessionId>": { ... },           // conversation share (key = UUID)
  "file:<workspace-relative-path>": { ... }  // file share (key = prefixed path)
}
```

**`ShareEntry` type:**

```ts
interface ShareEntry {
  shareId: string;          // crypto.randomBytes(16).toString('base64url') — 22 chars, 128-bit
  createdAt: number;        // epoch ms
  expiresAt?: number;       // epoch ms — undefined = no expiry
  passwordHash?: string;    // scrypt "salt_hex:hash_hex"
  title?: string;           // cached at creation time (avoids N+1 on list)
  resourceType?: 'conversation' | 'file';  // undefined = 'conversation' (backward compat)
  filePath?: string;        // workspace-relative path (present when resourceType='file')
}
```

**Key conventions:**
- Conversations: keyed by `sessionId` (UUID) — no prefix
- Files: keyed by `file:<workspace-relative-path>` — the `file:` prefix prevents collisions with session UUIDs
- Existing entries without `resourceType` are treated as conversations throughout (backward compatible)

**Write mutex:** All read-modify-write operations on `share-links.json` are serialized via an in-memory promise-based mutex (`withShareLinksMutex`). Password hashing is done outside the mutex to avoid holding the lock during expensive crypto.

**Error handling:** `readShareLinks()` is fail-closed — only `ENOENT` returns an empty store. Parse errors and permission errors throw (never silently overwrite corrupt data).

## Endpoints

### Authenticated — Conversation Shares

Handled inside `handleSessionShare` (called from the sessions route when `segments[3] === 'share'`):

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/sessions/:id/share` | Idempotent create — returns existing share or creates new. Body: `{ expiresIn?, password? }` |
| GET | `/api/sessions/:id/share` | Get share status. Returns `{ shareId, expiresAt?, hasPassword }` or 404 |
| PUT | `/api/sessions/:id/share` | Update expiry/password. Partial update semantics: `undefined` = no change, `null` = remove, string = set |
| DELETE | `/api/sessions/:id/share` | Revoke share link |

### Authenticated — File Shares

Handled by `handleFileShare` at `/api/file-shares`. Uses body/query params (not URL path) because file paths contain slashes:

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/file-shares` | Create file share. Body: `{ filePath, expiresIn?, password? }`. Validates file exists in workspace |
| GET | `/api/file-shares?filePath=<encoded>` | Get share status for a file |
| PUT | `/api/file-shares` | Update. Body: `{ filePath, expiresIn?, password? }` |
| DELETE | `/api/file-shares?filePath=<encoded>` | Revoke file share |

### Authenticated — List All Shares

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/shares` | Returns all active (non-expired) shares with `resourceType`, `filePath`, cached `title` |

### Unauthenticated — Public Access

All placed before the auth gate in `server.ts`:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/shared/:shareId` | Returns sanitized resource data. Conversations: `{ title, messages, ... }`. Files: `{ resourceType, fileName, mimeType, size, content?, downloadUrl, updatedAt }` |
| POST | `/api/shared/:shareId/unlock` | Password unlock. Returns same data as GET. For password-protected files, includes HMAC-signed `downloadUrl` |
| GET | `/api/shared/:shareId/download` | Raw file download (streaming). Password-protected files require `?sig=<hmac>&exp=<timestamp>` |

## Security

### Path Traversal & Symlink Protection

File shares use two layers of validation (see `resolveSharedFilePath` and `validateFilePath` in `share.ts`):

1. **Traversal check**: `path.resolve(workspaceDir, filePath)` must `startsWith(workspaceDir + sep)`
2. **Symlink check**: `fs.realpath()` resolves symlinks, then re-checks the result is within workspace bounds

### HMAC-Signed Downloads

Password-protected binary file downloads use stateless HMAC-signed URLs (survives Fly.io restarts, no cleanup timers):

- **Signature**: `HMAC-SHA256(REBEL_SHARE_DOWNLOAD_SECRET, shareId + ":" + exp)` with 5-minute TTL
- **Verification**: `crypto.timingSafeEqual` for constant-time comparison
- **Env var**: `REBEL_SHARE_DOWNLOAD_SECRET` must be provisioned on Fly.io. Missing → 500 for password-protected file downloads

### Password Hashing

Async `crypto.scrypt` (non-blocking): `N=2^14, r=8, p=1`, 32-byte key, stored as `salt_hex:hash_hex`. Password bounds: 1–128 characters.

### Rate Limiting

In-memory per-key rate limiters with periodic cleanup:

| Endpoint class | Limit | Key |
|---------------|-------|-----|
| Public read (`GET /api/shared/:shareId`) | 60/min | Client IP |
| Unlock (`POST /api/shared/:shareId/unlock`) | 5/15min | IP + shareId |
| Management (authenticated CRUD) | 30/min | Bearer token |
| Download | Shares public read limiter | Client IP |

IP extracted via: `fly-client-ip` header → `socket.remoteAddress` → `'unknown'`

### Other Hardening

- **shareId format validation**: `/^[A-Za-z0-9_-]{22}$/` — rejects invalid IDs before any I/O
- **Log redaction**: `server.ts` redacts shareIds from request logs (`/api/shared/*` → `/api/shared/[redacted]`)
- **Generic 500 errors**: Public endpoints return `'An unexpected error occurred'`, not raw `err.message`
- **Public response privacy**: File shares return `fileName` only — never exposes `filePath` or workspace structure
- **Content-Disposition sanitization**: Strips control chars, provides ASCII fallback + RFC 5987 `filename*=UTF-8''...` encoding
- **`X-Content-Type-Options: nosniff`** on all download responses
- **`Cache-Control: no-store`** on all public responses (live data, must revalidate)

## Key Design Decisions

1. **Live, not snapshot** — Shared resources always reflect the latest synced version. No copy is made at share time. Consistent across conversations and files.

2. **Dedicated file endpoints** — File share management uses `POST/GET/PUT/DELETE /api/file-shares` (body-based), completely separate from `/api/sessions/:id/share`. Zero risk to existing conversation sharing. Public endpoints remain unified at `/api/shared/:shareId` since they use shareId not resource path.

3. **HMAC over in-memory tokens** — Password-protected binary downloads use stateless HMAC-signed URLs instead of in-memory download tokens. Survives Fly.io restarts, needs no cleanup timers.

4. **Fail-closed forceSync** — Desktop handler calls `forceWorkspaceSync()` before file share creation. If sync fails or has `failed > 0`, returns error to user ("Unable to sync file to cloud. Please try again."). Never proceeds with potentially stale content.

5. **File rename/move = broken link** — Documented as expected behavior. Share dialog warns: "Moving or renaming the file will break the link." Path-based identity is correct for live sharing semantics.

6. **`SpaceSharingLevel` is NOT public sharing** — `SpaceSharingLevel` controls space metadata/safety sharing between users within Rebel. Overloading it for public URL sharing would be a semantic reversal.

7. **`rebel://` links are NOT public sharing** — Internal `rebel://` links (including `rebel://library/…` file references, `rebel://space/…` cross-user references, and legacy `library://` / `workspace://`) are in-app navigation. Public sharing uses explicit cloud share tokens via `https://` URLs. The `/app/open?u=...` launcher bridges the two — it *attempts* an in-app handoff but never grants access on its own; the underlying resource still has to resolve on the recipient's machine. See [Public vs In-App Links](#public-vs-in-app-links) above for the full comparison.

8. **Unified `share-links.json`** — One file for both conversations and files, discriminated by `resourceType` + composite key prefix. Avoids duplicating infrastructure.

9. **CloudTab filtering** — Desktop `cloud:share-list` handler filters out `resourceType === 'file'` entries before returning to renderer. Temporary measure until CloudTab's share management UI supports mixed resource types.

## Desktop Integration

### IPC Channels

All four `cloud:share-*` channels use **discriminated unions** — each branch has exactly the fields it needs (no empty-string hacks):

```ts
// Conversation branch — resourceType optional for backward compat
z.object({ resourceType: z.literal('conversation').optional(), sessionId: z.string(), ... })

// File branch — filePath required, no sessionId
z.object({ resourceType: z.literal('file'), filePath: z.string(), ... })
```

Old callers without `resourceType` match the conversation branch via `.optional()`.

### Desktop Handler Routing

`src/main/ipc/cloudHandlers.ts` routes based on `resourceType`:
- **Conversation** (`undefined` or `'conversation'`): existing behavior — direct fetch to `/api/sessions/:id/share`
- **File** (`'file'`): `forceWorkspaceSync()` → `POST /api/file-shares`

### Share Dialog

`ShareConversationDialog` (`src/renderer/features/agent-session/components/ShareConversationDialog.tsx`) is generalized with a `mode` prop (`'conversation' | 'file'`). Copy adjusts per mode; file mode warns about rename breaking the link.

### Library Context Menu

"Share publicly..." action in `LibraryDialogs.tsx` (Globe icon, lucide-react). Only visible when:
- Item is a file (not folder)
- `onShareFile` callback is provided (gated on `settings?.cloudInstance?.mode === 'cloud'`)

Callback path: `App.tsx` → `LibraryDrawer` → `LibraryNavigatorProvider` → `contextMenuState.sharePublicly`. The provider converts absolute paths to workspace-relative via `getRelativeLibraryPath`.

## Web Companion

### SharedResourceRouter

`web-companion/src/App.tsx` defines `SharedResourceRouter` at route `/shared/:shareId`:
- Single fetch via `fetchSharedResource(origin, shareId)`
- Handles password flow centrally with `unlockSharedResource`
- Discriminates on `resourceType` in response (missing = conversation for backward compat)
- Passes data as props to child screens — no double-fetch

### SharedFileScreen

`web-companion/src/screens/SharedFileScreen.tsx`:
- **Markdown/text files** (`content` present): rendered inline via `react-markdown` + `remark-gfm`, with "Download original" link
- **Non-text files**: download page with file icon, name, MIME label, size, and download button
- HMAC-signed `downloadUrl` passed through for password-protected files

### SharedConversationScreen

Refactored with optional `data?: SharedSession` prop. When provided by the router, skips internal fetch. Standalone usage still works.

## Limitations

- **"Live" is bounded by sync cadence** — workspace sync has 15s debounce, 5-minute throttle, 7MB upload cap. Shared content reflects the latest *synced* version, not real-time edits.
- **7MB upload cap** — files larger than 7MB cannot be synced to cloud and therefore cannot be shared.
- **No folder sharing** — files only. Folder sharing is a separate, more complex feature.
- **No mobile share creation** — mobile can view shared resources via web URLs but has no share creation flow.
- **File rename/move breaks link** — share entries reference files by workspace-relative path. Renaming or moving the file makes the share return 404.
- **One active share per resource** — re-sharing a resource that already has an active (non-expired) share returns the existing share (idempotent).
- **In-memory rate limiting** — per-machine on Fly.io. Multi-instance deployments have independent rate limit state.
- **No lazy orphan cleanup** — expired share entries are filtered from list responses, but shares whose backing file has been deleted remain in the store. They return 404 on public access ("This file is no longer available") but are not automatically removed from the store.

## Deployment Notes

- **`REBEL_SHARE_DOWNLOAD_SECRET`** — required env var on Fly.io for password-protected file downloads. If unset, password-protected file download attempts return 500. Non-password shares work without it.
- **OG preview** — `getSharePreviewData()` in `share.ts` provides title/description for social cards. Password-protected shares return null (no preview). File shares show filename + first 150 chars of stripped content.
- Cloud service deploys independently from desktop. Backend changes are backward compatible — new fields are additive.
