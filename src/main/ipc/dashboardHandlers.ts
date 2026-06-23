/**
 * Dashboard Domain IPC Handlers
 *
 * Handles attention suggestions and contextual dashboard features.
 */

import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import fs from 'node:fs/promises';
import path from 'node:path';
import fm from 'front-matter';
import { logger } from '@core/logger';
import { getBroadcastService } from '@core/broadcastService';
import { registerHandler } from './utils/registerHandler';
import { generatePersonalizedUseCases } from '../services/useCaseGeneratorService';
import { getSpaceActivity } from '../services/spaceActivityService';
import { getOrGenerateSynthesis } from '../services/spacesSynthesisService';
import { loadSessionToken } from '@core/services/tokenStorage/authTokenStorage';
import { MINDSTONE_API_URL as API_URL } from '@core/services/mindstoneApiUrl';
import { settingsStore } from '../settingsStore';
import { callBehindTheScenesWithAuth } from '../services/behindTheScenesClient';
import type { AppSettings } from '@shared/types';
import type {
  DashboardSharePayload,
  DashboardShareRedeemResponse,
  PersonalGoals,
  PersonalGoalItem,
} from '@shared/ipc/channels/dashboard';
import { ModelError } from '@core/rebelCore/modelErrors';
import { humanizeAgentError } from '@rebel/shared';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { fireAndForget } from '@shared/utils/fireAndForget';

export interface DashboardHandlerDeps {
  getSettings: () => AppSettings;
}

const GOALS_STALE_DAYS = 90;
type DashboardShareRedeemErrorCode = Extract<DashboardShareRedeemResponse, { success: false }>['errorCode'];

// Track in-progress restructuring to prevent duplicate calls
let goalsRestructuringInProgress = false;

/**
 * Serialize frontmatter attributes to YAML-compatible string.
 * Uses JSON.stringify for all values to ensure proper escaping of quotes/newlines.
 * Complex objects use indented JSON (valid YAML subset).
 */
function serializeFrontmatterToYaml(attrs: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    // Skip undefined values entirely
    if (value === undefined) {
      continue;
    }
    if (typeof value === 'string') {
      // Use JSON.stringify to properly escape quotes and special characters
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      // Use indented JSON for complex objects (valid YAML subset)
      const jsonStr = JSON.stringify(value, null, 2);
      lines.push(`${key}: ${jsonStr}`);
    }
  }
  return lines.join('\n');
}

/**
 * Check if a value looks like a goal item (has 'goal', 'why', 'primary', or 'focus' keys).
 */
function isGoalLikeItem(item: unknown): boolean {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return false;
  }
  const obj = item as Record<string, unknown>;
  return 'goal' in obj || 'why' in obj || 'primary' in obj || 'focus' in obj;
}

/**
 * Check if personal_goals object contains goal-like content that isn't in the expected format.
 * Returns true if there's content worth restructuring.
 * 
 * Handles various legacy formats:
 * - q1_2026: [{goal: "...", why: "..."}] (array format)
 * - q1_2026: {primary: "...", goal: "..."} (object format)
 * - ongoing_personal: [{goal: "..."}] (personal goals array)
 * - vision: "..." / year_end: {...} (older formats)
 */
