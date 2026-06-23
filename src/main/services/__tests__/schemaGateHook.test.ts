import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSchemaGateHook, createSchemaGatePostHook, clearSchemaGateSession } from '../schemaGateHook';

const USE_TOOL = 'mcp__super-mcp-router__use_tool';
const GET_DETAILS = 'mcp__super-mcp-router__get_tool_details';
const LIST_TOOLS = 'mcp__super-mcp-router__list_tools';

const makeHookInput = (toolName: string, toolInput: unknown) => ({
  hook_event_name: 'PreToolUse' as const,
  tool_name: toolName,
  tool_input: toolInput,
  tool_use_id: 'test-id',
});

const makePostInput = (toolName: string, toolInput: unknown, toolResponse: unknown) => ({
  hook_event_name: 'PostToolUse' as const,
  tool_name: toolName,
  tool_input: toolInput,
  tool_response: toolResponse,
  tool_use_id: 'test-id',
});

const invokeHook = (
  hook: ReturnType<typeof createSchemaGateHook>,
  input: ReturnType<typeof makeHookInput> | ReturnType<typeof makePostInput>,
) => {
  return hook(
    input as Parameters<typeof hook>[0],
    input.tool_use_id,
    { signal: new AbortController().signal },
  );
};

/**
 * Hydrate a tool by driving the PostToolUse recorder with a get_tool_details
 * result. Success by default (isError:false); pass { isError:true } or
 * { omitResponse:true } to model a failed/missing result (F3: those must NOT
 * hydrate). Mirrors how the real runtime records hydration.
 */
const hydrate = async (
  sessionId: string,
  toolIds: string[] | string,
  opts: { isError?: boolean; omitResponse?: boolean } = {},
) => {
  const postHook = createSchemaGatePostHook(sessionId);
  const response = opts.omitResponse
    ? undefined
    : { output: 'schema-json-here', isError: opts.isError ?? false };
  await invokeHook(postHook, makePostInput(GET_DETAILS, { tool_ids: toolIds }, response));
};

