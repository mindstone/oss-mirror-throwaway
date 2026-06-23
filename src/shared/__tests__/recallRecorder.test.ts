import { describe, expect, it } from 'vitest';
import {
  RECALL_DESKTOP_SDK_INSTALL_ARGS,
  RECALL_DESKTOP_SDK_INSTALL_COMMAND,
  RECALL_DESKTOP_SDK_PACKAGE_NAME,
  RECALL_DESKTOP_SDK_PACKAGE_SPEC,
  RECALL_DESKTOP_SDK_VERSION,
} from '../recallRecorder';

describe('recallRecorder install spec', () => {
  it('derives the package spec from name + version', () => {
    expect(RECALL_DESKTOP_SDK_PACKAGE_SPEC).toBe(
      `${RECALL_DESKTOP_SDK_PACKAGE_NAME}@${RECALL_DESKTOP_SDK_VERSION}`,
    );
  });

  it('runs the install with lifecycle scripts enabled and without --save', () => {
    expect(RECALL_DESKTOP_SDK_INSTALL_ARGS).toEqual([
      'install',
      '--no-save',
      RECALL_DESKTOP_SDK_PACKAGE_SPEC,
    ]);
    // The native recorder is fetched by the SDK's `install` lifecycle script,
    // so --ignore-scripts must NOT appear here.
    expect(RECALL_DESKTOP_SDK_INSTALL_ARGS).not.toContain('--ignore-scripts');
  });

  it('keeps the displayed copy-command in lockstep with the spawned argv', () => {
    // Single source of truth: the command string is derived from the args.
    expect(RECALL_DESKTOP_SDK_INSTALL_COMMAND).toBe(
      ['npm', ...RECALL_DESKTOP_SDK_INSTALL_ARGS].join(' '),
    );
    expect(RECALL_DESKTOP_SDK_INSTALL_COMMAND).toBe(
      'npm install --no-save @recallai/desktop-sdk@2.0.9',
    );
  });
});
