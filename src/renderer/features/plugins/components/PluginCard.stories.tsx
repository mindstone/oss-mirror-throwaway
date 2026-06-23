import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { PluginCard } from './PluginCard';
import type { PluginManifest } from '../manifest/pluginManifest';

const baseManifest: PluginManifest = {
  id: 'pomodoro-timer',
  name: 'Pomodoro Timer',
  description: 'A focus timer with circular progress ring, session tracking, and animated states.',
  version: '0.4.1',
  entryPoint: 'index.tsx',
  maturity: 'stable',
  role: 'utility',
  permissions: [],
  externalDomains: [],
  surfaces: {
    sidebar: { enabled: true },
    homepageWidget: { enabled: false, defaultSize: 'medium' },
  },
  changelog: [
    { version: '0.4.1', date: '2026-05-12', author: 'Acme Team', summary: 'Tightened timing.' },
  ],
};

const meta = {
  title: 'Plugins / PluginCard',
  component: PluginCard,
  parameters: {
    layout: 'centered',
    controls: { disable: false },
    docs: {
      description: {
        component:
          '`PluginCard` renders a Library Plugins lens card. It mirrors `SkillCard` density (180–240px height), '
          + 'reuses `Badge` (Hero), `MaturityBadge` (Labs), `Notice` (conflict warning), `InlineToggle` '
          + '(On for me / Off for me), and the existing `PluginActionsMenu` overflow.',
      },
    },
  },
} satisfies Meta<typeof PluginCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const wrapperStyle: React.CSSProperties = { width: 320 };

function ToggleHarness({
  manifest,
  origin,
  spacePath,
  initiallyActive,
  isBuiltIn,
  conflictFiles,
}: {
  manifest: PluginManifest;
  origin: 'space' | 'local';
  spacePath?: string;
  initiallyActive: boolean;
  isBuiltIn?: boolean;
  conflictFiles?: string[];
}) {
  const [active, setActive] = useState(initiallyActive);
  return (
    <div style={wrapperStyle}>
      <PluginCard
        manifest={manifest}
        origin={origin}
        spacePath={spacePath}
        isActive={active}
        isBuiltIn={isBuiltIn}
        onActiveChange={setActive}
        conflictFiles={conflictFiles}
      />
    </div>
  );
}

export const InactiveStable: Story = {
  render: () => (
    <ToggleHarness
      manifest={baseManifest}
      origin="space"
      spacePath="/Users/me/Spaces/Acme/Operations"
      initiallyActive={false}
    />
  ),
};

export const ActiveLabs: Story = {
  render: () => (
    <ToggleHarness
      manifest={{ ...baseManifest, maturity: 'labs', name: 'Pomodoro Timer (Labs)' }}
      origin="space"
      spacePath="/Users/me/Spaces/Acme/Operations"
      initiallyActive
    />
  ),
};

export const HeroPlugin: Story = {
  render: () => (
    <ToggleHarness
      manifest={{
        ...baseManifest,
        id: 'sources-browser',
        name: 'My Sources',
        description: 'Spotlight plugin for this Space — semantic search across meeting notes and recordings.',
        role: 'hero',
      }}
      origin="space"
      spacePath="/Users/me/Spaces/Acme/Knowledge"
      initiallyActive
    />
  ),
};

export const BuiltInSeeded: Story = {
  render: () => (
    <ToggleHarness
      manifest={{
        ...baseManifest,
        id: 'sources-browser',
        name: 'My Sources',
        description: 'Spotlight plugin for this Space — semantic search across meeting notes and recordings.',
        role: 'hero',
      }}
      origin="space"
      spacePath="/Users/me/Spaces/Acme/Knowledge"
      isBuiltIn
      initiallyActive
    />
  ),
};

export const WithConflict: Story = {
  render: () => (
    <ToggleHarness
      manifest={baseManifest}
      origin="space"
      spacePath="/Users/me/Spaces/Acme/Operations"
      initiallyActive={false}
      conflictFiles={['plugin.tsx']}
    />
  ),
};

export const LocalOnly: Story = {
  render: () => (
    <ToggleHarness
      manifest={{ ...baseManifest, name: 'Local Notepad', id: 'local-notepad' }}
      origin="local"
      initiallyActive
    />
  ),
};

export const NoDescription: Story = {
  render: () => (
    <ToggleHarness
      manifest={{ ...baseManifest, description: undefined, name: 'Mystery Plugin' }}
      origin="space"
      spacePath="/Users/me/Spaces/Acme/Sandbox"
      initiallyActive={false}
    />
  ),
};