function hasGoalsInWrongFormat(goalsObj: Record<string, unknown>): boolean {
  // Check if this_quarter already exists with valid goal-like content
  // Must have at least one item that looks like a goal (has goal/why/primary/focus keys)
  const hasValidThisQuarter = Array.isArray(goalsObj.this_quarter) && 
    goalsObj.this_quarter.length > 0 &&
    goalsObj.this_quarter.some(item => isGoalLikeItem(item));
  
  // Check for quarter-named keys (q1_2026, q2_2025, etc.) with goal content
  // Even if this_quarter exists, we want to detect legacy keys that should be merged
  let hasLegacyQuarterKeys = false;
  for (const [key, value] of Object.entries(goalsObj)) {
    if (key.match(/^q[1-4]_\d{4}$/i) && value && typeof value === 'object') {
      // Handle array format: q1_2026: [{goal: "...", why: "..."}]
      if (Array.isArray(value) && value.length > 0) {
        // Check if ANY item in the array looks like a goal (not just the first)
        if (value.some(item => isGoalLikeItem(item))) {
          hasLegacyQuarterKeys = true;
          break;
        }
      } else if (!Array.isArray(value)) {
        // Handle object format: q1_2026: {primary: "...", goal: "..."}
        const section = value as Record<string, unknown>;
        if (section.primary || section.goal || section.focus) {
          hasLegacyQuarterKeys = true;
          break;
        }
      }
    }
  }
  
  // If this_quarter is valid AND no legacy keys exist, no restructuring needed
  if (hasValidThisQuarter && !hasLegacyQuarterKeys) {
    return false;
  }
  
  // If legacy quarter keys exist (regardless of this_quarter state), trigger restructuring
  if (hasLegacyQuarterKeys) {
    return true;
  }
  
  // Check for ongoing_personal with array of goals (only if this_quarter is empty/missing)
  if (Array.isArray(goalsObj.ongoing_personal) && goalsObj.ongoing_personal.length > 0) {
    if (goalsObj.ongoing_personal.some(item => isGoalLikeItem(item))) {
      return true;
    }
  }
  
  // Check for vision with meaningful content (only if this_quarter is empty/missing)
  if (goalsObj.vision && typeof goalsObj.vision === 'string' && goalsObj.vision.trim().length > 0) {
    return true;
  }
  
  // Check for year_end with meaningful object content (guard against null)
  if (goalsObj.year_end && typeof goalsObj.year_end === 'object' && !Array.isArray(goalsObj.year_end)) {
    const yearEnd = goalsObj.year_end as Record<string, unknown>;
    if (Object.keys(yearEnd).length > 0) {
      return true;
    }
  }
  
  return false;
}

/**
 * Use Haiku to restructure malformed goals into the expected format.
 * Returns the restructured goals or null if restructuring fails.
 */
async function restructureGoalsWithHaiku(
  goalsObj: Record<string, unknown>,
  settings: AppSettings
): Promise<PersonalGoalItem[] | null> {
  try {
    const goalsJson = JSON.stringify(goalsObj, null, 2);
    
    const prompt = `Extract quarterly goals from this data and return them in a specific JSON format.

INPUT DATA:
${goalsJson}

REQUIRED OUTPUT FORMAT:
Return ONLY a JSON array of goals, where each goal has:
- "goal": string (the main goal text, concise but complete)
- "why": string (optional - the reason/context for this goal)

Example output:
[
  {"goal": "Close Series A funding round", "why": "Capture market opportunity before competitors"},
  {"goal": "Launch product v2.0", "why": "Address top customer requests"}
]

Focus on extracting THIS QUARTER's goals. If there's a "primary" field, that's the main goal.
If there's a "critical_milestone", use that as the "why".
Return 1-4 goals maximum. Return ONLY the JSON array, no explanation.`;
    
    const response = await callBehindTheScenesWithAuth(settings, {
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 2048,
    }, { category: 'metadata' });
    
    // Extract text from response
    const textBlock = response.content.find(block => block.type === 'text');
    if (!textBlock?.text) {
      logger.warn('Haiku returned no text for goals restructuring');
      return null;
    }
    
    // Parse the JSON response
    const jsonText = textBlock.text.trim();
    const parsed = JSON.parse(jsonText);
    
    if (!Array.isArray(parsed) || parsed.length === 0) {
      logger.warn({ parsed }, 'Haiku returned invalid goals format');
      return null;
    }
    
    // Validate and clean the goals
    const goals: PersonalGoalItem[] = parsed
      .filter((item): item is Record<string, unknown> => 
        item && typeof item === 'object' && 
        typeof item.goal === 'string' && 
        item.goal.trim().length > 0
      )
      .map(item => ({
        goal: (item.goal as string).trim(),
        why: typeof item.why === 'string' ? item.why.trim() : undefined,
      }));
    
    if (goals.length === 0) {
      return null;
    }
    
    logger.info({ goalCount: goals.length }, 'Successfully restructured goals with Haiku');
    return goals;
  } catch (error) {
    logger.error({ err: error }, 'Failed to restructure goals with Haiku');
    return null;
  }
}

