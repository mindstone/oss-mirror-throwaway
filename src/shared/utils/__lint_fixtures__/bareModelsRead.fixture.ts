import type { AppSettings } from '@shared/types';

export function readCanonicalModel(settings: AppSettings): string {
  return settings.models!.model;
}
