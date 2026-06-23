import { afterEach, describe, expect, it } from 'vitest';
import { FORCE_RECORDER_UNINSTALLED_ENV, isRecorderInstalled } from '../recorderInstallation';

const originalForceFlag = process.env[FORCE_RECORDER_UNINSTALLED_ENV];

afterEach(() => {
  if (originalForceFlag === undefined) {
    delete process.env[FORCE_RECORDER_UNINSTALLED_ENV];
  } else {
    process.env[FORCE_RECORDER_UNINSTALLED_ENV] = originalForceFlag;
  }
});

describe('isRecorderInstalled', () => {
  it('reports absent when the dev force flag is set', () => {
    process.env[FORCE_RECORDER_UNINSTALLED_ENV] = '1';

    expect(isRecorderInstalled()).toBe(false);
  });

  it('reports present when the SDK is installed and the force flag is unset', () => {
    delete process.env[FORCE_RECORDER_UNINSTALLED_ENV];

    expect(isRecorderInstalled()).toBe(true);
  });

  it('reports absent when package resolution fails without throwing', () => {
    delete process.env[FORCE_RECORDER_UNINSTALLED_ENV];

    expect(isRecorderInstalled(() => {
      throw new Error('missing');
    })).toBe(false);
  });
});
