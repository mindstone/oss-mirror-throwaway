import { useMemo } from 'react';
import type { AppSettings } from '@shared/types';
import {
  createProfileConnectivity,
  getProfileConnectivityStateFromSettings,
  type ProfileConnectivity,
} from '@shared/utils/connectivityHelpers';

export function useProfileConnectivity({
  settings,
  codexConnected,
}: {
  settings: AppSettings | null | undefined;
  codexConnected: boolean;
}): ProfileConnectivity {
  const connectivityState = useMemo(
    () => getProfileConnectivityStateFromSettings(settings, { codexConnected }),
    [codexConnected, settings],
  );

  return useMemo(
    () => createProfileConnectivity(connectivityState),
    [connectivityState],
  );
}
