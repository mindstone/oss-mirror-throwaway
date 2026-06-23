const LOOPBACK_URL_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i;

export function isLocalhostUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return LOOPBACK_URL_REGEX.test(url);
}
