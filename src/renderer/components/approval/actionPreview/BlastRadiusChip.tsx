import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  Clock3,
  Globe,
  Hash,
  HelpCircle,
  Lock,
  MapPin,
  Monitor,
  RefreshCw,
  Users,
} from 'lucide-react';
import { Badge } from '@renderer/components/ui';
import styles from './ActionPreview.module.css';

type ChipGroup = 'where' | 'audience' | 'afterwards' | 'risk';

// Blast-radius chips are descriptive context, not an alarm. They all share one
// calm, token-based treatment (Badge `muted`) so the surface reads as a quiet
// summary rather than a colour-coded warning console. The contextual icon is
// what differentiates the facets; severity is communicated in the plain-language
// "Why Rebel paused" copy, not by chip colour.
interface BlastRadiusVisualConfig {
  icon: LucideIcon;
  variant: 'muted';
}

function includes(label: string, query: string): boolean {
  return label.toLowerCase().includes(query);
}

function resolveAudienceConfig(label: string): BlastRadiusVisualConfig {
  if (includes(label, 'private')) return { icon: Lock, variant: 'muted' };
  if (includes(label, 'public')) return { icon: Globe, variant: 'muted' };
  if (includes(label, 'company') || includes(label, 'shared') || includes(label, 'just ') || includes(label, 'recipient')) {
    return { icon: Users, variant: 'muted' };
  }
  return { icon: HelpCircle, variant: 'muted' };
}

function resolveAfterwardsConfig(label: string): BlastRadiusVisualConfig {
  if (includes(label, 'hard to undo')) return { icon: AlertTriangle, variant: 'muted' };
  if (includes(label, 'can edit')) return { icon: RefreshCw, variant: 'muted' };
  if (includes(label, 'runs once')) return { icon: Clock3, variant: 'muted' };
  if (includes(label, 'runs on your device')) return { icon: Monitor, variant: 'muted' };
  return { icon: Clock3, variant: 'muted' };
}

function resolveRiskConfig(label: string): BlastRadiusVisualConfig {
  if (includes(label, 'leaves rebel')) return { icon: Globe, variant: 'muted' };
  if (includes(label, 'hard to undo')) return { icon: AlertTriangle, variant: 'muted' };
  if (includes(label, 'shared')) return { icon: Users, variant: 'muted' };
  return { icon: HelpCircle, variant: 'muted' };
}

function resolveConfig(group: ChipGroup, label: string): BlastRadiusVisualConfig {
  if (group === 'where') {
    if (label.startsWith('#')) return { icon: Hash, variant: 'muted' };
    if (includes(label, 'device')) return { icon: Monitor, variant: 'muted' };
    return { icon: MapPin, variant: 'muted' };
  }

  if (group === 'audience') return resolveAudienceConfig(label);
  if (group === 'afterwards') return resolveAfterwardsConfig(label);
  return resolveRiskConfig(label);
}

export interface BlastRadiusChipProps {
  label: string;
  group: ChipGroup;
  testId?: string;
}

export const BlastRadiusChip = ({ label, group, testId }: BlastRadiusChipProps) => {
  const { icon: Icon, variant } = resolveConfig(group, label);

  return (
    <Badge
      variant={variant}
      size="sm"
      className={styles.blastRadiusChip}
      data-testid={testId}
    >
      <Icon size={12} aria-hidden />
      <span>{label}</span>
    </Badge>
  );
};
