/**
 * Default `CodexAuthProvider` — the real implementation used on desktop AND
 * cloud. Delegates to `codexAuthCore` (pure HTTP + storeFactory).
 *
 * Why a single impl? Previously we registered `NULL_CODEX_AUTH_PROVIDER` on
 * cloud, which silently disabled ChatGPT Pro anywhere that wasn't desktop.
 * That defeated the point of running the cloud service as a user's personal
 * home for their settings + subscription. With token storage + refresh now in
 * core, the same provider works identically everywhere — the only surface-
 * specific bit (interactive OAuth login) is invoked on desktop and the
 * resulting tokens are synced to cloud via the `codex:sync-tokens` channel.
 */

import type { CodexAuthProvider } from '@core/codexAuth';
import {
  forceRefreshCodexAccessToken,
  getCodexAccessToken,
  getCodexAccountId,
  getCodexStatus,
  isCodexConnected,
} from './codexAuthCore';

export const DEFAULT_CODEX_AUTH_PROVIDER: CodexAuthProvider = {
  isConnected: isCodexConnected,
  getAccessToken: getCodexAccessToken,
  getAccountId: getCodexAccountId,
  forceRefreshToken: forceRefreshCodexAccessToken,
  getStatus: getCodexStatus,
};
