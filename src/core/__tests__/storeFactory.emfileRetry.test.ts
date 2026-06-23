import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyValueStore } from '@core/store';

interface TestStoreState extends Record<string, unknown> {
  value: string;
}

const makeEmfileError = (): NodeJS.ErrnoException => {
  const err: NodeJS.ErrnoException = new Error('EMFILE: too many open files');
  err.code = 'EMFILE';
  return err;
};

describe('StoreFactory EMFILE retry wrapper', () => {
  let setStoreFactory: typeof import('@core/storeFactory').setStoreFactory;
  let createStore: typeof import('@core/storeFactory').createStore;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@core/storeFactory');
    setStoreFactory = mod.setStoreFactory;
    createStore = mod.createStore;
  });

  const installBackingStore = (backingStore: KeyValueStore<TestStoreState>): void => {
    setStoreFactory(<T extends Record<string, unknown>>() =>
      backingStore as unknown as KeyValueStore<T>
    );
  };

  it('retries get() once on EMFILE', () => {
    const emfile = makeEmfileError();
    let attempts = 0;

    const backingStore = {
      get: vi.fn(() => {
        attempts++;
        if (attempts === 1) {
          throw emfile;
        }
        return 'ok';
      }),
      set: vi.fn(),
      has: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
      store: { value: 'ok' },
      path: '/mock/test.json',
    } as unknown as KeyValueStore<TestStoreState>;

    installBackingStore(backingStore);

    const store = createStore<TestStoreState>({
      name: 'test',
      defaults: { value: 'default' },
    });

    expect(store.get('value')).toBe('ok');
    expect(backingStore.get).toHaveBeenCalledTimes(2);
  });

  it('retries set() once on EMFILE', () => {
    const emfile = makeEmfileError();
    let attempts = 0;

    const backingStore = {
      get: vi.fn(),
      set: vi.fn(() => {
        attempts++;
        if (attempts === 1) {
          throw emfile;
        }
      }),
      has: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
      store: { value: 'ok' },
      path: '/mock/test.json',
    } as unknown as KeyValueStore<TestStoreState>;

    installBackingStore(backingStore);

    const store = createStore<TestStoreState>({
      name: 'test',
      defaults: { value: 'default' },
    });

    expect(() => store.set('value', 'ok')).not.toThrow();
    expect(backingStore.set).toHaveBeenCalledTimes(2);
  });

  it('retries .store reads once on EMFILE', () => {
    const emfile = makeEmfileError();
    let attempts = 0;

    const backingStore = {
      get: vi.fn(),
      set: vi.fn(),
      has: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
      get store() {
        attempts++;
        if (attempts === 1) {
          throw emfile;
        }
        return { value: 'ok' };
      },
      set store(_value: TestStoreState) {},
      path: '/mock/test.json',
    } as unknown as KeyValueStore<TestStoreState>;

    installBackingStore(backingStore);

    const store = createStore<TestStoreState>({
      name: 'test',
      defaults: { value: 'default' },
    });

    expect(store.store).toEqual({ value: 'ok' });
    expect(attempts).toBe(2);
  });

  it('retries .store writes once on EMFILE', () => {
    const emfile = makeEmfileError();
    let attempts = 0;

    const backingStore = {
      get: vi.fn(),
      set: vi.fn(),
      has: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
      get store() {
        return { value: 'old' };
      },
      set store(_value: TestStoreState) {
        attempts++;
        if (attempts === 1) {
          throw emfile;
        }
      },
      path: '/mock/test.json',
    } as unknown as KeyValueStore<TestStoreState>;

    installBackingStore(backingStore);

    const store = createStore<TestStoreState>({
      name: 'test',
      defaults: { value: 'default' },
    });

    expect(() => {
      store.store = { value: 'ok' };
    }).not.toThrow();
    expect(attempts).toBe(2);
  });
});
