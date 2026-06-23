import type { AssembledDesktopBundle, DiagnosticManifest, LogSummary, MobileDiagnosticsBundle } from './manifest';

/**
 * MD-inline privacy allowlist. The desktop ZIP contains files that are safe to
 * ship to support over a deliberate ZIP attachment but should NOT be inlined
 * into the user-facing markdown download labelled "Best for sharing":
 *
 *   - `recent-sessions/*.json` — full message content per session
 *   - `logs/sessions/*` — turn logs that may contain message content
 *   - `rebel-system/README.md` — Chief-of-Staff system prompt (redacted, but
 *     bulky and surprising in a "share with a friend" report)
 *   - `logs/main.ndjson` — full unfiltered (redacted) main-process log dump
 *
 * Everything else from `assembled.files` (structured JSON, events.jsonl,
 * cost-ledger.jsonl, sentry-scope.json, continuity/*.json with hashed IDs,
 * `logs/errors.ndjson` warnings-and-errors-only) is fair game.
 */
const MD_INLINE_SKIP_PREFIXES = [
  'recent-sessions/',
  'logs/sessions/',
  'rebel-system/',
];
const MD_INLINE_SKIP_EXACT = new Set<string>([
  'logs/main.ndjson',
  'manifest.json',
  'README.md',
]);

function isMdInlineable(filename: string): boolean {
  if (MD_INLINE_SKIP_EXACT.has(filename)) return false;
  for (const prefix of MD_INLINE_SKIP_PREFIXES) {
    if (filename.startsWith(prefix)) return false;
  }
  return true;
}

function formatAgeMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

