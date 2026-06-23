import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import type { AppSettings } from '@shared/types';
import type { HookJSONOutput } from '@core/agentRuntimeTypes';
import { configurePromptFileService, _resetForTesting } from '@core/services/promptFileService';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

const {
  mockCallWithModelAuthAware,
  mockSafeJsonParseFromModelText,
  mockFenceUntrustedContent,
} = vi.hoisted(() => ({
  mockCallWithModelAuthAware: vi.fn(),
  mockSafeJsonParseFromModelText: vi.fn(),
  mockFenceUntrustedContent: vi.fn(
    (content: string) => `[FENCED]${content}[/FENCED]`
  ),
}));

vi.mock('../behindTheScenesClient', () => ({
  callWithModelAuthAware: mockCallWithModelAuthAware,
}));

vi.mock('@shared/utils/safeJsonParse', () => ({
  safeJsonParseFromModelText: mockSafeJsonParseFromModelText,
}));

vi.mock('../safety/fenceUtils', () => ({
  fenceUntrustedContent: mockFenceUntrustedContent,
}));

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

type PublicBroadcastHookInput = {
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
};

type PublicBroadcastHook = (
  input: PublicBroadcastHookInput,
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;

let createPublicBroadcastSafetyHook: (
  ...args: Parameters<typeof import('../inboundTriggers/publicBroadcastSafetyHook').createPublicBroadcastSafetyHook>
) => PublicBroadcastHook | null;

beforeAll(async () => {
  const promptsDir = path.resolve(__dirname, '../../../../rebel-system/prompts');
  configurePromptFileService(promptsDir);
  const mod = await import('../inboundTriggers/publicBroadcastSafetyHook');
  createPublicBroadcastSafetyHook = (...args) =>
    mod.createPublicBroadcastSafetyHook(...args) as unknown as PublicBroadcastHook | null;
});

afterEach(() => {
  _resetForTesting();
  const promptsDir = path.resolve(__dirname, '../../../../rebel-system/prompts');
  configurePromptFileService(promptsDir);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const minimalSettings = {
  behindTheScenesModel: 'claude-3-haiku',
} as AppSettings;

function makeSignal(): AbortSignal {
  return new AbortController().signal;
}

/** Simulate the hook input shape matching the runtime's PreToolUse structure. */
function makeInput(toolName: string, toolInput: unknown) {
  return { tool_name: toolName, tool_input: toolInput };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createPublicBroadcastSafetyHook()', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Restore the default mock implementation for fenceUntrustedContent
    mockFenceUntrustedContent.mockImplementation(
      (content: string) => `[FENCED]${content}[/FENCED]`
    );
  });

  it('returns null for private surfaces (isPublicBroadcastSurface=false)', () => {
    const result = createPublicBroadcastSafetyHook(false, minimalSettings);
    expect(result).toBeNull();
  });

  it('returns a function for public broadcast surfaces', () => {
    const result = createPublicBroadcastSafetyHook(true, minimalSettings);
    expect(typeof result).toBe('function');
  });
});

