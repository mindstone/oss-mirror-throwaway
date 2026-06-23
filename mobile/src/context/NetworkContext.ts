import { createContext, useContext } from 'react';

export interface NetworkContextValue {
  isOnline: boolean;
  isInternetReachable: boolean | null;
  isConnected: boolean;
}

export const NetworkContext = createContext<NetworkContextValue>({
  isOnline: true,
  isInternetReachable: null,
  isConnected: true,
});

export function useNetworkContext(): NetworkContextValue {
  return useContext(NetworkContext);
}
