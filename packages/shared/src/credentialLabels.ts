/**
 * Human-friendly labels for credential detection categories.
 *
 * Maps the snake_case category labels from `containsCredentialPatterns()` in
 * `@core/utils/logRedaction` to plain-language descriptions suitable for
 * non-technical users in approval UI.
 *
 * This file lives in `@rebel/shared` because it is consumed by both:
 * - `src/renderer/` (desktop approval UI)
 * - `cloud-client/` (cross-surface approval hooks after Stage 4)
 *
 * It is pure data + a pure lookup function — no React, no platform imports.
 */

const CREDENTIAL_LABELS: Record<string, string> = {
  anthropic_api_key: 'what looks like an API key',
  openai_api_key: 'what looks like an API key',
  groq_api_key: 'what looks like an API key',
  google_api_key: 'what looks like an API key',
  elevenlabs_api_key: 'what looks like an API key',
  github_pat: 'what looks like a GitHub token',
  aws_access_key: 'what looks like an AWS access key',
  pem_private_key: 'what looks like a private key',
  bearer_token: 'what looks like an authentication token',
  json_credential: 'what might be a password or secret',
  env_credential: 'what might be a password or secret',
  connection_string_credential: 'what looks like a database connection string with credentials',
  non_inspectable_bash: "a command whose output Rebel can't preview",
  stripe_api_key: 'what looks like a Stripe API key',
  twilio_credentials: 'what looks like Twilio credentials',
  gitlab_pat: 'what looks like a GitLab token',
  slack_token: 'what looks like a Slack token',
};

/**
 * Convert a credential detection category label to a human-friendly description.
 * Returns a generic fallback for unknown labels.
 */
export function getCredentialLabel(category: string): string {
  return CREDENTIAL_LABELS[category] ?? 'content that may contain credentials';
}
