/**
 * Unit tests for containsCredentialPatterns — structural credential detection
 * for the memory write secret gate.
 *
 * Verifies that:
 * - Known API key formats are detected (Anthropic, OpenAI, Groq, Google, etc.)
 * - PEM private keys, bearer tokens, and connection strings are detected
 * - Structural JSON/ENV patterns with real values are detected
 * - Dummy/placeholder values do NOT trigger detection
 * - Word boundaries prevent partial matches
 * - Normal prose, markdown, and meeting notes are not flagged
 */

import { describe, it, expect } from 'vitest';
import { containsCredentialPatterns } from '@core/utils/logRedaction';
import type { CredentialDetectionResult } from '@core/utils/logRedaction';

// =============================================================================
// Helpers
// =============================================================================

function expectDetected(result: CredentialDetectionResult, label: string): void {
  expect(result.detected).toBe(true);
  expect(result.reasons).toContain(label);
}

function expectClean(result: CredentialDetectionResult): void {
  expect(result.detected).toBe(false);
  expect(result.reasons).toEqual([]);
}

// =============================================================================
// Phase 1: Value-based credential patterns
// =============================================================================

describe('containsCredentialPatterns — value-based patterns', () => {
  it('detects Anthropic API keys', () => {
    expectDetected(
      containsCredentialPatterns('My key is sk-ant-api03-aBcDeFgHiJkLmNoPqR'),
      'anthropic_api_key',
    );
  });

  it('detects Anthropic key at start of string', () => {
    expectDetected(
      containsCredentialPatterns('sk-ant-api03-aBcDeFgHiJkLmNoPqR'),
      'anthropic_api_key',
    );
  });

  it('detects OpenAI API keys (20+ chars after sk-)', () => {
    // 25 chars after sk-
    expectDetected(
      containsCredentialPatterns('Use sk-proj-aBcDeFgHiJkLmNoPqRsTuVw for auth'),
      'openai_api_key',
    );
  });

  it('does NOT detect short sk- strings as OpenAI keys', () => {
    // Only 10 chars after sk-  — below the 20-char threshold
    expectClean(containsCredentialPatterns('sk-shortkey1'));
  });

  it('detects Groq API keys', () => {
    expectDetected(
      containsCredentialPatterns('export GROQ_KEY=gsk_aBcDeFgHiJkLmNoPqR'),
      'groq_api_key',
    );
  });

  it('detects Google API keys (35 chars after AIza)', () => {
    // Exactly 35 chars after AIza
    expectDetected(
      containsCredentialPatterns('key: AIzaSyAbcdefghijklmnopqrstuvwxyz12345678'),
      'google_api_key',
    );
  });

  it('does NOT detect short AIza strings as Google keys', () => {
    // Only 10 chars after AIza
    expectClean(containsCredentialPatterns('AIzaShort1234'));
  });

  it('detects ElevenLabs API keys (20+ chars after xi-)', () => {
    expectDetected(
      containsCredentialPatterns('xi-aBcDeFgHiJkLmNoPqRsTuVwXyZ'),
      'elevenlabs_api_key',
    );
  });

  it('does NOT detect short xi- strings', () => {
    expectClean(containsCredentialPatterns('xi-short'));
  });

  it('detects GitHub personal access tokens (36 chars after ghp_)', () => {
    expectDetected(
      containsCredentialPatterns('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890'),
      'github_pat',
    );
  });

  it('does NOT detect short ghp_ strings', () => {
    // Only 10 chars after ghp_
    expectClean(containsCredentialPatterns('ghp_abcdef1234'));
  });

  it('detects AWS access key IDs (16 uppercase chars after AKIA)', () => {
    expectDetected(
      containsCredentialPatterns('aws_access_key_id = AKIAIOSFODNN7EXAMPLE'),
      'aws_access_key',
    );
  });

  it('does NOT detect short AKIA strings', () => {
    expectClean(containsCredentialPatterns('AKIA1234'));
  });

  it('detects PEM private keys (plain)', () => {
    expectDetected(
      containsCredentialPatterns('-----BEGIN PRIVATE KEY-----\nMIIE...'),
      'pem_private_key',
    );
  });

  it('detects RSA PEM private keys', () => {
    expectDetected(
      containsCredentialPatterns('-----BEGIN RSA PRIVATE KEY-----'),
      'pem_private_key',
    );
  });

  it('detects EC PEM private keys', () => {
    expectDetected(
      containsCredentialPatterns('-----BEGIN EC PRIVATE KEY-----'),
      'pem_private_key',
    );
  });

  it('detects DSA PEM private keys', () => {
    expectDetected(
      containsCredentialPatterns('-----BEGIN DSA PRIVATE KEY-----'),
      'pem_private_key',
    );
  });

  it('detects OPENSSH PEM private keys', () => {
    expectDetected(
      containsCredentialPatterns('-----BEGIN OPENSSH PRIVATE KEY-----'),
      'pem_private_key',
    );
  });

  it('detects Stripe live API keys (20+ chars after sk_live_)', () => {
    expectDetected(
      containsCredentialPatterns('Use sk_live_aBcDeFgHiJkLmNoPqRsTuVw for payment processing'),
      'stripe_api_key',
    );
  });

  it('detects Stripe test API keys (20+ chars after sk_test_)', () => {
    expectDetected(
      containsCredentialPatterns('Sandbox: sk_test_aBcDeFgHiJkLmNoPqRsTuVw'),
      'stripe_api_key',
    );
  });

  it('does NOT detect short Stripe keys', () => {
    // Only 10 chars after sk_live_ — below the 20-char threshold
    expectClean(containsCredentialPatterns('sk_live_short12345'));
  });

  it('detects Twilio Account SIDs (AC + 32 hex chars)', () => {
    expectDetected(
      containsCredentialPatterns('TWILIO_SID=AC1234567890abcdef1234567890abcdef'),
      'twilio_credentials',
    );
  });

  it('does NOT detect short AC strings', () => {
    expectClean(containsCredentialPatterns('AC1234'));
  });

  it('detects GitLab personal access tokens (20+ chars after glpat-)', () => {
    expectDetected(
      containsCredentialPatterns('export GITLAB_TOKEN=glpat-abcdefghijklmnopqrstuvwxyz'),
      'gitlab_pat',
    );
  });

  it('does NOT detect short glpat- strings', () => {
    expectClean(containsCredentialPatterns('glpat-short'));
  });

  it('detects Slack bot tokens (xoxb-)', () => {
    expectDetected(
      containsCredentialPatterns('SLACK_TOKEN=xoxb-123456789012-abcdef'),
      'slack_token',
    );
  });

  it('detects Slack user tokens (xoxp-)', () => {
    expectDetected(
      containsCredentialPatterns('token: xoxp-123456789012-abcdef'),
      'slack_token',
    );
  });

  it('detects Slack app tokens (xoxa-)', () => {
    expectDetected(
      containsCredentialPatterns('SLACK_APP=xoxa-1234567890-abcdef'),
      'slack_token',
    );
  });

  it('does NOT detect short xox strings', () => {
    expectClean(containsCredentialPatterns('xoxb-short'));
  });

  it('detects bearer tokens (20+ chars)', () => {
    expectDetected(
      containsCredentialPatterns('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij'),
      'bearer_token',
    );
  });

  it('detects bearer tokens case-insensitively', () => {
    expectDetected(
      containsCredentialPatterns('bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij'),
      'bearer_token',
    );
  });

  it('does NOT detect short bearer tokens', () => {
    // Only 10 chars — below the 20-char threshold
    expectClean(containsCredentialPatterns('Bearer short12345'));
  });
});

