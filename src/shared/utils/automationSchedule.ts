/**
 * Constructor + `fromUntrusted` API for `AutomationSchedule`.
 *
 * R6 (Schedule Algebra refactor — see
 * `docs/plans/260427_refactor_schedule_algebra.md`). This module is the
 * single sanctioned construction path for `AutomationSchedule` values.
 *
 * Stage 2 adds the mandatory brand cutover. The only sanctioned brand casts
 * live in this module: constructor parse output and `fromUntrusted` parse output.
 *
 * `fromUntrusted` is the only sanctioned path from untrusted input
 * (MCP tool calls, IPC payloads, persisted store values, archive restores,
 * future plugin integrations) to a validated `AutomationSchedule`. It
 * performs a small repair pass for known legacy shapes (every_n_days
 * without `anchorDate`, event branch with `trigger` / `event_type` aliases),
 * then validates with the canonical `AutomationScheduleSchema`.
 *
 * The function is pure — it does NOT log, does NOT call `Date.now()`, does
 * NOT touch any store. Callers decide what to do with `Err` (quarantine,
 * surface a user error, etc.).
 */

import { AutomationScheduleSchema } from '../ipc/schemas/automations';
import type {
  AutomationEventType,
  AutomationSchedule as ScheduleType,
} from '../types/automations';

// Re-export so consumers can `import { AutomationSchedule } from '@shared/utils/automationSchedule'`
// and get both the type (TS) and the const (value) under a single identifier. The const + type
// must share the same exported name so callers don't need two imports.
export type AutomationSchedule = ScheduleType;

// =============================================================================
// Result + error types
// =============================================================================

/**
 * Local Result-shape used by `fromUntrusted`.
 *
 * Deliberately NOT exported as a project-wide abstraction — there is no
 * `neverthrow` dependency and no `src/shared/types/result.ts`. This shape
 * mirrors Zod's `safeParse` return so it composes with existing code.
 */
export type SafeParseResult<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type AutomationScheduleErrorKind =
  | 'missing-field'
  | 'wrong-type'
  | 'missing-anchor-no-context'
  | 'unknown-type'
  | 'invalid-additional-times'
  | 'unrepairable';

export interface AutomationScheduleError {
  kind: AutomationScheduleErrorKind;
  /** Dotted path to the offending field, when known (e.g. "additionalTimes" or "schedule.eventType"). */
  field?: string;
  message: string;
}

/**
 * Calling-context for `fromUntrusted`. Drives anchor-repair semantics so
 * update paths preserve cadence (use `existingCreatedAt`) while create
 * paths anchor to "now" (use `now`).
 */
export interface FromUntrustedContext {
  source: 'mcp' | 'ipc' | 'store-load' | 'cloud-reload' | 'import' | 'plugin';
  /** Wall-clock for create paths. Pure function — caller passes Date.now() explicitly. */
  now?: number;
  /** Definition.createdAt for update / store-load paths. Preserves anchor cadence on legacy data. */
  existingCreatedAt?: number;
}

// =============================================================================
// Internal helpers
// =============================================================================

const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

const KNOWN_SCHEDULE_TYPES = [
  'hourly',
  'daily',
  'every_n_days',
  'weekly',
  'monthly',
  'event',
  'once',
] as const;
type KnownScheduleType = (typeof KNOWN_SCHEDULE_TYPES)[number];

