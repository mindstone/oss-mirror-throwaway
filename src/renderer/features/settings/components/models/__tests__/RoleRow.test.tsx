// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RoleAssignment } from '@core/rebelCore/roleAssignment';
import type { AppSettings, ModelProfile } from '@shared/types';
import {
  appendRendererOptimisticTurnStartedEvent,
  clearCurrentSessionEvents,
  useSessionStore,
} from '@renderer/features/agent-session/store/sessionStore';
import { RoleRow } from '../RoleRow';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@renderer/components/ui', async () => {
  const actual = await vi.importActual<typeof import('@renderer/components/ui')>('@renderer/components/ui');
  return {
    ...actual,
    BillingBadge: ({ source }: { source: string }) => <span data-testid={`billing-badge-${source}`}>{source}</span>,
    Tooltip: ({ children, content }: { children: React.ReactElement; content?: string }) =>
      React.cloneElement(
        children,
        content ? ({ 'data-tooltip-content': content } as React.HTMLAttributes<HTMLElement>) : {},
      ),
  };
});

const profile: ModelProfile = {
  id: 'profile-1',
  name: 'Gateway',
  providerType: 'openai',
  routeSurface: 'api-key',
  serverUrl: 'https://example.test/v1',
  model: 'gpt-5.5',
  apiKey: 'fake-key',
  createdAt: 1,
  enabled: true,
};

const settings = {
  activeProvider: 'anthropic',
  localModel: { profiles: [profile] },
  models: { apiKey: 'fake-key' },
} as AppSettings;

const baseAssignment: RoleAssignment = {
  role: 'working',
  label: 'Working',
  primary: { kind: 'profile', profileId: 'profile-1' },
  fallback: null,
  status: { kind: 'ok', source: 'profile' },
  display: {
    modelLabel: 'Gateway',
    providerLabel: 'OpenAI',
    billingSource: 'pay-per-use',
  },
  fallbackDisplay: null,
  effectiveModelId: 'gpt-5.5',
  warning: null,
  warningCta: null,
};

type Mounted = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => void;
};

const MID_TURN_ID = 'settings-role-row-mid-turn';

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function roleRowElement(assignment: RoleAssignment, overrides: Partial<React.ComponentProps<typeof RoleRow>> = {}) {
  return (
    <RoleRow
      role={assignment.role}
      label={`${assignment.label} model`}
      tooltip="Tooltip"
      htmlFor={`${assignment.role}-model`}
      assignment={assignment}
      onChangePrimary={vi.fn()}
      onChangeFallback={vi.fn()}
      onStatusCtaClick={vi.fn()}
      catalogModels={[{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }]}
      fallbackCatalogModels={[{ value: 'claude-opus-4-7', label: 'Claude Opus 4.7' }]}
      profiles={[profile]}
      settings={settings}
      codexConnected={false}
      activeProvider="anthropic"
      {...overrides}
    />
  );
}

function renderRoleRow(assignment: RoleAssignment, overrides: Partial<React.ComponentProps<typeof RoleRow>> = {}) {
  return mount(roleRowElement(assignment, overrides));
}

