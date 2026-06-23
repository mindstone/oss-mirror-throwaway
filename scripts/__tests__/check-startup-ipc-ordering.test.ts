import { describe, expect, it } from 'vitest';

import { scanSourceForStartupIpcOrdering } from '../check-startup-ipc-ordering';

describe('check-startup-ipc-ordering', () => {
  it('(a) passes when startup registrations happen before createWindow()', () => {
    const source = [
      "const createWindow = async () => {};",
      "ipcMain.handle('early', async () => {});",
      'registerAlphaHandlers({});',
      'async function bootstrap() {',
      '  await createWindow();',
      '}',
    ].join('\n');

    const result = scanSourceForStartupIpcOrdering(source, 'fixture-clean.ts');
    expect(result.violations).toHaveLength(0);
  });

  it('(b) fails when top-level ipcMain.handle() appears after await createWindow()', () => {
    const source = [
      "const createWindow = async () => {};",
      'async function bootstrap() {',
      '  await createWindow();',
      '}',
      "ipcMain.handle('foo', async () => {});",
    ].join('\n');

    const result = scanSourceForStartupIpcOrdering(source, 'fixture-late-handle.ts');
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      file: 'fixture-late-handle.ts',
      createWindowLine: 3,
    });
    expect(result.violations[0]?.code).toContain("ipcMain.handle('foo'");
  });

  it('(c) fails when late ipcMain.handle() has STARTUP_LATE_REGISTRATION_OK sentinel (hard-fail)', () => {
    const source = [
      "const createWindow = async () => {};",
      'async function bootstrap() {',
      '  await createWindow();',
      '}',
      '// STARTUP_LATE_REGISTRATION_OK: late registration is required for backwards compatibility',
      "ipcMain.handle('foo', async () => {});",
    ].join('\n');

    const result = scanSourceForStartupIpcOrdering(source, 'fixture-sentinel.ts');
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe('ipcMain.handle');
  });

  it("(d) passes when late ipcMain.handle() is inside app.on('activate', ...) callback", () => {
    const source = [
      "const createWindow = async () => {};",
      'async function bootstrap() {',
      '  await createWindow();',
      '}',
      "app.on('activate', async () => {",
      "  ipcMain.handle('activate-safe', async () => {});",
      '});',
    ].join('\n');

    const result = scanSourceForStartupIpcOrdering(source, 'fixture-activate.ts');
    expect(result.violations).toHaveLength(0);
  });

  it('(e) fails when late register*Handlers() appears after createWindow()', () => {
    const source = [
      "const createWindow = async () => {};",
      'async function bootstrap() {',
      '  await createWindow();',
      '}',
      'registerCloudHandlers({});',
    ].join('\n');

    const result = scanSourceForStartupIpcOrdering(source, 'fixture-late-register.ts');
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe('register*Handlers');
  });

  it('(f) fails when late ipcMain.on() lacks STARTUP_LATE_REGISTRATION_OK sentinel', () => {
    const source = [
      "const createWindow = async () => {};",
      'async function bootstrap() {',
      '  await createWindow();',
      '}',
      "ipcMain.on('find-in-page:search', () => {});",
    ].join('\n');

    const result = scanSourceForStartupIpcOrdering(source, 'fixture-ipc-on-unannotated.ts');
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe('ipcMain.on');
  });

  it('(g) passes when late ipcMain.on() has substantive STARTUP_LATE_REGISTRATION_OK sentinel', () => {
    const source = [
      "const createWindow = async () => {};",
      'async function bootstrap() {',
      '  await createWindow();',
      '}',
      '// STARTUP_LATE_REGISTRATION_OK: one-way renderer event fired by user action after initial startup load',
      "ipcMain.on('find-in-page:search', () => {});",
    ].join('\n');

    const result = scanSourceForStartupIpcOrdering(source, 'fixture-ipc-on-annotated.ts');
    expect(result.violations).toHaveLength(0);
  });

  it('(h) fails when late ipcMain.on() has weak STARTUP_LATE_REGISTRATION_OK reason', () => {
    const source = [
      "const createWindow = async () => {};",
      'async function bootstrap() {',
      '  await createWindow();',
      '}',
      '// STARTUP_LATE_REGISTRATION_OK: TODO',
      "ipcMain.on('find-in-page:search', () => {});",
    ].join('\n');

    const result = scanSourceForStartupIpcOrdering(source, 'fixture-ipc-on-weak.ts');
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe('ipcMain.on');
  });
});