/** YYYY-MM-DD form of a unix-millis timestamp. Matches the existing anchorDate fixture style. */
const toIsoDateString = (timestamp: number): string => new Date(timestamp).toISOString().slice(0, 10);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function resolvePath(obj: Record<string, unknown>, path: ReadonlyArray<string | number>): unknown {
  let current: unknown = obj;
  for (const segment of path) {
    if (!isPlainObject(current) && !Array.isArray(current)) return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

const describeReceived = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

/**
 * Repair the event-branch shape by collapsing legacy aliases onto the
 * canonical `eventType` field. Precedence (per MCP_SERVER_STANDARD spec
 * invariant 6 — snake_case wins): `event_type > eventType > trigger`.
 *
 * Returns the repaired object. Does NOT validate the resulting eventType
 * value against `AUTOMATION_EVENT_TYPES`; that happens in the Zod parse.
 */
function repairEventBranch(input: Record<string, unknown>): Record<string, unknown> {
  const candidates: Array<{ field: 'event_type' | 'eventType' | 'trigger'; value: unknown }> = [
    { field: 'event_type', value: input.event_type },
    { field: 'eventType', value: input.eventType },
    { field: 'trigger', value: input.trigger },
  ];

  const winner = candidates.find((entry) => entry.value !== undefined);

  // Drop all three legacy keys; we'll re-set `eventType` below if a winner exists.
  const { event_type: _ignoredSnake, eventType: _ignoredCamel, trigger: _ignoredTrigger, ...rest } = input;
  void _ignoredSnake;
  void _ignoredCamel;
  void _ignoredTrigger;

  if (winner === undefined) {
    return rest;
  }

  return { ...rest, eventType: winner.value };
}

/**
 * Repair an `every_n_days` schedule that's missing `anchorDate`. Uses
 * `existingCreatedAt` first (preserves cadence on update / store-load paths),
 * then `now` (matches MCP create-path behaviour today). Returns an error
 * if neither is available — caller MUST quarantine.
 */
function repairEveryNDaysAnchor(
  input: Record<string, unknown>,
  ctx: FromUntrustedContext | undefined,
): { result: Record<string, unknown> } | { error: AutomationScheduleError } {
  const anchor = input.anchorDate;
  if (anchor !== undefined) {
    return { result: input };
  }

  if (ctx?.existingCreatedAt !== undefined) {
    return { result: { ...input, anchorDate: toIsoDateString(ctx.existingCreatedAt) } };
  }

  if (ctx?.now !== undefined) {
    return { result: { ...input, anchorDate: toIsoDateString(ctx.now) } };
  }

  return {
    error: {
      kind: 'missing-anchor-no-context',
      field: 'anchorDate',
      message:
        'every_n_days schedule is missing anchorDate and no creation context (existingCreatedAt / now) was provided to repair it.',
    },
  };
}

// =============================================================================
// Constructors + fromUntrusted
// =============================================================================

/**
 * Parse a literal through `AutomationScheduleSchema` and return the typed
 * value. Throws on invalid args — these are caller-side bugs (the
 * constructor signature only accepts well-typed args). Stage 2 will make
 * this the only path; Stage 1 keeps it additive.
 */
function constructSchedule(literal: unknown): AutomationSchedule {
  // Cast through `unknown` is safe: the Zod parse has just verified the shape.
  // This is the sanctioned brand cast site for constructor-built schedules.
  // eslint-disable-next-line no-restricted-syntax -- sanctioned brand cast after Zod parse (R6 constructor module)
  return AutomationScheduleSchema.parse(literal) as AutomationSchedule;
}

export const AutomationSchedule = {
  hourly(args: { minute: number }): AutomationSchedule {
    return constructSchedule({ type: 'hourly', minute: args.minute });
  },

  daily(args: { time: string; additionalTimes?: string[] }): AutomationSchedule {
    return constructSchedule({
      type: 'daily',
      time: args.time,
      ...(args.additionalTimes !== undefined ? { additionalTimes: args.additionalTimes } : {}),
    });
  },

  everyNDays(args: { intervalDays: number; time: string; anchorDate: string }): AutomationSchedule {
    return constructSchedule({
      type: 'every_n_days',
      intervalDays: args.intervalDays,
      time: args.time,
      anchorDate: args.anchorDate,
    });
  },

  weekly(args: { daysOfWeek: number[]; time: string }): AutomationSchedule {
    return constructSchedule({
      type: 'weekly',
      daysOfWeek: args.daysOfWeek,
      time: args.time,
    });
  },

  monthly(args: {
    daysOfMonth: number[];
    time: string;
    runOnLastDayIfShorter?: boolean;
  }): AutomationSchedule {
    return constructSchedule({
      type: 'monthly',
      daysOfMonth: args.daysOfMonth,
      time: args.time,
      ...(args.runOnLastDayIfShorter !== undefined
        ? { runOnLastDayIfShorter: args.runOnLastDayIfShorter }
        : {}),
    });
  },

  event(args: { eventType: AutomationEventType }): AutomationSchedule {
    return constructSchedule({ type: 'event', eventType: args.eventType });
  },

  once(args: { dateTime: string }): AutomationSchedule {
    return constructSchedule({ type: 'once', dateTime: args.dateTime });
  },

  /**
   * Normalise an untrusted input into a validated `AutomationSchedule`.
   *
   * Pure function — no logging, no I/O. Callers decide what to do with
   * `{ ok: false, error }` (typically: quarantine + structured warn-log,
   * or surface a user-visible validation error).
   *
   * Repair pass handles known legacy shapes:
   *   - `every_n_days` missing `anchorDate` (260422 postmortem)
   *   - `event` branch with `trigger` / `event_type` legacy aliases
   *     (260411, MCP_SERVER_STANDARD invariant 6 — snake_case wins)
   */
  fromUntrusted(
    input: unknown,
    ctx?: FromUntrustedContext,
  ): SafeParseResult<AutomationSchedule, AutomationScheduleError> {
    if (!isPlainObject(input)) {
      return {
        ok: false,
        error: {
          kind: 'wrong-type',
          message: `Expected schedule to be an object, received ${describeReceived(input)}.`,
        },
      };
    }

    const rawType = input.type;
    if (rawType === undefined) {
      return {
        ok: false,
        error: {
          kind: 'missing-field',
          field: 'type',
          message: 'schedule is missing required field "type".',
        },
      };
    }

    if (typeof rawType !== 'string') {
      return {
        ok: false,
        error: {
          kind: 'wrong-type',
          field: 'type',
          message: `schedule.type must be a string, received ${describeReceived(rawType)}.`,
        },
      };
    }

    if (!(KNOWN_SCHEDULE_TYPES as readonly string[]).includes(rawType)) {
      return {
        ok: false,
        error: {
          kind: 'unknown-type',
          field: 'type',
          message: `schedule.type "${rawType}" is not a recognised AutomationSchedule branch.`,
        },
      };
    }

    const typedRaw = rawType as KnownScheduleType;
    let working: Record<string, unknown> = { ...input };

    // Repair pass — branch-specific.
    if (typedRaw === 'event') {
      working = repairEventBranch(working);
      if (working.eventType === undefined) {
        return {
          ok: false,
          error: {
            kind: 'missing-field',
            field: 'eventType',
            message:
              'event schedule is missing eventType (and no legacy alias `event_type` / `trigger` was supplied).',
          },
        };
      }
    }

    if (typedRaw === 'every_n_days') {
      const repair = repairEveryNDaysAnchor(working, ctx);
      if ('error' in repair) {
        return { ok: false, error: repair.error };
      }
      working = repair.result;
    }

    if (typedRaw === 'daily') {
      const additional = working.additionalTimes;
      if (additional !== undefined) {
        if (!Array.isArray(additional)) {
          return {
            ok: false,
            error: {
              kind: 'invalid-additional-times',
              field: 'additionalTimes',
              message: `additionalTimes must be an array of HH:mm strings, received ${describeReceived(additional)}.`,
            },
          };
        }
        for (const entry of additional) {
          if (typeof entry !== 'string' || !HHMM_REGEX.test(entry)) {
            return {
              ok: false,
              error: {
                kind: 'invalid-additional-times',
                field: 'additionalTimes',
                message: `additionalTimes contains invalid HH:mm value: ${
                  typeof entry === 'string' ? `"${entry}"` : describeReceived(entry)
                }.`,
              },
            };
          }
        }
      }
    }

    const parsed = AutomationScheduleSchema.safeParse(working);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const path = firstIssue?.path.map((segment) => String(segment)).join('.') ?? '';

      // Classify against Zod v4 issue codes. We deliberately keep this coarse —
      // structured callers (Stage 2 IPC handler, MCP bridge) inspect `kind` to
      // decide between user-facing copy vs. quarantine; downstream consumers
      // only need a small enum.
      let kind: AutomationScheduleErrorKind = 'unrepairable';
      switch (firstIssue?.code) {
        case 'invalid_type':
          // Zod v4 strips `issue.input` from finalized issues by default, so
          // classify missing-vs-wrong-type by resolving the issue path against
          // the pre-Zod working object instead.
          kind = resolvePath(working, firstIssue.path as ReadonlyArray<string | number>) === undefined
            ? 'missing-field'
            : 'wrong-type';
          break;
        case 'invalid_value':
          // Enum / literal mismatch (e.g. unknown event type).
          kind = 'wrong-type';
          break;
        case 'invalid_format':
          // Regex / format mismatch (e.g. once.dateTime not ISO 8601).
          kind = 'wrong-type';
          break;
        case 'invalid_union':
          // Discriminated-union mismatch — unknown discriminant or no branch matched.
          kind = 'unknown-type';
          break;
        case 'too_small':
        case 'too_big':
        case 'not_multiple_of':
        case 'custom':
          kind = 'wrong-type';
          break;
        default:
          kind = 'unrepairable';
          break;
      }

      return {
        ok: false,
        error: {
          kind,
          field: path.length > 0 ? path : undefined,
          message: parsed.error.message,
        },
      };
    }

    // Sanctioned brand cast site for untrusted boundary repair + validation.
    // eslint-disable-next-line no-restricted-syntax -- sanctioned brand cast after Zod parse (R6 fromUntrusted)
    return { ok: true, value: parsed.data as AutomationSchedule };
  },
};
