// mobile/src/storage/secureTokenStorage.ts

import * as SecureStore from 'expo-secure-store';
import type { TokenStorage } from '@rebel/cloud-client';

const SECURE_KEY_CLOUD_URL = 'rebel_cloud_url';
const SECURE_KEY_TOKEN = 'rebel_token';
const SECURE_KEY_CLIENT_ID = 'rebel_client_id';

export const secureTokenStorage: TokenStorage = {
  async getToken() {
    const cloudUrl = await SecureStore.getItemAsync(SECURE_KEY_CLOUD_URL);
    const token = await SecureStore.getItemAsync(SECURE_KEY_TOKEN);
    if (cloudUrl && token) {
      return { cloudUrl, token };
    }
    return null;
  },

  async setToken(cloudUrl: string, token: string) {
    await SecureStore.setItemAsync(SECURE_KEY_CLOUD_URL, cloudUrl);
    await SecureStore.setItemAsync(SECURE_KEY_TOKEN, token);
  },

  async clearToken() {
    await SecureStore.deleteItemAsync(SECURE_KEY_CLOUD_URL);
    await SecureStore.deleteItemAsync(SECURE_KEY_TOKEN);
  },

  async getClientId() {
    return SecureStore.getItemAsync(SECURE_KEY_CLIENT_ID);
  },

  async setClientId(clientId: string) {
    await SecureStore.setItemAsync(SECURE_KEY_CLIENT_ID, clientId);
  },
};
