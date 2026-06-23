import { describe, expect, it, vi } from 'vitest';
import type { ToolAuthState, ToolAuthStatus, ToolType } from '../useOnboardingFlow';
import {
  isConnectedStatus,
  isInFlight,
  isPollingStatus,
  isToolAuthGateRelevantStatus,
  toolAuthEventFromAuthUrlResponse,
  toolAuthEventFromVerifyResponse,
  toolAuthReducer,
  type ToolAuthEvent,
} from '../toolAuthMachine';

const STATUSES: ToolAuthStatus[] = [
  'pending',
  'generating',
  'ready_to_connect',
  'awaiting_auth',
  'verifying',
  'connected',
  'error',
];

function makeState(status: ToolAuthStatus, tool: ToolType = 'gmail'): ToolAuthState {
  return {
    tool,
    displayName: tool,
    description: `${tool} description`,
    serverName: tool,
    status,
    authUrl: status === 'ready_to_connect' || status === 'awaiting_auth' ? 'https://auth.example.test' : null,
    error: status === 'error' ? 'Previous error' : null,
    awaitingSince: status === 'awaiting_auth' || status === 'verifying' ? 1234 : null,
    required: tool === 'gmail',
  };
}

function reduceOne(status: ToolAuthStatus, event: ToolAuthEvent): {
  initial: ToolAuthState[];
  next: ToolAuthState[];
  nextState: ToolAuthState;
} {
  const initial = [makeState(status)];
  const next = toolAuthReducer(initial, event);
  return { initial, next, nextState: next[0] };
}

function expectedStatus(status: ToolAuthStatus, event: ToolAuthEvent): ToolAuthStatus | 'unchanged' {
  switch (event.type) {
    case 'GENERATE_REQUESTED':
      return status === 'pending' || status === 'ready_to_connect' || status === 'error'
        ? 'generating'
        : 'unchanged';
    case 'URL_READY':
      return status === 'generating' ? 'ready_to_connect' : 'unchanged';
    case 'USER_CLICKED_CONNECT':
      return status === 'ready_to_connect' || status === 'generating' ? 'awaiting_auth' : 'unchanged';
    case 'GENERATE_FAILED':
      return status === 'generating' ? 'error' : 'unchanged';
    case 'LOCAL_OAUTH_CONNECTED':
      return 'connected';
    case 'EXISTING_ACCOUNT_FOUND':
      return ['pending', 'generating', 'ready_to_connect', 'awaiting_auth', 'verifying'].includes(status)
        ? 'connected'
        : 'unchanged';
    case 'CATALOG_CONNECTION_OBSERVED':
      return status === 'pending' ? 'connected' : 'unchanged';
    case 'POLL_AUTHENTICATED':
    case 'VERIFY_AUTHENTICATED':
      return status === 'awaiting_auth' || status === 'verifying' ? 'connected' : 'unchanged';
    case 'VERIFY_REQUESTED':
      return status === 'awaiting_auth' ? 'verifying' : 'unchanged';
    case 'VERIFY_PENDING':
      return status === 'verifying' ? 'awaiting_auth' : 'unchanged';
    case 'VERIFY_FAILED':
      return status === 'verifying' ? 'error' : 'unchanged';
    case 'POLL_TIMEOUT':
      return status === 'awaiting_auth' ? 'error' : 'unchanged';
    case 'DISCONNECTED':
      // Resets to `pending` from ANY status — pre-FSM ToolAuthStep reset every
      // tool sharing a connector unconditionally, not only the connected one.
      return 'pending';
    case 'ERROR_CLEARED':
    case 'PATCH_STATUS':
    case 'FIELD_PATCHED':
    case 'STATES_REPLACED':
      return status;
    default:
      return event satisfies never;
  }
}

const MATRIX_EVENTS: ToolAuthEvent[] = [
  { type: 'GENERATE_REQUESTED', tool: 'gmail' },
  { type: 'URL_READY', tool: 'gmail', authUrl: 'https://auth.example.test/ready' },
  { type: 'USER_CLICKED_CONNECT', tool: 'gmail', awaitingSince: 9999 },
  { type: 'GENERATE_FAILED', tool: 'gmail', error: 'Could not generate link' },
  { type: 'LOCAL_OAUTH_CONNECTED', tools: ['gmail'] },
  { type: 'EXISTING_ACCOUNT_FOUND', tools: ['gmail'] },
  { type: 'CATALOG_CONNECTION_OBSERVED', tool: 'gmail' },
  { type: 'POLL_AUTHENTICATED', tool: 'gmail' },
  { type: 'VERIFY_REQUESTED', tool: 'gmail' },
  { type: 'VERIFY_AUTHENTICATED', tool: 'gmail' },
  { type: 'VERIFY_PENDING', tool: 'gmail' },
  { type: 'VERIFY_FAILED', tool: 'gmail', error: 'Could not verify auth' },
  { type: 'POLL_TIMEOUT', tool: 'gmail', error: 'Timed out waiting for authentication - try again.' },
  { type: 'DISCONNECTED', tool: 'gmail' },
  { type: 'ERROR_CLEARED', tool: 'gmail' },
  { type: 'FIELD_PATCHED', tool: 'gmail', patch: { authUrl: 'https://auth.example.test/patched' } },
];

