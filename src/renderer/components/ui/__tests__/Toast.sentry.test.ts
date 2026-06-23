import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockCaptureRendererMessage, mockRecordRendererBreadcrumb } = vi.hoisted(() => ({
  mockCaptureRendererMessage: vi.fn(),
  mockRecordRendererBreadcrumb: vi.fn(),
}));

vi.mock('@renderer/src/sentry', () => ({
  captureRendererMessage: (...args: unknown[]) => mockCaptureRendererMessage(...args),
  recordRendererBreadcrumb: (...args: unknown[]) => mockRecordRendererBreadcrumb(...args),
}));

import { instrumentToast, type ToastVariant } from '../Toast';

describe('Toast Sentry instrumentation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('breadcrumbs', () => {
    it('records breadcrumb for every toast variant', () => {
      const variants: ToastVariant[] = ['default', 'success', 'warning', 'error', 'info'];
      for (const variant of variants) {
        mockRecordRendererBreadcrumb.mockClear();
        instrumentToast('Test message', variant);
        expect(mockRecordRendererBreadcrumb).toHaveBeenCalledOnce();
      }
    });

    it('maps error variant to error breadcrumb level', () => {
      instrumentToast('Something failed', 'error');
      expect(mockRecordRendererBreadcrumb).toHaveBeenCalledWith({
        category: 'toast',
        level: 'error',
        message: 'Something failed',
        data: { variant: 'error' },
      });
    });

    it('maps warning variant to warning breadcrumb level', () => {
      instrumentToast('Watch out', 'warning');
      expect(mockRecordRendererBreadcrumb).toHaveBeenCalledWith({
        category: 'toast',
        level: 'warning',
        message: 'Watch out',
        data: { variant: 'warning' },
      });
    });

    it('maps success variant to info breadcrumb level', () => {
      instrumentToast('Done', 'success');
      expect(mockRecordRendererBreadcrumb).toHaveBeenCalledWith({
        category: 'toast',
        level: 'info',
        message: 'Done',
        data: { variant: 'success' },
      });
    });

    it('maps default variant to info breadcrumb level', () => {
      instrumentToast('Hello', 'default');
      expect(mockRecordRendererBreadcrumb).toHaveBeenCalledWith({
        category: 'toast',
        level: 'info',
        message: 'Hello',
        data: { variant: 'default' },
      });
    });

    it('includes description in breadcrumb data when present', () => {
      instrumentToast('Error title', 'error', 'Detailed description');
      expect(mockRecordRendererBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { variant: 'error', description: 'Detailed description' },
        }),
      );
    });

    it('omits description from breadcrumb data when absent', () => {
      instrumentToast('Error title', 'error');
      expect(mockRecordRendererBreadcrumb).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { variant: 'error' },
        }),
      );
    });
  });

  describe('Sentry events', () => {
    it('captures Sentry message for error variant', () => {
      instrumentToast('Cloud update failed', 'error', 'Something went wrong');
      expect(mockCaptureRendererMessage).toHaveBeenCalledOnce();
      expect(mockCaptureRendererMessage).toHaveBeenCalledWith(
        'toast.error: Cloud update failed',
        {
          level: 'error',
          tags: { area: 'toast', variant: 'error' },
          extra: { description: 'Something went wrong' },
        },
      );
    });

    it('does NOT capture Sentry message for warning variant', () => {
      instrumentToast('Needs attention', 'warning');
      expect(mockCaptureRendererMessage).not.toHaveBeenCalled();
    });

    it('does NOT capture Sentry message for success variant', () => {
      instrumentToast('All good', 'success');
      expect(mockCaptureRendererMessage).not.toHaveBeenCalled();
    });

    it('does NOT capture Sentry message for info variant', () => {
      instrumentToast('FYI', 'info');
      expect(mockCaptureRendererMessage).not.toHaveBeenCalled();
    });

    it('does NOT capture Sentry message for default variant', () => {
      instrumentToast('Hello', 'default');
      expect(mockCaptureRendererMessage).not.toHaveBeenCalled();
    });

    it('omits description from Sentry extras when absent', () => {
      instrumentToast('Failed', 'error');
      expect(mockCaptureRendererMessage).toHaveBeenCalledWith(
        'toast.error: Failed',
        {
          level: 'error',
          tags: { area: 'toast', variant: 'error' },
          extra: {},
        },
      );
    });
  });

  // FOX-3519: group residual arg-validation error toasts into ONE Sentry issue
  // (instead of N per-tool singletons). The primary fix routes this class to a
  // calm `info` toast (no capture at all); this fingerprint is the backstop for
  // any error-variant toast that still carries the validator text.
  describe('arg-validation fingerprint (FOX-3519)', () => {
    it('fingerprints an error toast whose title carries the validator substring', () => {
      instrumentToast(
        "Approved, but the action failed: Argument validation failed for tool 'x'",
        'error',
      );
      expect(mockCaptureRendererMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ fingerprint: ['toast', 'tool-arg-validation-failed'] }),
      );
    });

    it('fingerprints when the validator substring is only in the description', () => {
      instrumentToast('Approved, but the action failed', 'error', 'use_tool "args" must be an object');
      expect(mockCaptureRendererMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ fingerprint: ['toast', 'tool-arg-validation-failed'] }),
      );
    });

    it('does NOT fingerprint unrelated error toasts', () => {
      instrumentToast('Cloud update failed', 'error', 'Something went wrong');
      const call = mockCaptureRendererMessage.mock.calls[0];
      expect(call?.[1]).not.toHaveProperty('fingerprint');
    });
  });
});
