/**
 * Fire-and-forget: safely detach a promise, logging any rejection.
 *
 * Use this instead of `void someAsyncFn()` which silently swallows rejections.
 * The label parameter is required for debuggability — it identifies which
 * call site failed in logs.
 *
 * @example
 * fireAndForget(submitQueuedMessage(text, 'text'), 'handleAskRebel');
 */
export function fireAndForget(promise: Promise<unknown> | void, label: string): void {
  Promise.resolve(promise).catch((err: unknown) => {
    console.error(`[fireAndForget:${label}]`, err);
  });
}
