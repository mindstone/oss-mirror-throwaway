# Reference Files

This directory contains reference copies of code that lives in external repositories (e.g., Cloudflare Workers).

## How to Edit Cloudflare Workers

1. Log in to the Cloudflare dashboard
2. Navigate to: **Compute & AI** → **Workers and Pages**
3. Select the worker (see table below)
4. Click **Edit Code**
5. Make changes and click **Deploy**
6. **Update the reference file here** to keep it in sync

| Worker | URL | Cloudflare Name |
|--------|-----|-----------------|
| Meeting Bot API | rebel.mindstone.com | mindstone-rebel-meeting-bot |
| OAuth Callbacks | rebel-auth.mindstone.com | lively-lab |

---

## cloudflare-worker-reference.js

**Live location:** Cloudflare → Compute & AI → Workers and Pages → **mindstone-rebel-meeting-bot** → Edit Code

This is a reference copy of the Cloudflare Worker that handles:
- Bot creation and status polling (`/api/bot`, `/api/bot/status`)
- Transcript retrieval (`/api/transcript`)
- Local recording upload sessions (`/api/upload-session`, `/api/upload-session/status`, `/api/upload-session/transcript`)
- Recall webhooks (`/webhook/recall`)

**Last updated:** 2026-01-07

---

## cloudflare-oauth-worker-reference.js

**Live location:** Cloudflare → Compute & AI → Workers and Pages → **lively-lab** → Edit Code

This is a reference copy of the OAuth callback redirector that handles:
- `/slack/callback` → `mindstone://slack/callback`
- `/microsoft/callback` → `mindstone://microsoft/callback`
- `/salesforce/callback` → `mindstone://salesforce/callback`
- `/plaud/callback` → `mindstone://plaud/callback`
- `/github/callback` → `mindstone://github/callback`

**Last updated:** 2026-01-22

### Adding a new OAuth callback

1. Edit the live worker in Cloudflare (see navigation above)
2. Add a new route handler:
   ```javascript
   if (url.pathname.startsWith('/provider/callback')) {
     return createRedirectPage('mindstone://provider/callback' + url.search, 'Provider Name');
   }
   ```
3. Deploy the worker
4. Update `cloudflare-oauth-worker-reference.js` in this repo
5. Use `https://rebel-auth.mindstone.com/provider/callback` as the OAuth redirect URI

---

**Note:** Always check the live Cloudflare Workers for the authoritative version. These reference copies are for local development and AI agent context.