// =============================================================================
// Phase 2: Structural credential patterns (JSON, ENV, connection strings)
// =============================================================================

describe('containsCredentialPatterns — structural patterns', () => {
  it('detects JSON password with real value', () => {
    expectDetected(
      containsCredentialPatterns('{"password": "mySuperSecretPassword123"}'),
      'json_credential',
    );
  });

  it('detects JSON secret with real value', () => {
    expectDetected(
      containsCredentialPatterns('{"secret": "realSecretValue12345678"}'),
      'json_credential',
    );
  });

  it('detects JSON api_key with real value', () => {
    expectDetected(
      containsCredentialPatterns('{"api_key": "live_key_aBcDeFg1234567890"}'),
      'json_credential',
    );
  });

  it('detects JSON token with real value', () => {
    expectDetected(
      containsCredentialPatterns('{"token": "realTokenValue12345678"}'),
      'json_credential',
    );
  });

  it('detects ENV API_KEY with real value', () => {
    expectDetected(
      containsCredentialPatterns('API_KEY=live_key_aBcDeFg1234567890'),
      'env_credential',
    );
  });

  it('detects ENV SECRET_KEY with real value', () => {
    expectDetected(
      containsCredentialPatterns('SECRET_KEY=my_super_secret_key_123'),
      'env_credential',
    );
  });

  it('detects ENV PASSWORD with real value', () => {
    expectDetected(
      containsCredentialPatterns('PASSWORD=realPassword12345678'),
      'env_credential',
    );
  });

  it('detects ENV TOKEN with real value', () => {
    expectDetected(
      containsCredentialPatterns('TOKEN=realTokenValue12345678'),
      'env_credential',
    );
  });

  it('detects postgres connection string', () => {
    expectDetected(
      containsCredentialPatterns('postgres://admin:secretPass@db.example.com/mydb'),
      'connection_string_credential',
    );
  });

  it('detects mysql connection string', () => {
    expectDetected(
      containsCredentialPatterns('mysql://root:p4ssw0rd@localhost:3306/app'),
      'connection_string_credential',
    );
  });

  it('detects mongodb connection string', () => {
    expectDetected(
      containsCredentialPatterns('mongodb://user:cred123@cluster.mongodb.net/db'),
      'connection_string_credential',
    );
  });

  it('detects real credential even when a preceding JSON match is a dummy', () => {
    const content = `{
      "token": "test",
      "password": "realProductionPassword123"
    }`;
    expectDetected(containsCredentialPatterns(content), 'json_credential');
  });
});

