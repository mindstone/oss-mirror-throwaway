import { useMemo } from 'react';
import { useSessionStore, type ExternalContext } from '@rebel/cloud-client';

type MobileSlackExternalContext = Extract<
  ExternalContext,
  { kind: 'slack-thread' | 'slack-mention-poll' }
>;

export interface MobileExternalContextEntry {
  appId: 'slack';
  externalContext: MobileSlackExternalContext;
}

function isMobileSlackExternalContext(
  externalContext: ExternalContext | undefined,
): externalContext is MobileSlackExternalContext {
  return (
    externalContext?.kind === 'slack-thread' ||
    externalContext?.kind === 'slack-mention-poll'
  );
}

export function useExternalContextForMobileSession(
  sessionId: string | null | undefined,
): MobileExternalContextEntry | undefined {
  const externalContext = useSessionStore((state) => {
    if (!sessionId || state.currentSession?.id !== sessionId) return undefined;
    return state.currentSession.externalContext;
  });

  return useMemo(() => {
    if (!isMobileSlackExternalContext(externalContext)) {
      return undefined;
    }

    return {
      appId: 'slack',
      externalContext,
    };
  }, [externalContext]);
}