/**
 * Update the README.md frontmatter with correctly structured goals.
 */
async function writeRestructuredGoals(
  coreDirectory: string,
  goals: PersonalGoalItem[],
  existingContent: string
): Promise<boolean> {
  try {
    const parsed = fm<Record<string, unknown>>(existingContent);
    const attrs = parsed.attributes as Record<string, unknown>;
    
    // Update personal_goals with correct structure
    const personalGoals = (attrs.personal_goals ?? {}) as Record<string, unknown>;
    personalGoals.this_quarter = goals.map(g => ({
      goal: g.goal,
      ...(g.why ? { why: g.why } : {})
    }));
    attrs.personal_goals = personalGoals;
    
    // Update last reviewed date
    const today = new Date().toISOString().split('T')[0];
    attrs.personal_goals_last_reviewed = today;
    
    // Rebuild the file content using canonical YAML serialization
    const yamlContent = serializeFrontmatterToYaml(attrs);
    const newContent = `---\n${yamlContent}\n---\n${parsed.body}`;
    
    // Write to both possible paths (canonical first)
    const pathsToTry = [
      path.join(coreDirectory, 'Chief-of-Staff', 'README.md'),
      path.join(coreDirectory, 'chief-of-staff', 'README.md'),
    ];
    
    for (const filePath of pathsToTry) {
      try {
        await fs.writeFile(filePath, newContent, 'utf-8');
        logger.info({ path: filePath }, 'Wrote restructured goals to README');
        return true;
      } catch {
        // Try next path
      }
    }
    
    return false;
  } catch (error) {
    logger.error({ err: error }, 'Failed to write restructured goals');
    return false;
  }
}

/**
 * Check if a date is stale (more than GOALS_STALE_DAYS ago).
 */
function isGoalsStale(lastReviewed: string): boolean {
  const reviewDate = new Date(lastReviewed);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - reviewDate.getTime()) / (1000 * 60 * 60 * 24));
  return diffDays > GOALS_STALE_DAYS;
}

/**
 * Normalize lastReviewed to string - YAML may parse dates as Date objects.
 */
function normalizeLastReviewed(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString().split('T')[0]; // YYYY-MM-DD format
  }
  return null;
}

/**
 * Read personal goals from Chief-of-Staff README.md frontmatter.
 * Uses raw frontmatter parsing to access the personal_goals field that isn't in the typed schema.
 * Tries both 'Chief-of-Staff' (canonical) and 'chief-of-staff' (demo mode) paths.
 * 
 * If goals exist but in the wrong format, triggers a Haiku call to restructure them.
 */
