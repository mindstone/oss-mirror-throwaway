import { extractServiceFromReason } from '../../approvalUtils';
import { isSideEffectVerb } from '../../toolVerbs';
import type {
  ActionEffectKind,
  ActionPreviewInput,
  BlastRadius,
  BlastRadiusChip,
  MemorySharing,
  Reversibility,
  RiskReason,
} from '../model';

export interface BlastRadiusProjection {
  blastRadius: BlastRadius;
  reversibility: Reversibility | null;
  riskReasons: RiskReason[];
}

const LOCAL_PACKAGE_HINTS = ['bash', 'shell', 'terminal', 'filesystem', 'texteditor', 'computer'] as const;

const PACKAGE_NAME_LABELS: Record<string, string> = {
  slack: 'Slack',
  gmail: 'Gmail',
  outlook: 'Outlook',
  'google-workspace': 'Google Workspace',
  googleworkspace: 'Google Workspace',
  hubspot: 'HubSpot',
  salesforce: 'Salesforce',
  zendesk: 'Zendesk',
  notion: 'Notion',
  linear: 'Linear',
  github: 'GitHub',
};

function chip(label: string, evidence: BlastRadiusChip['evidence'] = 'explicit'): BlastRadiusChip {
  return { label, evidence };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function getToolLike(input: ActionPreviewInput): {
  packageId: string;
  reason: string;
  args: Record<string, unknown>;
  toolIdLike: string;
} | null {
  if (input.kind !== 'tool' && input.kind !== 'staged-tool') return null;
  const toolIdLike = input.kind === 'tool'
    ? `${input.effectiveToolId ?? ''} ${input.toolName}`.trim().toLowerCase()
    : `${input.toolId} ${input.displayName ?? ''}`.trim().toLowerCase();

  return {
    packageId: (input.packageId ?? '').toLowerCase(),
    reason: input.reason ?? '',
    args: asRecord(input.args),
    toolIdLike,
  };
}

function deriveDataCaptureWhere(input: ActionPreviewInput): BlastRadiusChip[] {
  if (input.kind !== 'memory' && input.kind !== 'staged-file') return [];
  if (input.spaceName) {
    if (/chief[\s-_]*of[\s-_]*staff/i.test(input.spaceName)) {
      return [chip('Chief-of-Staff', 'derived')];
    }
    return [chip(input.spaceName)];
  }
  if (input.spacePath) return [chip(input.spacePath, 'derived')];
  if (input.filePath) return [chip(input.filePath, 'derived')];
  return [];
}

function sharingToAudience(sharing: MemorySharing | undefined): BlastRadiusChip[] {
  switch (sharing) {
    case 'private':
      return [chip('Private to you')];
    case 'restricted':
      return [chip('Shared workspace')];
    case 'company-wide':
      return [chip('Company-wide')];
    case 'public':
      return [chip('Public')];
    default:
      return [];
  }
}

function packageToLabel(packageId: string): string | null {
  if (!packageId) return null;
  const lowered = packageId.toLowerCase();
  if (PACKAGE_NAME_LABELS[lowered]) return PACKAGE_NAME_LABELS[lowered];
  return lowered
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isProvablyExternal(toolLike: NonNullable<ReturnType<typeof getToolLike>>): boolean {
  if (!toolLike.packageId) return false;
  return !LOCAL_PACKAGE_HINTS.some((hint) => toolLike.packageId.includes(hint));
}

function deriveGenericWhere(toolLike: NonNullable<ReturnType<typeof getToolLike>>): BlastRadiusChip {
  if (LOCAL_PACKAGE_HINTS.some((hint) => toolLike.packageId.includes(hint))) {
    return chip('Runs on your device', 'derived');
  }
  const fromReason = extractServiceFromReason(toolLike.reason);
  if (fromReason) return chip(fromReason, 'derived');
  const fromPackage = packageToLabel(toolLike.packageId);
  if (fromPackage) return chip(fromPackage, 'derived');
  return chip('Runs on your device', 'derived');
}

function hasSideEffect(toolLike: NonNullable<ReturnType<typeof getToolLike>>): boolean {
  return isSideEffectVerb(toolLike.toolIdLike);
}

export function projectBlastRadius(
  input: ActionPreviewInput,
  effectKind: ActionEffectKind,
): BlastRadiusProjection {
  const where: BlastRadiusChip[] = [];
  const whoCanSeeIt: BlastRadiusChip[] = [];
  const afterwards: BlastRadiusChip[] = [];
  const riskReasons: RiskReason[] = [];
  let reversibility: Reversibility | null = null;

  const toolLike = getToolLike(input);

  if (effectKind === 'data-capture') {
    where.push(...deriveDataCaptureWhere(input));
    if (input.kind === 'memory' || input.kind === 'staged-file') {
      whoCanSeeIt.push(...sharingToAudience(input.sharing));
      if (input.sharing && input.sharing !== 'private') {
        riskReasons.push('Shared');
      }
    }
    reversibility = 'Can edit after saving';
    afterwards.push(chip(reversibility));
  } else if (effectKind === 'document') {
    where.push(...deriveDataCaptureWhere(input));
    if (input.kind === 'memory' || input.kind === 'staged-file') {
      whoCanSeeIt.push(...sharingToAudience(input.sharing));
      if (input.sharing && input.sharing !== 'private') {
        riskReasons.push('Shared');
      }
    }
    reversibility = 'Can edit after saving';
    afterwards.push(chip(reversibility));
  } else if (toolLike) {
    where.push(deriveGenericWhere(toolLike));
    if (effectKind === 'command' || toolLike.packageId.includes('bash') || toolLike.toolIdLike.includes('bash')) {
      reversibility = 'Runs once';
      afterwards.push(chip(reversibility, 'derived'));
    } else if (hasSideEffect(toolLike)) {
      reversibility = 'Hard to undo';
      afterwards.push(chip(reversibility, 'derived'));
      riskReasons.push('Hard to undo');
    }
    if (isProvablyExternal(toolLike)) {
      riskReasons.push('Leaves Rebel');
    }
  }

  const uniqueRiskReasons = Array.from(new Set(riskReasons));
  return {
    blastRadius: { where, whoCanSeeIt, afterwards },
    reversibility,
    riskReasons: uniqueRiskReasons,
  };
}
