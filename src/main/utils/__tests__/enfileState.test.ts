import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSendToAllWindows = vi.hoisted(() => vi.fn());

// Mock broadcast boundary interface to avoid Electron dependency in tests.
// Canonical implementation lives at @core/utils/enfileState (the local
// src/main/utils/enfileState.ts is a re-export shim) and uses
// getBroadcastService().sendToAllWindows() rather than the legacy
// broadcastToAllWindows helper.
vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock({ sendToAllWindows: mockSendToAllWindows });
});

// Mock graceful-fs observability so the gated tagFsExhaustion call is observable.
 
vi.mock('@core/utils/gracefulFsObservability', () => ({
  tagFsExhaustion: vi.fn(),
}));

import { markEnfileDetected, isEnfileActive, _resetForTesting } from '../enfileState';
import { tagFsExhaustion } from '@core/utils/gracefulFsObservability';

const mockBroadcast = mockSendToAllWindows;
const mockTag = vi.mocked(tagFsExhaustion);

describe('enfileState', () => {
  beforeEach(() => {
    _resetForTesting();
    mockBroadcast.mockClear();
    mockTag.mockClear();
  });

  describe('markEnfileDetected', () => {
    it('returns isFirstDetection: true on first call', () => {
      const result = markEnfileDetected();
      expect(result.isFirstDetection).toBe(true);
    });

    it('returns isFirstDetection: false on subsequent calls within cooldown', () => {
      markEnfileDetected();
      const result = markEnfileDetected();
      expect(result.isFirstDetection).toBe(false);
    });

    it('returns isFirstDetection: true after cooldown expires', () => {
      vi.useFakeTimers();
      try {
        markEnfileDetected();
        
        // Advance past cooldown (60 seconds)
        vi.advanceTimersByTime(61_000);
        
        const result = markEnfileDetected();
        expect(result.isFirstDetection).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('isEnfileActive', () => {
    it('returns false when no ENFILE has been detected', () => {
      expect(isEnfileActive()).toBe(false);
    });

    it('returns true immediately after detection', () => {
      markEnfileDetected();
      expect(isEnfileActive()).toBe(true);
    });

    it('returns true within cooldown period', () => {
      vi.useFakeTimers();
      try {
        markEnfileDetected();
        
        // Advance but stay within cooldown (59 seconds)
        vi.advanceTimersByTime(59_000);
        
        expect(isEnfileActive()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns false after cooldown expires', () => {
      vi.useFakeTimers();
      try {
        markEnfileDetected();
        
        // Advance past cooldown (60 seconds)
        vi.advanceTimersByTime(61_000);
        
        expect(isEnfileActive()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('_resetForTesting', () => {
    it('resets state so isEnfileActive returns false', () => {
      markEnfileDetected();
      expect(isEnfileActive()).toBe(true);
      
      _resetForTesting();
      
      expect(isEnfileActive()).toBe(false);
    });

    it('resets state so next markEnfileDetected returns isFirstDetection: true', () => {
      markEnfileDetected();
      markEnfileDetected(); // Second call should be false
      
      _resetForTesting();
      
      const result = markEnfileDetected();
      expect(result.isFirstDetection).toBe(true);
    });
  });

  describe('cooldown refresh behavior', () => {
    it('extends cooldown when ENFILE is detected again', () => {
      vi.useFakeTimers();
      try {
        markEnfileDetected();
        
        // Advance 50 seconds (within cooldown)
        vi.advanceTimersByTime(50_000);
        expect(isEnfileActive()).toBe(true);
        
        // Detect again, should extend cooldown
        markEnfileDetected();
        
        // Advance another 50 seconds (would be past original cooldown, but not the extended one)
        vi.advanceTimersByTime(50_000);
        expect(isEnfileActive()).toBe(true);
        
        // Advance past the extended cooldown
        vi.advanceTimersByTime(15_000);
        expect(isEnfileActive()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('toast notification', () => {
    it('broadcasts toast on first detection only', () => {
      markEnfileDetected();
      expect(mockBroadcast).toHaveBeenCalledTimes(1);
      expect(mockBroadcast).toHaveBeenCalledWith('system:resource-warning', {
        type: 'enfile',
        message: expect.stringContaining('resource constraints')
      });

      // Subsequent detection within cooldown should NOT broadcast
      markEnfileDetected();
      expect(mockBroadcast).toHaveBeenCalledTimes(1);
    });

    it('broadcasts toast again after cooldown expires', () => {
      vi.useFakeTimers();
      try {
        markEnfileDetected();
        expect(mockBroadcast).toHaveBeenCalledTimes(1);

        // Advance past cooldown
        vi.advanceTimersByTime(61_000);

        // New episode should broadcast again
        markEnfileDetected();
        expect(mockBroadcast).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('Sentry tag gating (Stage 3)', () => {
    it('calls tagFsExhaustion with native_bypass on first detection when error is provided', () => {
      const error = Object.assign(new Error('emfile'), { code: 'EMFILE' });
      const result = markEnfileDetected(error);
      expect(result.isFirstDetection).toBe(true);
      expect(mockTag).toHaveBeenCalledTimes(1);
      expect(mockTag).toHaveBeenCalledWith(error, 'native_bypass');
    });

    it('does NOT call tagFsExhaustion on subsequent detections in the same cooldown window', () => {
      const error1 = Object.assign(new Error('emfile-1'), { code: 'EMFILE' });
      const error2 = Object.assign(new Error('emfile-2'), { code: 'EMFILE' });
      markEnfileDetected(error1);
      expect(mockTag).toHaveBeenCalledTimes(1);

      markEnfileDetected(error2);
      // Second detection within cooldown — must NOT re-tag.
      expect(mockTag).toHaveBeenCalledTimes(1);
    });

    it('calls tagFsExhaustion again on first detection after cooldown expires', () => {
      vi.useFakeTimers();
      try {
        const error1 = Object.assign(new Error('emfile-1'), { code: 'EMFILE' });
        const error2 = Object.assign(new Error('emfile-2'), { code: 'EMFILE' });
        markEnfileDetected(error1);
        expect(mockTag).toHaveBeenCalledTimes(1);

        // Advance past cooldown — new episode.
        vi.advanceTimersByTime(61_000);

        markEnfileDetected(error2);
        expect(mockTag).toHaveBeenCalledTimes(2);
        expect(mockTag).toHaveBeenLastCalledWith(error2, 'native_bypass');
      } finally {
        vi.useRealTimers();
      }
    });

    it('does NOT call tagFsExhaustion when error is omitted', () => {
      const result = markEnfileDetected();
      expect(result.isFirstDetection).toBe(true);
      expect(mockTag).not.toHaveBeenCalled();
    });

    it('swallows tagFsExhaustion errors and still updates detection state', () => {
      mockTag.mockImplementationOnce(() => {
        throw new Error('reporter is on fire');
      });
      const error = Object.assign(new Error('emfile'), { code: 'EMFILE' });
      const result = markEnfileDetected(error);
      // tagFsExhaustion threw, but markEnfileDetected must still succeed.
      expect(result.isFirstDetection).toBe(true);
      expect(isEnfileActive()).toBe(true);
    });
  });
});
