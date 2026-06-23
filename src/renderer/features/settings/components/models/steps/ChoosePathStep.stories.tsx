import type { Meta, StoryObj } from '@storybook/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { PROVIDER_CATALOGS } from '@shared/data/providerCatalogs';
import { materializeCatalogProfile } from '@shared/utils/catalogMaterialization';
import type { ConnectorCatalogEntry } from '@shared/utils/catalogMaterialization';
import { ChoosePathStep } from './ChoosePathStep';

// -----------------------------------------------------------------------
// Theme helpers
// -----------------------------------------------------------------------

function BodyTheme({
  theme,
  children,
}: {
  theme: 'light' | 'dark';
  children: ReactNode;
}) {
  useEffect(() => {
    document.body.classList.remove(theme === 'light' ? 'dark' : 'light');
    document.body.classList.add(theme);
    return () => {
      document.body.classList.remove(theme);
    };
  }, [theme]);

  return (
    <div
      className={theme}
      style={{
        background: 'var(--color-background)',
        color: 'var(--color-text-primary)',
        padding: 16,
        maxWidth: 560,
      }}
    >
      {children}
    </div>
  );
}

function ThemePair({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 24 }}>
      <BodyTheme theme="light">{children}</BodyTheme>
      <BodyTheme theme="dark">{children}</BodyTheme>
    </div>
  );
}

// -----------------------------------------------------------------------
// Shared fixtures
// -----------------------------------------------------------------------

const openRouterEntries = PROVIDER_CATALOGS.openrouter.slice(0, 14) as ConnectorCatalogEntry[];
const codexEntries = PROVIDER_CATALOGS.openai.slice(0, 3) as ConnectorCatalogEntry[];
const anthropicEntries = PROVIDER_CATALOGS.anthropic.slice(0, 3) as ConnectorCatalogEntry[];

const allEntries: ConnectorCatalogEntry[] = [
  ...codexEntries,
  ...openRouterEntries,
  ...anthropicEntries,
];

const allConnected = {
  codex: { connected: true },
  openrouter: { connected: true },
  anthropic: { connected: true },
  gemini: { connected: false },
};

const noOp = async () => { /* no-op */ };

// -----------------------------------------------------------------------
// Controlled search host
// Renders ChoosePathStep and fires a synthetic change event on the search
// input after mount to simulate the user having typed a query.
//
// Uses a container ref to scope the querySelector so each ThemePair instance
// drives its own input independently — fixing the bug where the unscoped
// document.querySelector only drove the light-mode input and the dark-mode
// active-search stories showed empty results.
// -----------------------------------------------------------------------

function SearchQueryHost({ initialQuery }: { initialQuery: string }) {
  const [, setReady] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="settings-models-search-input"]',
    );
    if (!input) return;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    if (nativeInputValueSetter) nativeInputValueSetter.call(input, initialQuery);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    setReady(true);
  }, [initialQuery]);

  return (
    <div ref={containerRef}>
      <ChoosePathStep
        connectorCatalogEntries={allEntries}
        existingProfiles={[]}
        providerConnections={allConnected}
        onAddCatalogEntry={noOp}
        onRemoveFromTeam={noOp}
        onSelectCustom={() => { /* no-op */ }}
      />
    </div>
  );
}

// -----------------------------------------------------------------------
// Meta
// -----------------------------------------------------------------------

const meta = {
  title: 'Settings/Models/ChoosePathStep',
  component: ChoosePathStep,
  parameters: {
    layout: 'padded',
    controls: { disable: true },
  },
  // Every story below drives the component through `render` + `ThemePair`, so
  // these args are never read at runtime — they exist only to satisfy the
  // component's required props on `StoryObj<typeof meta>` (otherwise each
  // render-only story would have to repeat an `args` block).
  args: {
    connectorCatalogEntries: allEntries,
    existingProfiles: [],
    providerConnections: allConnected,
    onAddCatalogEntry: noOp,
    onRemoveFromTeam: noOp,
    onSelectCustom: () => { /* no-op */ },
  },
} satisfies Meta<typeof ChoosePathStep>;

export default meta;
type Story = StoryObj<typeof meta>;

// -----------------------------------------------------------------------
// Stories
// -----------------------------------------------------------------------

/**
 * Recommended group — connected providers, cap active, recommended section
 * visible above connection groups. Shows the first 6 isMainModel entries.
 */
export const WithRecommended: Story = {
  render: () => (
    <ThemePair>
      <ChoosePathStep
        connectorCatalogEntries={allEntries}
        existingProfiles={[]}
        providerConnections={allConnected}
        onAddCatalogEntry={noOp}
        onRemoveFromTeam={noOp}
        onSelectCustom={() => { /* no-op */ }}
      />
    </ThemePair>
  ),
};

