const LOCAL_ONLY_SETTINGS_KEYS_ARRAY = [
  'coreDirectory',
  'someProvider',
] as const;

export const LOCAL_ONLY_SETTINGS_KEYS = new Set(LOCAL_ONLY_SETTINGS_KEYS_ARRAY);
