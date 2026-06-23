import type { AppSettings } from '@shared/types';

export function buildClaudeMirror(settings: AppSettings): Record<string, unknown> {
  return {
    ...settings.claude,
  };
}
