/**
 * Pure helper that resolves whether a message should be hidden and what
 * `messageOrigin` to stamp, given the caller's `receiptText` and explicit
 * `options.isHidden` signals.
 *
 * Three hide-signalling concepts coexist:
 *  - `receiptText` → hide AND inject a compact receipt chip (approval / memory / staged-tool).
 *  - `options.isHidden` → hide only; no receipt chip (AskUserQuestion continuations).
 *  - Neither → the message is user-visible (e.g. `onContinueIncomplete`).
 *
 * When either hide signal is active, `messageOrigin` is stamped as
 * `'system-continuation'` so downstream consumers have an authoritative
 * non-textual signal independent of message text content.
 */
export function resolveSendMessageOptions(params: {
  receiptText?: string;
  options?: { isHidden?: boolean };
}): { shouldHide: boolean; messageOrigin?: 'system-continuation' } {
  const shouldHide = Boolean(params.receiptText) || Boolean(params.options?.isHidden);
  return {
    shouldHide,
    messageOrigin: shouldHide ? 'system-continuation' : undefined,
  };
}