describe('toolAuthReducer transition matrix', () => {
  it.each(STATUSES.flatMap((status) => MATRIX_EVENTS.map((event) => ({ status, event }))))(
    '$status + $event.type',
    ({ status, event }) => {
      const { initial, next, nextState } = reduceOne(status, event);
      const expected = expectedStatus(status, event);

      if (expected === 'unchanged') {
        expect(next).toBe(initial);
        expect(nextState.status).toBe(status);
        return;
      }

      expect(nextState.status).toBe(expected);
    },
  );
});

describe('toolAuthReducer forbidden transitions from postmortem narrative', () => {
  it('keeps ready_to_connect out of polling-authenticated overwrite paths', () => {
    const { initial, next, nextState } = reduceOne('ready_to_connect', {
      type: 'POLL_AUTHENTICATED',
      tool: 'gmail',
    });

    expect(next).toBe(initial);
    expect(nextState.status).toBe('ready_to_connect');
  });

  it('keeps ready_to_connect out of manual-verify authenticated overwrite paths', () => {
    const { initial, next, nextState } = reduceOne('ready_to_connect', {
      type: 'VERIFY_AUTHENTICATED',
      tool: 'gmail',
    });

    expect(next).toBe(initial);
    expect(nextState.status).toBe('ready_to_connect');
  });

  it('never lets URL_READY jump directly to awaiting_auth', () => {
    const { nextState } = reduceOne('generating', {
      type: 'URL_READY',
      tool: 'gmail',
      authUrl: 'https://auth.example.test/ready',
    });

    expect(nextState.status).toBe('ready_to_connect');
    expect(nextState.status).not.toBe('awaiting_auth');
  });

  it('keeps pending out of polling-authenticated overwrite paths', () => {
    const { initial, next, nextState } = reduceOne('pending', {
      type: 'POLL_AUTHENTICATED',
      tool: 'gmail',
    });

    expect(next).toBe(initial);
    expect(nextState.status).toBe('pending');
  });

  it('keeps pending out of manual-verify authenticated overwrite paths', () => {
    const { initial, next, nextState } = reduceOne('pending', {
      type: 'VERIFY_AUTHENTICATED',
      tool: 'gmail',
    });

    expect(next).toBe(initial);
    expect(nextState.status).toBe('pending');
  });

  it('requires an explicit click or auto-start event before polling status is reachable', () => {
    const ready = toolAuthReducer([makeState('generating')], {
      type: 'URL_READY',
      tool: 'gmail',
      authUrl: 'https://auth.example.test/ready',
    });
    const awaiting = toolAuthReducer(ready, {
      type: 'USER_CLICKED_CONNECT',
      tool: 'gmail',
      awaitingSince: 5678,
    });

    expect(ready[0].status).toBe('ready_to_connect');
    expect(isPollingStatus(ready[0].status)).toBe(false);
    expect(awaiting[0].status).toBe('awaiting_auth');
    expect(isPollingStatus(awaiting[0].status)).toBe(true);
  });
});

