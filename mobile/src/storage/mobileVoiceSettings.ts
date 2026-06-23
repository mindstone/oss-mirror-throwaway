/**
 * @device-scoped: default mobile voice provider is a local device preference.
 *
 * Mobile-only voice provider preference storage.
 *
 * This stores the local voice choice in AsyncStorage, NOT in shared AppSettings.
 * This prevents cloud/desktop sync corruption — mobile voice preference is device-local.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const VOICE_PROVIDER_KEY = 'rebel:mobileVoiceProvider';

export type MobileVoiceProvider = 'cloud' | 'local-moonshine';

/**
 * Get the mobile voice provider preference.
 * Returns 'cloud' (default) if no preference is stored.
 */
export async function getMobileVoiceProvider(): Promise<MobileVoiceProvider> {
  try {
    const value = await AsyncStorage.getItem(VOICE_PROVIDER_KEY);
    if (value === 'local-moonshine') return 'local-moonshine';
    return 'cloud';
  } catch {
    return 'cloud';
  }
}

/**
 * Set the mobile voice provider preference.
 */
export async function setMobileVoiceProvider(provider: MobileVoiceProvider): Promise<void> {
  await AsyncStorage.setItem(VOICE_PROVIDER_KEY, provider);
}
