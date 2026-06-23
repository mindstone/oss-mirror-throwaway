export const createId = (): string => {
  const globalCrypto = typeof globalThis !== 'undefined' ? (globalThis as typeof globalThis & { crypto?: Crypto })?.crypto : undefined;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    try {
      return globalCrypto.randomUUID();
    } catch {
      // fall through
    }
  }
  return Math.random().toString(36).slice(2);
};
