import type { AppSettings } from '@shared/types';

export function readModelViaAlias(settings: AppSettings): string {
  const c = settings.claude!;
  return c.model;
}