describe('Hook behavior (returned function)', () => {
  let hook: NonNullable<ReturnType<typeof createPublicBroadcastSafetyHook>>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockFenceUntrustedContent.mockImplementation(
      (content: string) => `[FENCED]${content}[/FENCED]`
    );
    hook = createPublicBroadcastSafetyHook(true, minimalSettings)!;
    expect(hook).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Non-intercepted tools
  // -----------------------------------------------------------------------

  it('returns empty object for tools not registered in any outbound-broadcast gate', async () => {
    const result = await hook(
      makeInput('read_file', { path: '/tmp/test.txt' }),
      'tool-use-1',
      { signal: makeSignal() }
    );
    expect(result).toEqual({});
  });

  it('returns empty object when tool_name/tool_input missing', async () => {
    const result = await hook(
      {} as Record<string, unknown>,
      'tool-use-1',
      { signal: makeSignal() }
    );
    expect(result).toEqual({});
  });

  // -----------------------------------------------------------------------
  // Intercepted Slack tools
  // -----------------------------------------------------------------------

  it('intercepts reply_to_slack_thread', async () => {
    mockCallWithModelAuthAware.mockResolvedValue({
      content: [{ type: 'text', text: '{"safe":true,"reason":"ok"}' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue({ safe: true, reason: 'ok' });

    const result = await hook(
      makeInput('reply_to_slack_thread', { text: 'Hello world' }),
      'tool-use-1',
      { signal: makeSignal() }
    );

    expect(mockCallWithModelAuthAware).toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('intercepts post_slack_message', async () => {
    mockCallWithModelAuthAware.mockResolvedValue({
      content: [{ type: 'text', text: '{"safe":true,"reason":"ok"}' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue({ safe: true, reason: 'ok' });

    const result = await hook(
      makeInput('post_slack_message', { text: 'Update posted' }),
      'tool-use-1',
      { signal: makeSignal() }
    );

    expect(mockCallWithModelAuthAware).toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('intercepts send_slack_message', async () => {
    mockCallWithModelAuthAware.mockResolvedValue({
      content: [{ type: 'text', text: '{"safe":true,"reason":"ok"}' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue({ safe: true, reason: 'ok' });

    const result = await hook(
      makeInput('send_slack_message', { text: 'Something' }),
      'tool-use-1',
      { signal: makeSignal() }
    );

    expect(mockCallWithModelAuthAware).toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('intercepts MCP router use_tool forwarding to Slack tools', async () => {
    mockCallWithModelAuthAware.mockResolvedValue({
      content: [{ type: 'text', text: '{"safe":true,"reason":"ok"}' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue({ safe: true, reason: 'ok' });

    const result = await hook(
      makeInput('mcp__super-mcp-router__use_tool', {
        tool_id: 'reply_to_slack_thread',
        args: { text: 'MCP forwarded reply' },
      }),
      'tool-use-1',
      { signal: makeSignal() }
    );

    expect(mockCallWithModelAuthAware).toHaveBeenCalled();
    expect(result).toEqual({});
  });

  // -----------------------------------------------------------------------
  // Missing content
  // -----------------------------------------------------------------------

  it('returns empty object when reply content is null/missing', async () => {
    const result = await hook(
      makeInput('reply_to_slack_thread', { channel: 'C001' }), // no text field
      'tool-use-1',
      { signal: makeSignal() }
    );

    // Should NOT call LLM — there's nothing to evaluate
    expect(mockCallWithModelAuthAware).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  // -----------------------------------------------------------------------
  // LLM evaluation outcomes
  // -----------------------------------------------------------------------

  it('calls LLM safety evaluation with reply content', async () => {
    mockCallWithModelAuthAware.mockResolvedValue({
      content: [{ type: 'text', text: '{"safe":true,"reason":"all good"}' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue({ safe: true, reason: 'all good' });

    await hook(
      makeInput('reply_to_slack_thread', { text: 'Here is your summary' }),
      'tool-use-1',
      { signal: makeSignal() }
    );

    expect(mockFenceUntrustedContent).toHaveBeenCalledWith(
      'Here is your summary',
      'reply_content',
      expect.any(String),
      4000
    );
    expect(mockCallWithModelAuthAware).toHaveBeenCalledTimes(1);
  });

  it('renders the Slack-templated prompt byte-identical to the historical wording (no eval regression)', async () => {
    mockFenceUntrustedContent.mockImplementation((content: string) => content);
    mockCallWithModelAuthAware.mockResolvedValue({
      content: [{ type: 'text', text: '{"safe":true,"reason":"ok"}' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue({ safe: true, reason: 'ok' });

    await hook(
      makeInput('reply_to_slack_thread', { text: 'REPLY_BODY' }),
      'tool-use-1',
      { signal: makeSignal() }
    );

    const renderedPrompt = (mockCallWithModelAuthAware.mock.calls[0]?.[2] as {
      messages: { role: string; content: string }[];
    }).messages[0].content;

    expect(renderedPrompt).toBe(
      `You are a privacy safety evaluator. Your job is to check if a message being posted to a PUBLIC Slack channel contains sensitive personal information that should not be shared publicly.

The message is a reply from an AI assistant (Rebel) in response to a user's @-mention in a public Slack channel. Everyone in the workspace can see messages in public channels.

## What to flag as UNSAFE

Flag the message as unsafe if it contains ANY of the following:
- Personal email addresses (other than the recipient's own, which they already know)
- Phone numbers, physical addresses, or location data
- Calendar events, meeting details, or schedule information
- Contents of private emails, DMs, or documents
- Financial data (account numbers, transactions, salary info)
- Health or medical information
- Passwords, API keys, tokens, or credentials
- Information explicitly marked as confidential or private
- Detailed personal notes or journal entries

## What is SAFE

The following are safe to share in a public channel:
- General knowledge and publicly available information
- Task status updates, summaries of public work
- Links to public resources
- Acknowledgments like "Done" or "I'll look into that"
- Information the user explicitly asked to be shared publicly
- The user's own name (they mentioned Rebel publicly, so their identity is already visible)

## Reply content to evaluate

<reply_content>
REPLY_BODY
</reply_content>

## Response format (JSON only)

Respond with JSON:
{
  "safe": true/false,
  "reason": "Brief explanation of why the content is safe or what sensitive data was found"
}`,
    );
  });

  it('allows safe content (returns empty object)', async () => {
    mockCallWithModelAuthAware.mockResolvedValue({
      content: [{ type: 'text', text: '{"safe":true,"reason":"Content is fine"}' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue({ safe: true, reason: 'Content is fine' });

    const result = await hook(
      makeInput('reply_to_slack_thread', { text: 'Task is done!' }),
      'tool-use-1',
      { signal: makeSignal() }
    );

    expect(result).toEqual({});
  });

  it('blocks unsafe content (returns continue:false with reason)', async () => {
    mockCallWithModelAuthAware.mockResolvedValue({
      content: [{ type: 'text', text: '{"safe":false,"reason":"Contains email address"}' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue({
      safe: false,
      reason: 'Contains email address',
    });

    const result = await hook(
      makeInput('reply_to_slack_thread', { text: 'john@example.com' }),
      'tool-use-1',
      { signal: makeSignal() }
    );

    expect(result).toHaveProperty('continue', false);
    expect(result).toHaveProperty('stopReason');
    expect((result as Record<string, unknown>).hookSpecificOutput).toBeDefined();
  });

  it('renders the Slack-templated deny reason byte-identical to the historical wording', async () => {
    mockCallWithModelAuthAware.mockResolvedValue({
      content: [{ type: 'text', text: '{"safe":false,"reason":"Contains email address"}' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue({
      safe: false,
      reason: 'Contains email address',
    });

    const result = await hook(
      makeInput('reply_to_slack_thread', { text: 'john@example.com' }),
      'tool-use-1',
      { signal: makeSignal() }
    );

    const hookOutput = (result as Record<string, unknown>).hookSpecificOutput as {
      permissionDecisionReason: string;
    };

    expect(hookOutput.permissionDecisionReason).toBe(
      `BLOCKED: Your reply to this public Slack channel was blocked because it may contain sensitive personal information.

Reason: Contains email address

This is a PUBLIC channel — your reply would be visible to everyone in the workspace.

Please rewrite your reply to exclude any sensitive personal information. If the request requires sharing private data, suggest the user DM you or use a private channel instead.`,
    );
  });

  it('handles LLM evaluation errors (blocks for safety)', async () => {
    mockCallWithModelAuthAware.mockRejectedValue(new Error('LLM call failed'));

    const result = await hook(
      makeInput('reply_to_slack_thread', { text: 'Something' }),
      'tool-use-1',
      { signal: makeSignal() }
    );

    // On error, should block for safety
    expect(result).toHaveProperty('continue', false);
  });

  it('handles parse failure (blocks for safety)', async () => {
    mockCallWithModelAuthAware.mockResolvedValue({
      content: [{ type: 'text', text: 'not json' }],
    });
    mockSafeJsonParseFromModelText.mockReturnValue(null);

    const result = await hook(
      makeInput('reply_to_slack_thread', { text: 'Something' }),
      'tool-use-1',
      { signal: makeSignal() }
    );

    expect(result).toHaveProperty('continue', false);
  });

  it('handles AbortError (allows — turn is being cancelled)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockCallWithModelAuthAware.mockRejectedValue(abortError);

    const result = await hook(
      makeInput('reply_to_slack_thread', { text: 'Something' }),
      'tool-use-1',
      { signal: makeSignal() }
    );

    // On abort, should allow (turn is being cancelled)
    expect(result).toEqual({});
  });
});
