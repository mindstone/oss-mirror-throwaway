import { z } from 'zod';

export const DIAGNOSTIC_SECTION_IDS = [
  'provider_reachability',
  'health_timing',
  'index_health',
  'pre_turn_worker',
  'auto_update_forensics',
  'settings_drift',
  'cost_summary',
  'continuity_trail',
  'recent_events',
  'recent_logs',
] as const;

export const SectionIdSchema = z.enum(DIAGNOSTIC_SECTION_IDS);
export type SectionId = z.infer<typeof SectionIdSchema>;

export const SectionStateSchema = z.enum([
  'included',
  'omitted_by_user_toggle',
  'omitted_by_option',
  'unavailable',
  'reader_unavailable',
  'empty',
]);
export type SectionState = z.infer<typeof SectionStateSchema>;

export const DiagnosticSectionsSchema = z.partialRecord(SectionIdSchema, z.boolean());
export type DiagnosticSections = z.infer<typeof DiagnosticSectionsSchema>;

export interface DiagnosticSectionDescriptor {
  id: SectionId;
  label: string;
  description: string;
  privacyHint: string;
}

export const DIAGNOSTIC_SECTION_DESCRIPTORS: readonly DiagnosticSectionDescriptor[] = [
  {
    id: 'provider_reachability',
    label: 'Provider reachability',
    description: 'Connection checks for AI providers and cloud services.',
    privacyHint: 'No prompts or responses.',
  },
  {
    id: 'health_timing',
    label: 'Health timing',
    description: 'Slow or failing health checks from recent app activity.',
    privacyHint: 'Technical status only.',
  },
  {
    id: 'index_health',
    label: 'Index health',
    description: 'Embedding and search-index readiness signals.',
    privacyHint: 'No document text.',
  },
  {
    id: 'pre_turn_worker',
    label: 'Pre-turn worker',
    description: 'Worker startup, crash, and timing snapshots.',
    privacyHint: 'Process metadata only.',
  },
  {
    id: 'auto_update_forensics',
    label: 'Update forensics',
    description: 'Recent app update state and installer breadcrumbs.',
    privacyHint: 'No personal content.',
  },
  {
    id: 'settings_drift',
    label: 'Settings drift',
    description: 'Observed desktop, cloud, and mobile settings differences.',
    privacyHint: 'Values are redacted.',
  },
  {
    id: 'cost_summary',
    label: 'Cost summary',
    description: 'Recent API spend grouped by outcome.',
    privacyHint: 'No message content.',
  },
  {
    id: 'continuity_trail',
    label: 'Continuity trail',
    description: 'Sync, outbox, and session continuity snapshots.',
    privacyHint: 'Identifiers are hashed.',
  },
  {
    id: 'recent_events',
    label: 'Recent events',
    description: 'Recent diagnostic ledger entries for triage.',
    privacyHint: 'Redaction-safe enums.',
  },
  {
    id: 'recent_logs',
    label: 'Recent logs',
    description: 'Recent warnings and errors from the app.',
    privacyHint: 'Logs are filtered and redacted.',
  },
];

export const DEFAULT_DIAGNOSTIC_SECTIONS: Record<SectionId, boolean> =
  Object.fromEntries(DIAGNOSTIC_SECTION_IDS.map((id) => [id, true])) as Record<SectionId, boolean>;

export interface DiagnosticSectionOptions {
  diagnosticSections?: Partial<Record<SectionId, boolean>>;
  includeEnrichedDiagnostics?: boolean;
  attachContinuityDiagnostics?: boolean;
}

export interface DiagnosticSectionResolution {
  enabled: boolean;
  omittedState?: Extract<SectionState, 'omitted_by_user_toggle' | 'omitted_by_option'>;
}

export function resolveDiagnosticSection(
  options: DiagnosticSectionOptions | undefined,
  sectionId: SectionId,
): DiagnosticSectionResolution {
  if (options?.diagnosticSections && Object.prototype.hasOwnProperty.call(options.diagnosticSections, sectionId)) {
    return options.diagnosticSections[sectionId] === false
      ? { enabled: false, omittedState: 'omitted_by_user_toggle' }
      : { enabled: true };
  }

  const legacyEnabled = options?.includeEnrichedDiagnostics !== false || options?.attachContinuityDiagnostics === true;
  if (!legacyEnabled) {
    return { enabled: false, omittedState: 'omitted_by_option' };
  }

  return { enabled: true };
}

export function defaultDiagnosticSectionStates(
  state: SectionState = 'empty',
): Record<SectionId, SectionState> {
  return Object.fromEntries(DIAGNOSTIC_SECTION_IDS.map((id) => [id, state])) as Record<SectionId, SectionState>;
}
