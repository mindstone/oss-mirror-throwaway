/**
 * RebelAppBridge — browser tool definitions (Stage 6b + Stage 6c).
 *
 * Every tool is a thin wrapper around one relay capability
 * (`POST /apps/browser-extension/:capability`) that the bundled extension
 * implements. Shapes are deliberately narrow so the LLM has to be explicit
 * about every mutation — see the safety contract in the plan (R10 / D15 /
 * R22 / R23).
 *
 * Stage 6c tab-targeting (R18 / D21):
 *   - DOM capabilities (`read_page`, `get_selection`, `get_current_tab_url`,
 *     `fill_form`, `click`, `scroll`) REQUIRE `tabContext` so the extension
 *     can validate the target tab is still alive. Passing the wrong or
 *     stale tabId → the bridge surfaces `TAB_CONTEXT_GONE` (410 Gone).
 *   - `status` accepts an optional `tabContext` — status is a connection
 *     probe and does not touch the DOM, so there's no tab to target.
 *
 * Keep this file in lock-step with `CAPABILITY_KEYS` in
 * `src/core/appBridge/shared/protocol.ts` — the Stage 4 consistency check
 * (`scripts/check-app-bridge-tool-registry.ts`) fails the build if they drift.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 6b, 6c)
 */
const { z } = require('zod');

/**
 * Maximum characters we'll ever render for a single selector / label input.
 * Keeps the tool description tight and matches the App Bridge 500 KB body cap.
 */
const SELECTOR_MAX = 2_048;
const LABEL_MAX = 512;
const STRING_INPUT_MAX = 16_384;

/**
 * Stage 6c tab-targeting envelope. `tabId` is the only strictly-required
 * field (the extension uses it for `chrome.tabs.get` validation); `url`
 * and `title` are echoed for logging and brand-voice error messages.
 *
 * The LLM MUST call `rebel_browser_status` first to learn the current tab's
 * tabContext, then pass it back to every DOM tool call. When the tab closes
 * mid-task the extension returns `TAB_CONTEXT_GONE` and the agent must ask
 * for a new tabContext rather than retargeting a different tab.
 */
const RequiredTabContextSchema = z
  .object({
    tabId: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Chrome tabId the command must run against. Obtain this from rebel_browser_status; do not guess.',
      ),
    windowId: z.number().int().nonnegative().optional(),
    url: z
      .string()
      .max(2048)
      .optional()
      .describe('Expected URL of the target tab; used only for breadcrumbs.'),
    title: z
      .string()
      .max(1024)
      .optional()
      .describe('Expected title of the target tab; used only for breadcrumbs.'),
  })
  .describe(
    'Identifies the browser tab this command should run against. The LLM must supply this from a prior rebel_browser_status call. If omitted or stale, the extension returns TAB_CONTEXT_GONE and the agent should re-check the tab.',
  );

/** Optional tabContext — used by `status`, which doesn't target a tab. */
const OptionalTabContextSchema = RequiredTabContextSchema.optional();

const InternalBrowserContextShape = {
  __rebel_conversation_id: z
    .string()
    .max(256)
    .optional()
    .describe('Internal Rebel routing context injected automatically. Leave unset.'),
};

const FillFormFieldSchema = z.object({
  selector: z
    .string()
    .min(1, 'selector must be a non-empty CSS selector')
    .max(SELECTOR_MAX)
    .describe('CSS selector identifying the field, e.g. "#email" or "input[name=q]".'),
  value: z
    .string()
    .max(STRING_INPUT_MAX)
    .describe('The string to set on the field. Empty string clears the field.'),
  includeSensitive: z
    .boolean()
    .optional()
    .describe(
      'Explicit opt-in for password / OTP / payment / hidden / file fields. Without it, sensitive fields are denied by default and the user will see per-field approval cards.',
    ),
  elementLabel: z
    .string()
    .max(LABEL_MAX)
    .optional()
    .describe(
      "The visible label you believe this field has (aria-label / associated <label> / placeholder). The extension re-reads this at execution and rejects the field if it changed — prevents TOCTOU against page mutations between approval and execution.",
    ),
});

