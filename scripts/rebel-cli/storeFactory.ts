import { setStoreFactory } from '@core/storeFactory';
import CloudStore from '../../cloud-service/src/electronStoreShim';

export function initializeStandaloneStoreFactory(): void {
  setStoreFactory((opts) => new CloudStore(opts as any) as any);
}