// =============================================================================
// Dummy/placeholder value filtering
// =============================================================================

describe('containsCredentialPatterns — dummy value filtering', () => {
  it('does NOT detect JSON with "your_api_key" placeholder', () => {
    expectClean(containsCredentialPatterns('{"api_key": "your_api_key"}'));
  });

  it('does NOT detect JSON with "YOUR_API_KEY" placeholder (case-insensitive)', () => {
    expectClean(containsCredentialPatterns('{"api_key": "YOUR_API_KEY"}'));
  });

  it('does NOT detect ENV with "placeholder" value', () => {
    expectClean(containsCredentialPatterns('API_KEY=placeholder'));
  });

  it('does NOT detect JSON with "xxxx" repeated value', () => {
    expectClean(containsCredentialPatterns('{"password": "xxxxxxxxxxxxxxxx"}'));
  });

  it('does NOT detect ENV with INSERT_KEY_HERE', () => {
    expectClean(containsCredentialPatterns('SECRET_KEY=INSERT_KEY_HERE'));
  });

  it('does NOT detect JSON with angle-bracket placeholder', () => {
    expectClean(containsCredentialPatterns('{"token": "<your-token-here>"}'));
  });

  it('does NOT detect JSON with template variable placeholder', () => {
    expectClean(containsCredentialPatterns('{"secret": "${SECRET_KEY}"}'));
  });

  it('does NOT detect JSON with empty value', () => {
    expectClean(containsCredentialPatterns('{"password": ""}'));
  });

  it('does NOT detect JSON with short value (< 8 chars)', () => {
    expectClean(containsCredentialPatterns('{"token": "abc123"}'));
  });

  it('does NOT detect ENV with short value', () => {
    expectClean(containsCredentialPatterns('TOKEN=abc'));
  });

  it('does NOT detect ENV with "test" value', () => {
    expectClean(containsCredentialPatterns('TOKEN=test'));
  });

  it('does NOT detect JSON with ellipsis placeholder', () => {
    expectClean(containsCredentialPatterns('{"api_key": "...your-key-here"}'));
  });
});

// =============================================================================
// Word boundary and partial-match protection
// =============================================================================

