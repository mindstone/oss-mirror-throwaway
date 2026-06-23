import {
  DashboardSharePayloadSchema,
  type DashboardSharePayload,
} from '@shared/ipc/channels/dashboard';

export function dashboardShareErrorCopy(errorCode: string): { title: string; description: string } {
  switch (errorCode) {
    case 'TOKEN_EXPIRED':
      return {
        title: 'Dashboard context expired',
        description: 'Open the table from the dashboard again.',
      };
    case 'TOKEN_REPLAYED':
      return {
        title: 'Dashboard context already opened',
        description: 'Open the table from the dashboard again if you need a fresh chat.',
      };
    case 'TOKEN_NOT_FOUND':
      return {
        title: "Couldn't find that dashboard context",
        description: 'Open the table from the dashboard again.',
      };
    case 'FORBIDDEN_SCOPE':
      return {
        title: "Can't open that dashboard context",
        description: 'It belongs to a different account or you no longer have access.',
      };
    case 'UNSUPPORTED_PAYLOAD_VERSION':
      return {
        title: 'Update Rebel to open this dashboard context',
        description: 'This dashboard link uses a newer format than this app understands.',
      };
    case 'UNAUTHENTICATED':
      return {
        title: 'Sign in to Rebel first',
        description: 'Then open the table from the dashboard again.',
      };
    default:
      return {
        title: "Couldn't open dashboard context",
        description: 'Open the table from the dashboard again.',
      };
  }
}

function markdownTable(rows: unknown[], maxRows = 25): string {
  const objectRows = rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
    .slice(0, maxRows);
  if (objectRows.length === 0) return '_No structured rows were included._';

  const columns = Array.from(
    new Set(objectRows.flatMap((row) => Object.keys(row).filter((key) => row[key] !== undefined))),
  ).slice(0, 8);
  if (columns.length === 0) return '_No structured rows were included._';

  const format = (value: unknown) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value).replace(/\|/g, '\\|');
  };

  const header = `| ${columns.join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = objectRows.map((row) => `| ${columns.map((column) => format(row[column])).join(' | ')} |`);
  const more = rows.length > objectRows.length ? `\n\n_Showing ${objectRows.length} of ${rows.length} rows._` : '';
  return [header, divider, ...body].join('\n') + more;
}

export function buildDashboardSeedDraft(payload: DashboardSharePayload): string {
  const source = payload.source;
  const contextHeader = [
    `Opened from Company dashboard: ${source.tableId}`,
    `Company: ${source.organizationName}`,
    `Window: last ${source.windowDays} days`,
    `Rows: ${payload.rows.length}`,
  ].join('\n');

  const hints = payload.mcpHints?.scopedToolHint
    ? `\n\nDashboard follow-up available when the matching key is configured: ${payload.mcpHints.scopedToolHint}`
    : '';

  const pullSafetyNote = `\n\nNote: this chat includes the table snapshot. To ask Rebel for other ROI dashboard tables, make sure the matching Rebel Platform MCP key is configured for ${source.organizationName}. If it is missing or scoped to a different company, ask Mindstone CS to set it up.`;

  return `${payload.starterPrompt}

Context:
${contextHeader}${hints}${pullSafetyNote}

Table:
${markdownTable(payload.rows)}`;
}

export function parseDashboardSharePayload(payload: unknown) {
  const parsed = DashboardSharePayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  return parsed.data;
}

export async function redeemDashboardShareToken(token: string) {
  return window.dashboardApi.redeemShareToken({ token });
}
