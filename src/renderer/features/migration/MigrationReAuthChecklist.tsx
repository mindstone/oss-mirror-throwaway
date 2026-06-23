import { CheckCircle2, X } from 'lucide-react';
import { Button } from '@renderer/components/ui';
import { useNavigationSafe } from '@renderer/contexts/NavigationContext';
import type { MigrationReAuthChecklist as MigrationReAuthChecklistData } from '@shared/ipc/channels/migration';
import styles from './MigrationReAuthChecklist.module.css';

type ChecklistItem = {
  title: string;
  body: string;
  target: { tab: 'agents' | 'tools' | 'cloud' | 'spaces'; section?: string };
};

const CONNECTOR_DISPLAY_NAMES: Record<string, string> = {
  digitalocean: 'DigitalOcean',
  github: 'GitHub',
  google: 'Google',
  hubspot: 'HubSpot',
  microsoft: 'Microsoft',
  plaud: 'Plaud',
  salesforce: 'Salesforce',
  slack: 'Slack',
};

function formatConnectorName(connector: string): string {
  return CONNECTOR_DISPLAY_NAMES[connector] ?? connector
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatConnectorList(connectors: readonly string[]): string {
  const names = [...new Set(connectors)].map(formatConnectorName).sort((a, b) => a.localeCompare(b));
  if (names.length === 0) return 'the connectors you use';
  if (names.length === 1) return names[0] ?? 'the connector you use';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function buildChecklistItems(reAuthChecklist?: MigrationReAuthChecklistData): ChecklistItem[] {
  const connectors = reAuthChecklist?.connectors ?? [];
  const items: ChecklistItem[] = [
    {
      title: 'AI access',
      body: 'Add your Claude/OpenAI keys or sign in again.',
      target: { tab: 'agents' as const, section: 'providerKeys' },
    },
    {
      title: 'Connectors',
      body: `Reconnect ${formatConnectorList(connectors)}.`,
      target: { tab: 'tools' as const },
    },
    {
      title: 'Cloud folders',
      body: 'Let Google Drive, OneDrive, Dropbox, or iCloud finish syncing before expecting those files to appear.',
      target: { tab: 'spaces' as const, section: 'spaces' },
    },
  ];

  if (reAuthChecklist?.cloudRepairRequired ?? true) {
    items.splice(2, 0, {
      title: 'Cloud continuity',
      body: 'Pair this computer again if you use Rebel across devices.',
      target: { tab: 'cloud' as const, section: 'cloudSync' },
    });
  }

  return items;
}

export function MigrationReAuthChecklist({ reAuthChecklist }: { reAuthChecklist?: MigrationReAuthChecklistData }) {
  const navigation = useNavigationSafe();
  const checklistItems = buildChecklistItems(reAuthChecklist);

  return (
    <>
      <div className={styles.checklist}>
        {checklistItems.map((item) => (
          <div key={item.title} className={styles.checklistItem}>
            <p className={styles.checklistTitle}>{item.title}</p>
            <p className={styles.checklistBody}>{item.body}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void navigation?.navigate({ type: 'settings', tab: item.target.tab, section: item.target.section })}
            >
              Open
            </Button>
          </div>
        ))}
      </div>
      <p className={styles.footerNote}>This is expected after a move. Nothing has gone wrong; computers are just territorial.</p>
    </>
  );
}

export function MigrationReAuthChecklistNotice({
  reAuthChecklist,
  onDismiss,
}: {
  reAuthChecklist: MigrationReAuthChecklistData;
  onDismiss: () => void;
}) {
  return (
    <section className={styles.notice} role="status" aria-live="polite" data-testid="migration-import-notice-card">
      <div className={styles.noticeContent}>
        <div className={styles.noticeHeader}>
          <div className={styles.iconWrap} aria-hidden>
            <CheckCircle2 size={16} />
          </div>
          <div className={styles.noticeCopy}>
            <p className={styles.noticeTitle}>Finish settling in</p>
            <p className={styles.noticeBody}>
              Your Rebel data is here. A few connections need fresh permission from this computer.
            </p>
          </div>
        </div>
        <MigrationReAuthChecklist reAuthChecklist={reAuthChecklist} />
      </div>
      <Button
        variant="ghost"
        size="sm"
        className={styles.dismiss}
        aria-label="Dismiss migration checklist"
        onClick={onDismiss}
      >
        <X size={14} />
      </Button>
    </section>
  );
}
