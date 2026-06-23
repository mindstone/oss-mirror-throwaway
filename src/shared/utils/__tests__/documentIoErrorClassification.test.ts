import { describe, expect, it } from 'vitest';

import {
  ACTIONABLE_WRITE_ERRNOS,
  WriteFailureError,
  classifySafeError,
  errnoToUserMessage,
} from '../documentIoErrorClassification';

describe('documentIoErrorClassification', () => {
  describe('classifySafeError', () => {
    it('returns fs kind and whitelisted errno code for POSIX-shaped error codes', () => {
      const err = Object.assign(new Error('m'), { code: 'ENOSPC' });

      expect(classifySafeError(err)).toEqual({
        errorName: 'Error',
        errorCode: 'ENOSPC',
        errorKind: 'fs',
      });
    });

    it('returns unknown kind without an errorCode for Error instances without .code', () => {
      expect(classifySafeError(new Error('m'))).toEqual({
        errorName: 'Error',
        errorKind: 'unknown',
      });
    });

    it('returns unknown kind without an errorCode when .code fails the errno whitelist', () => {
      const err = Object.assign(new Error('m'), { code: 'lowercaseStuff' });

      expect(classifySafeError(err)).toEqual({
        errorName: 'Error',
        errorKind: 'unknown',
      });
    });

    it('includes safe error identity fields without leaking message, stack, or path', () => {
      const err = Object.assign(new Error('/Users/person/private-file.md'), {
        code: 'EACCES',
        path: '/Users/person/private-file.md',
      });

      const result = classifySafeError(err);

      expect(result.errorName).toBe('Error');
      expect(result).not.toHaveProperty('message');
      expect(result).not.toHaveProperty('stack');
      expect(result).not.toHaveProperty('path');
    });
  });

  describe('errnoToUserMessage', () => {
    it('maps EISDIR to the non-writable-file copy', () => {
      expect(errnoToUserMessage('EISDIR')).toEqual({
        title: "That location isn't a writable file.",
      });
    });

    it('maps ENOTDIR to the non-writable-file copy', () => {
      expect(errnoToUserMessage('ENOTDIR')).toEqual({
        title: "That location isn't a writable file.",
      });
    });

    it('keeps the storage-full copy for ENOSPC', () => {
      expect(errnoToUserMessage('ENOSPC')).toEqual({
        title: 'Your storage is full.',
        description: 'Free up some space and try again.',
      });
    });

    it('keeps the permissions copy for EACCES', () => {
      expect(errnoToUserMessage('EACCES')).toEqual({
        title: "Rebel can't write to this file.",
        description: 'It may be read-only — check permissions and try again.',
      });
    });
  });

  describe('WriteFailureError', () => {
    it('stores the input errno on .code', () => {
      expect(new WriteFailureError('EACCES').code).toBe('EACCES');
    });
  });

  describe('ACTIONABLE_WRITE_ERRNOS', () => {
    it('contains exactly the actionable write errnos', () => {
      expect([...ACTIONABLE_WRITE_ERRNOS]).toEqual([
        'ENOSPC',
        'EDQUOT',
        'EACCES',
        'EPERM',
        'EROFS',
      ]);
    });
  });
});
