import type { AppSettings } from '@shared/types';

export function readApiKey(settings: AppSettings): string | null {
  return settings.claude!.apiKey;
}
