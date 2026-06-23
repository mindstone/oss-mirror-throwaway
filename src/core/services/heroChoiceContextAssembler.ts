/**
 * Hero Choice Context Assembler
 *
 * Assembles all user context for the daily Hero Choice LLM call.
 * Lives in src/core/ — uses dependency injection, no Electron imports.
 *
 * Context includes: sessions (full transcripts), goals, skills, use cases,
 * calendar events, and past recommendations.
 *
 * Token budget is dynamic based on the model's context window:
 * - Extended context (1M): 900K token budget
 * - Standard (200K): 180K token budget
 * Estimation: Math.ceil(text.length / 4) with 20% safety margin.
 *
 * @see docs/plans/260315_spark_redesign.md
 */

import { createScopedLogger } from '@core/logger';
import type { HeroChoiceCandidate } from '@core/heroChoiceTypes';

const log = createScopedLogger({ service: 'heroChoiceContextAssembler' });

/** Default token budget (standard 200K context window minus headroom) */
export const DEFAULT_TOKEN_BUDGET = 180_000;

/** Safety margin applied to token estimation */
export const SAFETY_MARGIN = 1.2;

/** When truncating a large session, keep this many messages from start and end */
const TRUNCATION_KEEP_COUNT = 3;

// ---------------------------------------------------------------------------
// Dependency interfaces — injected by caller, no Electron imports
// ---------------------------------------------------------------------------

export interface SessionSummary {
  id: string;
  title?: string;
  createdAt: number;
  resolvedAt?: number;
}

export interface SessionMessage {
  role: 'user' | 'assistant' | 'result';
  text: string;
}

export interface LoadedSession {
  id: string;
  title: string;
  createdAt: number;
  messages: SessionMessage[];
}

export interface PersonalGoals {
  thisQuarter: Array<{ goal: string; why?: string }>;
  status: string;
}

export interface SkillSummaryInfo {
  name: string;
  description: string;
  qualityScore?: number;
  band?: string;
}

export interface UseCaseInfo {
  title: string;
  description: string;
  prompt: string;
  usageCount: number;
  qualityRating: number;
}

export interface CalendarEvent {
  title: string;
  startTime: number;
  endTime?: number;
  attendees?: string[];
}

export interface HeroChoiceContextDeps {
  /** List all session summaries (lightweight) */
  listSessionSummaries: () => SessionSummary[];
  /** Load a full session by ID */
  loadSession: (id: string) => Promise<LoadedSession | null>;
  /** Get user's personal goals */
  getPersonalGoals: () => Promise<PersonalGoals | null>;
  /** Get all skill summaries */
  getSkillSummaries: () => Promise<SkillSummaryInfo[]>;
  /** Get user's use cases */
  getUseCases: () => UseCaseInfo[];
  /** Get upcoming calendar events */
  getUpcomingEvents: () => CalendarEvent[];
  /** Get past recommendations to avoid repetition */
  getPastCandidates: () => HeroChoiceCandidate[];
  /** User's IANA timezone (e.g. 'Europe/London') for calendar time formatting */
  timeZone: string;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Estimate token count from text length (chars/4 with safety margin) */
export function estimateTokens(text: string): number {
  return Math.ceil((text.length / 4) * SAFETY_MARGIN);
}

// ---------------------------------------------------------------------------
// Section formatters
// ---------------------------------------------------------------------------

function formatGoals(goals: PersonalGoals | null): string {
  if (!goals || goals.thisQuarter.length === 0) return '';

  const lines = goals.thisQuarter.map((g) => {
    const why = g.why ? ` (${g.why})` : '';
    return `- ${g.goal}${why}`;
  });

  return `## Your Goals (This Quarter)\n${lines.join('\n')}\n`;
}

function formatTimeUntil(startTime: number): string {
  const diffMs = startTime - Date.now();
  if (diffMs < 0) return 'started';
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `in ${diffMin} minutes`;
  const diffHours = Math.round(diffMin / 60 * 10) / 10;
  if (diffHours < 24) return `in ~${diffHours} hours`;
  return `in ~${Math.round(diffHours / 24)} days`;
}

function formatCalendar(events: CalendarEvent[], timeZone: string): string {
  if (events.length === 0) return '';

  const lines = events.map((e) => {
    const time = new Date(e.startTime).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    });
    const proximity = formatTimeUntil(e.startTime);
    const attendees = e.attendees && e.attendees.length > 0
      ? ` (attendees: ${e.attendees.join(', ')})`
      : '';
    return `- ${time} (${proximity}): ${e.title}${attendees}`;
  });

  return `## Your Calendar (Next 24 Hours)\n${lines.join('\n')}\n`;
}

function formatSkills(skills: SkillSummaryInfo[]): string {
  if (skills.length === 0) return '';

  const lines = skills.map((s) => {
    const quality = s.qualityScore != null ? `, quality: ${s.qualityScore}/100` : '';
    const band = s.band ? `, band: ${s.band}` : '';
    return `- ${s.name}: ${s.description}${quality}${band}`;
  });

  return `## Your Skills\n${lines.join('\n')}\n`;
}