export function formatBundleReadme(manifest: DiagnosticManifest, logSummary: LogSummary): string {
  const lines: string[] = [];
  lines.push('# Mindstone Rebel Diagnostic Bundle');
  lines.push('');
  lines.push(`**Generated:** ${manifest.generated}`);
  lines.push(`**App Version:** ${manifest.app.version}`);
  lines.push(`**Platform:** ${manifest.app.platform} (${manifest.app.arch})`);
  lines.push(`**Packaged:** ${manifest.app.isPackaged ? 'Yes' : 'No (development)'}`);
  lines.push('');
  lines.push('## Quick Status');
  lines.push('');
  lines.push(`- **Health:** ${manifest.quickStats.healthStatus}`);
  if (manifest.quickStats.failedChecks.length > 0) lines.push(`- **Failed Checks:** ${manifest.quickStats.failedChecks.join(', ')}`);
  if (manifest.quickStats.warnChecks.length > 0) lines.push(`- **Warning Checks:** ${manifest.quickStats.warnChecks.join(', ')}`);
  lines.push(`- **Errors (last 15m):** ${manifest.quickStats.errorCountLast15m}`);
  lines.push(`- **Warnings (last 15m):** ${manifest.quickStats.warnCountLast15m}`);
  lines.push(`- **Sessions:** ${manifest.quickStats.sessionCount}`);
  if (manifest.quickStats.perfStats) {
    const perf = manifest.quickStats.perfStats;
    lines.push(`- **Slow Store Writes:** ${perf.slowStoreWritesSinceStart} (max ${perf.maxStoreWriteMs}ms)`);
    lines.push(`- **Slow Spawns:** ${perf.slowSpawnsSinceStart} (max ${perf.maxSpawnMs}ms)`);
    lines.push(`- **Uptime:** ${perf.uptimeMinutes} min | **Platform:** ${perf.platform}`);
  }
  if (manifest.quickStats.processSupervision) {
    const sup = manifest.quickStats.processSupervision;
    lines.push(`- **Last Shutdown:** ${sup.lastShutdownClean ? 'clean' : 'unclean'} | **Crashes (24h / 7d / total):** ${sup.crashesInLast24h} / ${sup.crashesInLast7Days} / ${sup.totalCrashesAllTime}${sup.lastCrashAt ? ` | **Last Crash:** ${new Date(sup.lastCrashAt).toISOString()}` : ''}`);
  }
  if (manifest.quickStats.cloudOutbox) {
    const ob = manifest.quickStats.cloudOutbox;
    lines.push(`- **Cloud Outbox:** ${ob.pending} pending${typeof ob.oldestAgeMs === 'number' ? ` (oldest ${formatAgeMs(ob.oldestAgeMs)})` : ''}`);
  }
  lines.push('');
  if (manifest.quickStats.fsExhaustion) {
    const fs = manifest.quickStats.fsExhaustion;
    const sourceParts: string[] = [];
    for (const [src, n] of Object.entries(fs.sourceCounts).sort()) {
      if (n > 0) sourceParts.push(`${src}=${n}`);
    }
    lines.push('## Filesystem Pressure');
    lines.push('');
    lines.push(`- **Queue Depth (now / peak):** ${fs.queueDepth} / ${fs.queuePeak}${typeof fs.oldestPendingAgeMs === 'number' ? ` | **Oldest Pending:** ${formatAgeMs(fs.oldestPendingAgeMs)}` : ''}`);
    if (sourceParts.length > 0) lines.push(`- **EMFILE Tags by Source:** ${sourceParts.join(', ')}`);
    if (fs.lastSource && typeof fs.lastTaggedAt === 'number') {
      lines.push(`- **Last Tagged:** \`${fs.lastSource}\` at ${new Date(fs.lastTaggedAt).toISOString()}`);
    }
    lines.push('');
  }
  if (manifest.quickStats.storeBreakdown && manifest.quickStats.storeBreakdown.entries.length > 0) {
    const breakdown = manifest.quickStats.storeBreakdown;
    lines.push('## Store File Sizes');
    lines.push('');
    lines.push(`Top-level userData files sorted by size. Total: ${formatBytes(breakdown.totalBytes)}${breakdown.truncated ? ' (list truncated)' : ''}.`);
    lines.push('');
    lines.push('| File | Size | Last modified (UTC) |');
    lines.push('|------|-----:|---------------------|');
    for (const entry of breakdown.entries) {
      lines.push(`| \`${entry.name}\` | ${formatBytes(entry.bytes)} | ${new Date(entry.mtimeMs).toISOString()} |`);
    }
    lines.push('');
  }
  const eventCounts = manifest.quickStats.recentDiagnosticEventCounts;
  const eventLastTimes = manifest.quickStats.lastDiagnosticEventTimes;
  if (eventCounts && Object.keys(eventCounts).length > 0) {
    lines.push('## Recent Diagnostic Events');
    lines.push('');
    lines.push('Per-kind tally from `events.jsonl`. Counts reflect the last events retained in the ledger, not lifetime totals.');
    lines.push('');
    lines.push('| Kind | Count | Last seen (UTC) |');
    lines.push('|------|------:|-----------------|');
    const sortedKinds = Object.keys(eventCounts).sort() as Array<keyof typeof eventCounts>;
    for (const kind of sortedKinds) {
      const count = eventCounts[kind] ?? 0;
      const lastTs = eventLastTimes?.[kind];
      const lastSeen = typeof lastTs === 'number' ? new Date(lastTs).toISOString() : '—';
      lines.push(`| \`${kind}\` | ${count} | ${lastSeen} |`);
    }
    lines.push('');
  }
  if (logSummary.errorPatterns.length > 0) {
    lines.push('## Top Error Patterns');
    lines.push('');
    for (const pattern of logSummary.errorPatterns.slice(0, 5)) {
      const levelLabel = pattern.level >= 50 ? 'ERROR' : 'WARN';
      lines.push(`- **[${levelLabel}]** ${pattern.msg} (x${pattern.count})`);
    }
    lines.push('');
  }
  if (logSummary.topicTags.length > 0) {
    lines.push('## Topic Tags');
    lines.push('');
    lines.push(`Detected topics: ${logSummary.topicTags.join(', ')}`);
    lines.push('');
  }
  lines.push('## Bundle Contents');
  lines.push('');
  lines.push('| File | Description |');
  lines.push('|------|-------------|');
  for (const [filename, entry] of Object.entries(manifest.contents)) lines.push(`| \`${filename}\` | ${entry.description} |`);
  lines.push('');
  lines.push('## For AI Agents');
  lines.push('');
  lines.push(manifest.agentGuidance);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('*This bundle contains redacted diagnostic information. API keys, tokens, and sensitive paths have been removed. User email and company name may be visible to aid support.*');
  return lines.join('\n');
}

/**
 * Renders the assembled desktop bundle as a single Markdown report — the
 * user-facing "Download Diagnostic Report" output. Same data as the ZIP
 * (no second collector chain, no re-implemented aggregation), with structured
 * files inlined as fenced code blocks. Honours `MD_INLINE_SKIP_PREFIXES`
 * so high-sensitivity files (session content, raw turn logs, system prompts)
 * stay ZIP-only.
 *
 * Renders the manifest's `sections` table so failed/missing collectors are
 * fail-loud rather than silently absent.
 */