describe('RoleRow', () => {
  let mounted: Mounted | null = null;

  beforeEach(() => {
    act(() => {
      clearCurrentSessionEvents();
      useSessionStore.setState({ isBusy: false, activeTurnId: null, sessionSummaries: [] });
    });
  });

  afterEach(() => {
    mounted?.unmount();
    mounted = null;
    clearCurrentSessionEvents();
    document.body.innerHTML = '';
  });

  it('shows missing-profile warnings with the status CTA', () => {
    const onStatusCtaClick = vi.fn();
    mounted = renderRoleRow({
      ...baseAssignment,
      primary: { kind: 'profile', profileId: 'missing-profile' },
      status: { kind: 'missing-profile', profileId: 'missing-profile' },
      display: { modelLabel: 'Unknown profile', providerLabel: '', billingSource: null },
      warning: 'Selected profile is no longer available. Pick another model before Rebel can use this role.',
      warningCta: 'Pick another model',
    }, { onStatusCtaClick });

    expect(mounted.container.textContent)
      .toContain('Selected profile is no longer available. Pick another model before Rebel can use this role.');
    const button = mounted.container.querySelector<HTMLButtonElement>('[data-testid="settings-role-row-working-status-cta"]');
    expect(button?.textContent).toContain('Pick another model');

    act(() => button?.click());
    expect(onStatusCtaClick).toHaveBeenCalled();
  });

  it('shows incomplete-profile warnings with the finish-setup CTA', () => {
    mounted = renderRoleRow({
      ...baseAssignment,
      status: { kind: 'incomplete-profile', profileId: 'profile-1' },
      warning: 'Selected profile needs setup.',
      warningCta: 'Finish setup',
    });

    expect(mounted.container.textContent).toContain('Selected profile needs setup.');
    expect(mounted.container.textContent).toContain('Finish setup');
  });

  it('shows reconnect guidance for assigned-but-disconnected profiles without claiming the profile is missing', () => {
    mounted = renderRoleRow({
      ...baseAssignment,
      status: {
        kind: 'assigned-but-disconnected',
        profileId: 'profile-1',
        providerLabel: 'OpenAI',
      },
      warning: 'Reconnect OpenAI to use this role.',
      warningCta: null,
    });

    expect(mounted.container.textContent).toContain('Reconnect OpenAI to use this role.');
    expect(mounted.container.textContent).not.toContain('Pick another model before Rebel can use this role.');
    expect(mounted.container.querySelector('[data-testid="settings-role-row-working-status-cta"]')).toBeNull();
  });

  it('supports add and remove fallback interactions', () => {
    const onChangeFallback = vi.fn();
    mounted = renderRoleRow(baseAssignment, { onChangeFallback });

    const add = mounted.container.querySelector<HTMLButtonElement>('[data-testid="settings-role-row-working-add-fallback"]');
    expect(add).not.toBeNull();

    act(() => add?.click());
    expect(mounted.container.querySelector('#working-model-fallback')).not.toBeNull();

    const remove = mounted.container.querySelector<HTMLButtonElement>('[data-testid="settings-role-row-working-remove-fallback"]');
    act(() => remove?.click());

    expect(onChangeFallback).toHaveBeenCalledWith(null);
  });

  it('hides fallback affordances for recovery', () => {
    mounted = renderRoleRow({
      ...baseAssignment,
      role: 'recovery',
      label: 'Recovery',
      primary: { kind: 'auto' },
      status: { kind: 'auto' },
      display: { modelLabel: 'Automatic', providerLabel: '', billingSource: null },
      effectiveModelId: null,
    });

    expect(mounted.container.textContent).not.toContain('+ Add availability fallback');
    expect(mounted.container.querySelector('#recovery-model-fallback')).toBeNull();
  });

  it('renders an inline Test button for uncatalogued bare model ids', () => {
    const onInlineTest = vi.fn();
    const assignment: RoleAssignment = {
      ...baseAssignment,
      primary: { kind: 'model', modelId: 'future-private-model' },
      status: { kind: 'ok', source: 'model' },
      display: { modelLabel: 'future-private-model', providerLabel: 'Anthropic', billingSource: null },
      effectiveModelId: 'future-private-model',
      isUncatalogued: true,
    };

    mounted = renderRoleRow(assignment, { onInlineTest });

    expect(mounted.container.querySelector('[data-testid="settings-role-row-working-inline-test"]')).not.toBeNull();
    expect(mounted.container.textContent).not.toContain('Unverified');
  });

  it('keeps the inline Test button non-destructive after a passing test', () => {
    const assignment: RoleAssignment = {
      ...baseAssignment,
      primary: { kind: 'model', modelId: 'future-private-model' },
      status: { kind: 'ok', source: 'model' },
      display: { modelLabel: 'future-private-model', providerLabel: 'Anthropic', billingSource: null },
      effectiveModelId: 'future-private-model',
      isUncatalogued: true,
    };

    mounted = renderRoleRow(assignment, {
      onInlineTest: vi.fn(),
      inlineTestState: { testing: false, modelKey: 'future-private-model', result: { success: true } },
    });

    const button = mounted.container.querySelector<HTMLButtonElement>('[data-testid="settings-role-row-working-inline-test"]');
    expect(button?.className).not.toContain('btn-destructive');
    expect(mounted.container.querySelector('[data-testid="settings-role-row-working-inline-test-error"]')).toBeNull();
  });

  it('shows destructive inline Test styling and Notice after a failed test', () => {
    const assignment: RoleAssignment = {
      ...baseAssignment,
      primary: { kind: 'model', modelId: 'future-private-model' },
      status: { kind: 'ok', source: 'model' },
      display: { modelLabel: 'future-private-model', providerLabel: 'Anthropic', billingSource: null },
      effectiveModelId: 'future-private-model',
      isUncatalogued: true,
    };

    mounted = renderRoleRow(assignment, {
      onInlineTest: vi.fn(),
      inlineTestState: {
        testing: false,
        modelKey: 'future-private-model',
        result: { success: false, error: 'Model refused the tiny audition.' },
      },
    });

    const button = mounted.container.querySelector<HTMLButtonElement>('[data-testid="settings-role-row-working-inline-test"]');
    expect(button?.className).toContain('btn-destructive');
    expect(mounted.container.textContent).toContain('Model refused the tiny audition.');
    expect(mounted.container.querySelector('[data-testid="settings-role-row-working-inline-test-error"]')).not.toBeNull();
  });

  it('clears stale inline-test failure UI when the primary choice changes', () => {
    const staleState = {
      testing: false,
      modelKey: 'future-private-model',
      result: { success: false as const, error: 'Model refused the tiny audition.' },
    };
    const uncataloguedAssignment: RoleAssignment = {
      ...baseAssignment,
      primary: { kind: 'model', modelId: 'future-private-model' },
      status: { kind: 'ok', source: 'model' },
      display: { modelLabel: 'future-private-model', providerLabel: 'Anthropic', billingSource: null },
      effectiveModelId: 'future-private-model',
      isUncatalogued: true,
    };
    const cataloguedAssignment: RoleAssignment = {
      ...baseAssignment,
      primary: { kind: 'model', modelId: 'claude-sonnet-4-6' },
      status: { kind: 'ok', source: 'model' },
      display: { modelLabel: 'Claude Sonnet 4.6', providerLabel: 'Anthropic', billingSource: 'pay-per-use' },
      effectiveModelId: 'claude-sonnet-4-6',
      isUncatalogued: false,
    };

    mounted = renderRoleRow(uncataloguedAssignment, {
      onInlineTest: vi.fn(),
      inlineTestState: staleState,
    });

    expect(mounted.container.textContent).toContain('Model refused the tiny audition.');

    act(() => {
      mounted?.root.render(roleRowElement(cataloguedAssignment, {
        onInlineTest: vi.fn(),
        inlineTestState: staleState,
      }));
    });

    expect(mounted.container.textContent).not.toContain('Model refused the tiny audition.');
    expect(mounted.container.querySelector('[data-testid="settings-role-row-working-inline-test-error"]')).toBeNull();
  });

  it('does not render extra inline-test UI for healthy catalogued assignments', () => {
    mounted = renderRoleRow({
      ...baseAssignment,
      primary: { kind: 'model', modelId: 'claude-sonnet-4-6' },
      status: { kind: 'ok', source: 'model' },
      display: { modelLabel: 'Claude Sonnet 4.6', providerLabel: 'Anthropic', billingSource: 'pay-per-use' },
      effectiveModelId: 'claude-sonnet-4-6',
      isUncatalogued: false,
    }, { onInlineTest: vi.fn() });

    expect(mounted.container.querySelector('[data-testid="settings-role-row-working-inline-test"]')).toBeNull();
    expect(mounted.container.querySelector('[data-testid="settings-role-row-working-inline-test-error"]')).toBeNull();
  });

  it('clicking inline Test invokes the handler with the resolved choice', () => {
    const onInlineTest = vi.fn();
    const choice = { kind: 'model' as const, modelId: 'future-private-model' };
    const assignment: RoleAssignment = {
      ...baseAssignment,
      primary: choice,
      status: { kind: 'ok', source: 'model' },
      display: { modelLabel: 'future-private-model', providerLabel: 'Anthropic', billingSource: null },
      effectiveModelId: 'future-private-model',
      isUncatalogued: true,
    };

    mounted = renderRoleRow(assignment, { onInlineTest });
    const button = mounted.container.querySelector<HTMLButtonElement>('[data-testid="settings-role-row-working-inline-test"]');

    act(() => button?.click());

    expect(onInlineTest).toHaveBeenCalledWith(choice, assignment);
  });

  it('renders the secondary fallback sub-line label and picker when provided', () => {
    mounted = renderRoleRow(baseAssignment, {
      secondaryFallback: {
        label: 'When conversations get long, fall back to:',
        picker: {
          role: 'recovery',
          value: { kind: 'off' },
          htmlFor: 'long-context-fallback-model',
          catalogModels: [{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }],
          profiles: [profile],
          offLabel: 'Off',
        },
        onChange: vi.fn(),
      },
    });

    const subLine = mounted.container.querySelector('[data-testid="settings-role-row-working-secondary-fallback"]');
    expect(subLine).not.toBeNull();
    expect(subLine?.textContent).toContain('When conversations get long, fall back to:');
    expect(subLine?.querySelector('#long-context-fallback-model')).not.toBeNull();
  });

  it('renders secondary fallback warnings and invokes the scoped CTA', () => {
    const onWarningCtaClick = vi.fn();
    mounted = renderRoleRow(baseAssignment, {
      secondaryFallback: {
        label: 'When conversations get long, fall back to:',
        picker: {
          role: 'recovery',
          value: { kind: 'profile', profileId: 'missing-recovery-profile' },
          htmlFor: 'long-context-fallback-model',
          catalogModels: [{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }],
          profiles: [profile],
          offLabel: 'Off',
        },
        onChange: vi.fn(),
        warning: 'Recovery fallback is unavailable. Pick another fallback for long conversations.',
        warningCta: 'Pick fallback',
        onWarningCtaClick,
      },
    });

    const warning = mounted.container.querySelector('[data-testid="settings-role-row-working-secondary-fallback-warning"]');
    const cta = mounted.container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-role-row-working-secondary-fallback-cta"]',
    );

    expect(warning?.textContent)
      .toContain('Recovery fallback is unavailable. Pick another fallback for long conversations.');
    expect(cta?.textContent).toContain('Pick fallback');

    act(() => cta?.click());

    expect(onWarningCtaClick).toHaveBeenCalledOnce();
  });

  it('does not render the secondary fallback sub-line when the prop is omitted', () => {
    mounted = renderRoleRow(baseAssignment);

    expect(mounted.container.querySelector('[data-testid="settings-role-row-working-secondary-fallback"]')).toBeNull();
    expect(mounted.container.textContent).not.toContain('When conversations get long, fall back to:');
  });

  it('disables the secondary fallback picker with the live mid-turn tooltip', () => {
    act(() => {
      appendRendererOptimisticTurnStartedEvent(MID_TURN_ID);
      useSessionStore.setState({ activeTurnId: MID_TURN_ID, sessionSummaries: [] });
    });

    mounted = renderRoleRow(baseAssignment, {
      secondaryFallback: {
        label: 'When conversations get long, fall back to:',
        picker: {
          role: 'recovery',
          value: { kind: 'off' },
          htmlFor: 'long-context-fallback-model',
          catalogModels: [{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }],
          profiles: [profile],
          offLabel: 'Off',
        },
        onChange: vi.fn(),
      },
    });

    const subLine = mounted.container.querySelector<HTMLElement>('[data-testid="settings-role-row-working-secondary-fallback"]');
    const picker = mounted.container.querySelector<HTMLSelectElement>('#long-context-fallback-model');
    expect(picker?.disabled).toBe(true);
    expect(subLine?.tabIndex).toBe(0);
    expect(subLine?.getAttribute('aria-label')).toBeNull();
    expect(subLine?.getAttribute('data-tooltip-content')).toBe('Edits apply to your next turn.');
  });
});
