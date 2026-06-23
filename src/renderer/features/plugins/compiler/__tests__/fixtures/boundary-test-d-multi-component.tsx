/**
 * Boundary Test D: Multi-component plugin file
 *
 * Tests whether a plugin can define multiple React components (helper
 * components) and use them within the default-exported main component.
 * Expected: compile succeeds (validator only checks for default export
 * and forbidden patterns, not component count).
 */
import { useState } from 'react';
import { useConversations } from '@rebel/plugin-api';
import { Card, Stack, Badge, Button } from '@rebel/plugin-ui';

// Helper component 1: Header with action
function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0' }}>
      <span style={{ fontSize: '0.875rem', fontWeight: 600 }}>{title}</span>
      <Badge variant="outline">{count}</Badge>
    </div>
  );
}

// Helper component 2: Stat row
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '0.8125rem' }}>
      <span style={{ color: 'var(--color-text-secondary)' }}>{label}</span>
      <span style={{ fontWeight: 500 }}>{value}</span>
    </div>
  );
}

// Helper component 3: Conversation item with multiple features
function ConvoItem({
  title,
  isBusy,
  date,
  onSelect,
}: {
  title: string;
  isBusy: boolean;
  date: string;
  onSelect: () => void;
}) {
  return (
    <Card onClick={onSelect}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: '0.875rem', fontWeight: 500 }}>{title}</div>
          <div style={{ fontSize: '0.6875rem', color: 'var(--color-text-secondary)', marginTop: '2px' }}>{date}</div>
        </div>
        {isBusy && <Badge variant="secondary">Active</Badge>}
      </div>
    </Card>
  );
}

// Helper component 4: Empty state
function EmptyState({ message }: { message: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'var(--color-text-secondary)', fontSize: '0.8125rem' }}>
      {message}
    </div>
  );
}

// Helper component 5: Tab bar
function TabBar({
  tabs,
  active,
  onSelect,
}: {
  tabs: string[];
  active: string;
  onSelect: (tab: string) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: '4px' }}>
      {tabs.map((tab) => (
        <Button
          key={tab}
          variant={tab === active ? 'default' : 'ghost'}
          onClick={() => onSelect(tab)}
        >
          {tab}
        </Button>
      ))}
    </div>
  );
}

// Main default-exported component uses all helpers
export default function MultiComponentPlugin() {
  const { data: conversations, isLoading } = useConversations();
  const [tab, setTab] = useState('All');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (isLoading) {
    return <EmptyState message="Loading..." />;
  }

  const filtered =
    tab === 'Active'
      ? conversations.filter((c) => c.isBusy)
      : tab === 'Recent'
        ? conversations.slice(0, 5)
        : conversations;

  const activeCount = conversations.filter((c) => c.isBusy).length;

  return (
    <Stack gap="md">
      <div style={{ padding: '1rem 1rem 0' }}>
        <h2 style={{ fontSize: '1.125rem', fontWeight: 600 }}>Multi-Component Demo</h2>
      </div>
      <div style={{ padding: '0 1rem' }}>
        <Stack gap="sm">
          <Card>
            <SectionHeader title="Overview" count={conversations.length} />
            <StatRow label="Total" value={String(conversations.length)} />
            <StatRow label="Active" value={String(activeCount)} />
            <StatRow label="Idle" value={String(conversations.length - activeCount)} />
          </Card>

          <TabBar tabs={['All', 'Active', 'Recent']} active={tab} onSelect={setTab} />

          <SectionHeader title={tab} count={filtered.length} />

          {filtered.length > 0 ? (
            filtered.slice(0, 10).map((c) => (
              <ConvoItem
                key={c.id}
                title={c.title || 'Untitled'}
                isBusy={c.isBusy}
                date={new Date(c.updatedAt).toLocaleDateString()}
                onSelect={() => setSelectedId(c.id)}
              />
            ))
          ) : (
            <EmptyState message={`No ${tab.toLowerCase()} conversations`} />
          )}

          {selectedId && (
            <Card>
              <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                Selected: {selectedId}
              </div>
            </Card>
          )}
        </Stack>
      </div>
    </Stack>
  );
}
