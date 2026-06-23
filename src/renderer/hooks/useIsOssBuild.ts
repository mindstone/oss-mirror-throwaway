import { useEffect, useState } from 'react';

type AuthApiWithConfigEvents = Window['authApi'] & {
  onAuthConfigReceived?: (callback: () => void) => () => void;
};

/**
 * Renderer-facing OSS build signal.
 *
 * `AuthConfigPresenceSchema` defaults `isOssBuild` to false for parsed IPC
 * payloads, but preload event callbacks do not parse the response body. Treat
 * only an explicit `true` as OSS so old/missing enterprise payloads remain
 * enterprise-compatible.
 */
export function useIsOssBuild(): boolean {
  const [isOssBuild, setIsOssBuild] = useState(false);

  useEffect(() => {
    let isMounted = true;

    const refresh = async () => {
      try {
        const config = await window.authApi?.getConfig();
        if (!isMounted) return;
        setIsOssBuild(config?.isOssBuild === true);
      } catch {
        if (!isMounted) return;
        setIsOssBuild(false);
      }
    };

    void refresh();

    const authApiWithConfigEvents = window.authApi as AuthApiWithConfigEvents | undefined;
    const subscribe =
      authApiWithConfigEvents && typeof authApiWithConfigEvents.onAuthConfigReceived === 'function'
        ? authApiWithConfigEvents.onAuthConfigReceived.bind(authApiWithConfigEvents)
        : window.api?.onAuthConfigReceived?.bind(window.api);

    const unsubscribe = subscribe
      ? subscribe(() => {
          void refresh();
        })
      : () => {};

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  return isOssBuild;
}
