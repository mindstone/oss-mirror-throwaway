import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createScopedLogger } from '@core/logger';
import { attachBenignSocketErrorGuard } from '@core/utils/socketErrorGuard';
import {
  bundledInboxBridgeStateReducer,
  handleBundledInboxBridgeRequest,
  resetPassThroughRevisitForTests,
  setAutomationSchedulerGetter,
  setMeetingBotServiceGetter,
  setBundledInboxBridgeToken,
} from '@core/services/inbox/inboxBridgeStateMachine';

const log = createScopedLogger({ service: 'bundledInboxBridge' });

interface BridgeState {
  server: http.Server;
  port: number;
  token: string;
}

let bridgeState: BridgeState | null = null;

export {
  bundledInboxBridgeStateReducer,
  resetPassThroughRevisitForTests,
  setAutomationSchedulerGetter,
  setMeetingBotServiceGetter,
};

export const startBundledInboxBridge = async (): Promise<{ port: number; token: string }> => {
  if (bridgeState) {
    return { port: bridgeState.port, token: bridgeState.token };
  }

  const token = randomBytes(32).toString('hex');
  setBundledInboxBridgeToken(token);
  const server = http.createServer((req, res) => void handleBundledInboxBridgeRequest(req, res));
  attachBenignSocketErrorGuard(server); // REBEL-5J5: swallow benign per-connection socket errors

  try {
    const port = await new Promise<number>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to determine bridge port.'));
          return;
        }
        resolve(address.port);
      });
      server.on('error', reject);
    });

    bridgeState = { server, port, token };
    log.info({ port }, 'Bundled MCP inbox bridge ready');
    return { port, token };
  } catch (error) {
    setBundledInboxBridgeToken(null);
    throw error;
  }
};

export const stopBundledInboxBridge = async (): Promise<void> => {
  if (!bridgeState) {
    return;
  }

  const { server } = bridgeState;
  bridgeState = null;
  setBundledInboxBridgeToken(null);

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
};

export const getBundledInboxBridgeEnv = (): Record<string, string> | null => {
  if (!bridgeState) {
    return null;
  }

  return {
    MINDSTONE_BUNDLED_BRIDGE_PORT: String(bridgeState.port),
    MINDSTONE_BUNDLED_BRIDGE_TOKEN: bridgeState.token,
  };
};

/** @deprecated Use startBundledInboxBridge */
export const startBundledTaskBridge = startBundledInboxBridge;
/** @deprecated Use stopBundledInboxBridge */
export const stopBundledTaskBridge = stopBundledInboxBridge;
/** @deprecated Use getBundledInboxBridgeEnv */
export const getBundledTaskBridgeEnv = getBundledInboxBridgeEnv;
