import type { CurrentUserProvider, CurrentUserSnapshot } from '@core/currentUserProvider';

export class StandaloneCurrentUserProvider implements CurrentUserProvider {
  getCurrentUser(): CurrentUserSnapshot | null {
    return null;
  }
}
