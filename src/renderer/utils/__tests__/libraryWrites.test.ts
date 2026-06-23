import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WriteFailureError } from '@shared/utils/documentIoErrorClassification';
import { writeFileOrFail } from '../libraryWrites';

describe('writeFileOrFail', () => {
  const payload = { path: 'notes/example.md', content: 'hello' };
  const telemetryMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('window', {});
    telemetryMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockWriteFile(result: unknown) {
    const writeFile = vi.fn().mockResolvedValue(result);
    Object.assign(window, {
      libraryApi: { writeFile },
      api: { emitLog: telemetryMock },
    });
    return writeFile;
  }

  it('returns the success envelope unchanged', async () => {
    const envelope = {
      result: 'ok' as const,
      path: payload.path,
      updatedAt: 123,
      currentHash: 'hash:next',
    };
    mockWriteFile(envelope);

    await expect(writeFileOrFail(payload)).resolves.toBe(envelope);
    expect(telemetryMock).not.toHaveBeenCalled();
  });

  it('returns the conflict envelope unchanged without throwing', async () => {
    const currentHash = 'hash:disk';
    const envelope = { result: 'conflict' as const, path: payload.path, currentHash };
    mockWriteFile(envelope);

    await expect(writeFileOrFail(payload)).resolves.toEqual({
      result: 'conflict',
      path: payload.path,
      currentHash,
    });
  });

  it('throws WriteFailureError with the failed envelope errorCode', async () => {
    mockWriteFile({ result: 'failed', errorCode: 'ENOSPC' });

    try {
      await writeFileOrFail(payload);
      throw new Error('Expected writeFileOrFail to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(WriteFailureError);
      expect(err).toMatchObject({ code: 'ENOSPC' });
    }
  });

  it('does not emit telemetry on success', async () => {
    mockWriteFile({ result: 'ok', path: payload.path });

    await writeFileOrFail(payload);

    expect(telemetryMock).not.toHaveBeenCalled();
  });

  it('does not emit telemetry before throwing on failure', async () => {
    mockWriteFile({ result: 'failed', errorCode: 'EACCES' });

    await expect(writeFileOrFail(payload)).rejects.toBeInstanceOf(WriteFailureError);

    expect(telemetryMock).not.toHaveBeenCalled();
  });
});