describe('containsCredentialPatterns — word boundary correctness', () => {
  it('does NOT trigger on task-ant-123 (not an Anthropic key)', () => {
    expectClean(containsCredentialPatterns('task-ant-123 is a task ID'));
  });

  it('does NOT trigger on mask-ant-pattern (embedded "ant")', () => {
    expectClean(containsCredentialPatterns('Use mask-ant-pattern for filtering'));
  });

  it('does NOT trigger on prefixed sk_ variants (e.g. mysk-something)', () => {
    // "mysk-" has no word boundary before "sk"
    expectClean(containsCredentialPatterns('mysk-long-string-that-is-over-twenty-chars'));
  });

  it('detects sk-ant- key preceded by a quote (word boundary)', () => {
    expectDetected(
      containsCredentialPatterns('"sk-ant-api03-aBcDeFgHiJkLmNoPqR"'),
      'anthropic_api_key',
    );
  });

  it('detects sk-ant- key at line start (word boundary)', () => {
    expectDetected(
      containsCredentialPatterns('\nsk-ant-api03-aBcDeFgHiJkLmNoPqR'),
      'anthropic_api_key',
    );
  });
});

// =============================================================================
// Negative cases: normal content that should NOT trigger
// =============================================================================

describe('containsCredentialPatterns — negative cases', () => {
  it('returns clean for empty string', () => {
    expectClean(containsCredentialPatterns(''));
  });

  it('returns clean for normal markdown text', () => {
    expectClean(
      containsCredentialPatterns(
        '# Meeting Notes\n\nDiscussed Q3 roadmap and budget allocations.\n\n' +
          '## Action Items\n- Review the proposal by Friday\n- Schedule follow-up',
      ),
    );
  });

  it('returns clean for meeting notes with names and dates', () => {
    expectClean(
      containsCredentialPatterns(
        'John met with Sarah on 2024-01-15 to discuss the product launch. ' +
          'They agreed to push the deadline to March.',
      ),
    );
  });

  it('returns clean for text mentioning "API key" in prose', () => {
    expectClean(
      containsCredentialPatterns(
        'Please update your API key in the settings panel before the next release.',
      ),
    );
  });

  it('returns clean for code examples with placeholder keys', () => {
    expectClean(
      containsCredentialPatterns(
        'Example:\n```\nconst key = "your_api_key";\nconst secret = "<INSERT_KEY_HERE>";\n```',
      ),
    );
  });

  it('returns clean for emails (not a credential pattern)', () => {
    expectClean(containsCredentialPatterns('Contact us at hello@example.com for support'));
  });

  it('returns clean for regular file paths', () => {
    expectClean(containsCredentialPatterns('/Users/alice/Documents/report.pdf'));
  });

  it('returns clean for URLs without credentials', () => {
    expectClean(containsCredentialPatterns('https://api.example.com/v1/users'));
  });

  it('returns clean for JSON without sensitive keys', () => {
    expectClean(
      containsCredentialPatterns('{"name": "Alice", "role": "admin", "active": true}'),
    );
  });

  it('returns clean for short random-looking strings', () => {
    expectClean(containsCredentialPatterns('ref: abc-def-123'));
  });
});

// =============================================================================
// Return value shape
// =============================================================================

describe('containsCredentialPatterns — return value shape', () => {
  it('returns { detected: false, reasons: [] } for clean content', () => {
    const result = containsCredentialPatterns('Just some normal text');
    expect(result).toEqual({ detected: false, reasons: [] });
  });

  it('returns exactly one reason on detection (short-circuits)', () => {
    const result = containsCredentialPatterns('sk-ant-api03-aBcDeFgHiJkLmNoPqR');
    expect(result.detected).toBe(true);
    expect(result.reasons).toHaveLength(1);
  });

  it('never includes matched content in reasons (only labels)', () => {
    const key = 'sk-ant-api03-aBcDeFgHiJkLmNoPqR';
    const result = containsCredentialPatterns(`Here is ${key}`);
    expect(result.reasons[0]).toBe('anthropic_api_key');
    expect(result.reasons[0]).not.toContain(key);
  });
});