function formatUseCases(useCases: UseCaseInfo[]): string {
  if (useCases.length === 0) return '';

  const lines = useCases.map((uc) =>
    `- ${uc.title}: ${uc.description} (used ${uc.usageCount} times)`,
  );

  return `## Your Workflows (Use Cases)\n${lines.join('\n')}\n`;
}

function formatPastCandidates(candidates: HeroChoiceCandidate[]): string {
  if (candidates.length === 0) return '';

  const lines = candidates.map((c) =>
    `- [${c.type}] "${c.headline}"`,
  );

  return `## Past Recommendations (Do Not Repeat)\n${lines.join('\n')}\n`;
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMin < 60) return `${diffMin} minutes ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  if (diffDays === 1) return 'yesterday';
  return `${diffDays} days ago`;
}

function formatSession(session: LoadedSession): string {
  const timeAgo = formatRelativeTime(session.createdAt);
  const header = `### Session: "${session.title}" (${timeAgo})\n`;

  const messageLines = session.messages
    .filter((m) => m.role !== 'result')
    .map((m) => `[${m.role}]: ${m.text}`);

  return header + messageLines.join('\n') + '\n';
}

/**
 * Truncate a session's messages keeping first and last N messages.
 * Used when a single session exceeds the token budget.
 */
function truncateSession(session: LoadedSession): LoadedSession {
  const messages = session.messages.filter((m) => m.role !== 'result');
  if (messages.length <= TRUNCATION_KEEP_COUNT * 2) return session;

  const kept = [
    ...messages.slice(0, TRUNCATION_KEEP_COUNT),
    { role: 'assistant' as const, text: `[... ${messages.length - TRUNCATION_KEEP_COUNT * 2} messages omitted ...]` },
    ...messages.slice(-TRUNCATION_KEEP_COUNT),
  ];

  return { ...session, messages: kept };
}

// ---------------------------------------------------------------------------
// Main assembler
// ---------------------------------------------------------------------------

/**
 * Assemble all user context for the Hero Choice LLM call.
 * Returns a single formatted string ready to include in the prompt.
 *
 * @param tokenBudget - Maximum tokens for context. Defaults to DEFAULT_TOKEN_BUDGET (180K).
 *                      Callers should pass a higher budget for models with extended context.
 */
export async function assembleHeroChoiceContext(
  deps: HeroChoiceContextDeps,
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
): Promise<string> {
  // 1. Load non-session context first (small)
  const [goals, skills, pastCandidates] = await Promise.all([
    deps.getPersonalGoals(),
    deps.getSkillSummaries(),
    Promise.resolve(deps.getPastCandidates()),
  ]);
  const useCases = deps.getUseCases();
  const upcomingEvents = deps.getUpcomingEvents();

  // 2. Format non-session sections
  const goalsSection = formatGoals(goals);
  const calendarSection = formatCalendar(upcomingEvents, deps.timeZone);
  const skillsSection = formatSkills(skills);
  const useCasesSection = formatUseCases(useCases);
  const pastSection = formatPastCandidates(pastCandidates);

  const nonSessionContext = [
    goalsSection,
    calendarSection,
    skillsSection,
    useCasesSection,
    pastSection,
  ].filter(Boolean).join('\n');

  const nonSessionTokens = estimateTokens(nonSessionContext);

  // 3. Load sessions (newest first)
  const summaries = deps.listSessionSummaries();
  const sorted = [...summaries].sort((a, b) => b.createdAt - a.createdAt);

  let sessionTokenBudget = tokenBudget - nonSessionTokens;
  if (sessionTokenBudget < 0) sessionTokenBudget = 0;

  const sessionTexts: string[] = [];

  for (const summary of sorted) {
    if (sessionTokenBudget <= 0) break;

    const session = await deps.loadSession(summary.id);
    if (!session || session.messages.length === 0) continue;

    let formatted = formatSession(session);
    let tokens = estimateTokens(formatted);

    // If this single session exceeds remaining budget, try truncating
    if (tokens > sessionTokenBudget) {
      const truncated = truncateSession(session);
      formatted = formatSession(truncated);
      tokens = estimateTokens(formatted);

      // If still too large after truncation, skip it
      if (tokens > sessionTokenBudget) {
        log.debug(
          { sessionId: session.id, tokens, budget: sessionTokenBudget },
          'Skipping session — exceeds budget even after truncation',
        );
        continue;
      }
    }

    sessionTexts.push(formatted);
    sessionTokenBudget -= tokens;
  }

  const sessionsHeader = sessionTexts.length > 0
    ? `## Recent Sessions (Newest First)\n${sessionTexts.join('\n')}`
    : '';

  const fullContext = [nonSessionContext, sessionsHeader].filter(Boolean).join('\n');

  log.info(
    {
      totalTokens: estimateTokens(fullContext),
      tokenBudget,
      sessionCount: sessionTexts.length,
      totalSessions: sorted.length,
      droppedSessions: sorted.length - sessionTexts.length,
    },
    'Assembled hero choice context',
  );

  return fullContext;
}