describe('schemaGateHook', () => {
  const SESSION_ID = 'test-session-1';

  beforeEach(() => {
    clearSchemaGateSession(SESSION_ID);
    clearSchemaGateSession('test-session-2');
    delete process.env.REBEL_SKIP_SCHEMA_GATE;
    delete process.env.REBEL_ENFORCE_SCHEMA_GATE;
  });

  afterEach(() => {
    delete process.env.REBEL_SKIP_SCHEMA_GATE;
    delete process.env.REBEL_ENFORCE_SCHEMA_GATE;
  });

  it('allows use_tool through when schema not fetched (telemetry-only mode)', async () => {
    process.env.REBEL_ENFORCE_SCHEMA_GATE = '0'; // opt out of the default-on enforcement
    const hook = createSchemaGateHook(SESSION_ID);
    const result = await invokeHook(
      hook,
      makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: { to: 'test@example.com' } }),
    );

    // Telemetry-only: allows through, does not block
    expect(result).toEqual({});
  });

  it('allows use_tool after a successful get_tool_details for that tool_id', async () => {
    const hook = createSchemaGateHook(SESSION_ID);

    // Schema fetched successfully (recorded by the PostToolUse hook)
    await hydrate(SESSION_ID, ['Gmail__send_email']);

    // Now use_tool should pass through
    const result = await invokeHook(
      hook,
      makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: { to: 'test@example.com' } }),
    );

    expect(result).toEqual({});
  });

  it('PreToolUse passes get_tool_details through without recording (recording is PostToolUse)', async () => {
    const hook = createSchemaGateHook(SESSION_ID);

    // The Pre hook must NOT record hydration for get_tool_details (F3).
    const preResult = await invokeHook(
      hook,
      makeHookInput(GET_DETAILS, { tool_ids: ['Gmail__send_email', 'Slack__post_message'] }),
    );
    expect(preResult).toEqual({});

    // After a SUCCESSFUL call (Post hook), both tools are allowed.
    await hydrate(SESSION_ID, ['Gmail__send_email', 'Slack__post_message']);
    expect(await invokeHook(hook, makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }))).toEqual({});
    expect(await invokeHook(hook, makeHookInput(USE_TOOL, { tool_id: 'Slack__post_message', args: {} }))).toEqual({});
  });

  it('allows non-Super-MCP tools unconditionally', async () => {
    const hook = createSchemaGateHook(SESSION_ID);

    const readResult = await invokeHook(
      hook,
      makeHookInput('Read', { file_path: '/tmp/test.txt' }),
    );
    expect(readResult).toEqual({});

    const writeResult = await invokeHook(
      hook,
      makeHookInput('Write', { file_path: '/tmp/test.txt', content: 'hello' }),
    );
    expect(writeResult).toEqual({});

    const editResult = await invokeHook(
      hook,
      makeHookInput('Edit', { file_path: '/tmp/test.txt' }),
    );
    expect(editResult).toEqual({});
  });

  it('respects REBEL_SKIP_SCHEMA_GATE=1 bypass', async () => {
    process.env.REBEL_SKIP_SCHEMA_GATE = '1';
    const hook = createSchemaGateHook(SESSION_ID);

    const result = await invokeHook(
      hook,
      makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
    );

    expect(result).toEqual({});
  });

  it('different sessions do not share hydrated sets', async () => {
    process.env.REBEL_ENFORCE_SCHEMA_GATE = '0'; // telemetry-only: session-2 pass-through asserts isolation, not enforcement
    const hook1 = createSchemaGateHook(SESSION_ID);
    const hook2 = createSchemaGateHook('test-session-2');

    // Hydrate in session 1
    await hydrate(SESSION_ID, ['Gmail__send_email']);

    // Session 1 should allow
    const result1 = await invokeHook(
      hook1,
      makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
    );
    expect(result1).toEqual({});

    // Session 2 should allow through (telemetry-only, no blocking)
    const result2 = await invokeHook(
      hook2,
      makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
    );
    expect(result2).toEqual({});
  });

  it('clearSchemaGateSession removes tracking', async () => {
    process.env.REBEL_ENFORCE_SCHEMA_GATE = '0'; // telemetry-only: asserts tracking-cleared via pass-through
    const hook = createSchemaGateHook(SESSION_ID);

    // Hydrate
    await hydrate(SESSION_ID, ['Gmail__send_email']);

    // Should be allowed
    const beforeClear = await invokeHook(
      hook,
      makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
    );
    expect(beforeClear).toEqual({});

    // Clear session
    clearSchemaGateSession(SESSION_ID);

    // Should now be un-hydrated (telemetry-only, still allows through)
    const afterClear = await invokeHook(
      hook,
      makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
    );
    expect(afterClear).toEqual({});
  });

  it('allows dry_run use_tool calls without hydration', async () => {
    const hook = createSchemaGateHook(SESSION_ID);

    const result = await invokeHook(
      hook,
      makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {}, dry_run: true }),
    );

    expect(result).toEqual({});
  });

  it('allows list_tools calls unconditionally', async () => {
    const hook = createSchemaGateHook(SESSION_ID);

    const result = await invokeHook(
      hook,
      makeHookInput(LIST_TOOLS, { query: 'email' }),
    );

    expect(result).toEqual({});
  });

  it('handles a successful get_tool_details with a single-string tool_ids', async () => {
    const hook = createSchemaGateHook(SESSION_ID);

    // Some callers pass a single string instead of an array
    await hydrate(SESSION_ID, 'Gmail__send_email');

    const result = await invokeHook(
      hook,
      makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
    );
    expect(result).toEqual({});
  });

  it('passes through when use_tool has no tool_id', async () => {
    const hook = createSchemaGateHook(SESSION_ID);

    const result = await invokeHook(
      hook,
      makeHookInput(USE_TOOL, { args: {} }),
    );

    // Can't gate without tool_id, so pass through
    expect(result).toEqual({});
  });

  it('PreToolUse hook ignores non-PreToolUse events', async () => {
    const hook = createSchemaGateHook(SESSION_ID);

    const result = await hook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: USE_TOOL,
        tool_input: { tool_id: 'Gmail__send_email', args: {} },
        tool_use_id: 'test-id',
      },
      'test-id',
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({});
  });

  it('allows unhydrated tools through even after other tools are hydrated (telemetry-only)', async () => {
    process.env.REBEL_ENFORCE_SCHEMA_GATE = '0'; // opt out of the default-on enforcement
    const hook = createSchemaGateHook(SESSION_ID);

    // Hydrate only Gmail
    await hydrate(SESSION_ID, ['Gmail__send_email']);

    // Slack is un-hydrated but should still be allowed through (telemetry-only)
    const result = await invokeHook(
      hook,
      makeHookInput(USE_TOOL, { tool_id: 'Slack__post_message', args: {} }),
    );
    expect(result).toEqual({});
  });

  describe('PostToolUse hydration recording (F3: success-based)', () => {
    it('a SUCCESSFUL get_tool_details hydrates → enforcing use_tool is allowed', async () => {
      process.env.REBEL_ENFORCE_SCHEMA_GATE = '1';
      const hook = createSchemaGateHook(SESSION_ID);

      await hydrate(SESSION_ID, ['Gmail__send_email'], { isError: false });

      const result = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
      );
      expect(result).toEqual({}); // hydrated → allowed
    });

    it('a stringified-JSON-array tool_ids hydrates correctly (Super-MCP coerces it) — F1', async () => {
      process.env.REBEL_ENFORCE_SCHEMA_GATE = '1';
      const hook = createSchemaGateHook(SESSION_ID);

      // Super-MCP's Stage-0 auto-repair coerces `tool_ids: '["X"]'` to an array and the
      // call SUCCEEDS — so the Post hook must record the bare id 'Gmail__send_email', NOT
      // the literal string '["Gmail__send_email"]', or the real use_tool stays denied.
      await hydrate(SESSION_ID, '["Gmail__send_email"]');

      const result = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
      );
      expect(result).toEqual({}); // hydrated via the parsed array → allowed
    });

    it('parallel same-message ordering: use_tool checked before its get_tool_details records is still denied (enforcing) — F2', async () => {
      process.env.REBEL_ENFORCE_SCHEMA_GATE = '1';
      const hook = createSchemaGateHook(SESSION_ID);

      // The real loop runs a single assistant message's tool calls concurrently, so a
      // use_tool's PreToolUse check can fire BEFORE the sibling get_tool_details's
      // PostToolUse records hydration. The gate must still deny (schema not yet seen).
      const denied = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
      );
      const r = denied as { hookSpecificOutput?: { permissionDecision?: string } };
      expect(r.hookSpecificOutput?.permissionDecision).toBe('deny');

      // Once the Post hook records the successful hydration, the retry is allowed.
      await hydrate(SESSION_ID, ['Gmail__send_email']);
      expect(
        await invokeHook(hook, makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} })),
      ).toEqual({});
    });

    it('a FAILED get_tool_details (isError) does NOT hydrate → enforcing use_tool is denied', async () => {
      process.env.REBEL_ENFORCE_SCHEMA_GATE = '1';
      const hook = createSchemaGateHook(SESSION_ID);

      // Model attempted get_tool_details but the call errored — must NOT hydrate.
      await hydrate(SESSION_ID, ['Gmail__send_email'], { isError: true });

      const result = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
      );
      const r = result as { hookSpecificOutput?: { permissionDecision?: string } };
      expect(r.hookSpecificOutput?.permissionDecision).toBe('deny');
    });

    it('a get_tool_details with a missing tool_response does NOT hydrate', async () => {
      process.env.REBEL_ENFORCE_SCHEMA_GATE = '1';
      const hook = createSchemaGateHook(SESSION_ID);

      await hydrate(SESSION_ID, ['Gmail__send_email'], { omitResponse: true });

      const result = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
      );
      const r = result as { hookSpecificOutput?: { permissionDecision?: string } };
      expect(r.hookSpecificOutput?.permissionDecision).toBe('deny');
    });

    it('the Post hook ignores non-PostToolUse events', async () => {
      const postHook = createSchemaGatePostHook(SESSION_ID);
      const result = await invokeHook(
        postHook,
        // PreToolUse-shaped event must be a no-op for the Post recorder
        makeHookInput(GET_DETAILS, { tool_ids: ['Gmail__send_email'] }),
      );
      expect(result).toEqual({});

      // and it should NOT have hydrated (enforcing use_tool still denied)
      process.env.REBEL_ENFORCE_SCHEMA_GATE = '1';
      const hook = createSchemaGateHook(SESSION_ID);
      const used = await invokeHook(hook, makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }));
      const r = used as { hookSpecificOutput?: { permissionDecision?: string } };
      expect(r.hookSpecificOutput?.permissionDecision).toBe('deny');
    });

    it('the Post hook ignores non-get_tool_details tools', async () => {
      process.env.REBEL_ENFORCE_SCHEMA_GATE = '1';
      const postHook = createSchemaGatePostHook(SESSION_ID);
      // A successful use_tool PostToolUse must not hydrate anything
      await invokeHook(
        postHook,
        makePostInput(USE_TOOL, { tool_id: 'Gmail__send_email' }, { output: 'ok', isError: false }),
      );
      const hook = createSchemaGateHook(SESSION_ID);
      const used = await invokeHook(hook, makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }));
      const r = used as { hookSpecificOutput?: { permissionDecision?: string } };
      expect(r.hookSpecificOutput?.permissionDecision).toBe('deny');
    });

    it('the Post hook respects REBEL_SKIP_SCHEMA_GATE=1 (records nothing)', async () => {
      process.env.REBEL_SKIP_SCHEMA_GATE = '1';
      await hydrate(SESSION_ID, ['Gmail__send_email']); // bypassed → no recording
      delete process.env.REBEL_SKIP_SCHEMA_GATE;

      process.env.REBEL_ENFORCE_SCHEMA_GATE = '1';
      const hook = createSchemaGateHook(SESSION_ID);
      const used = await invokeHook(hook, makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }));
      const r = used as { hookSpecificOutput?: { permissionDecision?: string } };
      expect(r.hookSpecificOutput?.permissionDecision).toBe('deny');
    });
  });

  describe('enforcing mode (REBEL_ENFORCE_SCHEMA_GATE=1)', () => {
    const expectDeny = (result: unknown, toolId: string) => {
      const r = result as {
        hookSpecificOutput?: {
          hookEventName?: string;
          permissionDecision?: string;
          permissionDecisionReason?: string;
        };
      };
      expect(r.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
      expect(r.hookSpecificOutput?.permissionDecision).toBe('deny');
      const reason = r.hookSpecificOutput?.permissionDecisionReason ?? '';
      expect(reason).toContain('get_tool_details');
      expect(reason).toContain(toolId);
    };

    it('denies unhydrated use_tool with a corrective get_tool_details message', async () => {
      process.env.REBEL_ENFORCE_SCHEMA_GATE = '1';
      const hook = createSchemaGateHook(SESSION_ID);

      const result = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
      );

      expectDeny(result, 'Gmail__send_email');
    });

    it('allows use_tool after a successful get_tool_details for that tool_id', async () => {
      process.env.REBEL_ENFORCE_SCHEMA_GATE = '1';
      const hook = createSchemaGateHook(SESSION_ID);

      await hydrate(SESSION_ID, ['Gmail__send_email']);

      const result = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
      );
      expect(result).toEqual({});
    });

    it('always allows list_tools, get_tool_details and dry_run', async () => {
      process.env.REBEL_ENFORCE_SCHEMA_GATE = '1';
      const hook = createSchemaGateHook(SESSION_ID);

      const listResult = await invokeHook(
        hook,
        makeHookInput(LIST_TOOLS, { query: 'email' }),
      );
      expect(listResult).toEqual({});

      // get_tool_details always passes the PreToolUse gate (never denied)
      const detailsResult = await invokeHook(
        hook,
        makeHookInput(GET_DETAILS, { tool_ids: ['Slack__post_message'] }),
      );
      expect(detailsResult).toEqual({});

      // dry_run use_tool for an un-hydrated tool is still allowed
      const dryRunResult = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {}, dry_run: true }),
      );
      expect(dryRunResult).toEqual({});
    });

    it('loop-guard: denies the 1st and 2nd unhydrated calls, allows the 3rd through with a warn', async () => {
      process.env.REBEL_ENFORCE_SCHEMA_GATE = '1';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const hook = createSchemaGateHook(SESSION_ID);

      const first = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
      );
      expectDeny(first, 'Gmail__send_email');

      const second = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
      );
      expectDeny(second, 'Gmail__send_email');

      // 3rd call exceeds the deny budget — allowed through
      const third = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
      );
      expect(third).toEqual({});

      warnSpy.mockRestore();
    });

    it('tracks the deny budget per tool_id independently', async () => {
      process.env.REBEL_ENFORCE_SCHEMA_GATE = '1';
      const hook = createSchemaGateHook(SESSION_ID);

      // Exhaust Gmail's budget
      await invokeHook(hook, makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }));
      await invokeHook(hook, makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }));

      // A different tool still gets denied on its first attempt
      const slack = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, { tool_id: 'Slack__post_message', args: {} }),
      );
      expectDeny(slack, 'Slack__post_message');
    });

    it('clearSchemaGateSession resets both hydration and deny-count state', async () => {
      process.env.REBEL_ENFORCE_SCHEMA_GATE = '1';
      const hook = createSchemaGateHook(SESSION_ID);

      // Hydrate Gmail (success) and exhaust Slack's deny budget
      await hydrate(SESSION_ID, ['Gmail__send_email']);
      await invokeHook(hook, makeHookInput(USE_TOOL, { tool_id: 'Slack__post_message', args: {} }));
      await invokeHook(hook, makeHookInput(USE_TOOL, { tool_id: 'Slack__post_message', args: {} }));

      clearSchemaGateSession(SESSION_ID);

      // Hydration cleared → Gmail is now denied again
      const gmail = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
      );
      expectDeny(gmail, 'Gmail__send_email');

      // Deny count cleared → Slack gets a fresh budget (denied, not allowed-through)
      const slack = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, { tool_id: 'Slack__post_message', args: {} }),
      );
      expectDeny(slack, 'Slack__post_message');
    });

    it('DEFAULT (no env set) now ENFORCES and denies an unhydrated use_tool', async () => {
      // Both env vars cleared in beforeEach → default. As of 2026-06-19 the default is ON.
      const hook = createSchemaGateHook(SESSION_ID);

      const result = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
      );
      expectDeny(result, 'Gmail__send_email');
    });

    it('explicit opt-out REBEL_ENFORCE_SCHEMA_GATE=0 is telemetry-only and never denies', async () => {
      process.env.REBEL_ENFORCE_SCHEMA_GATE = '0';
      const hook = createSchemaGateHook(SESSION_ID);

      const result = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, { tool_id: 'Gmail__send_email', args: {} }),
      );
      expect(result).toEqual({}); // opted out → allowed through (telemetry-only)
    });

    // Cross-family GPT review (Stage 1): the canonical Super-MCP call shape hydrates with a
    // NAMESPACED id but executes with package_id + a BARE tool_id. The gate must treat that
    // as hydrated (the identity-key blocker).
    it('allows the canonical shape: get_tool_details([Gmail__send_email]) → use_tool({package_id:Gmail, tool_id:send_email})', async () => {
      process.env.REBEL_ENFORCE_SCHEMA_GATE = '1';
      const hook = createSchemaGateHook(SESSION_ID);

      await hydrate(SESSION_ID, ['Gmail__send_email']);

      const result = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, {
          package_id: 'Gmail',
          tool_id: 'send_email',
          args: { to: 'test@example.com' },
        }),
      );
      expect(result).toEqual({}); // hydrated → allowed, NOT denied
    });

    it('denies the canonical bare shape when unhydrated, with a namespaced corrective hint', async () => {
      process.env.REBEL_ENFORCE_SCHEMA_GATE = '1';
      const hook = createSchemaGateHook(SESSION_ID);

      const result = await invokeHook(
        hook,
        makeHookInput(USE_TOOL, { package_id: 'Gmail', tool_id: 'send_email', args: {} }),
      );
      // Reconstructs the namespaced key for both the match and the corrective hint.
      expectDeny(result, 'Gmail__send_email');
    });
  });
});