const BROWSER_TOOLS = [
  {
    name: 'rebel_browser_status',
    capability: 'status',
    title: 'Check browser connection',
    description:
      "Check whether the Rebel browser extension is paired and reachable, and return " +
      "the user's currently-focused tabContext ({ tabId, windowId, url, title }). Call " +
      "this first when a user asks what I can see in their browser, when any other " +
      "rebel_browser_* tool has failed with 'not connected', or to refresh the tabContext " +
      "before targeting DOM capabilities. Returns the connection state, current tabContext, " +
      "and the list of currently-registered capabilities.",
    inputSchema: z.object({
      ...InternalBrowserContextShape,
      tabContext: OptionalTabContextSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'rebel_browser_read_page',
    capability: 'read_page',
    title: 'Read a specific browser tab',
    description:
      "Read a specific tab's title, URL, and main text content from the user's paired " +
      "browser. You MUST pass the `tabContext` obtained from a prior rebel_browser_status " +
      "call — the extension uses tabId to validate the target tab still exists. If the " +
      "tab has closed or navigated you'll get TAB_CONTEXT_GONE; in that case re-check " +
      "via rebel_browser_status and try again. Text is capped at 200k characters; " +
      "`truncated: true` in the response means you should ask for a narrower section or a summary.",
    inputSchema: z.object({
      ...InternalBrowserContextShape,
      tabContext: RequiredTabContextSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'rebel_browser_get_selection',
    capability: 'get_selection',
    title: 'Get the selected text on a specific tab',
    description:
      "Return whatever text the user has selected on the given tab. Empty selection " +
      "returns an empty string — not an error. You MUST pass `tabContext` from a prior " +
      "rebel_browser_status call so the extension can target the right tab; otherwise " +
      "you'll get TAB_CONTEXT_GONE.",
    inputSchema: z.object({
      ...InternalBrowserContextShape,
      tabContext: RequiredTabContextSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'rebel_browser_get_current_tab_url',
    capability: 'get_current_tab_url',
    title: 'Get the URL of a specific tab',
    description:
      "Return the URL and title of the given browser tab. Useful to confirm which page " +
      "you're about to act on before a destructive action. You MUST pass `tabContext` " +
      "from a prior rebel_browser_status call.",
    inputSchema: z.object({
      ...InternalBrowserContextShape,
      tabContext: RequiredTabContextSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'rebel_browser_fill_form',
    capability: 'fill_form',
    title: 'Fill form fields in a specific tab',
    description:
      "Fill one or more form fields in the given browser tab. Each field needs a CSS " +
      "selector and the value to set. Sensitive fields (password / OTP / credit-card / " +
      "hidden / file-upload) are denied by default — the user has to approve each one. " +
      "If you know a field is sensitive AND the user explicitly asked, set `includeSensitive: true` " +
      "on that field so the per-field approval card can surface. Provide `elementLabel` with " +
      "the visible label you see — the extension re-reads it before filling to catch pages " +
      "that change between approval and execution. You MUST pass `tabContext` from a prior " +
      "rebel_browser_status call. Does not submit the form.",
    inputSchema: z.object({
      ...InternalBrowserContextShape,
      tabContext: RequiredTabContextSchema,
      fields: z
        .array(FillFormFieldSchema)
        .min(1, 'fill_form requires at least one field')
        .max(50),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'rebel_browser_click',
    capability: 'click',
    title: 'Click an element in a specific tab',
    description:
      "Click a DOM element in the given browser tab. You must provide `tabContext` (from " +
      "a prior rebel_browser_status call), a CSS selector, AND the visible label you " +
      "believe the element has (button text, aria-label, or title). The extension rejects " +
      "the click if the label changed between your approval and the click — this stops " +
      "the page from switching buttons on us. Destructive labels (e.g. \"Delete\", \"Pay\", " +
      "\"Cancel subscription\") always require explicit user approval.",
    inputSchema: z.object({
      ...InternalBrowserContextShape,
      tabContext: RequiredTabContextSchema,
      selector: z
        .string()
        .min(1, 'selector must be a non-empty CSS selector')
        .max(SELECTOR_MAX)
        .describe('CSS selector identifying the element to click.'),
      elementLabel: z
        .string()
        .min(1, 'elementLabel is required — describe the button text the user sees')
        .max(LABEL_MAX)
        .describe(
          'The visible label of the element as the user sees it. The extension compares this to the live label at execution and refuses if it changed.',
        ),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'rebel_browser_scroll',
    capability: 'scroll',
    title: 'Scroll a specific tab',
    description:
      "Scroll the given browser tab to a specific vertical position (in pixels). Use " +
      "when the user wants to jump to a known spot on a long page. Pass `y: 0` to scroll " +
      "to the top. You MUST pass `tabContext` from a prior rebel_browser_status call.",
    inputSchema: z.object({
      ...InternalBrowserContextShape,
      tabContext: RequiredTabContextSchema,
      y: z
        .number()
        .int('y must be an integer number of pixels')
        .nonnegative()
        .describe('Target scroll position in pixels from the top of the document.'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
];

module.exports = { BROWSER_TOOLS };
