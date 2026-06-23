import { describe, expect, it } from 'vitest';
import { libraryChannels } from '../library';
import { StagedMemoryFileSchema } from '../memory';

const validInSpaceLocation = {
  kind: 'in-space' as const,
  spaceName: 'General',
  spaceWorkspacePath: 'General',
  spaceRelativePath: 'skills/workflows/weekly-update/SKILL.md',
  workspaceRelativePath: 'General/skills/workflows/weekly-update/SKILL.md',
  fileName: 'SKILL.md',
  absolutePath: '/tmp/General/skills/workflows/weekly-update/SKILL.md',
};

const baseStagedMemoryFile = {
  id: 'staged-file-1',
  realPath: '/tmp/General/skills/workflows/weekly-update/SKILL.md',
  pendingDestination: 'General/skills/workflows/weekly-update/SKILL.md',
  spaceName: 'General',
  spacePath: 'General',
  sessionId: 'session-1',
  baseHash: 'hash-1',
  summary: 'Updated workflow',
  stagedAt: 1_717_171_717_000,
  sensitivity: 'high' as const,
};

const baseSkillChangeNotification = {
  id: 'notification-1',
  skillName: 'weekly-update',
  skillWorkspacePath: 'General/skills/workflows/weekly-update/SKILL.md',
  spacePath: 'General',
  actorLabel: 'Rebel',
  actorKind: 'agent' as const,
  recipientReason: 'previous_editor' as const,
  createdAt: 1_717_171_717_000,
  updatedAt: 1_717_171_717_100,
};

function hasIssuePathSuffix(paths: readonly PropertyKey[], suffix: string): boolean {
  return paths.map((pathSegment) => String(pathSegment)).join('.').endsWith(suffix);
}

describe('Stage 2a file-location schema extensions', () => {
  describe('StagedMemoryFileSchema.location', () => {
    it('accepts a valid in-space location object', () => {
      const result = StagedMemoryFileSchema.safeParse({
        ...baseStagedMemoryFile,
        location: validInSpaceLocation,
      });

      expect(result.success).toBe(true);
    });

    it('accepts rows without location for backwards compatibility', () => {
      const result = StagedMemoryFileSchema.safeParse(baseStagedMemoryFile);

      expect(result.success).toBe(true);
    });

    it('rejects invalid nested location fields', () => {
      const result = StagedMemoryFileSchema.safeParse({
        ...baseStagedMemoryFile,
        location: {
          ...validInSpaceLocation,
          spaceName: '',
        },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => hasIssuePathSuffix(issue.path, 'location.spaceName'))).toBe(true);
      }
    });
  });

  describe('Stage 5A — StagedMemoryFileSchema.spacePath', () => {
    it('rejects rows with empty spacePath (the original bug)', () => {
      const result = StagedMemoryFileSchema.safeParse({
        ...baseStagedMemoryFile,
        spacePath: '',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => hasIssuePathSuffix(issue.path, 'spacePath'))).toBe(true);
      }
    });

    it('accepts rows with non-empty spacePath', () => {
      const result = StagedMemoryFileSchema.safeParse({
        ...baseStagedMemoryFile,
        spacePath: 'General/skills/workflows/weekly-update/SKILL.md',
      });

      expect(result.success).toBe(true);
    });

    it('still accepts rows without a location field (tolerant mode per F21)', () => {
      const { location: _ignore, ...withoutLocation } = {
        ...baseStagedMemoryFile,
        location: undefined,
      };
      void _ignore;

      const result = StagedMemoryFileSchema.safeParse(withoutLocation);

      expect(result.success).toBe(true);
    });
  });

  describe('SkillChangeNotificationSchema.location', () => {
    const schema = libraryChannels['library:list-skill-change-notifications'].response;

    it('accepts a valid in-space location object', () => {
      const result = schema.safeParse([
        {
          ...baseSkillChangeNotification,
          location: validInSpaceLocation,
        },
      ]);

      expect(result.success).toBe(true);
    });

    it('accepts records without location for backwards compatibility', () => {
      const result = schema.safeParse([baseSkillChangeNotification]);

      expect(result.success).toBe(true);
    });

    it('rejects invalid nested location fields', () => {
      const result = schema.safeParse([
        {
          ...baseSkillChangeNotification,
          location: {
            ...validInSpaceLocation,
            spaceName: '',
          },
        },
      ]);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => hasIssuePathSuffix(issue.path, 'location.spaceName'))).toBe(true);
      }
    });
  });
});