async function readPersonalGoals(coreDirectory: string, settings: AppSettings): Promise<PersonalGoals> {
  // Try canonical path first, then lowercase (demo mode creates lowercase)
  const pathsToTry = [
    path.join(coreDirectory, 'Chief-of-Staff', 'README.md'),
    path.join(coreDirectory, 'chief-of-staff', 'README.md'),
  ];
  
  let content: string | null = null;
  for (const chiefOfStaffPath of pathsToTry) {
    try {
      content = await fs.readFile(chiefOfStaffPath, 'utf-8');
      break;
    } catch (err) {
      // Log non-ENOENT errors (permission issues, etc.) to aid debugging
      const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (!isNotFound) {
        logger.warn({ err, path: chiefOfStaffPath }, 'Unexpected error reading Chief-of-Staff README');
      }
      // Try next path
    }
  }
  
  if (!content) {
    logger.debug('Could not read personal goals from Chief-of-Staff (tried both cases)');
    return { thisQuarter: [], lastReviewed: null, status: 'not_set' };
  }
  
  try {
    const parsed = fm<Record<string, unknown>>(content);
    const attrs = parsed.attributes;
    
    // Extract personal_goals_last_reviewed (handle both string and Date)
    const lastReviewed = normalizeLastReviewed(attrs.personal_goals_last_reviewed);
    
    // Extract personal_goals.this_quarter (expected format from set-personal-goals skill)
    const personalGoals = attrs.personal_goals;
    if (!personalGoals || typeof personalGoals !== 'object') {
      return { thisQuarter: [], lastReviewed, status: 'not_set' };
    }
    
    const goalsObj = personalGoals as Record<string, unknown>;
    const thisQuarterRaw = goalsObj.this_quarter;
    
    // Check if goals are in the expected format
    if (!Array.isArray(thisQuarterRaw) || thisQuarterRaw.length === 0) {
      // Check if goals exist but in wrong format - trigger restructuring
      if (hasGoalsInWrongFormat(goalsObj) && !goalsRestructuringInProgress) {
        goalsRestructuringInProgress = true;
        logger.info('Detected goals in wrong format, triggering restructuring with Haiku');
        
        // Fire-and-forget restructuring - don't block the current request
        fireAndForget((async () => {
          try {
            const restructured = await restructureGoalsWithHaiku(goalsObj, settings);
            if (restructured && restructured.length > 0) {
              await writeRestructuredGoals(coreDirectory, restructured, content);
            }
          } finally {
            goalsRestructuringInProgress = false;
          }
        })(), 'dashboardHandlers.restructureGoals');
      }
      return { thisQuarter: [], lastReviewed, status: lastReviewed ? 'current' : 'not_set' };
    }
    
    // Parse and validate each goal - ensure goal is a non-empty string
    const thisQuarter: PersonalGoalItem[] = thisQuarterRaw
      .filter((item): item is Record<string, unknown> => 
        item !== null && 
        typeof item === 'object' && 
        'goal' in item &&
        typeof item.goal === 'string' &&
        item.goal.trim().length > 0
      )
      .map(item => ({
        goal: (item.goal as string).trim(),
        why: typeof item.why === 'string' ? item.why.trim() : undefined,
      }));
    
    if (thisQuarter.length === 0) {
      return { thisQuarter: [], lastReviewed, status: lastReviewed ? 'current' : 'not_set' };
    }
    
    // Determine status
    let status: 'not_set' | 'current' | 'stale' = 'current';
    if (!lastReviewed) {
      status = 'not_set';
    } else if (isGoalsStale(lastReviewed)) {
      status = 'stale';
    }
    
    return { thisQuarter, lastReviewed, status };
  } catch (error) {
    // File doesn't exist or can't be parsed - return empty goals
    logger.debug({ err: error }, 'Could not read personal goals from Chief-of-Staff');
    return { thisQuarter: [], lastReviewed: null, status: 'not_set' };
  }
}

