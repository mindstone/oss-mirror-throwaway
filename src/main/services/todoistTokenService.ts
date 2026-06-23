/**
 * Todoist Token Service
 *
 * Reads the OAuth token from Super-MCP's token storage.
 * The token is stored by Super-MCP after the user authenticates via the Todoist MCP.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getSuperMcpOAuthTokensDir } from '../utils/testIsolation';

const log = createScopedLogger({ service: 'todoistTokenService' });

interface TodoistTokens {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
}

// Lazy getter — must NOT be a module-level constant because os.homedir() would
// evaluate at import time, before E2E test isolation redirects are active.
function getOAuthTokensDir(): string { return getSuperMcpOAuthTokensDir(); }

/**
 * Possible token file names for Todoist.
 * Super-MCP uses the server name from config, which could vary.
 */
const TODOIST_TOKEN_FILENAMES = [
  'todoist_tokens.json',
  'Todoist_tokens.json',
];

/**
 * Find the Todoist token file if it exists.
 */
const findTokenFile = async (): Promise<string | null> => {
  for (const filename of TODOIST_TOKEN_FILENAMES) {
    const tokenPath = path.join(getOAuthTokensDir(), filename);
    try {
      await fs.access(tokenPath);
      return tokenPath;
    } catch {
      // File doesn't exist, try next
    }
  }
  return null;
};

/**
 * Get the Todoist OAuth access token if available.
 * Returns null if user hasn't authenticated with Todoist yet.
 */
export const getTodoistAccessToken = async (): Promise<string | null> => {
  try {
    const tokenPath = await findTokenFile();
    if (!tokenPath) {
      log.debug('Todoist token file not found - user has not authenticated');
      return null;
    }

    const content = await fs.readFile(tokenPath, 'utf-8');
    const tokens: TodoistTokens = JSON.parse(content);

    if (!tokens.access_token) {
      log.warn('Todoist token file exists but has no access_token');
      return null;
    }

    return tokens.access_token;
  } catch (error) {
    log.error({ err: error }, 'Failed to read Todoist token');
    return null;
  }
};

/**
 * Check if the user has authenticated with Todoist.
 */
export const isTodoistAuthenticated = async (): Promise<boolean> => {
  const token = await getTodoistAccessToken();
  return token !== null;
};
