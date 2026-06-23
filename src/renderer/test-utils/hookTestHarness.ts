import { vi } from 'vitest';

type GlobalWithActEnvironment = typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type GlobalWithAnimationFrame = typeof globalThis & {
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
};

type WindowWithNamedApis = Window & Record<string, unknown>;

// Enable React act() environment for custom hook rendering.
(globalThis as GlobalWithActEnvironment).IS_REACT_ACT_ENVIRONMENT = true;

// Use require() to avoid Vite import-analysis issues in renderer hook tests.
const React = require('react') as typeof import('react');
const ReactDOMClient = require('react-dom/client') as typeof import('react-dom/client');
const { act: reactAct } = React;

type AnyProps = Record<string, unknown>;

export type RenderHookOptions<TProps> = {
  initialProps?: TProps;
};

export type RenderHookResult<TResult, TProps> = {
  result: { current: TResult };
  rerender: (props: TProps) => void;
  unmount: () => void;
};

export function renderHook<TResult, TProps = AnyProps>(
  hookFn: (props: TProps) => TResult,
  options?: RenderHookOptions<TProps>,
): RenderHookResult<TResult, TProps> {
  const result = { current: undefined as unknown as TResult };
  let renderError: Error | null = null;

  class ErrorBoundary extends React.Component<
    { children: React.ReactNode },
    { hasError: boolean }
  > {
    state = { hasError: false };

    static getDerivedStateFromError() {
      return { hasError: true };
    }

    componentDidCatch(error: Error) {
      renderError = error;
    }

    render() {
      return this.state.hasError ? null : this.props.children;
    }
  }

  const TestComponent = (props: TProps) => {
    result.current = hookFn(props);
    return null;
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);

  reactAct(() => {
    root.render(
      React.createElement(
        ErrorBoundary,
        null,
        // Generic hook wrapper — TProps is unconstrained, so we bypass createElement overloads
        (React.createElement as (...args: unknown[]) => React.ReactElement)(TestComponent, options?.initialProps ?? ({} as TProps)),
      ),
    );
  });

  if (renderError) {
    const error = renderError as Error;
    reactAct(() => {
      root.unmount();
    });
    container.remove();
    throw new Error(`Hook threw during render: ${error.message}`, { cause: error });
  }

  return {
    result,
    rerender: (props: TProps) => {
      renderError = null;
      reactAct(() => {
        root.render(
          React.createElement(
            ErrorBoundary,
            null,
            (React.createElement as (...args: unknown[]) => React.ReactElement)(TestComponent, props),
          ),
        );
      });

      if (renderError) {
        const error = renderError as Error;
        throw new Error(`Hook threw during rerender: ${error.message}`, { cause: error });
      }
    },
    unmount: () => {
      reactAct(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

export function act(
  callback: Parameters<typeof reactAct>[0],
): ReturnType<typeof reactAct> {
  return reactAct(callback);
}

export async function flushAsync(): Promise<void> {
  await reactAct(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

export function createMockWindowApi<T extends Record<string, unknown>>(
  apiName: string,
  methods: T,
): T {
  (window as unknown as WindowWithNamedApis)[apiName] = methods;
  return methods;
}

type IpcListener = (...args: unknown[]) => void;

export function createMockIpcListeners() {
  const listeners: Record<string, IpcListener[]> = {};

  const api = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => {
      if (typeof prop === 'string' && prop.startsWith('on')) {
        return (callback: IpcListener) => {
          listeners[prop] = listeners[prop] || [];
          listeners[prop].push(callback);
          return () => {
            listeners[prop] = listeners[prop].filter((listener) => listener !== callback);
          };
        };
      }
      return vi.fn();
    },
  });

  return {
    api,
    emit: (event: string, ...args: unknown[]) => {
      (listeners[event] || []).forEach((callback) => callback(...args));
    },
    listeners,
  };
}

let restoreRequestAnimationFrame: (() => void) | null = null;
let restoreCancelAnimationFrame: (() => void) | null = null;

function resetAnimationFrameMocks() {
  if (restoreRequestAnimationFrame) {
    restoreRequestAnimationFrame();
    restoreRequestAnimationFrame = null;
  }

  if (restoreCancelAnimationFrame) {
    restoreCancelAnimationFrame();
    restoreCancelAnimationFrame = null;
  }
}

export function setupFakeTimers(): void {
  resetAnimationFrameMocks();
  vi.useFakeTimers();
  const globalWithAnimationFrame = globalThis as GlobalWithAnimationFrame;

  if (typeof globalThis.requestAnimationFrame === 'function') {
    const requestAnimationFrameSpy = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        return setTimeout(() => callback(Date.now()), 16) as unknown as number;
      });
    restoreRequestAnimationFrame = () => requestAnimationFrameSpy.mockRestore();
  } else {
    const originalRequestAnimationFrame = globalWithAnimationFrame.requestAnimationFrame;
    globalWithAnimationFrame.requestAnimationFrame = (callback: FrameRequestCallback) => {
      return setTimeout(() => callback(Date.now()), 16) as unknown as number;
    };
    restoreRequestAnimationFrame = () => {
      if (originalRequestAnimationFrame === undefined) {
        delete (globalWithAnimationFrame as { requestAnimationFrame?: unknown }).requestAnimationFrame;
      } else {
        globalWithAnimationFrame.requestAnimationFrame = originalRequestAnimationFrame;
      }
    };
  }

  if (typeof globalThis.cancelAnimationFrame === 'function') {
    const cancelAnimationFrameSpy = vi
      .spyOn(globalThis, 'cancelAnimationFrame')
      .mockImplementation((frameId: number) => {
        clearTimeout(frameId);
      });
    restoreCancelAnimationFrame = () => cancelAnimationFrameSpy.mockRestore();
  } else {
    const originalCancelAnimationFrame = globalWithAnimationFrame.cancelAnimationFrame;
    globalWithAnimationFrame.cancelAnimationFrame = (frameId: number) => {
      clearTimeout(frameId);
    };
    restoreCancelAnimationFrame = () => {
      if (originalCancelAnimationFrame === undefined) {
        delete (globalWithAnimationFrame as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
      } else {
        globalWithAnimationFrame.cancelAnimationFrame = originalCancelAnimationFrame;
      }
    };
  }
}

export function cleanupFakeTimers(): void {
  resetAnimationFrameMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
}