export function registerDashboardHandlers(deps: DashboardHandlerDeps): void {
  const { getSettings } = deps;

  registerHandler(
    'dashboard:get-space-activity',
    async (_event: HandlerInvokeEvent, req: { dayWindow?: number }) => {
      try {
        const settings = getSettings();
        if (!settings.coreDirectory) {
          return { spaces: [], totalMemoryCount: 0, totalSkillCount: 0 };
        }
        const result = await getSpaceActivity(settings.coreDirectory, req.dayWindow ?? 7);
        return result;
      } catch (error) {
        logger.error({ err: error }, 'Failed to get space activity');
        return { spaces: [], totalMemoryCount: 0, totalSkillCount: 0 };
      }
    }
  );

  registerHandler(
    'dashboard:get-spaces-synthesis',
    async (_event: HandlerInvokeEvent, req: { focus: string; forceRegenerate?: boolean }) => {
      const settings = getSettings();
      const result = await getOrGenerateSynthesis(settings, req.focus, req.forceRegenerate ?? false);
      return result;
    }
  );

  registerHandler('dashboard:generate-use-cases', async (_event: HandlerInvokeEvent) => {
    try {
      // generatePersonalizedUseCases uses injected deps for settings and executeAgentTurn
      const result = await generatePersonalizedUseCases();

      // Persist results directly in main process using atomic field updates
      // This ensures results are saved even if renderer callback doesn't execute
      // (e.g., user completed onboarding before generation finished)
      if (result.success && result.useCases && result.useCases.length > 0) {
        settingsStore.set('personalizedUseCases', result.useCases);
        logger.info(
          { useCaseCount: result.useCases.length },
          'Persisted use cases to settings store'
        );

        // Also persist user info if discovered and not already set
        const currentSettings = settingsStore.store;
        if (result.userFirstName && !currentSettings.userFirstName) {
          settingsStore.set('userFirstName', result.userFirstName);
          logger.info({ userFirstName: result.userFirstName }, 'Persisted user first name');
        }
        if (result.userEmail && !currentSettings.userEmail) {
          settingsStore.set('userEmail', result.userEmail);
          logger.info('Persisted user email');
        }

        // Notify renderer that use cases are ready (for background generation)
        // This allows showing a toast even if the original IPC caller is gone
        getBroadcastService().sendToAllWindows('dashboard:use-cases-ready', {
          count: result.useCases.length,
          userFirstName: result.userFirstName,
        });
      }

      return { ...result, count: result.useCases?.length };
    } catch (error) {
      logger.error({ err: error }, 'Failed to generate personalized use cases');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate use cases',
      };
    }
  });

  // Parse and save use cases from existing session output (skips Phase 1 discovery)
  // Used by onboarding where the visible session already ran the skill
  registerHandler('dashboard:parse-use-cases', async (_event: HandlerInvokeEvent, req: { sessionOutput: string }) => {
    try {
      // Call generatePersonalizedUseCases with existingSessionOutput to skip Phase 1
      const result = await generatePersonalizedUseCases(undefined, { existingSessionOutput: req.sessionOutput });

      // Same persistence logic as generate-use-cases
      if (result.success && result.useCases && result.useCases.length > 0) {
        settingsStore.set('personalizedUseCases', result.useCases);
        logger.info(
          { useCaseCount: result.useCases.length },
          'Persisted use cases to settings store (from existing session)'
        );

        const currentSettings = settingsStore.store;
        if (result.userFirstName && !currentSettings.userFirstName) {
          settingsStore.set('userFirstName', result.userFirstName);
          logger.info({ userFirstName: result.userFirstName }, 'Persisted user first name');
        }
        if (result.userEmail && !currentSettings.userEmail) {
          settingsStore.set('userEmail', result.userEmail);
          logger.info('Persisted user email');
        }

        getBroadcastService().sendToAllWindows('dashboard:use-cases-ready', {
          count: result.useCases.length,
          userFirstName: result.userFirstName,
        });
      }

      return { ...result, count: result.useCases?.length };
    } catch (error) {
      logger.error({ err: error }, 'Failed to parse use cases from session output');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to parse use cases',
      };
    }
  });

  registerHandler('dashboard:get-personal-goals', async (_event: HandlerInvokeEvent) => {
    try {
      const settings = getSettings();
      if (!settings.coreDirectory) {
        return { thisQuarter: [], lastReviewed: null, status: 'not_set' as const };
      }
      return await readPersonalGoals(settings.coreDirectory, settings);
    } catch (error) {
      logger.error({ err: error }, 'Failed to get personal goals');
      return { thisQuarter: [], lastReviewed: null, status: 'not_set' as const };
    }
  });

  registerHandler(
    'dashboard:redeem-share-token',
    async (_event: HandlerInvokeEvent, req: { token: string }): Promise<DashboardShareRedeemResponse> => {
      const sessionToken = loadSessionToken();
      if (!sessionToken) {
        return {
          success: false,
          errorCode: 'UNAUTHENTICATED',
          message: 'Sign in to Rebel before opening dashboard context.',
        };
      }

      try {
        const response = await fetch(
          `${API_URL}/api/dashboard/share-tokens/${encodeURIComponent(req.token)}`,
          {
            headers: { Authorization: `Bearer ${sessionToken}` },
          },
        );
        let body: Record<string, unknown> = {};
        try {
          body = await response.json();
        } catch (error) {
          ignoreBestEffortCleanup(error, {
            operation: 'dashboard-redeem-share-token-parse-error',
            reason: 'Response body is best-effort error context; HTTP status still drives the user-facing outcome.',
          });
        }

        if (!response.ok) {
          if (response.status === 401) {
            return {
              success: false,
              errorCode: 'UNAUTHENTICATED',
              message: 'Sign in to Rebel before opening dashboard context.',
            };
          }

          const errorBody = body.error && typeof body.error === 'object'
            ? body.error as Record<string, unknown>
            : {};
          const code: DashboardShareRedeemErrorCode =
            typeof errorBody.code === 'string'
              ? (errorBody.code as DashboardShareRedeemErrorCode)
              : 'UNKNOWN_ERROR';
          const message =
            typeof errorBody.message === 'string'
              ? errorBody.message
              : 'Could not open this dashboard context.';
          return {
            success: false,
            errorCode: code as DashboardShareRedeemResponse extends { success: false; errorCode: infer C } ? C : never,
            message,
          };
        }

        return {
          success: true,
          payload: body.payload as DashboardSharePayload,
          organizationId: String(body.organizationId ?? ''),
          createdByUserId: String(body.createdByUserId ?? ''),
        };
      } catch (error) {
        logger.warn({ err: error }, 'Failed to redeem dashboard share token');
        return {
          success: false,
          errorCode: 'NETWORK_ERROR',
          message: 'Could not reach Rebel Platform to open this dashboard context.',
        };
      }
    },
  );

  // One-time check after onboarding: ensure goals are in frontmatter, not just markdown body
  registerHandler('dashboard:ensure-goals-in-frontmatter', async (_event: HandlerInvokeEvent) => {
    const settings = getSettings();
    if (!settings.coreDirectory) {
      return { success: false, action: 'error' as const, error: 'No core directory' };
    }

    try {
      // Try to read the README
      const pathsToTry = [
        path.join(settings.coreDirectory, 'Chief-of-Staff', 'README.md'),
        path.join(settings.coreDirectory, 'chief-of-staff', 'README.md'),
      ];

      let content: string | null = null;
      let filePath: string | null = null;
      for (const p of pathsToTry) {
        try {
          content = await fs.readFile(p, 'utf-8');
          filePath = p;
          break;
        } catch {
          // Try next
        }
      }

      if (!content || !filePath) {
        return { success: true, action: 'no_goals_found' as const };
      }

      // Parse frontmatter
      const parsed = fm<Record<string, unknown>>(content);
      const attrs = parsed.attributes as Record<string, unknown>;
      const personalGoals = attrs.personal_goals as Record<string, unknown> | undefined;
      const thisQuarter = personalGoals?.this_quarter;

      // Check if goals already exist in frontmatter
      if (Array.isArray(thisQuarter) && thisQuarter.length > 0) {
        logger.info('Goals already in frontmatter, no extraction needed');
        return { success: true, action: 'already_correct' as const, goalCount: thisQuarter.length };
      }

      // Check if markdown body contains goal-like content
      const body = parsed.body;
      const goalPatterns = [
        /##\s*(?:Q[1-4]\s*\d{4}\s*)?Goals?/i,
        /##\s*(?:This\s*)?Quarter(?:'s)?\s*Goals?/i,
        /##\s*Primary\s*Goal/i,
        /\*\*Primary\s*Goal\*\*/i,
      ];

      const hasGoalsInBody = goalPatterns.some(pattern => pattern.test(body));
      if (!hasGoalsInBody) {
        logger.info('No goal-like content found in README body');
        return { success: true, action: 'no_goals_found' as const };
      }

      // Extract goals from markdown body using Haiku
      logger.info('Found goals in markdown body, extracting with Haiku');
      const prompt = `Extract quarterly goals from this README content and return them as a JSON array.

README CONTENT:
${body}

REQUIRED OUTPUT FORMAT:
Return ONLY a JSON array of goals, where each goal has:
- "goal": string (the main goal text, concise but complete)
- "why": string (optional - the reason/context for this goal)

Example output:
[
  {"goal": "Close Series A funding round", "why": "Capture market opportunity"},
  {"goal": "Launch product v2.0"}
]

Look for sections like "Goals", "Q1 Goals", "Primary Goal", "This Quarter", etc.
Extract 1-4 goals maximum. Return ONLY the JSON array, no explanation.`;

      const response = await callBehindTheScenesWithAuth(settings, {
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 2048,
      }, { category: 'metadata' });

      const textBlock = response.content.find(block => block.type === 'text');
      if (!textBlock?.text) {
        logger.warn('Haiku returned no text for goals extraction');
        return { success: false, action: 'error' as const, error: 'Failed to extract goals' };
      }

      // Parse JSON response
      const jsonMatch = textBlock.text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        logger.warn('Could not find JSON array in Haiku response');
        return { success: false, action: 'error' as const, error: 'Invalid response format' };
      }

      const goals = JSON.parse(jsonMatch[0]) as Array<{ goal: string; why?: string }>;
      if (!Array.isArray(goals) || goals.length === 0) {
        return { success: true, action: 'no_goals_found' as const };
      }

      // Write goals to frontmatter
      const validGoals = goals
        .filter(g => g.goal && typeof g.goal === 'string' && g.goal.trim().length > 0)
        .map(g => ({ goal: g.goal.trim(), ...(g.why ? { why: g.why.trim() } : {}) }));

      if (validGoals.length === 0) {
        return { success: true, action: 'no_goals_found' as const };
      }

      // Update frontmatter
      const updatedGoals = { ...(personalGoals ?? {}), this_quarter: validGoals };
      attrs.personal_goals = updatedGoals;
      attrs.personal_goals_last_reviewed = new Date().toISOString().split('T')[0];

      // Rebuild file with updated frontmatter using canonical YAML serialization
      const yamlContent = serializeFrontmatterToYaml(attrs);
      const newContent = `---\n${yamlContent}\n---\n${body}`;

      await fs.writeFile(filePath, newContent, 'utf-8');
      logger.info({ goalCount: validGoals.length, path: filePath }, 'Extracted goals from body and wrote to frontmatter');

      return { success: true, action: 'extracted_from_body' as const, goalCount: validGoals.length };
    } catch (error) {
      logger.error({ err: error }, 'Failed to ensure goals in frontmatter');
      const fallback = error instanceof Error ? error.message : 'Unknown error';
      // Stage 6b migration: classification-first humanization.
      // See docs/plans/260421_classification_driven_error_humanizer.md.
      const humanized = humanizeAgentError(
        error instanceof ModelError
          ? {
              kind: 'classified',
              errorKind: error.__agentErrorKind,
              rawMessage: error.__rawMessage,
              provider: error.provider,
              upstreamProviderName: error.upstreamProvider,
            }
          : { kind: 'unclassified', rawMessage: fallback },
      );
      return {
        success: false,
        action: 'error' as const,
        error: humanized,
        errorKind: error instanceof ModelError ? error.__agentErrorKind : 'unknown',
      };
    }
  });
}
