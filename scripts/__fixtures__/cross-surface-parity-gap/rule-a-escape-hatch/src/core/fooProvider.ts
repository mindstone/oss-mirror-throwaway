export interface FooProvider {
  ready: boolean;
}

export const NULL_FOO: FooProvider = { ready: false };
export const realFooProvider: FooProvider = { ready: true };

// CROSS_SURFACE_PARITY_EXEMPT: legit desktop-only — uses safeStorage
export function setFooProvider(provider: FooProvider): void {
  void provider;
}