/** Default landing — connected providers, search box empty, cap active. */
export const DefaultLanding: Story = {
  render: () => (
    <ThemePair>
      <ChoosePathStep
        connectorCatalogEntries={allEntries}
        existingProfiles={[]}
        providerConnections={allConnected}
        onAddCatalogEntry={noOp}
        onRemoveFromTeam={noOp}
        onSelectCustom={() => { /* no-op */ }}
      />
    </ThemePair>
  ),
};

/** No providers connected — shows the "No connected providers yet" empty state. */
export const NoConnections: Story = {
  render: () => (
    <ThemePair>
      <ChoosePathStep
        connectorCatalogEntries={[]}
        existingProfiles={[]}
        providerConnections={{
          codex: { connected: false },
          openrouter: { connected: false },
          anthropic: { connected: false },
          gemini: { connected: false },
        }}
        onAddCatalogEntry={noOp}
        onRemoveFromTeam={noOp}
        onSelectCustom={() => { /* no-op */ }}
      />
    </ThemePair>
  ),
};

/** Active query narrowing results — shows filtered rows without the Show-all fold. */
export const ActiveSearchQuery: Story = {
  render: () => (
    <ThemePair>
      <SearchQueryHost initialQuery="claude" />
    </ThemePair>
  ),
};

/** Empty search result — query matches nothing; shows quiet message + custom-model CTA. */
export const SearchEmptyResult: Story = {
  render: () => (
    <ThemePair>
      <SearchQueryHost initialQuery="xyzzy-no-match" />
    </ThemePair>
  ),
};

/** Mixed state — some models on team, others available to add. */
export const SomeOnTeam: Story = {
  render: () => {
    const firstCodex = codexEntries[0];
    const firstAnthropic = anthropicEntries[0];
    const profiles = [
      ...(firstCodex ? [materializeCatalogProfile(firstCodex, { id: 'profile-codex-1' })] : []),
      ...(firstAnthropic ? [materializeCatalogProfile(firstAnthropic, { id: 'profile-anthropic-1' })] : []),
    ];
    return (
      <ThemePair>
        <ChoosePathStep
          connectorCatalogEntries={allEntries}
          existingProfiles={profiles}
          providerConnections={allConnected}
          onAddCatalogEntry={noOp}
          onRemoveFromTeam={noOp}
          onSelectCustom={() => { /* no-op */ }}
        />
      </ThemePair>
    );
  },
};

/**
 * Mindstone managed-user landing — isMindstoneActive + a managed allow-list.
 * Shows the "Included with your Mindstone plan" section with DeepSeek V4 Flash
 * and other managed models, plus Recommended (if providers connected) above it,
 * and connection groups below. Light + dark.
 */
export const MindstoneManaged: Story = {
  render: () => {
    // Use the first few openrouter entries as stand-ins for managed models.
    // In production these come from useManagedDefaults() via AgentsTab.
    const managedModelIds = openRouterEntries.slice(0, 3).map((e) => e.model);
    return (
      <ThemePair>
        <ChoosePathStep
          connectorCatalogEntries={openRouterEntries}
          existingProfiles={[]}
          providerConnections={{
            openrouter: { connected: true },
            codex: { connected: false },
            anthropic: { connected: false },
            gemini: { connected: false },
          }}
          isMindstoneActive={true}
          managedAllowedModels={managedModelIds}
          onAddCatalogEntry={noOp}
          onRemoveFromTeam={noOp}
          onSelectCustom={() => { /* no-op */ }}
        />
      </ThemePair>
    );
  },
};

/**
 * Mindstone subscriber, off-Mindstone active provider — informational state.
 * The subscriber's plan models are visible ("Included with your Mindstone plan")
 * but rows show an "On your plan" badge instead of an Add button, with copy
 * directing them to switch their active provider to Mindstone to use them.
 * This is the footgun-free interim (design option b): discoverability without
 * mis-billing risk. Light + dark.
 */
export const MindstoneSubscriberOffMindstone: Story = {
  render: () => {
    // Use the first few openrouter entries as stand-ins for managed models.
    // isMindstoneActive is false — subscriber is on a different active provider.
    const managedModelIds = openRouterEntries.slice(0, 3).map((e) => e.model);
    return (
      <ThemePair>
        <ChoosePathStep
          connectorCatalogEntries={openRouterEntries}
          existingProfiles={[]}
          providerConnections={{
            openrouter: { connected: true },
            codex: { connected: true },
            anthropic: { connected: false },
            gemini: { connected: false },
          }}
          isMindstoneActive={false}
          managedAllowedModels={managedModelIds}
          onAddCatalogEntry={noOp}
          onRemoveFromTeam={noOp}
          onSelectCustom={() => { /* no-op */ }}
        />
      </ThemePair>
    );
  },
};
