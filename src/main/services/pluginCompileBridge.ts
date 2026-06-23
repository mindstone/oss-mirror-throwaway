import { BrowserWindow, MessageChannelMain } from 'electron';
import { createScopedLogger } from '@core/logger';
import {
  CompileAndRegisterPluginResponseSchema,
  type CompileAndRegisterPluginRequest,
  type CompileAndRegisterPluginResponse,
} from '@shared/ipc/schemas/plugins';

const log = createScopedLogger({ service: 'pluginCompileBridge' });

const COMPILE_AND_REGISTER_CHANNEL = 'plugins:compile-and-register';
const COMPILE_AND_REGISTER_TIMEOUT_MS = 30_000;

const createRuntimeErrorResponse = (message: string): CompileAndRegisterPluginResponse => ({
  ok: false,
  errors: [{ type: 'runtime', message }],
});

let mainWindowGetter: (() => BrowserWindow | null) | null = null;

export function setPluginCompileMainWindow(getter: () => BrowserWindow | null): void {
  mainWindowGetter = getter;
}

const getRendererWindow = (): BrowserWindow | null => {
  if (mainWindowGetter) {
    const win = mainWindowGetter();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      return win;
    }
  }

  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: plugin compile bridge uses injected main-window getter first; fallback is target-picking debt to migrate later.
  const allWindows = BrowserWindow.getAllWindows();
  for (const win of allWindows) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      return win;
    }
  }

  return null;
};

export async function requestPluginCompileAndRegister(
  request: CompileAndRegisterPluginRequest,
): Promise<CompileAndRegisterPluginResponse> {
  const targetWindow = getRendererWindow();
  if (!targetWindow) {
    return createRuntimeErrorResponse('No renderer window is available to compile plugins.');
  }

  const { port1, port2 } = new MessageChannelMain();

  return await new Promise<CompileAndRegisterPluginResponse>((resolve) => {
    let settled = false;
    // eslint-disable-next-line prefer-const -- declared before settle/timeout mutual reference
    let timeout: NodeJS.Timeout;

    function settle(result: CompileAndRegisterPluginResponse) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try {
        port1.close();
      } catch {
        // Ignore close errors during cleanup.
      }
      try {
        port2.close();
      } catch {
        // Ignore close errors during cleanup.
      }
      resolve(result);
    }

    timeout = setTimeout(() => {
      settle(createRuntimeErrorResponse('Timed out waiting for renderer plugin compile response.'));
    }, COMPILE_AND_REGISTER_TIMEOUT_MS);

    port1.on('message', (event) => {
      const parsed = CompileAndRegisterPluginResponseSchema.safeParse(event.data);
      if (!parsed.success) {
        log.warn({ issues: parsed.error.issues }, 'Renderer returned invalid plugin compile response');
        settle(createRuntimeErrorResponse('Renderer returned an invalid plugin compile response.'));
        return;
      }

      settle(parsed.data);
    });

    port1.on('close', () => {
      if (!settled) {
        settle(createRuntimeErrorResponse('Renderer closed plugin compile response channel before replying.'));
      }
    });

    try {
      port1.start();
      targetWindow.webContents.postMessage(COMPILE_AND_REGISTER_CHANNEL, request, [port2]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      settle(createRuntimeErrorResponse(`Failed to dispatch plugin compile request: ${message}`));
    }
  });
}
