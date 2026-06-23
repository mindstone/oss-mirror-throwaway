/**
 * Skill Usage Recorder
 *
 * Extracts which skills were used in a session (from user @`...` mentions
 * and agent tool-read events) and records their usage. Also detects
 * "doctor sessions" that improved a skill and broadcasts quality scores.
 *
 * Extracted from sessionCoachingScheduler — this logic has no LLM
 * dependency and runs independently of coaching limits.
 */

import type { AgentSession } from '@shared/types';
import { safeParseDetailRecord } from '@shared/utils/safeParseDetail';
import { createScopedLogger } from '@core/logger';
import { recordSkillUsage } from './skillUsageStore';
import { detectDoctorSession } from '@core/skillImprovementDetector';
import { scanSkills } from './skillsService';

const log = createScopedLogger({ service: 'skillUsageRecorder' });

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface SkillUsageRecorderDeps {
  isUsageRecorded: (sessionId: string) => boolean;
  markUsageRecorded: (sessionId: string) => void;
  broadcastSkillImprovementComplete?: (data: {
    skillName: string;
    skillPath: string;
    scoreAfter: number;
    bandAfter: string;
    lastSessionId?: string;
  }) => void;
  getWorkspacePath: () => string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// extractSkillsUsed
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse a session's messages and tool events to find which skills were used.
 *
 * Sources:
 * 1. User explicit `@`path`` mentions pointing to skill .md files
 * 2. Agent reading skill files during a turn (tool read events)
 */
export function extractSkillsUsed(session: AgentSession): string[] {
  const skillsUsed: string[] = [];

  const extractSkillName = (filePath: string): string | null => {
    const hasSkillsSegment = filePath.includes('/skills/') || filePath.startsWith('skills/');
    if (!hasSkillsSegment || !filePath.endsWith('.md')) return null;
    const parts = filePath.split('/');
    const fileName = parts[parts.length - 1];
    return fileName === 'SKILL.md' || fileName.toLowerCase() === 'skill.md'
      ? parts[parts.length - 2]
      : fileName.replace(/\.md$/i, '');
  };

  // Source 1: User explicit mentions in messages
  const fileMentionPattern = /@`([^`]+)`/g;
  for (const msg of session.messages) {
    if (msg.role === 'user' && msg.text) {
      const matches = msg.text.matchAll(fileMentionPattern);
      for (const match of matches) {
        const skillName = extractSkillName(match[1] ?? '');
        if (skillName && !skillsUsed.includes(skillName)) {
          skillsUsed.push(skillName);
        }
      }
    }
  }

  // Source 2: Agent reading skill files during turn (tool events)
  // Tool events store the file path in `detail` (JSON string with file_path)
  // rather than in `input` (which is not persisted in session events).
  for (const events of Object.values(session.eventsByTurn ?? {})) {
    for (const event of events) {
      if (event.type === 'tool') {
        const toolEvent = event as { toolName?: string; detail?: string; stage?: string; input?: Record<string, unknown> };
        const isReadTool = ['read', 'read_file', 'str_replace_editor', 'view'].some(
          name => toolEvent.toolName?.toLowerCase().includes(name)
        );
        if (!isReadTool || toolEvent.stage !== 'start') continue;

        // Try detail first (JSON string with file_path), fall back to input
        let filePath = '';
        if (toolEvent.detail) {
          // BOUNDED via safeParseDetailRecord: malformed, over-budget, OR
          // non-object valid JSON detail is skipped (falls through to input
          // below) — matching the pre-migration try/catch fallback.
          const result = safeParseDetailRecord(toolEvent.detail);
          if (result.ok) {
            const parsed = result.value;
            filePath = (parsed.file_path ?? parsed.path ?? parsed.file ?? '') as string;
          }
        }
        if (!filePath && toolEvent.input) {
          filePath = (toolEvent.input.path ?? toolEvent.input.file_path ?? toolEvent.input.file ?? '') as string;
        }

        const skillName = extractSkillName(filePath);
        if (skillName && !skillsUsed.includes(skillName)) {
          skillsUsed.push(skillName);
        }
      }
    }
  }

  return skillsUsed;
}

// ─────────────────────────────────────────────────────────────────────────
// broadcastImprovementResults (post-doctor-session quality scoring)
// ─────────────────────────────────────────────────────────────────────────

async function broadcastImprovementResults(
  targetSkillNames: string[],
  deps: Pick<SkillUsageRecorderDeps, 'broadcastSkillImprovementComplete' | 'getWorkspacePath'>
): Promise<void> {
  if (!deps.broadcastSkillImprovementComplete) return;

  try {
    const workspacePath = deps.getWorkspacePath();
    if (!workspacePath) return;

    const result = await scanSkills(workspacePath);
    const { computeSkillQualityScore } = await import('@core/skillQualityScore');
    const { getAllSkillUsage } = await import('./skillUsageStore');

    const usageByName = new Map(getAllSkillUsage().map(r => [r.skillName.trim().toLowerCase(), r]));
    const targetSet = new Set(targetSkillNames.map(n => n.trim().toLowerCase()));

    for (const group of result.groups) {
      for (const skills of Object.values(group.categories)) {
        for (const skill of skills) {
          if (!targetSet.has(skill.name.trim().toLowerCase())) continue;

          const normalizedName = skill.name.trim().toLowerCase();
          const usageRecord = usageByName.get(normalizedName);

          const quality = computeSkillQualityScore({
            name: skill.name,
            relativePath: skill.relativePath,
            hasFrontmatter: skill.hasFrontmatter,
            frontmatter: skill.frontmatter as import('@core/skillQualityScore').SkillQualityFrontmatter | undefined,
            examples: skill.examples ?? [],
            bodyText: skill.bodyText ?? '',
            usageCount: usageRecord?.usageCount,
            lastUsedAt: usageRecord && Number.isFinite(usageRecord.lastUsedAt) ? new Date(usageRecord.lastUsedAt) : null,
            sessionCount: usageRecord?.recentSessionIds.length ?? 0,
          });

          deps.broadcastSkillImprovementComplete({
            skillName: skill.name,
            skillPath: skill.relativePath,
            scoreAfter: quality.total,
            bandAfter: quality.band,
            lastSessionId: usageRecord?.recentSessionIds.at(-1),
          });

          log.info({ skillName: skill.name, scoreAfter: quality.total, band: quality.band }, 'Broadcast skill improvement result');
        }
      }
    }
  } catch (err) {
    log.warn({ err }, 'Failed to compute post-improvement quality scores');
  }
}

// ─────────────────────────────────────────────────────────────────────────
// processSkillUsageForSessions
// ─────────────────────────────────────────────────────────────────────────

/**
 * Record skill usage for a batch of resolved sessions.
 *
 * For each session that hasn't been recorded yet:
 * 1. Extract which skills were used
 * 2. Record each skill's usage
 * 3. Detect doctor sessions and broadcast improvement results
 */
export async function processSkillUsageForSessions(
  sessions: AgentSession[],
  deps: SkillUsageRecorderDeps
): Promise<void> {
  for (const session of sessions) {
    if (deps.isUsageRecorded(session.id)) continue;
    deps.markUsageRecorded(session.id);

    const skillsUsed = extractSkillsUsed(session);
    for (const skillName of skillsUsed) {
      recordSkillUsage(skillName, session.id);
    }
    if (skillsUsed.length > 0) {
      log.debug({ sessionId: session.id, skillsUsed }, 'Recorded skill usage');

      // Detect doctor sessions and broadcast improvement results
      const doctorDetection = detectDoctorSession(skillsUsed);
      if (doctorDetection.isDoctorSession) {
        await broadcastImprovementResults(doctorDetection.targetSkills, deps);
      }
    }
  }
}
