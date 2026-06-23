import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import {
  AUTH_REQUIRED_ACTION,
  buildAuthRequiredKey,
  extractLatestAuthRequiredByPackage,
  parseAuthRequiredSignal,
} from '../authRequiredSignal';

function makeToolEvent(
  detail: string,
  overrides: Partial<Extract<AgentEvent, { type: 'tool' }>> = {},
): AgentEvent {
  return {
    type: 'tool',
    toolName: 'use_tool',
    stage: 'end',
    detail,
    timestamp: Date.now(),
    ...overrides,
  } as AgentEvent;
}

function makeEnvelope(
  payload: Record<string, unknown>,
  packageId = 'Slack-mindstone',
): string {
  return JSON.stringify({
    package_id: packageId,
    result: {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload),
        },
      ],
    },
  });
}

describe('parseAuthRequiredSignal', () => {
  it('parses tool event detail wrapped in a Super-MCP envelope', () => {
    const detail = makeEnvelope({
      action: AUTH_REQUIRED_ACTION,
      package_id: 'Slack-mindstone',
      auth_tool: 'authenticate_slack_workspace',
      reason: 'token_expired',
      error: 'Slack token has expired or been revoked.',
    });

    const event = makeToolEvent(detail, { timestamp: 111 });
    const parsed = parseAuthRequiredSignal(event, 'turn-1');

    expect(parsed).toEqual({
      packageId: 'Slack-mindstone',
      authTool: 'authenticate_slack_workspace',
      reason: 'token_expired',
      turnId: 'turn-1',
      timestamp: 111,
      rawError: 'Slack token has expired or been revoked.',
    });
  });

  it('parses tool event detail when JSON is direct and not envelope-wrapped', () => {
    const event = makeToolEvent(
      JSON.stringify({
        action: AUTH_REQUIRED_ACTION,
        package_id: 'Slack-acme',
        auth_tool: 'authenticate_slack_workspace',
        reason: 'not_connected',
      }),
      { timestamp: 222 },
    );

    const parsed = parseAuthRequiredSignal(event, 'turn-2');

    expect(parsed).toEqual({
      packageId: 'Slack-acme',
      authTool: 'authenticate_slack_workspace',
      reason: 'not_connected',
      turnId: 'turn-2',
      timestamp: 222,
    });
  });

  it('returns null for malformed JSON payloads', () => {
    const event = makeToolEvent('not-json');
    expect(parseAuthRequiredSignal(event, 'turn-3')).toBeNull();
  });

  it('returns null when package_id is missing', () => {
    const event = makeToolEvent(
      JSON.stringify({
        action: AUTH_REQUIRED_ACTION,
        auth_tool: 'authenticate_slack_workspace',
        reason: 'token_expired',
      }),
    );

    expect(parseAuthRequiredSignal(event, 'turn-4')).toBeNull();
  });

  it('returns null when auth_tool is missing', () => {
    const event = makeToolEvent(
      JSON.stringify({
        action: AUTH_REQUIRED_ACTION,
        package_id: 'Slack-mindstone',
        reason: 'token_expired',
      }),
    );

    expect(parseAuthRequiredSignal(event, 'turn-5')).toBeNull();
  });

  it('returns null when reason is missing', () => {
    const event = makeToolEvent(
      JSON.stringify({
        action: AUTH_REQUIRED_ACTION,
        package_id: 'Slack-mindstone',
        auth_tool: 'authenticate_slack_workspace',
      }),
    );

    expect(parseAuthRequiredSignal(event, 'turn-6')).toBeNull();
  });

  it('returns null for non-tool events', () => {
    const event: AgentEvent = {
      type: 'result',
      text: JSON.stringify({
        action: AUTH_REQUIRED_ACTION,
        package_id: 'Slack-mindstone',
        auth_tool: 'authenticate_slack_workspace',
        reason: 'token_expired',
      }),
      timestamp: Date.now(),
    };

    expect(parseAuthRequiredSignal(event, 'turn-7')).toBeNull();
  });
});

describe('extractLatestAuthRequiredByPackage', () => {
  it('keeps only the latest signal for each package id across multiple workspaces', () => {
    const eventsByTurn: Record<string, AgentEvent[]> = {
      'turn-1': [
        makeToolEvent(
          JSON.stringify({
            action: AUTH_REQUIRED_ACTION,
            package_id: 'Slack-mindstone',
            auth_tool: 'authenticate_slack_workspace',
            reason: 'token_expired',
          }),
          { timestamp: 100 },
        ),
      ],
      'turn-2': [
        makeToolEvent(
          JSON.stringify({
            action: AUTH_REQUIRED_ACTION,
            package_id: 'Slack-acme',
            auth_tool: 'authenticate_slack_workspace',
            reason: 'token_expired',
          }),
          { timestamp: 200 },
        ),
      ],
      'turn-3': [
        makeToolEvent(
          JSON.stringify({
            action: AUTH_REQUIRED_ACTION,
            package_id: 'Slack-mindstone',
            auth_tool: 'authenticate_slack_workspace',
            reason: 'not_connected',
          }),
          { timestamp: 300 },
        ),
      ],
    };

    const latest = extractLatestAuthRequiredByPackage(eventsByTurn);

    expect(latest.size).toBe(2);
    expect(latest.get('Slack-mindstone')?.reason).toBe('not_connected');
    expect(latest.get('Slack-mindstone')?.turnId).toBe('turn-3');
    expect(latest.get('Slack-acme')?.reason).toBe('token_expired');
    expect(latest.get('Slack-acme')?.turnId).toBe('turn-2');
  });
});

describe('buildAuthRequiredKey', () => {
  it('combines package and reason into a stable key', () => {
    expect(buildAuthRequiredKey('Slack-mindstone', 'token_expired')).toBe(
      'Slack-mindstone:token_expired',
    );
  });
});
