import type { ActiveProvider } from '@shared/types';

type SlashFormRouteSettings = {
  activeProvider?: ActiveProvider;
  openRouter?: {
    oauthToken?: string | null;
  } | null;
};

export function canRouteSlashFormModel(settings: SlashFormRouteSettings): boolean {
  // Closed set: slash-form models are routable only through personal OpenRouter OAuth
  // or Mindstone-managed routing. Keep this explicit so future providers are added intentionally.
  return settings.activeProvider === 'mindstone' || !!settings.openRouter?.oauthToken;
}
