/**
 * Translate a tool name + optional detail JSON into a human-readable
 * present-participle activity sentence for live sub-agent status.
 *
 * Designed for Rebel's calm, clear voice — no developer jargon.
 */

import { safeParseDetailRecord } from './safeParseDetail';

const PATH_KEYS = ['path', 'file_path', 'filepath'] as const;

/** Extract a file basename from a detail JSON string (best-effort). */
const extractBasenameFromDetail = (detail: string): string | null => {
  // BOUNDED via safeParseDetailRecord: malformed, over-budget, OR non-object
  // valid JSON → null (skip), matching the pre-migration try/catch fallback.
  const result = safeParseDetailRecord(detail);
  if (result.ok) {
    const parsed = result.value;
    for (const key of PATH_KEYS) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) {
        const segments = value.replace(/\\/g, '/').split('/');
        return segments[segments.length - 1] || null;
      }
    }
  }
  return null;
};

/** Extract an agent/subagent name from detail JSON. */
const extractAgentName = (detail: string): string | null => {
  // BOUNDED via safeParseDetailRecord: malformed, over-budget, OR non-object
  // valid JSON → null (skip), matching the pre-migration try/catch fallback.
  const result = safeParseDetailRecord(detail);
  if (result.ok) {
    const parsed = result.value;
    const name = parsed.agent ?? parsed.subagent_type;
    if (typeof name === 'string' && name.trim()) {
      return name
        .replace(/^mcp__/i, '')
        .replace(/[_-]+/g, ' ')
        .trim();
    }
  }
  return null;
};

/** Humanize an MCP tool name (contains `/` or `__`). */
const humanizeMcpTool = (toolName: string): string => {
  // "google_calendar/list_events" → "Google Calendar"
  // "mcp__slack__send_message" → "Slack"
  const cleaned = toolName.replace(/^mcp__/i, '');
  // Split on `/` or `__` to isolate the server/service name, preserving single `_`
  const firstPart = cleaned.split(/\/|__/)[0] ?? cleaned;
  const label = firstPart
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return `Using ${label || 'a tool'}`;
};

export function humanizeToolActivity(toolName: string, detail?: string): string {
  const name = toolName.toLowerCase().replace(/^mcp__|_tool$/g, '');
  const file = detail ? extractBasenameFromDetail(detail) : null;

  switch (name) {
    case 'read':
    case 'read_file':
      return file ? `Reading ${file}` : 'Reading a file';

    case 'write':
    case 'write_file':
    case 'edit':
    case 'edit_file':
    case 'str_replace_editor':
    case 'create':
    case 'create_file':
      return file ? `Editing ${file}` : 'Editing a file';

    case 'bash':
    case 'shell':
    case 'execute':
      return 'Running a command';

    case 'grep':
    case 'search':
    case 'find':
      return 'Searching';

    case 'glob':
      return 'Finding files';

    case 'ls':
    case 'list':
      return 'Listing directory';

    case 'websearch':
    case 'web_search':
    case 'search_web':
      return 'Searching the web';

    case 'agent':
    case 'task': {
      const agentName = detail ? extractAgentName(detail) : null;
      return agentName ? `Delegating to ${agentName}` : 'Delegating to a sub-agent';
    }

    case 'todowrite':
      return 'Updating the plan';

    case 'taskcreate':
    case 'taskupdate':
      return 'Updating tasks';

    case 'fetchurl':
    case 'fetch_url':
    case 'webfetch':
    case 'web_fetch':
      return 'Fetching a page';

    case 'searchfiles':
    case 'search_files':
      return 'Searching files';

    case 'screenshot':
    case 'take_screenshot':
      return 'Taking a screenshot';

    case 'missionset':
      return 'Setting the mission';

    case 'tasklist':
      return 'Reviewing tasks';

    case 'view':
    case 'cat':
      return file ? `Reading ${file}` : 'Reading a file';

    default: {
      // MCP tools typically contain `/` or `__` in the original name
      if (toolName.includes('/') || toolName.includes('__')) {
        return humanizeMcpTool(toolName);
      }
      // Smart fallback: title-case the tool name for a reasonable label
      const titleCased = toolName
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim()
        .split(/\s+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
      return titleCased ? `Using ${titleCased}` : 'Working…';
    }
  }
}
