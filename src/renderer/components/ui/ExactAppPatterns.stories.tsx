import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { AlertCircle, AlertTriangle, Check, Play } from 'lucide-react';
import { BrowserContextChip } from '@renderer/features/app-bridge/BrowserContextChip';
import { StepPill } from '@renderer/features/onboarding/components/StepPill';
import { ConnectionChip } from '@renderer/features/settings/components/ConnectionChip';
import { FrontmatterPill } from '@renderer/features/library/components/FrontmatterPill';
import type { UnifiedConnection } from '@renderer/features/settings/hooks/useUnifiedConnections';
import automationsStyles from '@renderer/features/automations/components/AutomationsPanel.module.css';

const meta = {
  title: 'Design System/Mixed/Chips & Pills',
  parameters: {
    layout: 'fullscreen',
    controls: { disable: true },
    docs: {
      description: {
        component:
          'These stories import the exact app components directly, rather than reconstructing them from styles. Use these when you want the strongest possible source-of-truth preview for current product patterns.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const connectedConnection: UnifiedConnection = {
  id: 'slack-mindstone',
  name: 'Slack',
  description: 'Read channels, search messages, and draft follow-ups.',
  icon: 'message-square',
  status: 'connected',
  provider: 'community',
  toolCount: 12,
  serverPreview: {
    name: 'Slack-mindstone',
    transport: 'stdio',
    health: 'ok',
    workspace: 'Mindstone',
    lastConnectedAt: Date.now() - 1000 * 60 * 60 * 24 * 2,
  },
};

const warningConnection: UnifiedConnection = {
  id: 'notion-workspace',
  name: 'Notion',
  description: 'Search docs and project context from your workspace.',
  icon: 'folder',
  status: 'needs-setup',
  provider: 'direct',
  toolCount: 7,
  serverPreview: {
    name: 'Notion-workspace',
    transport: 'http',
    url: 'https://mcp.notion.example',
    health: 'unavailable',
    email: '[Mindstone-email]',
    lastConnectedAt: Date.now() - 1000 * 60 * 60 * 24 * 10,
  },
};

const disabledConnection: UnifiedConnection = {
  id: 'custom-python',
  name: 'Custom connector',
  description: 'Manually configured tool server.',
  icon: 'terminal',
  status: 'connected',
  provider: 'community',
  toolCount: 3,
  serverPreview: {
    name: 'custom-python',
    transport: 'stdio',
    health: 'ok',
    disabled: true,
  },
};

export const ChipsAndPills: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 28, padding: 24 }}>
      <section style={{ display: 'grid', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Chips & Pills</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', maxWidth: 820 }}>
          Repeated app patterns, not yet shared. These are imported directly from the app so this page
          can act as a reliable reference for what currently exists today.
        </p>
      </section>
      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Browser context chip</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <BrowserContextChip
            url="https://docs.anthropic.com/en/docs/build-with-claude/tool-use"
            title="Anthropic docs - Tool use"
          />
          <BrowserContextChip
            url="https://storybook.js.org/docs"
            title="Storybook documentation"
          />
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Onboarding step pills</h2>
        <div style={{ display: 'grid', gap: 10, maxWidth: 860 }}>
          <div className="dark" style={{ display: 'flex', gap: 12 }}>
            <StepPill index={1} total={4} label="Welcome" state="done" />
            <StepPill index={2} total={4} label="Connect tools" state="active" />
            <StepPill index={3} total={4} label="Permissions" state="upcoming" />
            <StepPill index={4} total={4} label="Finish" state="upcoming" />
          </div>
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Connection chips</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <ConnectionChip connection={connectedConnection} />
          <ConnectionChip connection={warningConnection} attentionState="needs-attention" />
          <ConnectionChip connection={disabledConnection} attentionState="inactive" />
          <ConnectionChip connection={connectedConnection} isLoading showAccountIdentity />
        </div>
      </section>

      <section style={{ display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>Frontmatter disclosure pill</h2>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)', maxWidth: 760 }}>
          Local library/editor pill. It is useful chip-family evidence, but it should not be flattened into
          a generic badge API.
        </p>
        <div style={{ maxWidth: 640, padding: '8px 0' }}>
          <FrontmatterPill
            fields={{
              owner: 'Design Systems',
              approved: true,
              tags: ['trust', 'ui', 'storybook'],
              priority: 2,
            }}
          />
        </div>
      </section>
    </div>
  ),
};

const runHistorySurface = (mode: 'light' | 'dark'): React.CSSProperties => ({
  display: 'grid',
  gap: 10,
  padding: 14,
  borderRadius: 14,
  background: mode === 'dark' ? '#0f172a' : '#ffffff',
  border: mode === 'dark' ? '1px solid rgba(148,163,184,0.2)' : '1px solid rgba(148,163,184,0.16)',
});

export const AutomationsWaitingRunHistoryPattern: Story = {
  render: () => (
    <div style={{ display: 'grid', gap: 20, padding: 24 }}>
      <section style={{ display: 'grid', gap: 8 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>Automations waiting run-history pattern</h1>
        <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
          Mixed stack: success, error, waiting single, waiting grouped, and waiting expanded. Hover
          uses the same row background tint as the live panel.
        </p>
      </section>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        {(['light', 'dark'] as const).map((mode) => (
          <div key={mode} className={mode} style={runHistorySurface(mode)}>
            <p style={{ margin: 0, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--color-text-secondary)' }}>
              {mode}
            </p>
            <div className={automationsStyles.runHistorySection}>
              <div className={automationsStyles.runHistoryTimeline}>
                <div className={`${automationsStyles.runHistoryItem} ${automationsStyles.runHistoryItemFirst}`}>
                  <div className={automationsStyles.runHistoryItemMain}>
                    <span className={`${automationsStyles.runHistoryStatus} ${automationsStyles.runHistoryStatusSuccess}`}><Check size={12} /></span>
                    <div className={automationsStyles.runHistoryInfo}>
                      <div className={automationsStyles.runHistoryHeader}>
                        <span className={automationsStyles.runHistoryStatusLabel}>Completed</span>
                        <span className={automationsStyles.runHistoryDot}>·</span>
                        <span className={automationsStyles.runHistoryTime}>2 hours ago</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className={automationsStyles.runHistoryItem}>
                  <div className={automationsStyles.runHistoryItemMain}>
                    <span className={`${automationsStyles.runHistoryStatus} ${automationsStyles.runHistoryStatusError}`}><AlertCircle size={12} /></span>
                    <div className={automationsStyles.runHistoryInfo}>
                      <div className={automationsStyles.runHistoryHeader}>
                        <span className={`${automationsStyles.runHistoryStatusLabel} ${automationsStyles.runHistoryStatusLabelError}`}>Failed</span>
                        <span className={automationsStyles.runHistoryDot}>·</span>
                        <span className={automationsStyles.runHistoryTime}>5 hours ago</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className={automationsStyles.runHistoryItem}>
                  <div className={automationsStyles.runHistoryItemMain}>
                    <span className={`${automationsStyles.runHistoryStatus} ${automationsStyles.runHistoryStatusWaiting}`}><AlertTriangle size={12} /></span>
                    <div className={automationsStyles.runHistoryInfo}>
                      <div className={automationsStyles.runHistoryHeader}>
                        <span className={automationsStyles.runHistoryStatusLabel}>Waiting</span>
                      </div>
                      <span className={automationsStyles.runHistoryTime}>1 scheduled run skipped Friday 9:00 AM</span>
                    </div>
                    <div className={automationsStyles.runHistoryActions}>
                      <button type="button" className={automationsStyles.runHistoryRetryButton}>
                        <Play size={12} />
                        <span>Run now</span>
                      </button>
                    </div>
                  </div>
                </div>

                <div className={automationsStyles.runHistoryItem}>
                  <div className={automationsStyles.runHistoryItemMain}>
                    <span className={`${automationsStyles.runHistoryStatus} ${automationsStyles.runHistoryStatusWaiting}`}><AlertTriangle size={12} /></span>
                    <div className={automationsStyles.runHistoryInfo}>
                      <div className={automationsStyles.runHistoryHeader}>
                        <span className={automationsStyles.runHistoryStatusLabel}>Waiting</span>
                      </div>
                      <span className={automationsStyles.runHistoryTime}>4 scheduled runs skipped since Thursday 3:00 PM</span>
                      <button type="button" className={automationsStyles.runHistoryWaitToggle}>
                        <span>Show details</span>
                      </button>
                    </div>
                    <div className={automationsStyles.runHistoryActions}>
                      <button type="button" className={automationsStyles.runHistoryRetryButton}>
                        <Play size={12} />
                        <span>Run now</span>
                      </button>
                    </div>
                  </div>
                </div>

                <div className={automationsStyles.runHistoryItem}>
                  <div className={automationsStyles.runHistoryItemMain}>
                    <span className={`${automationsStyles.runHistoryStatus} ${automationsStyles.runHistoryStatusWaiting}`}><AlertTriangle size={12} /></span>
                    <div className={automationsStyles.runHistoryInfo}>
                      <div className={automationsStyles.runHistoryHeader}>
                        <span className={automationsStyles.runHistoryStatusLabel}>Waiting</span>
                      </div>
                      <span className={automationsStyles.runHistoryTime}>2 scheduled runs skipped since Wednesday 7:00 AM</span>
                      <button type="button" className={automationsStyles.runHistoryWaitToggle}>
                        <span>Hide details</span>
                      </button>
                    </div>
                    <div className={automationsStyles.runHistoryActions}>
                      <button type="button" className={automationsStyles.runHistoryRetryButton}>
                        <Play size={12} />
                        <span>Run now</span>
                      </button>
                    </div>
                  </div>
                  <div className={automationsStyles.runHistoryWaitDetails}>
                    <p className={automationsStyles.runHistoryWaitText}>
                      Rebel didn&apos;t run this because ChatGPT Pro is disconnected. Reconnect and runs
                      resume on schedule, or use Run now if you&apos;d rather not wait.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  ),
};
