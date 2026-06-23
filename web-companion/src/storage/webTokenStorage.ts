// web-companion/src/storage/webTokenStorage.ts

import type { TokenStorage } from '@rebel/cloud-client';

const KEY_CLOUD_URL = 'rebel_cloud_url';
const KEY_TOKEN = 'rebel_token';

/**
 * TokenStorage implementation using localStorage.
 * User stays logged in across browser sessions (tab close/reopen).
 */
export const webTokenStorage: TokenStorage = {
  async getToken() {
    try {
      const cloudUrl = localStorage.getItem(KEY_CLOUD_URL);
      const token = localStorage.getItem(KEY_TOKEN);
      if (cloudUrl && token) {
        return { cloudUrl, token };
      }
    } catch {
      // localStorage unavailable (private browsing, storage full, etc.)
    }
    return null;
  },

  async setToken(cloudUrl: string, token: string) {
    try {
      localStorage.setItem(KEY_CLOUD_URL, cloudUrl);
      localStorage.setItem(KEY_TOKEN, token);
    } catch {
      // Storage write failed — continue with in-memory only
    }
  },

  async clearToken() {
    try {
      localStorage.removeItem(KEY_CLOUD_URL);
      localStorage.removeItem(KEY_TOKEN);
    } catch {
      // Best-effort cleanup
    }
  },
};
