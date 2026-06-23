export interface CurrentUserSnapshot {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}

export interface CurrentUserProvider {
  getCurrentUser(): CurrentUserSnapshot | null;
}

export type CurrentUserProviderFactory = () => CurrentUserProvider;

let _factory: CurrentUserProviderFactory | undefined;
let _instance: CurrentUserProvider | undefined;

export function setCurrentUserProviderFactory(factory: CurrentUserProviderFactory): void {
  _factory = factory;
  _instance = undefined;
}

export function getCurrentUserProvider(): CurrentUserProvider {
  if (_instance) return _instance;
  if (!_factory) {
    throw new Error(
      'CurrentUserProvider not initialized. Call setCurrentUserProviderFactory() before use.',
    );
  }
  _instance = _factory();
  return _instance;
}
