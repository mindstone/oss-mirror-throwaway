/**
 * Stage 4 — poller.mapSentryIssue unit tests.
 *
 * Covers the new reporter-email + reporter-name extraction added in Stage 1:
 *   - Only feedback-category issues (errorType === 'feedback') get userEmail/userName populated
 *   - Non-feedback issues NEVER get these fields, even if the metadata happens to contain
 *     contact_email / name. This is the explicit non-goal — we do not fall back to
 *     event.user.email (logged-in user context).
 *   - Sentry's payload shape varies across SDK versions, so we try multiple metadata
 *     paths defensively. We exercise each one.
 *   - Graceful degradation: feedback issues without contact info return undefined for
 *     userEmail/userName rather than throwing or returning empty strings.
 *
 * Source of truth: scripts/sentry-autopilot/poller.ts § extractUserEmail / extractUserName / mapSentryIssue.
 * Task plan: docs/plans/260528_autopilot-user-response-draft/PLAN.md (Stage 1).
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import { mapSentryIssue, type SentryIssueResponse } from '../poller.ts';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function makeConfig(overrides: Partial<AutopilotConfig> = {}): AutopilotConfig {
  return {
    sentryAuthToken: 'token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: undefined,
    slackWebhook: undefined,
    githubToken: undefined,
    repoFullName: undefined,
    phase: 'shadow',
    verifyMode: 'disabled',
    pushMode: 'disabled',
    pendingMode: 'disabled',
    stateDir: '/tmp/test-state-dir',
    maxConcurrent: 1,
    maxHourly: 1,
    maxDaily: 1,
    maxRetries: 2,
    sessionTimeoutSeconds: 60,
    bootstrapLookbackHours: 24,
    repoRoot: REPO_ROOT,
    ...overrides,
  };
}

describe('mapSentryIssue', () => {
  const config = makeConfig();

  describe('basic mapping', () => {
    it('returns null when issue.id is missing', () => {
      const issue: SentryIssueResponse = {
        title: 'something',
      };
      expect(mapSentryIssue(config, issue)).toBeNull();
    });

    it('maps a standard exception issue with required fields', () => {
      const issue: SentryIssueResponse = {
        id: '12345',
        permalink: 'https://sentry.io/issues/12345/',
        title: "TypeError: Cannot read properties of undefined (reading 'foo')",
        shortId: 'REBEL-ABC',
        level: 'error',
        count: '10',
        userCount: '5',
        firstSeen: '2026-05-15T00:00:00Z',
        lastSeen: '2026-05-15T01:00:00Z',
        issueCategory: 'error',
        type: 'error',
      };

      const mapped = mapSentryIssue(config, issue);
      expect(mapped).toEqual({
        sentryId: '12345',
        sentryUrl: 'https://sentry.io/issues/12345/',
        title: "TypeError: Cannot read properties of undefined (reading 'foo')",
        errorType: 'exception',
        isUserReported: false,
        occurrences: 10,
        users: 5,
        level: 'error',
        firstSeen: '2026-05-15T00:00:00Z',
        lastSeen: '2026-05-15T01:00:00Z',
      });
    });

    it('falls back to shortId for title and synthesizes sentryUrl when permalink missing', () => {
      const issue: SentryIssueResponse = {
        id: '99',
        shortId: 'REBEL-XYZ',
        level: 'fatal',
        type: 'crash',
        firstSeen: '2026-05-15T00:00:00Z',
        lastSeen: '2026-05-15T00:00:00Z',
      };

      const mapped = mapSentryIssue(config, issue);
      expect(mapped?.title).toBe('REBEL-XYZ');
      expect(mapped?.sentryUrl).toContain('/organizations/mindstone/issues/99/');
      expect(mapped?.errorType).toBe('crash');
    });
  });

  describe('errorType classification', () => {
    it('classifies issueCategory:feedback as feedback', () => {
      const issue: SentryIssueResponse = {
        id: '1',
        issueCategory: 'feedback',
      };
      expect(mapSentryIssue(config, issue)?.errorType).toBe('feedback');
    });

    it('classifies type:user_report as feedback', () => {
      const issue: SentryIssueResponse = {
        id: '1',
        type: 'user_report',
      };
      expect(mapSentryIssue(config, issue)?.errorType).toBe('feedback');
    });

    it('classifies level:fatal as crash', () => {
      const issue: SentryIssueResponse = {
        id: '1',
        level: 'fatal',
      };
      expect(mapSentryIssue(config, issue)?.errorType).toBe('crash');
    });

    it('defaults to exception otherwise', () => {
      const issue: SentryIssueResponse = {
        id: '1',
        level: 'error',
      };
      expect(mapSentryIssue(config, issue)?.errorType).toBe('exception');
    });
  });

  describe('isUserReported', () => {
    it('is true for feedback-category issues even with no userReportCount', () => {
      const issue: SentryIssueResponse = {
        id: '1',
        issueCategory: 'feedback',
      };
      expect(mapSentryIssue(config, issue)?.isUserReported).toBe(true);
    });

    it('is true for non-feedback issues with userReportCount > 0', () => {
      const issue: SentryIssueResponse = {
        id: '1',
        userReportCount: 3,
      };
      expect(mapSentryIssue(config, issue)?.isUserReported).toBe(true);
    });

    it('is false for plain exceptions with no user reports', () => {
      const issue: SentryIssueResponse = {
        id: '1',
        type: 'error',
      };
      expect(mapSentryIssue(config, issue)?.isUserReported).toBe(false);
    });
  });

  describe('userEmail / userName extraction (feedback issues only)', () => {
    it('extracts both from metadata.feedback.{contact_email,name}', () => {
      const issue: SentryIssueResponse = {
        id: '1',
        issueCategory: 'feedback',
        metadata: {
          feedback: {
            contact_email: 'user@example.com',
            name: 'Alice Smith',
            message: 'Something broke when I clicked submit',
          },
        },
      };

      const mapped = mapSentryIssue(config, issue);
      expect(mapped?.userEmail).toBe('user@example.com');
      expect(mapped?.userName).toBe('Alice Smith');
      expect(mapped?.userDescription).toBe('Something broke when I clicked submit');
    });

    it('extracts from top-level metadata.{contact_email,name} as fallback', () => {
      const issue: SentryIssueResponse = {
        id: '1',
        issueCategory: 'feedback',
        metadata: {
          contact_email: 'top@example.com',
          name: 'Bob',
        },
      };

      const mapped = mapSentryIssue(config, issue);
      expect(mapped?.userEmail).toBe('top@example.com');
      expect(mapped?.userName).toBe('Bob');
    });

    it('extracts from metadata.feedback.email when contact_email is absent', () => {
      const issue: SentryIssueResponse = {
        id: '1',
        issueCategory: 'feedback',
        metadata: {
          feedback: {
            email: 'alt@example.com',
          },
        },
      };

      expect(mapSentryIssue(config, issue)?.userEmail).toBe('alt@example.com');
    });

    it('extracts from top-level metadata.email as final fallback', () => {
      const issue: SentryIssueResponse = {
        id: '1',
        issueCategory: 'feedback',
        metadata: {
          email: 'final@example.com',
        },
      };

      expect(mapSentryIssue(config, issue)?.userEmail).toBe('final@example.com');
    });

    it('prefers metadata.feedback.contact_email over other paths', () => {
      const issue: SentryIssueResponse = {
        id: '1',
        issueCategory: 'feedback',
        metadata: {
          email: 'lower@example.com',
          contact_email: 'middle@example.com',
          feedback: {
            email: 'inner@example.com',
            contact_email: 'preferred@example.com',
          },
        },
      };

      expect(mapSentryIssue(config, issue)?.userEmail).toBe('preferred@example.com');
    });

    it('returns undefined for userEmail/userName when feedback metadata has no contact info', () => {
      const issue: SentryIssueResponse = {
        id: '1',
        issueCategory: 'feedback',
        metadata: {
          feedback: {
            message: 'It just broke',
          },
        },
      };

      const mapped = mapSentryIssue(config, issue);
      expect(mapped?.userEmail).toBeUndefined();
      expect(mapped?.userName).toBeUndefined();
      expect(mapped?.errorType).toBe('feedback');
      expect(mapped?.isUserReported).toBe(true);
    });

    it('returns undefined when metadata is absent entirely', () => {
      const issue: SentryIssueResponse = {
        id: '1',
        issueCategory: 'feedback',
      };

      const mapped = mapSentryIssue(config, issue);
      expect(mapped?.userEmail).toBeUndefined();
      expect(mapped?.userName).toBeUndefined();
    });

    it('does NOT populate userEmail/userName for non-feedback issues even when metadata contains them', () => {
      // This is the explicit non-goal: we don't fall back to event.user.email
      // or any other logged-in user context. Only feedback widget reports.
      const issue: SentryIssueResponse = {
        id: '1',
        type: 'error',
        level: 'error',
        metadata: {
          contact_email: 'logged-in-user@example.com',
          name: 'Logged In User',
          feedback: {
            contact_email: 'also@example.com',
            name: 'Also',
          },
        },
      };

      const mapped = mapSentryIssue(config, issue);
      expect(mapped?.errorType).toBe('exception');
      expect(mapped?.userEmail).toBeUndefined();
      expect(mapped?.userName).toBeUndefined();
    });

    it('treats empty/whitespace strings as absent (graceful degradation)', () => {
      const issue: SentryIssueResponse = {
        id: '1',
        issueCategory: 'feedback',
        metadata: {
          feedback: {
            contact_email: '   ',
            name: '',
          },
        },
      };

      const mapped = mapSentryIssue(config, issue);
      expect(mapped?.userEmail).toBeUndefined();
      expect(mapped?.userName).toBeUndefined();
    });
  });
});
