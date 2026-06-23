import { ShieldCheck, ShieldBan, Layers, Target, type LucideIcon } from 'lucide-react';
import type { PrincipleOptionScope } from '../../../core/safetyPromptTypes';

export const SCOPE_LABELS: Record<PrincipleOptionScope, { label: string; icon: LucideIcon }> = {
  trusted_tool: { label: 'Always', icon: ShieldCheck },
  broad: { label: 'Similar', icon: Layers },
  specific: { label: 'This only', icon: Target },
};

export const DENY_SCOPE_LABELS: Record<PrincipleOptionScope, { label: string; icon: LucideIcon }> = {
  trusted_tool: { label: 'Always block', icon: ShieldBan },
  broad: { label: 'Similar', icon: Layers },
  specific: { label: 'This only', icon: Target },
};