export function formatDesktopBundleAsMarkdownReport(
  assembled: AssembledDesktopBundle,
  logSummary: LogSummary,
): string {
  const lines: string[] = [];
  lines.push(formatBundleReadme(assembled.manifest, logSummary));
  lines.push('');
  lines.push('## Section Coverage');
  lines.push('');
  lines.push('Resolution of each diagnostic section in this bundle. `included` carries data; `empty` ran but had nothing to report; `reader_unavailable` means the collector errored; `unavailable` means this surface cannot produce that section; `omitted_by_*` means a user toggle or option suppressed it.');
  lines.push('');
  lines.push('| Section | State |');
  lines.push('|---------|-------|');
  const sections = assembled.manifest.sections;
  if (sections) {
    for (const sectionId of Object.keys(sections).sort()) {
      lines.push(`| \`${sectionId}\` | ${sections[sectionId as keyof typeof sections]} |`);
    }
  }
  lines.push('');

  const inlinableFiles = [...assembled.files.entries()]
    .filter(([filename]) => isMdInlineable(filename))
    .sort(([a], [b]) => a.localeCompare(b));

  if (inlinableFiles.length > 0) {
    lines.push('## Inline Diagnostic Files');
    lines.push('');
    lines.push('Structured files from the bundle, inlined for readability. The ZIP download contains the same files plus session excerpts, turn logs, and the full main-process log dump (excluded here for privacy and size).');
    lines.push('');
    for (const [filename, content] of inlinableFiles) {
      lines.push(`### \`${filename}\``);
      const description = assembled.manifest.contents[filename]?.description;
      if (description) lines.push('', `*${description}*`);
      lines.push('');
      const fence = filename.endsWith('.jsonl') ? 'jsonl' : filename.endsWith('.json') ? 'json' : '';
      lines.push('```' + fence);
      lines.push(content);
      lines.push('```');
      lines.push('');
    }
  }

  return lines.join('\n');
}

export function formatMobileBundleAsMarkdown(bundle: MobileDiagnosticsBundle): string {
  const lines: string[] = [
    '# Mindstone Rebel Mobile Diagnostics',
    '',
    `**Generated:** ${bundle.manifest.generatedAt}`,
    `**Platform:** ${bundle.manifest.app.platform} ${bundle.manifest.app.platformVersion}`.trimEnd(),
    `**App Version:** ${bundle.manifest.app.version}`,
    `**Runtime Version:** ${bundle.manifest.app.runtimeVersion}`,
    `**Health:** ${bundle.health.status}`,
    '',
    '## Health Checks',
    '',
  ];
  for (const [checkId, check] of Object.entries(bundle.health.checks)) lines.push(`- **${checkId}**: ${check.status} — ${check.detail}`);
  lines.push('', '## Sessions Index', '', `- Session count in snapshot: ${bundle.sessionsIndex.count}`, `- Total known sessions: ${bundle.sessionsIndex.totalInHistory}`, '');
  if (bundle.queueSnapshot) {
    const queueLines = [
      '## Queue Snapshot',
      '',
      `- Pending: ${bundle.queueSnapshot.pendingCount}`,
      `- Processing: ${bundle.queueSnapshot.processingCount}`,
      `- Queue full: ${bundle.queueSnapshot.queueFull ? 'yes' : 'no'}`,
      `- Limited connectivity: ${bundle.queueSnapshot.limitedConnectivity ? 'yes' : 'no'}`,
      `- Auth expired: ${bundle.queueSnapshot.authExpired ? 'yes' : 'no'}`,
    ];
    if (typeof bundle.queueSnapshot.oldestAgeMs === 'number') {
      queueLines.push(`- Oldest queued age: ${formatAgeMs(bundle.queueSnapshot.oldestAgeMs)}`);
    }
    queueLines.push('');
    lines.push(...queueLines);
  }
  if (bundle.continuityState) {
    lines.push('## Continuity State', '', `- Connection: ${bundle.continuityState.connectionState}`, `- Known sessions: ${bundle.continuityState.knownSessionCount}`, `- Applied-seq sessions: ${bundle.continuityState.appliedSeqSessionCount}`);
    if (bundle.continuityState.lastTombstoneSyncAt) lines.push(`- Last tombstone sync: ${new Date(bundle.continuityState.lastTombstoneSyncAt).toISOString()}`);
    lines.push('');
  }
  if (bundle.recentEvents && bundle.recentEvents.length > 0) {
    lines.push(`## Recent Events (${bundle.recentEvents.length})`, '');
    for (const entry of bundle.recentEvents) {
      const ts = typeof entry['ts'] === 'number' ? new Date(entry['ts'] as number).toISOString() : '';
      const family = typeof entry['family'] === 'string' ? entry['family'] : 'unknown';
      const message = typeof entry['message'] === 'string' ? entry['message'] : '';
      const level = typeof entry['level'] === 'string' ? entry['level'] : 'info';
      lines.push(`- ${ts} [${level}] **${family}** — ${message}`);
    }
    lines.push('');
  }
  if (bundle.logs.mainNdjson && bundle.logs.lineCount > 0) {
    lines.push(`## Recent Logs (filtered, ${bundle.logs.lineCount} lines)`, '', '```', bundle.logs.mainNdjson, '```');
  } else if (bundle.logs.mainNdjson) {
    lines.push('## Recent Logs', '', bundle.logs.mainNdjson);
  } else {
    lines.push('## Recent Logs', '', '_No recent logs available._');
  }
  return lines.join('\n');
}
