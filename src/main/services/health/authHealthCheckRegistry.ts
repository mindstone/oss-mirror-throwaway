import type { PrivateMindstoneHealthCheck } from '@core/services/privateMindstoneBootstrap';

const defaultAuthHealthCheck: PrivateMindstoneHealthCheck = () => ({
  id: 'authHealth',
  name: 'Authentication',
  status: 'warn',
  message: 'Authentication health check has not been registered',
});

let authHealthCheck: PrivateMindstoneHealthCheck = defaultAuthHealthCheck;

export function setAuthHealthCheck(check: PrivateMindstoneHealthCheck): void {
  authHealthCheck = check;
}

export function getAuthHealthCheck(): PrivateMindstoneHealthCheck {
  return authHealthCheck;
}
