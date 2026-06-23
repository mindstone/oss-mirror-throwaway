import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Badge, Button, Tabs, TabsContent, TabsList, TabsTrigger, Tooltip } from '@renderer/components/ui';
import { createMessageSnippet, formatDurationShort } from '@renderer/utils/formatters';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import type { NarrativeAnalysis } from '@shared/ipc/schemas/sessions';
import type { InsightTurnSummary } from '../work-surface/types';
import type { TurnStepContext } from '../utils/turnStepContext';
import {
  computeSessionStats,
  formatSessionCacheTokens,
  formatSessionCost,
  formatSessionTokensInOut
} from './utils/sessionDiagnostics';
import { SummaryTab } from './tabs/SummaryTab';
import { TimelineTab } from './tabs/TimelineTab';
import { CostTab } from './tabs/CostTab';
import { ToolsTab } from './tabs/ToolsTab';
import { ContextTab } from './tabs/ContextTab';
import { CompositionTab } from './tabs/CompositionTab';
import { IssuesTab } from './tabs/IssuesTab';
import { NarrativeTab } from './tabs/NarrativeTab';
import { RawEventsTab } from './tabs/RawEventsTab';
import styles from './DiagnosticsPanel.module.css';

const DIAGNOSTIC_TABS = [
  { id: 'summary', label: 'Summary' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'cost', label: 'Cost' },
  { id: 'tools', label: 'Tools' },
  { id: 'context', label: 'Context' },
  { id: 'composition', label: 'Composition' },
  { id: 'narrative', label: 'Narrative' },
  { id: 'issues', label: 'Issues' },
  { id: 'raw-events', label: 'Raw Events' }
] as const;

type DiagnosticsTabId = (typeof DIAGNOSTIC_TABS)[number]['id'];

type DiagnosticsPanelProps = {
  sessionId: string;
  eventsByTurn: Record<string, AgentEvent[]>;
  turnSummaries: InsightTurnSummary[];
  messages: AgentTurnMessage[];
  turnStepContextByTurn: Record<string, TurnStepContext>;
  onClose: () => void;
};

const resolveSessionTitle = (
  messages: AgentTurnMessage[],
  turnSummaries: InsightTurnSummary[]
): string => {
  const firstUserMessage = messages.find((message) => message.role === 'user' && message.text.trim().length > 0);
  if (firstUserMessage) {
    return createMessageSnippet(firstUserMessage.text, 68);
  }

  if (turnSummaries.length > 0) {
    return turnSummaries[turnSummaries.length - 1]?.label ?? 'Conversation diagnostics';
  }

  return 'Conversation diagnostics';
};

