import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PersistenceAdapter } from '@rebel/cloud-client';

const KEY_PREFIX = 'rebel-cache:';

export const asyncStoragePersistence: PersistenceAdapter = {
  async getItem(key: string): Promise<string | null> {
    return AsyncStorage.getItem(KEY_PREFIX + key);
  },

  async setItem(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(KEY_PREFIX + key, value);
  },

  async removeItem(key: string): Promise<void> {
    await AsyncStorage.removeItem(KEY_PREFIX + key);
  },

  async getAllKeys(): Promise<string[]> {
    const allKeys = await AsyncStorage.getAllKeys();
    return allKeys
      .filter((k) => k.startsWith(KEY_PREFIX))
      .map((k) => k.slice(KEY_PREFIX.length));
  },
};
