import { describe, it, expect } from 'vitest';
import { getCredentialLabel } from '../credentialLabels';

describe('getCredentialLabel', () => {
  it.each([
    ['anthropic_api_key', 'what looks like an API key'],
    ['openai_api_key', 'what looks like an API key'],
    ['groq_api_key', 'what looks like an API key'],
    ['google_api_key', 'what looks like an API key'],
    ['elevenlabs_api_key', 'what looks like an API key'],
    ['github_pat', 'what looks like a GitHub token'],
    ['aws_access_key', 'what looks like an AWS access key'],
    ['pem_private_key', 'what looks like a private key'],
    ['bearer_token', 'what looks like an authentication token'],
    ['json_credential', 'what might be a password or secret'],
    ['env_credential', 'what might be a password or secret'],
    ['connection_string_credential', 'what looks like a database connection string with credentials'],
    ['non_inspectable_bash', "a command whose output Rebel can't preview"],
    ['stripe_api_key', 'what looks like a Stripe API key'],
    ['twilio_credentials', 'what looks like Twilio credentials'],
    ['gitlab_pat', 'what looks like a GitLab token'],
    ['slack_token', 'what looks like a Slack token'],
  ])('maps %s to friendly label', (input, expected) => {
    expect(getCredentialLabel(input)).toBe(expected);
  });

  it('returns generic fallback for unknown labels', () => {
    expect(getCredentialLabel('totally_unknown_category')).toBe('content that may contain credentials');
  });

  it('returns generic fallback for empty string', () => {
    expect(getCredentialLabel('')).toBe('content that may contain credentials');
  });
});
