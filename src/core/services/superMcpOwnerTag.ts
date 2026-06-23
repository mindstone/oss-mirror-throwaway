import { SUPER_MCP_SPAWN_ARGV_FLAGS } from '@core/rebelCore/superMcpContract';

const OWNER_ID_FLAG = SUPER_MCP_SPAWN_ARGV_FLAGS.REBEL_OWNER_ID;
const OWNER_PID_FLAG = SUPER_MCP_SPAWN_ARGV_FLAGS.REBEL_OWNER_PID;
const OWNER_START_FLAG = SUPER_MCP_SPAWN_ARGV_FLAGS.REBEL_OWNER_START;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGER_PATTERN = /^-?\d+$/;

export interface OwnerTag {
  ownerId: string;
  ownerPid: number;
  ownerStartTimeMs: number;
}

export interface OwnerTagInput {
  ownerId: string;
  ownerPid: number;
  ownerStartTimeMs: number;
}

/** Append the three argv tokens describing this owner to a CLI invocation. */
export function buildOwnerTagArgs(input: OwnerTagInput): string[] {
  return [
    OWNER_ID_FLAG,
    input.ownerId,
    OWNER_PID_FLAG,
    String(input.ownerPid),
    OWNER_START_FLAG,
    String(input.ownerStartTimeMs),
  ];
}

/**
 * Parse owner identity from a process command line (`ps -o command=` shape).
 * Returns null when any required flag is missing or malformed.
 */
export function parseOwnerTagFromCmdline(cmdline: string): OwnerTag | null {
  const tokens = tokenizeCmdline(cmdline);
  if (tokens.length === 0) {
    return null;
  }

  let ownerIdRaw: string | null = null;
  let ownerPidRaw: string | null = null;
  let ownerStartRaw: string | null = null;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (
      (token === OWNER_ID_FLAG || token === OWNER_PID_FLAG || token === OWNER_START_FLAG)
      && i + 1 >= tokens.length
    ) {
      return null;
    }

    if (token === OWNER_ID_FLAG) {
      ownerIdRaw = tokens[i + 1] ?? null;
      i += 1;
      continue;
    }

    if (token === OWNER_PID_FLAG) {
      ownerPidRaw = tokens[i + 1] ?? null;
      i += 1;
      continue;
    }

    if (token === OWNER_START_FLAG) {
      ownerStartRaw = tokens[i + 1] ?? null;
      i += 1;
    }
  }

  if (!ownerIdRaw || !ownerPidRaw || !ownerStartRaw) {
    return null;
  }
  if (!UUID_PATTERN.test(ownerIdRaw)) {
    return null;
  }

  const ownerPid = parseInteger(ownerPidRaw);
  if (ownerPid === null || ownerPid <= 0) {
    return null;
  }

  const ownerStartTimeMs = parseInteger(ownerStartRaw);
  if (ownerStartTimeMs === null || ownerStartTimeMs <= 0) {
    return null;
  }

  return {
    ownerId: ownerIdRaw,
    ownerPid,
    ownerStartTimeMs,
  };
}

function tokenizeCmdline(cmdline: string): string[] {
  const trimmed = cmdline.trim();
  if (!trimmed) {
    return [];
  }

  return trimmed
    .split(/\s+/)
    .map(stripEdgeDoubleQuotes)
    .filter((token) => token.length > 0);
}

function stripEdgeDoubleQuotes(token: string): string {
  return token.replace(/^"+|"+$/g, '');
}

function parseInteger(value: string): number | null {
  if (!INTEGER_PATTERN.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) {
    return null;
  }
  return parsed;
}
