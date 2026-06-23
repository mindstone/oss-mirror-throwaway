import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearAutomationScripts,
  getAutomationScript,
  listAutomationScripts,
  registerAutomationScript,
  replaceAutomationScript,
  unregisterAutomationScript,
} from '../scriptRegistry';

describe('scriptRegistry', () => {
  afterEach(() => {
    clearAutomationScripts();
  });

  it('registers and looks up a script by module id', async () => {
    const fn = vi.fn(async () => ({ summary: 'done' }));
    const unregister = registerAutomationScript('test.module', fn);

    expect(getAutomationScript('test.module')).toBe(fn);
    expect(listAutomationScripts()).toEqual(['test.module']);

    unregister();

    expect(getAutomationScript('test.module')).toBeUndefined();
  });

  it('throws on duplicate registration', () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);

    registerAutomationScript('duplicate.module', first);

    expect(() => registerAutomationScript('duplicate.module', second)).toThrow(
      'Automation script "duplicate.module" is already registered. Use replaceAutomationScript for hot-reload.',
    );
  });

  it('replaces an existing registration', () => {
    const first = vi.fn(async () => ({ summary: 'first' }));
    const second = vi.fn(async () => ({ summary: 'second' }));

    registerAutomationScript('replace.module', first);
    replaceAutomationScript('replace.module', second);

    expect(getAutomationScript('replace.module')).toBe(second);
  });

  it('unregisters a script', () => {
    const fn = vi.fn(async () => undefined);

    registerAutomationScript('remove.module', fn);
    unregisterAutomationScript('remove.module');

    expect(getAutomationScript('remove.module')).toBeUndefined();
    expect(listAutomationScripts()).toEqual([]);
  });

  it('clears the entire registry', () => {
    registerAutomationScript('one.module', vi.fn(async () => undefined));
    registerAutomationScript('two.module', vi.fn(async () => undefined));

    clearAutomationScripts();

    expect(listAutomationScripts()).toEqual([]);
  });

  it('rejects empty module ids', () => {
    expect(() => registerAutomationScript('   ', vi.fn(async () => undefined))).toThrow(
      'Automation script moduleId must be a non-empty string.',
    );
  });
});
