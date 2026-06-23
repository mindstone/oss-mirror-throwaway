import type { CurrentUserProvider, CurrentUserSnapshot } from '@core/currentUserProvider';

export class CloudCurrentUserProvider implements CurrentUserProvider {
  getCurrentUser(): CurrentUserSnapshot | null {
    return null;
  }
}
