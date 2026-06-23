export interface FooProvider {
  ready: boolean;
}

export const NULL_FOO: FooProvider = { ready: false };
export const realFooProvider: FooProvider = { ready: true };

export function setFooProvider(provider: FooProvider): void {
  void provider;
}
