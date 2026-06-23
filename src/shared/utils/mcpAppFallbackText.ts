import type { AgentEvent, McpAppStructuredFallback, McpAppUiMeta } from '../types';

const DEFAULT_ROLE_LABEL = 'Interactive view';

const compactLine = (value: string | undefined): string => value?.trim() ?? '';

const compactList = (value: string[] | undefined): string => (value ?? [])
  .map((entry) => entry.trim())
  .filter(Boolean)
  .join(', ');

const joinNonEmptyLines = (lines: Array<string | null | undefined>): string =>
  lines.filter((line): line is string => line !== null && line !== undefined).join('\n').trim();

export function formatMcpAppStructuredFallbackAsPlainText(
  fallback: McpAppStructuredFallback | undefined,
  options: { roleLabel?: string } = {},
): string {
  if (!fallback) {
    return '';
  }

  switch (fallback.kind) {
    case 'email-draft': {
      const { to, cc, bcc, subject, body } = fallback.payload;
      return joinNonEmptyLines([
        `[${options.roleLabel?.trim() || 'Editable email draft'}]`,
        `To: ${compactList(to)}`,
        compactList(cc) ? `Cc: ${compactList(cc)}` : null,
        compactList(bcc) ? `Bcc: ${compactList(bcc)}` : null,
        `Subject: ${compactLine(subject)}`,
        '',
        compactLine(body),
      ]);
    }
    case 'calendar-pick': {
      const { title, options: calendarOptions } = fallback.payload;
      return joinNonEmptyLines([
        `[${options.roleLabel?.trim() || 'Calendar options'}]`,
        compactLine(title) ? `Title: ${compactLine(title)}` : null,
        ...calendarOptions.map((entry, index) => {
          const time = [entry.start, entry.end].map(compactLine).filter(Boolean).join(' - ');
          const location = compactLine(entry.location);
          const suffix = [time, location].filter(Boolean).join(' · ');
          return `${index + 1}. ${compactLine(entry.label)}${suffix ? ` (${suffix})` : ''}`;
        }),
      ]);
    }
    case 'document-outline': {
      const { title, sections } = fallback.payload;
      return joinNonEmptyLines([
        `[${options.roleLabel?.trim() || 'Document outline'}]`,
        compactLine(title) ? `Title: ${compactLine(title)}` : null,
        ...sections.flatMap((section) => [
          `## ${compactLine(section.heading)}`,
          ...(section.bullets ?? []).map((bullet) => `- ${compactLine(bullet)}`),
        ]),
      ]);
    }
    case 'plain':
      return compactLine(fallback.payload.markdown);
    default: {
      const exhaustive: never = fallback;
      return exhaustive;
    }
  }
}

export function formatPrimaryMcpAppFallbackAsPlainText(uiMeta: McpAppUiMeta | undefined): string {
  if (uiMeta?.presentation !== 'primary') {
    return '';
  }

  return joinNonEmptyLines([
    compactLine(uiMeta.viewSummary),
    formatMcpAppStructuredFallbackAsPlainText(uiMeta.structuredFallback, {
      roleLabel: uiMeta.viewRoleLabel ?? DEFAULT_ROLE_LABEL,
    }),
  ]);
}

export function getPrimaryMcpAppFallbackTextsFromEvents(events: AgentEvent[] | undefined): string[] {
  if (!events?.length) {
    return [];
  }

  return events
    .filter((event): event is Extract<AgentEvent, { type: 'tool' }> => event.type === 'tool')
    .map((event) => formatPrimaryMcpAppFallbackAsPlainText(event.mcpAppUiMeta))
    .filter((text) => text.trim().length > 0);
}

export function buildMcpAppAwareMessageText(
  messageText: string | undefined,
  events: AgentEvent[] | undefined,
): string {
  const parts = [compactLine(messageText), ...getPrimaryMcpAppFallbackTextsFromEvents(events)];
  return joinNonEmptyLines(parts);
}
