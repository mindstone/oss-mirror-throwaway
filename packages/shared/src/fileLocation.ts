import path from 'pathe';
import { z } from 'zod';

const UNKNOWN_FILE_LABEL = 'Unknown file';
const UNKNOWN_SPACE_LABEL = 'Unknown space';
const DEGRADED_TOOLTIP = 'File location missing — degraded display';
const SHARED_SKILL_SPACE_TYPES = ['chief-of-staff', 'personal', 'company', 'team', 'project', 'operator', 'other'] as const;

function toPortableNormalizedPath(value: string): string {
  const normalized = path.normalize(value.replace(/\\/g, '/')).replace(/\/+/g, '/');
  if (normalized === '/') {
    return normalized;
  }
  return normalized.replace(/\/+$/, '');
}

function toTrimmedNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toNormalizedNonEmptyPath(value: string | undefined): string | undefined {
  const trimmed = toTrimmedNonEmpty(value);
  if (!trimmed) {
    return undefined;
  }
  const normalized = toPortableNormalizedPath(trimmed);
  if (normalized === '.' || normalized === './') {
    return undefined;
  }
  return normalized.length > 0 ? normalized : undefined;
}

function isEscapingPath(value: string): boolean {
  const portable = toPortableNormalizedPath(value);
  return portable === '..'
    || portable.startsWith('../')
    || portable.includes('/../')
    || portable.endsWith('/..');
}

function ensureNonEmptyFileName(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const trimmed = toTrimmedNonEmpty(candidate);
    if (trimmed) {
      return trimmed;
    }
  }
  return UNKNOWN_FILE_LABEL;
}

function deriveOutsideParent(absolutePath: string): string {
  const normalizedPath = toPortableNormalizedPath(absolutePath);
  const parentDir = path.dirname(normalizedPath);
  if (
    parentDir === '/'
    || parentDir === normalizedPath
    || /^\/?[A-Za-z]:[\\/]?$/.test(parentDir)
  ) {
    return '';
  }

  const parentName = path.basename(parentDir);
  return toTrimmedNonEmpty(parentName) ?? '';
}

export const SharedSkillTargetSchema = z.object({
  absolutePath: z.string(),
  relativePath: z.string(),
  sharing: z.enum(['restricted', 'company-wide', 'public']),
  spaceName: z.string(),
  spacePath: z.string(),
  spaceAbsolutePath: z.string(),
  spaceType: z.enum(SHARED_SKILL_SPACE_TYPES).optional(),
  shape: z.enum(['file', 'folder']),
});
export type SharedSkillTarget = z.infer<typeof SharedSkillTargetSchema>;

export const OutsideCategorySchema = z.enum([
  'temp',
  'system',
  'inbox',
  'mcp_servers',
  'outside',
  'workspace_root',
  'unknown',
]);
export type OutsideCategory = z.infer<typeof OutsideCategorySchema>;

const InSpaceFileLocationSchema = z.object({
  kind: z.literal('in-space'),
  spaceName: z.string().min(1),
  spaceWorkspacePath: z.string().min(1),
  spaceRelativePath: z.string().min(1),
  workspaceRelativePath: z.string().min(1),
  fileName: z.string().min(1),
  absolutePath: z.string().min(1).optional(),
});

const OutsideWorkspaceFileLocationSchema = z.object({
  kind: z.literal('outside-workspace'),
  absolutePath: z.string().min(1),
  fileName: z.string().min(1),
  outsideCategory: OutsideCategorySchema.optional(),
});

const LegacyMissingLocationSchema = z.object({
  kind: z.literal('legacy-missing-location'),
  fileName: z.string().min(1),
  spaceName: z.string().optional(),
  legacyPath: z.string().optional(),
});

export const FileLocationSchema = z.discriminatedUnion('kind', [
  InSpaceFileLocationSchema,
  OutsideWorkspaceFileLocationSchema,
  LegacyMissingLocationSchema,
]);
export type FileLocation = z.infer<typeof FileLocationSchema>;

export interface FileLocationDescription {
  label: string;
  shortLabel: string;
  tooltip: string;
  fileName: string;
  degraded: boolean;
}

export function legacyMissingLocation(input: {
  fileName?: string;
  spaceName?: string;
  legacyPath?: string;
}): FileLocation {
  const normalizedLegacyPath = toNormalizedNonEmptyPath(input.legacyPath);
  const resolvedFileName = ensureNonEmptyFileName(
    input.fileName,
    normalizedLegacyPath ? path.basename(normalizedLegacyPath) : undefined,
    input.spaceName,
  );

  return {
    kind: 'legacy-missing-location',
    fileName: resolvedFileName,
    spaceName: toTrimmedNonEmpty(input.spaceName),
    legacyPath: normalizedLegacyPath,
  };
}