export const DiagnosticsPanel = ({
  sessionId,
  eventsByTurn: inMemoryEventsByTurn,
  turnSummaries,
  messages,
  turnStepContextByTurn,
  onClose
}: DiagnosticsPanelProps) => {
  const [activeTab, setActiveTab] = useState<DiagnosticsTabId>('summary');

  // Lift AI analysis state so it persists across tab switches
  const [narrativeAnalysis, setNarrativeAnalysis] = useState<NarrativeAnalysis | null>(null);

  // ---------------------------------------------------------------------------
  // Data recovery: reload full session from disk to bypass in-memory compaction.
  // The in-memory eventsByTurn may have tool details stripped by eventCompaction.
  // The on-disk session file retains the original uncompacted data.
  // ---------------------------------------------------------------------------
  const [diskEventsByTurn, setDiskEventsByTurn] = useState<Record<string, AgentEvent[]> | null>(null);
  const [diskToolDetailArchive, setDiskToolDetailArchive] = useState<Record<string, import('@shared/types').ToolDetailArchiveEntry> | null>(null);
  const [diskLoadState, setDiskLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');

  useEffect(() => {
    let cancelled = false;
    setDiskLoadState('loading');

    window.sessionsApi
      .get({ id: sessionId })
      .then((session) => {
        if (cancelled) return;
        if (session?.eventsByTurn && Object.keys(session.eventsByTurn).length > 0) {
          setDiskEventsByTurn(session.eventsByTurn);
        }
        if (session?.toolDetailArchive && Object.keys(session.toolDetailArchive).length > 0) {
          setDiskToolDetailArchive(session.toolDetailArchive);
        }
        setDiskLoadState('loaded');
      })
      .catch(() => {
        if (!cancelled) setDiskLoadState('error');
      });

    return () => { cancelled = true; };
  }, [sessionId]);

  // Use disk-loaded events if available (full fidelity), otherwise fall back to in-memory
  const eventsByTurn = diskEventsByTurn ?? inMemoryEventsByTurn;
  const toolDetailArchive = diskToolDetailArchive ?? null;
  const recoveredFromDisk = diskEventsByTurn !== null;

  // Memo keyed to eventsByTurn identity alone. Invariant: messages is
  // downstream of the event flow that bumps eventsByTurnVersion in
  // sessionStore (see store/sessionStore.ts "Invariants" header), so its
  // content is implicitly covered. If you add a path that updates messages
  // WITHOUT appending an agent event, this deps array must be expanded
  // (e.g. add `messages.length`). Stage 6 / 260523 code-health sweep.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- per invariant above
  const sessionStats = useMemo(() => computeSessionStats(eventsByTurn, messages), [eventsByTurn]);

  const sessionTitle = useMemo(
    () => resolveSessionTitle(messages, turnSummaries),
    [messages, turnSummaries]
  );

  const analyzedTurnCount = Object.keys(turnStepContextByTurn).length;
  const turnLabel = `${sessionStats.turnCount} turn${sessionStats.turnCount === 1 ? '' : 's'}`;
  const analyzedLabel = `${analyzedTurnCount} analyzed`;

  return (
    <section className={styles.panel} aria-label="Conversation diagnostics panel">
      <header className={styles.header}>
        <Button variant="ghost" size="sm" onClick={onClose} className={styles.backButton}>
          <ArrowLeft size={16} aria-hidden />
          <span>Back to conversation</span>
        </Button>
        <div className={styles.headerText}>
          <h2 className={styles.title}>{sessionTitle}</h2>
          <p className={styles.subtitle}>{turnLabel} · {analyzedLabel}</p>
        </div>
      </header>

      {diskLoadState === 'loading' && (
        <div className={styles.compactedBanner} role="status" aria-live="polite">
          <RefreshCw size={14} className={styles.spinIcon} aria-hidden />
          <span>Loading full session data from disk…</span>
        </div>
      )}

      {diskLoadState === 'loaded' && recoveredFromDisk && sessionStats.isCompacted === false && (
        <div className={styles.recoveredBanner} role="status" aria-live="polite">
          <Badge variant="muted" size="sm">Recovered</Badge>
          <span>Full diagnostic data recovered from disk</span>
        </div>
      )}

      {sessionStats.isCompacted && (
        <div className={styles.compactedBanner} role="status" aria-live="polite">
          <Badge variant="muted" size="sm">Compacted</Badge>
          <span>Some diagnostic data has been compacted for this session</span>
        </div>
      )}

      <div className={styles.statsBar}>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>Total turns</span>
          <span className={styles.statValue}>{sessionStats.turnCount}</span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>Total duration</span>
          <span className={styles.statValue}>{formatDurationShort(sessionStats.totalDurationMs)}</span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>Total cost</span>
          <span className={styles.statValue}>{formatSessionCost(sessionStats.totalCostUsd)}</span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statLabelRow}>
            <span className={styles.statLabel}>Total tokens (in/out)</span>
            <Tooltip
              content={`Cache read/write: ${formatSessionCacheTokens(
                sessionStats.totalCacheReadTokens,
                sessionStats.totalCacheWriteTokens
              )} · Cache efficiency: ${sessionStats.cacheEfficiencyPercent}%`}
              placement="top"
            >
              <span className={styles.infoDot} aria-hidden>ⓘ</span>
            </Tooltip>
          </span>
          <span className={styles.statValue}>
            {formatSessionTokensInOut(sessionStats.totalInputTokens, sessionStats.totalOutputTokens)}
          </span>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>Context window</span>
          <Badge variant="outline" size="sm">{sessionStats.contextWindowMode}</Badge>
        </div>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>Errors</span>
          {sessionStats.errorCount > 0 ? (
            <Badge variant="destructive" size="sm">{sessionStats.errorCount}</Badge>
          ) : (
            <span className={styles.statValue}>0</span>
          )}
        </div>
        <div className={styles.statItem}>
          <span className={styles.statLabel}>Model</span>
          <span className={styles.statValue}>{sessionStats.modelName}</span>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as DiagnosticsTabId)}
        className={styles.tabs}
      >
        <TabsList variant="underline" className={styles.tabsList}>
          {DIAGNOSTIC_TABS.map((tab) => (
            <TabsTrigger key={tab.id} value={tab.id} className={styles.tabsTrigger}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="summary" className={styles.tabContent}>
          <SummaryTab
            eventsByTurn={eventsByTurn}
            turnSummaries={turnSummaries}
            messages={messages}
          />
        </TabsContent>

        <TabsContent value="timeline" className={styles.tabContent}>
          <TimelineTab
            eventsByTurn={eventsByTurn}
            turnSummaries={turnSummaries}
            messages={messages}
          />
        </TabsContent>

        <TabsContent value="cost" className={styles.tabContent}>
          <CostTab eventsByTurn={eventsByTurn} turnSummaries={turnSummaries} />
        </TabsContent>

        <TabsContent value="tools" className={styles.tabContent}>
          <ToolsTab eventsByTurn={eventsByTurn} turnSummaries={turnSummaries} />
        </TabsContent>

        <TabsContent value="context" className={styles.tabContent}>
          <ContextTab eventsByTurn={eventsByTurn} turnSummaries={turnSummaries} />
        </TabsContent>

        <TabsContent value="composition" className={styles.tabContent}>
          <CompositionTab eventsByTurn={eventsByTurn} turnSummaries={turnSummaries} toolDetailArchive={toolDetailArchive} />
        </TabsContent>

        <TabsContent value="narrative" className={styles.tabContent}>
          <NarrativeTab
            sessionId={sessionId}
            eventsByTurn={eventsByTurn}
            turnSummaries={turnSummaries}
            toolDetailArchive={toolDetailArchive}
            analysis={narrativeAnalysis}
            onAnalysisChange={setNarrativeAnalysis}
          />
        </TabsContent>

        <TabsContent value="issues" className={styles.tabContent}>
          <IssuesTab eventsByTurn={eventsByTurn} turnSummaries={turnSummaries} />
        </TabsContent>

        <TabsContent value="raw-events" className={styles.tabContent}>
          <RawEventsTab eventsByTurn={eventsByTurn} turnSummaries={turnSummaries} />
        </TabsContent>
      </Tabs>
    </section>
  );
};
