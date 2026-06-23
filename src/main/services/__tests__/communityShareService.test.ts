import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import { ModelError } from '@core/rebelCore/modelErrors';

// Stub logger
const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

// Mock return value for getSessionTimeSavedSummary
let mockSummary: { totalMinutes: number; highestImpact: string | undefined } = {
  totalMinutes: 0,
  highestImpact: undefined,
};

const setupModule = async () => {
  vi.resetModules();
  await initTestPlatformConfig();

  vi.doMock('@core/logger', () => ({
    createScopedLogger: () => stubLogger,
  }));

  vi.doMock('@core/services/timeSavedStore', () => ({
    getSessionTimeSavedSummary: () => mockSummary,
  }));

   
  vi.doMock('@core/codexAuth', () => ({
    getCodexAuthProvider: () => ({
      isConnected: () => false,
    }),
  }));

  // Mock behind-the-scenes client (not needed for pure function tests but required for import)
  vi.doMock('@core/services/behindTheScenesClient', () => ({
    callBehindTheScenesWithAuth: vi.fn(),
  }));

  vi.doMock('@shared/utils/safeJsonParse', () => ({
    safeJsonParseFromModelText: vi.fn(),
  }));

  return await import('../communityShareService');
};

describe('communityShareService', () => {
  beforeEach(() => {
    Object.values(stubLogger).forEach((fn) => (fn as Mock).mockClear());
    mockSummary = { totalMinutes: 0, highestImpact: undefined };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // checkSessionEligibility
  // ─────────────────────────────────────────────────────────────────────────

  describe('checkSessionEligibility', () => {
    it('returns eligibility when session has >= 300 minutes AND high impact', async () => {
      mockSummary = { totalMinutes: 350, highestImpact: 'high' };
      const service = await setupModule();

      const result = service.checkSessionEligibility('session-1');

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('session-1');
      expect(result!.timeSavedMinutes).toBe(350);
      expect(result!.impact).toBe('high');
    });

    it('returns eligibility when session has >= 300 minutes AND critical impact', async () => {
      mockSummary = { totalMinutes: 500, highestImpact: 'critical' };
      const service = await setupModule();

      const result = service.checkSessionEligibility('session-2');

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('session-2');
      expect(result!.timeSavedMinutes).toBe(500);
      expect(result!.impact).toBe('critical');
    });

    it('returns null when session has >= 300 minutes but medium impact', async () => {
      mockSummary = { totalMinutes: 400, highestImpact: 'medium' };
      const service = await setupModule();

      const result = service.checkSessionEligibility('session-3');

      expect(result).toBeNull();
    });

    it('returns null when session has < 300 minutes even with high impact', async () => {
      mockSummary = { totalMinutes: 200, highestImpact: 'high' };
      const service = await setupModule();

      const result = service.checkSessionEligibility('session-4');

      expect(result).toBeNull();
    });

    it('returns null when session has no entries (0 minutes, no impact)', async () => {
      mockSummary = { totalMinutes: 0, highestImpact: undefined };
      const service = await setupModule();

      const result = service.checkSessionEligibility('session-5');

      expect(result).toBeNull();
    });

    it('returned eligibility includes a quip string and formatted time', async () => {
      mockSummary = { totalMinutes: 360, highestImpact: 'high' };
      const service = await setupModule();

      const result = service.checkSessionEligibility('session-6');

      expect(result).not.toBeNull();
      expect(typeof result!.quip).toBe('string');
      expect(result!.quip.length).toBeGreaterThan(0);
      expect(typeof result!.timeSavedFormatted).toBe('string');
      expect(result!.timeSavedFormatted).toBe('6.0h');
      expect(result!.evaluatedAt).toBeGreaterThan(0);
    });

    it('returns null for low impact even above threshold', async () => {
      mockSummary = { totalMinutes: 600, highestImpact: 'low' };
      const service = await setupModule();

      const result = service.checkSessionEligibility('session-7');

      expect(result).toBeNull();
    });

    it('returns null for trivial impact even above threshold', async () => {
      mockSummary = { totalMinutes: 600, highestImpact: 'trivial' };
      const service = await setupModule();

      const result = service.checkSessionEligibility('session-8');

      expect(result).toBeNull();
    });

    it('returns formatted time as "Xh" for >= 10 hours', async () => {
      mockSummary = { totalMinutes: 720, highestImpact: 'critical' };
      const service = await setupModule();

      const result = service.checkSessionEligibility('session-9');

      expect(result).not.toBeNull();
      expect(result!.timeSavedFormatted).toBe('12h');
    });

    it('returns formatted time as "X min" for < 60 minutes (edge case)', async () => {
      // This won't pass the threshold, but let's test formatting via the quip helper
      mockSummary = { totalMinutes: 300, highestImpact: 'high' };
      const service = await setupModule();

      const result = service.checkSessionEligibility('session-10');

      expect(result).not.toBeNull();
      expect(result!.timeSavedFormatted).toBe('5.0h');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // scrubPII
  // ─────────────────────────────────────────────────────────────────────────

  describe('scrubPII', () => {
    it('removes email addresses', async () => {
      const service = await setupModule();

      const result = service.scrubPII('Contact john@example.com for details');

      expect(result).toBe('Contact [redacted] for details');
    });

    it('removes multiple email addresses', async () => {
      const service = await setupModule();

      const result = service.scrubPII('From [external-email] to bob@example.org');

      expect(result).toBe('From [redacted] to [redacted]');
    });

    it('removes phone numbers in +1-555-123-4567 format', async () => {
      const service = await setupModule();

      const result = service.scrubPII('Call me at +1-555-123-4567');

      expect(result).toBe('Call me at [redacted]');
    });

    it('removes phone numbers in (555) 123-4567 format', async () => {
      const service = await setupModule();

      const result = service.scrubPII('Phone: (555) 123-4567');

      expect(result).toBe('Phone: [redacted]');
    });

    it('removes phone numbers in 555.123.4567 format', async () => {
      const service = await setupModule();

      const result = service.scrubPII('Fax: 555.123.4567');

      expect(result).toBe('Fax: [redacted]');
    });

    it('removes Unix file paths', async () => {
      const service = await setupModule();

      const result = service.scrubPII('Saved at /Users/john/Documents/report.pdf');

      expect(result).toBe('Saved at [redacted]');
    });

    it('removes home directory paths with tilde', async () => {
      const service = await setupModule();

      const result = service.scrubPII('Config at ~/Downloads/settings.json');

      expect(result).toBe('Config at [redacted]');
    });

    it('removes Windows file paths', async () => {
      const service = await setupModule();

      const result = service.scrubPII('File at C:\\Users\\john\\docs\\file.txt');

      expect(result).toBe('File at [redacted]');
    });

    it('removes IP addresses', async () => {
      const service = await setupModule();

      const result = service.scrubPII('Server at 192.168.1.1 is down');

      expect(result).toBe('Server at [redacted] is down');
    });

    it('removes URLs', async () => {
      const service = await setupModule();

      const result = service.scrubPII('Check out https://example.com/path?q=1 and http://internal.corp.co/docs');

      expect(result).toBe('Check out [redacted] and [redacted]');
    });

    it('preserves normal text without PII', async () => {
      const service = await setupModule();
      const text = 'I saved 5 hours on meeting preparation by automating the research phase.';

      const result = service.scrubPII(text);

      expect(result).toBe(text);
    });

    it('preserves the ~Xh time-saved figure in titles (regression: tilde-path regex was eating it)', async () => {
      const service = await setupModule();
      const title = 'How I saved ~5h on meeting prep';

      const result = service.scrubPII(title);

      expect(result).toBe(title);
    });

    it('preserves fractional and double-digit ~Xh figures', async () => {
      const service = await setupModule();

      expect(service.scrubPII('How I saved ~6.7h on research synthesis')).toBe(
        'How I saved ~6.7h on research synthesis'
      );
      expect(service.scrubPII('How I saved ~12h on quarterly review prep')).toBe(
        'How I saved ~12h on quarterly review prep'
      );
    });

    it('preserves dollar amounts and impact figures', async () => {
      const service = await setupModule();
      const text = 'Drafted a $2M renewal proposal in one sitting.';

      const result = service.scrubPII(text);

      expect(result).toBe(text);
    });

    it('preserves generic reference-shaped tokens that are not identifiers', async () => {
      const service = await setupModule();
      const text = 'Wrapped up Q3-2026 board prep before MAR-2026 deadline.';

      const result = service.scrubPII(text);

      expect(result).toBe(text);
    });

    it('handles text with multiple PII types mixed in', async () => {
      const service = await setupModule();
      const text =
        'Email [external-email], call 555-123-4567, check /Users/john/docs/plan.md and 10.0.0.1';

      const result = service.scrubPII(text);

      expect(result).not.toContain('[external-email]');
      expect(result).not.toContain('555-123-4567');
      expect(result).not.toContain('/Users/john');
      expect(result).not.toContain('10.0.0.1');
      // All replaced with [redacted]
      expect(result).toContain('[redacted]');
    });

    it('handles empty string', async () => {
      const service = await setupModule();

      const result = service.scrubPII('');

      expect(result).toBe('');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // buildDiscourseNewTopicUrl
  // ─────────────────────────────────────────────────────────────────────────

  describe('buildDiscourseNewTopicUrl', () => {
    it('returns correct URL with encoded title', async () => {
      const service = await setupModule();

      const url = service.buildDiscourseNewTopicUrl('How I saved ~5h on meeting prep');

      expect(url).toBe(
        'https://rebels.mindstone.com/new-topic?title=How%20I%20saved%20~5h%20on%20meeting%20prep&category_id=6'
      );
    });

    it('includes category_id=6', async () => {
      const service = await setupModule();

      const url = service.buildDiscourseNewTopicUrl('Test title');

      expect(url).toContain('category_id=6');
    });

    it('properly encodes special characters in title', async () => {
      const service = await setupModule();

      const url = service.buildDiscourseNewTopicUrl('Saved time on Q&A prep — "amazing" results');

      expect(url).toContain(encodeURIComponent('Saved time on Q&A prep — "amazing" results'));
      expect(url).not.toContain('&A'); // ampersand should be encoded, not raw
    });

    it('URL starts with https://rebels.mindstone.com/new-topic', async () => {
      const service = await setupModule();

      const url = service.buildDiscourseNewTopicUrl('Any title');

      expect(url.startsWith('https://rebels.mindstone.com/new-topic')).toBe(true);
    });

    it('handles empty title', async () => {
      const service = await setupModule();

      const url = service.buildDiscourseNewTopicUrl('');

      expect(url).toBe('https://rebels.mindstone.com/new-topic?title=&category_id=6');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // composeCommunitySharePost (transcript truncation)
  // ─────────────────────────────────────────────────────────────────────────

  describe('composeCommunitySharePost — transcript truncation', () => {
    const makeSession = (messageCount: number, textLength: number) => ({
      id: 'session-long',
      title: 'Long session',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: Array.from({ length: messageCount }, (_, i) => ({
        id: `msg-${i}`,
        turnId: `turn-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: 'x'.repeat(textLength),
        createdAt: Date.now(),
      })),
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
        resolvedAt: null,
    });

    it('truncates transcript for long sessions and caps total length', async () => {
      mockSummary = { totalMinutes: 400, highestImpact: 'high' };

      vi.resetModules();
      await initTestPlatformConfig();

      let capturedPrompt = '';
      const mockCallBts = vi.fn().mockImplementation((_settings: unknown, options: { messages: { content: string }[] }) => {
        capturedPrompt = options.messages[0].content;
        return { content: [{ type: 'text', text: '{"title":"How I saved ~6.7h on research","body":"I used Rebel..."}' }] };
      });

      vi.doMock('@core/logger', () => ({ createScopedLogger: () => stubLogger }));
      vi.doMock('@core/services/timeSavedStore', () => ({ getSessionTimeSavedSummary: () => mockSummary }));
      vi.doMock('@core/services/behindTheScenesClient', () => ({ callBehindTheScenesWithAuth: mockCallBts }));
      vi.doMock('@shared/utils/safeJsonParse', () => ({
        safeJsonParseFromModelText: () => ({ title: 'How I saved ~6.7h on research', body: 'I used Rebel to do research.' }),
      }));

      const service = await import('../communityShareService');

      // 200 messages x 1000 chars each = ~200K raw transcript (well over the 12K cap)
      const session = makeSession(200, 1000);
      await service.composeCommunitySharePost(session as never, {} as never);

      expect(mockCallBts).toHaveBeenCalled();

      // Prompt includes the transcript — verify it's been truncated
      // The transcript portion should contain the truncation marker
      expect(capturedPrompt).toContain('[...middle of conversation truncated...]');

      // The total prompt should be much smaller than the raw transcript
      expect(capturedPrompt.length).toBeLessThan(20_000);

      // Verify the truncation was logged
      expect(stubLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-long', originalLength: expect.any(Number) }),
        'Community share transcript exceeds cap, using tail-biased truncation'
      );
    });

    it('does not truncate short transcripts', async () => {
      mockSummary = { totalMinutes: 400, highestImpact: 'high' };

      vi.resetModules();
      await initTestPlatformConfig();

      let capturedPrompt = '';
      const mockCallBts = vi.fn().mockImplementation((_settings: unknown, options: { messages: { content: string }[] }) => {
        capturedPrompt = options.messages[0].content;
        return { content: [{ type: 'text', text: '{"title":"How I saved ~6.7h","body":"Short session."}' }] };
      });

      vi.doMock('@core/logger', () => ({ createScopedLogger: () => stubLogger }));
      vi.doMock('@core/services/timeSavedStore', () => ({ getSessionTimeSavedSummary: () => mockSummary }));
      vi.doMock('@core/services/behindTheScenesClient', () => ({ callBehindTheScenesWithAuth: mockCallBts }));
      vi.doMock('@shared/utils/safeJsonParse', () => ({
        safeJsonParseFromModelText: () => ({ title: 'How I saved ~6.7h', body: 'Short session.' }),
      }));

      const service = await import('../communityShareService');

      // 5 messages x 100 chars = ~500 chars (well under the 12K cap)
      const session = makeSession(5, 100);
      await service.composeCommunitySharePost(session as never, {} as never);

      expect(mockCallBts).toHaveBeenCalled();
      expect(capturedPrompt).not.toContain('[...middle of conversation truncated...]');
    });

    it('passes 60s timeout to behind-the-scenes client', async () => {
      mockSummary = { totalMinutes: 400, highestImpact: 'high' };

      vi.resetModules();
      await initTestPlatformConfig();

      const mockCallBts = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{"title":"T","body":"B"}' }],
      });

      vi.doMock('@core/logger', () => ({ createScopedLogger: () => stubLogger }));
      vi.doMock('@core/services/timeSavedStore', () => ({ getSessionTimeSavedSummary: () => mockSummary }));
      vi.doMock('@core/services/behindTheScenesClient', () => ({ callBehindTheScenesWithAuth: mockCallBts }));
      vi.doMock('@shared/utils/safeJsonParse', () => ({
        safeJsonParseFromModelText: () => ({ title: 'T', body: 'B' }),
      }));

      const service = await import('../communityShareService');
      const session = makeSession(3, 50);
      await service.composeCommunitySharePost(session as never, {} as never);

      expect(mockCallBts).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ timeout: 60000 }),
        expect.anything()
      );
    });

    it('returns a humanized error payload for billing failures', async () => {
      mockSummary = { totalMinutes: 400, highestImpact: 'high' };

      vi.resetModules();
      await initTestPlatformConfig();

      // Re-import ModelError AFTER resetModules so the class identity matches the
      // re-imported service's `instanceof ModelError` check (Stage 6b migration uses
      // the shared humanizer which requires the instance check). The top-of-file
      // `ModelError` import is from a pre-reset module graph and has a different class
      // identity; using it here would fail the instanceof check inside the service.
      const { ModelError: FreshModelError } = await import('@core/rebelCore/modelErrors');
      const mockCallBts = vi.fn().mockRejectedValue(
        new FreshModelError(
          'billing',
          'This request requires more credits, or fewer max_tokens.',
          402,
          'OpenRouter',
          { rawMessage: '402 {"error":{"message":"This request requires more credits, or fewer max_tokens."}}' },
        ),
      );

      vi.doMock('@core/logger', () => ({ createScopedLogger: () => stubLogger }));
      vi.doMock('@core/services/timeSavedStore', () => ({ getSessionTimeSavedSummary: () => mockSummary }));
      vi.doMock('@core/services/behindTheScenesClient', () => ({ callBehindTheScenesWithAuth: mockCallBts }));
      vi.doMock('@shared/utils/safeJsonParse', () => ({
        safeJsonParseFromModelText: vi.fn(),
      }));

      const service = await import('../communityShareService');
      const session = makeSession(3, 50);
      const result = await service.composeCommunitySharePost(session as never, {} as never);

      expect(result).toEqual({
        success: false,
        // Stage 6b: classification-first humanization now produces subtype+provider-aware copy.
        // See docs/plans/260421_classification_driven_error_humanizer.md.
        error:
          'Your OpenRouter account has run out of credits. You can set up auto top-up in your OpenRouter settings to avoid this.',
        errorKind: 'billing',
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getRandomQuip
  // ─────────────────────────────────────────────────────────────────────────

  describe('getRandomQuip', () => {
    it('returns a non-empty string', async () => {
      const service = await setupModule();

      const quip = service.getRandomQuip('5h');

      expect(typeof quip).toBe('string');
      expect(quip.length).toBeGreaterThan(0);
    });

    it('substitutes {time} placeholder with formatted time', async () => {
      const service = await setupModule();

      // Run many times to increase chance of hitting a quip with {time}
      const quips = new Set<string>();
      for (let i = 0; i < 100; i++) {
        quips.add(service.getRandomQuip('5.0h'));
      }

      // At least some quips should NOT contain the raw placeholder
      const allQuips = Array.from(quips);
      const hasSubstituted = allQuips.some((q) => q.includes('5.0h'));
      expect(hasSubstituted).toBe(true);

      // None should contain the raw {time} placeholder
      const hasRawPlaceholder = allQuips.some((q) => q.includes('{time}'));
      expect(hasRawPlaceholder).toBe(false);
    });
  });
});
