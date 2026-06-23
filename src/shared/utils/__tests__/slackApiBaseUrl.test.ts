import { afterEach, describe, expect, it } from 'vitest';
import { getSlackApiBaseUrl } from '../slackApiBaseUrl';

const originalSlackApiBaseUrl = process.env.SLACK_API_BASE_URL;

describe('getSlackApiBaseUrl', () => {
  afterEach(() => {
    if (originalSlackApiBaseUrl === undefined) {
      delete process.env.SLACK_API_BASE_URL;
    } else {
      process.env.SLACK_API_BASE_URL = originalSlackApiBaseUrl;
    }
  });

  it('returns the default Slack base URL when no override is set', () => {
    delete process.env.SLACK_API_BASE_URL;

    expect(getSlackApiBaseUrl()).toBe('https://slack.com');
  });

  it('honours the SLACK_API_BASE_URL override', () => {
    process.env.SLACK_API_BASE_URL = 'http://127.0.0.1:4567';

    expect(getSlackApiBaseUrl()).toBe('http://127.0.0.1:4567');
  });
});
