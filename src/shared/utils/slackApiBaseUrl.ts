export function getSlackApiBaseUrl(): string {
  return process.env.SLACK_API_BASE_URL ?? 'https://slack.com';
}
