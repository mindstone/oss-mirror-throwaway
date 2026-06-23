/**
 * Rebel browser extension — content-script entry (Stage 6b).
 *
 * Injected lazily via `chrome.scripting.executeScript` when the bridge needs
 * to read or mutate the active tab. Never pre-injected from the manifest —
 * the user's page stays untouched until Rebel has an actual command to run.
 *
 * Protocol:
 *   - Service worker / offscreen sends `{ target: 'content', type: 'capability',
 *     capability, payload }` via `chrome.tabs.sendMessage`.
 *   - This script routes to the matching handler in `capabilityHandlers.ts`
 *     and replies `{ ok: true, data }` or `{ ok: false, code, …error fields }`.
 *
 * Errors are surfaced as structured envelopes — no thrown exceptions leak
 * across the message boundary, and no silent failures (per CODING_PRINCIPLES).
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 6b)
 */
import {
  capabilityHandlers,
  type CapabilityName,
  type ExecutionContext,
} from './capabilityHandlers';

interface ContentMessageEnvelope {
  target?: string;
  type?: string;
  capability?: string;
  payload?: unknown;
  ctx?: ExecutionContext;
}

interface ContentErrorResponse {
  ok: false;
  code:
    | 'UNKNOWN_CAPABILITY'
    | 'BAD_REQUEST'
    | 'INTERNAL_ERROR';
  reason?: string;
  error?: string;
}

interface ContentSuccessResponse {
  ok: true;
  data: unknown;
}

type ContentResponse = ContentSuccessResponse | ContentErrorResponse;

const HANDLER_NAMES: ReadonlySet<string> = new Set([
  'read_page',
  'get_selection',
  'get_current_tab_url',
  'fill_form',
  'click',
  'scroll',
]);

async function dispatch(
  capability: string,
  payload: unknown,
  ctx: ExecutionContext,
): Promise<ContentResponse> {
  if (!HANDLER_NAMES.has(capability)) {
    return {
      ok: false,
      code: 'UNKNOWN_CAPABILITY',
      reason: capability,
    };
  }

  try {
    const fn = capabilityHandlers[capability as CapabilityName] as (
      c: ExecutionContext,
      p: unknown,
    ) => unknown;
    const raw = await fn(ctx, payload ?? {});

    // `click` and `fill_form` may surface structured refusals in the data
    // envelope (e.g. `{ ok: false, code: 'BAD_REQUEST' }`). Pass them through
    // as errors so the bridge doesn't mis-classify them as success.
    if (raw && typeof raw === 'object' && (raw as { ok?: unknown }).ok === false) {
      const err = raw as ContentErrorResponse;
      return {
        ok: false,
        code: err.code ?? 'BAD_REQUEST',
        ...(err.reason ? { reason: err.reason } : {}),
        ...(err.error ? { error: err.error } : {}),
      } as ContentErrorResponse;
    }

    return { ok: true, data: raw };
  } catch (err) {
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function isContentEnvelope(v: unknown): v is ContentMessageEnvelope {
  if (!v || typeof v !== 'object') return false;
  const e = v as ContentMessageEnvelope;
  return e.target === 'content' && e.type === 'capability';
}

// Only register the listener when running in a browser page — tests import
// this module to exercise `dispatch` directly and should not trip Chrome APIs.
if (
  typeof chrome !== 'undefined'
  && typeof chrome.runtime?.onMessage?.addListener === 'function'
) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isContentEnvelope(message)) return false;
    const ctx: ExecutionContext = message.ctx ?? {};
    const capability = message.capability ?? '';
    const payload = message.payload;

    void dispatch(capability, payload, ctx).then((response) => {
      sendResponse(response);
    });
    // `true` keeps the message channel open for the async `sendResponse`.
    return true;
  });
}

export { dispatch };