function describeOutsideWorkspaceLabel(loc: Extract<FileLocation, { kind: 'outside-workspace' }>, fileName: string): {
  label: string;
  shortLabel: string;
} {
  switch (loc.outsideCategory) {
    case 'temp':
      return {
        label: `Temporary folder — ${fileName}`,
        shortLabel: `Temporary folder — ${fileName}`,
      };
    case 'system':
      return {
        label: `System files — ${fileName}`,
        shortLabel: `System files — ${fileName}`,
      };
    case 'inbox':
      return {
        label: `Actions — ${fileName}`,
        shortLabel: `Actions — ${fileName}`,
      };
    case 'mcp_servers':
      return {
        label: `MCP Servers — ${fileName}`,
        shortLabel: `MCP Servers — ${fileName}`,
      };
    case 'outside':
    case 'workspace_root':
    case 'unknown':
    case undefined: {
      const parentFolder = deriveOutsideParent(loc.absolutePath);
      const labelSuffix = parentFolder ? `${parentFolder} / ${fileName}` : fileName;
      return {
        label: `Outside workspace — ${labelSuffix}`,
        shortLabel: `Outside workspace — ${fileName}`,
      };
    }
    default: {
      const _exhaustive: never = loc.outsideCategory;
      void _exhaustive;
      throw new Error(`Unhandled outsideCategory in describeOutsideWorkspaceLabel: ${String(loc.outsideCategory)}`);
    }
  }
}

export function describeFileLocation(loc: FileLocation): FileLocationDescription {
  switch (loc.kind) {
    case 'in-space': {
      const fileName = ensureNonEmptyFileName(loc.fileName, path.basename(loc.spaceRelativePath));
      const label = `${loc.spaceName} / ${loc.spaceRelativePath}`;
      const shortLabel = `${loc.spaceName} / ${fileName}`;
      const tooltip = loc.absolutePath ?? loc.workspaceRelativePath;
      return {
        label,
        shortLabel,
        tooltip,
        fileName,
        degraded: false,
      };
    }

    case 'outside-workspace': {
      const fileName = ensureNonEmptyFileName(loc.fileName, path.basename(loc.absolutePath));
      const labels = describeOutsideWorkspaceLabel(loc, fileName);
      return {
        label: labels.label,
        shortLabel: labels.shortLabel,
        tooltip: loc.absolutePath,
        fileName,
        degraded: false,
      };
    }

    case 'legacy-missing-location': {
      const fileName = ensureNonEmptyFileName(
        loc.fileName,
        loc.legacyPath ? path.basename(loc.legacyPath) : undefined,
      );
      const spaceName = toTrimmedNonEmpty(loc.spaceName) ?? UNKNOWN_SPACE_LABEL;
      const label = `${spaceName} / ${fileName}`;
      return {
        label,
        shortLabel: label,
        tooltip: DEGRADED_TOOLTIP,
        fileName,
        degraded: true,
      };
    }

    default: {
      const _exhaustive: never = loc;
      void _exhaustive;
      throw new Error(`Unhandled FileLocation variant in describeFileLocation: ${JSON.stringify(loc)}`);
    }
  }
}

function toInSpaceLocation(target: SharedSkillTarget): FileLocation | null {
  const spaceName = toTrimmedNonEmpty(target.spaceName);
  const spaceWorkspacePath = toNormalizedNonEmptyPath(target.spacePath);
  const workspaceRelativePath = toNormalizedNonEmptyPath(target.relativePath);

  if (!spaceName || !spaceWorkspacePath || !workspaceRelativePath) {
    return null;
  }

  const spaceRelativePathRaw = path.relative(spaceWorkspacePath, workspaceRelativePath).replace(/\\/g, '/');
  const spaceRelativePath = toNormalizedNonEmptyPath(spaceRelativePathRaw);
  if (!spaceRelativePath || isEscapingPath(spaceRelativePath)) {
    return null;
  }

  const fileName = ensureNonEmptyFileName(path.basename(spaceRelativePath));
  const normalizedAbsolutePath = toNormalizedNonEmptyPath(target.absolutePath);

  return {
    kind: 'in-space',
    spaceName,
    spaceWorkspacePath,
    spaceRelativePath,
    workspaceRelativePath,
    fileName,
    absolutePath: normalizedAbsolutePath,
  };
}

export function fileLocationFromSkillTarget(target: SharedSkillTarget): FileLocation {
  const inSpace = toInSpaceLocation(target);
  if (inSpace) {
    return inSpace;
  }

  const normalizedAbsolutePath = toNormalizedNonEmptyPath(target.absolutePath);
  if (normalizedAbsolutePath) {
    return {
      kind: 'outside-workspace',
      absolutePath: normalizedAbsolutePath,
      fileName: ensureNonEmptyFileName(path.basename(normalizedAbsolutePath)),
    };
  }

  return legacyMissingLocation({
    spaceName: toTrimmedNonEmpty(target.spaceName),
    legacyPath: toNormalizedNonEmptyPath(target.relativePath),
  });
}