describe('toolAuthReducer field and error handling', () => {
  it.each(STATUSES)('ERROR_CLEARED clears error without changing %s status', (status) => {
    const initialState = { ...makeState(status), error: 'Please try again' };
    const next = toolAuthReducer([initialState], { type: 'ERROR_CLEARED', tool: 'gmail' });

    expect(next[0].status).toBe(status);
    expect(next[0].error).toBeNull();
  });

  it('rejects status-changing field patches in dev/test', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      expect(() =>
        toolAuthReducer([makeState('pending')], {
          type: 'FIELD_PATCHED',
          tool: 'gmail',
          patch: { status: 'connected' } as never,
        }),
      ).toThrow('Illegal tool auth state transition');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('preserves awaitingSince when VERIFY_PENDING returns verifying to awaiting_auth', () => {
    const next = toolAuthReducer([{ ...makeState('verifying'), awaitingSince: 251202 }], {
      type: 'VERIFY_PENDING',
      tool: 'gmail',
    });

    expect(next[0].status).toBe('awaiting_auth');
    expect(next[0].awaitingSince).toBe(251202);
  });

  it.each([
    {
      label: 'ready_to_connect',
      secondPatch: {
        type: 'PATCH_STATUS' as const,
        tool: 'gmail' as const,
        status: 'ready_to_connect' as const,
        fields: { authUrl: 'https://auth.example.test/ready' },
      },
      expected: {
        status: 'ready_to_connect' as const,
        authUrl: 'https://auth.example.test/ready',
        error: null,
      },
    },
    {
      label: 'awaiting_auth',
      secondPatch: {
        type: 'PATCH_STATUS' as const,
        tool: 'gmail' as const,
        status: 'awaiting_auth' as const,
        fields: { authUrl: 'https://auth.example.test/ready', error: null, awaitingSince: 260608 },
      },
      expected: {
        status: 'awaiting_auth' as const,
        authUrl: 'https://auth.example.test/ready',
        error: null,
        awaitingSince: 260608,
      },
    },
    {
      label: 'error',
      secondPatch: {
        type: 'PATCH_STATUS' as const,
        tool: 'gmail' as const,
        status: 'error' as const,
        fields: { error: 'Failed to generate auth link', awaitingSince: null },
      },
      expected: {
        status: 'error' as const,
        error: 'Failed to generate auth link',
        awaitingSince: null,
      },
    },
  ])('applies same-tick pending -> generating -> $label legacy status patches', ({ secondPatch, expected }) => {
    const generating = toolAuthReducer([makeState('pending')], {
      type: 'PATCH_STATUS',
      tool: 'gmail',
      status: 'generating',
      fields: { error: null },
    });
    const next = toolAuthReducer(generating, secondPatch);

    expect(generating[0].status).toBe('generating');
    expect(next[0]).toMatchObject(expected);
  });

  it('preserves authUrl when legacy error and disconnect patches omit authUrl', () => {
    const authUrl = 'https://auth.example.test/keep-me';
    const errored = toolAuthReducer([{ ...makeState('generating'), authUrl }], {
      type: 'PATCH_STATUS',
      tool: 'gmail',
      status: 'error',
      fields: { error: 'Could not generate link', awaitingSince: null },
    });
    const disconnected = toolAuthReducer([{ ...makeState('connected'), authUrl }], {
      type: 'PATCH_STATUS',
      tool: 'gmail',
      status: 'pending',
      fields: { error: null, awaitingSince: null },
    });

    expect(errored[0]).toMatchObject({
      status: 'error',
      authUrl,
      error: 'Could not generate link',
      awaitingSince: null,
    });
    expect(disconnected[0]).toMatchObject({
      status: 'pending',
      authUrl,
      error: null,
      awaitingSince: null,
    });
  });

  it.each(['error', 'awaiting_auth', 'generating', 'ready_to_connect', 'verifying', 'connected'] as const)(
    'DISCONNECTED resets a %s sibling tool to pending (pre-FSM reset every connector tool unconditionally)',
    (initialStatus) => {
      const result = toolAuthReducer(
        [{ ...makeState(initialStatus), error: 'stale', awaitingSince: 1234 }],
        { type: 'DISCONNECTED', tool: 'gmail' },
      );
      expect(result[0]).toMatchObject({ status: 'pending', error: null, awaitingSince: null });
    },
  );

  it.each([
    {
      initialStatus: 'generating' as const,
      event: { type: 'GENERATE_FAILED' as const, tool: 'gmail' as const, error: 'Could not generate link' },
      expectedStatus: 'error' as const,
    },
    {
      initialStatus: 'verifying' as const,
      event: { type: 'VERIFY_FAILED' as const, tool: 'gmail' as const, error: 'Could not verify auth' },
      expectedStatus: 'error' as const,
    },
    {
      initialStatus: 'awaiting_auth' as const,
      event: {
        type: 'POLL_TIMEOUT' as const,
        tool: 'gmail' as const,
        error: 'Timed out waiting for authentication - try again.',
      },
      expectedStatus: 'error' as const,
    },
    {
      initialStatus: 'connected' as const,
      event: { type: 'DISCONNECTED' as const, tool: 'gmail' as const },
      expectedStatus: 'pending' as const,
    },
  ])('preserves authUrl when $event.type omits authUrl', ({ initialStatus, event, expectedStatus }) => {
    const authUrl = 'https://auth.example.test/keep-me';
    const next = toolAuthReducer([{ ...makeState(initialStatus), authUrl }], event);

    expect(next[0].status).toBe(expectedStatus);
    expect(next[0].authUrl).toBe(authUrl);
  });

  it('keeps error reachable and gate-relevant for the 251217 escape path', () => {
    const generating = toolAuthReducer([makeState('pending', 'gmail'), makeState('pending', 'outlook-mail')], {
      type: 'GENERATE_REQUESTED',
      tool: 'gmail',
    });
    const errored = toolAuthReducer(generating, {
      type: 'GENERATE_FAILED',
      tool: 'gmail',
      error: 'Email auth failed',
    });
    const anyEmailGateRelevant = errored.some(
      (state) =>
        (state.tool === 'gmail' || state.tool === 'outlook-mail') &&
        isToolAuthGateRelevantStatus(state.status),
    );

    expect(errored[0].status).toBe('error');
    expect(errored[1].status).toBe('pending');
    expect(anyEmailGateRelevant).toBe(true);
  });

  it('allows guarded full-state replacement for legacy setter call sites', () => {
    const initial = [
      makeState('pending', 'gmail'),
      makeState('awaiting_auth', 'outlook-mail'),
      makeState('connected', 'slack'),
    ];

    const next = toolAuthReducer(initial, {
      type: 'STATES_REPLACED',
      replacement: (states) =>
        states.map((state) => {
          if (state.tool === 'gmail') {
            return { ...state, status: 'connected', error: null };
          }
          if (state.tool === 'outlook-mail') {
            return {
              ...state,
              status: 'error',
              authUrl: null,
              awaitingSince: null,
              error: 'Timed out waiting for authentication - try again.',
            };
          }
          return state;
        }),
    });

    expect(next.find((state) => state.tool === 'gmail')?.status).toBe('connected');
    expect(next.find((state) => state.tool === 'outlook-mail')?.status).toBe('error');
    expect(next.find((state) => state.tool === 'slack')?.status).toBe('connected');
  });

  it('rejects full-state replacement when a status change is outside the transition table', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      expect(() =>
        toolAuthReducer([makeState('pending')], {
          type: 'STATES_REPLACED',
          replacement: [{ ...makeState('pending'), status: 'awaiting_auth' }],
        }),
      ).toThrow('Illegal tool auth state replacement');
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe('toolAuthReducer shared-token batch connections', () => {
  it('connects Google sibling tools from a local OAuth success', () => {
    const initial = [
      makeState('generating', 'gmail'),
      makeState('pending', 'google-calendar'),
      makeState('pending', 'outlook-mail'),
    ];

    const next = toolAuthReducer(initial, {
      type: 'LOCAL_OAUTH_CONNECTED',
      tools: ['gmail', 'google-calendar'],
    });

    expect(next.find((state) => state.tool === 'gmail')?.status).toBe('connected');
    expect(next.find((state) => state.tool === 'google-calendar')?.status).toBe('connected');
    expect(next.find((state) => state.tool === 'outlook-mail')?.status).toBe('pending');
  });

  it('connects Microsoft sibling tools from a local OAuth success', () => {
    const initial = [
      makeState('generating', 'outlook-mail'),
      makeState('pending', 'outlook-calendar'),
      makeState('error', 'teams'),
      makeState('pending', 'slack'),
    ];

    const next = toolAuthReducer(initial, {
      type: 'LOCAL_OAUTH_CONNECTED',
      tools: ['outlook-mail', 'outlook-calendar', 'teams'],
    });

    expect(next.find((state) => state.tool === 'outlook-mail')?.status).toBe('connected');
    expect(next.find((state) => state.tool === 'outlook-calendar')?.status).toBe('connected');
    expect(next.find((state) => state.tool === 'teams')?.status).toBe('connected');
    expect(next.find((state) => state.tool === 'slack')?.status).toBe('pending');
  });
});

describe('tool auth boundary parsers', () => {
  it('maps auth URL success to URL_READY unless autoStart is explicit', () => {
    expect(
      toolAuthEventFromAuthUrlResponse('gmail', { success: true, authUrl: 'https://auth.example.test' }),
    ).toEqual({
      type: 'URL_READY',
      tool: 'gmail',
      authUrl: 'https://auth.example.test',
    });

    expect(
      toolAuthEventFromAuthUrlResponse(
        'gmail',
        { success: true, authUrl: 'https://auth.example.test' },
        { autoStart: true, awaitingSince: 42 },
      ),
    ).toEqual({
      type: 'USER_CLICKED_CONNECT',
      tool: 'gmail',
      authUrl: 'https://auth.example.test',
      awaitingSince: 42,
      autoStart: true,
    });
  });

  it('maps verify success by source and treats pending poll responses as no-op', () => {
    expect(
      toolAuthEventFromVerifyResponse('gmail', { success: true, isAuthenticated: true }, { source: 'poll' }),
    ).toEqual({ type: 'POLL_AUTHENTICATED', tool: 'gmail' });
    expect(
      toolAuthEventFromVerifyResponse('gmail', { success: true, isAuthenticated: true }, { source: 'verify' }),
    ).toEqual({ type: 'VERIFY_AUTHENTICATED', tool: 'gmail' });
    expect(
      toolAuthEventFromVerifyResponse('gmail', { success: true, isAuthenticated: false }, { source: 'verify' }),
    ).toEqual({ type: 'VERIFY_PENDING', tool: 'gmail' });
    expect(
      toolAuthEventFromVerifyResponse('gmail', { success: true, isAuthenticated: false }, { source: 'poll' }),
    ).toEqual({ type: 'FIELD_PATCHED', tool: 'gmail', patch: {} });
  });

  it('maps generate malformed IPC payload fallbacks to terminal generate failures', () => {
    expect(toolAuthEventFromAuthUrlResponse('gmail', null)).toEqual({
      type: 'GENERATE_FAILED',
      tool: 'gmail',
      error: 'Failed to generate auth link',
    });
    expect(toolAuthEventFromAuthUrlResponse('gmail', { success: true })).toEqual({
      type: 'GENERATE_FAILED',
      tool: 'gmail',
      error: 'Failed to generate auth link',
    });
    expect(toolAuthEventFromAuthUrlResponse('gmail', { success: false, error: 'Denied' })).toEqual({
      type: 'GENERATE_FAILED',
      tool: 'gmail',
      error: 'Denied',
    });

    const next = toolAuthReducer(
      [makeState('generating')],
      toolAuthEventFromAuthUrlResponse('gmail', { success: true }),
    );

    expect(next[0].status).toBe('error');
    expect(next[0].error).toBe('Failed to generate auth link');
  });

  it('maps manual-verify malformed IPC payload fallbacks to terminal verify events', () => {
    expect(toolAuthEventFromVerifyResponse('gmail', null, { source: 'verify' })).toEqual({
      type: 'VERIFY_FAILED',
      tool: 'gmail',
      error: 'Failed to verify authentication',
    });
    expect(toolAuthEventFromVerifyResponse('gmail', { success: true }, { source: 'verify' })).toEqual({
      type: 'VERIFY_PENDING',
      tool: 'gmail',
    });
    expect(
      toolAuthEventFromVerifyResponse('gmail', { success: false, error: 'Expired' }, { source: 'verify' }),
    ).toEqual({
      type: 'VERIFY_FAILED',
      tool: 'gmail',
      error: 'Expired',
    });
    expect(
      toolAuthEventFromVerifyResponse('gmail', { error: 'Malformed' }, { source: 'verify' }),
    ).toEqual({
      type: 'VERIFY_FAILED',
      tool: 'gmail',
      error: 'Malformed',
    });

    const failed = toolAuthReducer(
      [makeState('verifying')],
      toolAuthEventFromVerifyResponse('gmail', null, { source: 'verify' }),
    );
    const pending = toolAuthReducer(
      [{ ...makeState('verifying'), awaitingSince: 8675309 }],
      toolAuthEventFromVerifyResponse('gmail', { success: true }, { source: 'verify' }),
    );

    expect(failed[0].status).toBe('error');
    expect(failed[0].error).toBe('Failed to verify authentication');
    expect(pending[0].status).toBe('awaiting_auth');
    expect(pending[0].awaitingSince).toBe(8675309);
  });

  it('keeps malformed poll IPC payload fallbacks as safe no-op events', () => {
    expect(toolAuthEventFromVerifyResponse('gmail', null, { source: 'poll' })).toEqual({
      type: 'FIELD_PATCHED',
      tool: 'gmail',
      patch: {},
    });
    expect(toolAuthEventFromVerifyResponse('gmail', { success: true }, { source: 'poll' })).toEqual({
      type: 'FIELD_PATCHED',
      tool: 'gmail',
      patch: {},
    });
  });
});

describe('tool auth FSM status predicates', () => {
  it('classifies only FSM statuses, not connector-catalog statuses', () => {
    expect(isPollingStatus('awaiting_auth')).toBe(true);
    expect(isInFlight('generating')).toBe(true);
    expect(isInFlight('verifying')).toBe(true);
    expect(isConnectedStatus('connected')).toBe(true);
    expect(isToolAuthGateRelevantStatus('error')).toBe(true);
    expect(isToolAuthGateRelevantStatus('pending')).toBe(false);
  });
});
