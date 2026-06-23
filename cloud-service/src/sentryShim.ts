/**
 * Sentry Shim
 *
 * Stubs out @sentry/electron since the cloud service doesn't need
 * crash reporting. The main process sentry.ts imports from
 * @sentry/electron/main which deeply references real Electron APIs.
 */

export function init(): void { /* no-op */ }
export function captureException(_err: unknown): string | undefined { return undefined; }
export function captureMessage(_msg: string): string | undefined { return undefined; }
export function setTag(_key: string, _value: string): void { /* no-op */ }
export function setContext(_name: string, _context: unknown): void { /* no-op */ }
export function setUser(_user: unknown): void { /* no-op */ }
export function addBreadcrumb(_breadcrumb: unknown): void { /* no-op */ }
export function startSpan<T>(_options: unknown, callback: () => T): T { return callback(); }
export function withScope(callback: (scope: unknown) => void): void {
  callback({
    setTag: () => {},
    setExtra: () => {},
    setLevel: () => {},
    addAttachment: () => {},
  });
}
export function close(): Promise<void> { return Promise.resolve(); }
export function flush(): Promise<void> { return Promise.resolve(); }

export const Integrations = {};
export const Handlers = {};
export const IPCMode = { Classic: 0, Protocol: 1, Both: 2 };

export default {
  init, captureException, captureMessage, setTag, setContext, setUser,
  addBreadcrumb, startSpan, withScope, close, flush,
  Integrations, Handlers,
};
