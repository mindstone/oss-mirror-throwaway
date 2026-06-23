import { z } from 'zod';
import { defineInvokeChannel, SystemHealthReportSchema, HealthCheckTierSchema } from '../schemas';

// =============================================================================
// Workspace Access Validation Schemas
// =============================================================================

export const ValidateWorkspaceAccessRequestSchema = z.object({
  path: z.string(),
  createIfMissing: z.boolean().optional(),
});
export type ValidateWorkspaceAccessRequest = z.infer<typeof ValidateWorkspaceAccessRequestSchema>;

export const ValidateWorkspaceAccessResponseSchema = z.object({
  accessible: z.boolean(),
  code: z.string().optional(),
  error: z.string().optional(),
  resolvedPath: z.string().optional(),
  created: z.boolean().optional(),
});
export type ValidateWorkspaceAccessResponse = z.infer<typeof ValidateWorkspaceAccessResponseSchema>;

// =============================================================================
// Safe Mode Diagnostics Schemas
// =============================================================================

const StoreCheckResultSchema = z.object({
  exists: z.boolean(),
  readable: z.boolean(),
  validJson: z.boolean(),
  sizeBytes: z.number(),
  preview: z.string().optional(),
  error: z.string().optional(),
});

const DiagnosticIssueSchema = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  code: z.string(),
  message: z.string(),
  suggestedFix: z.string().optional(),
});

export const SafeModeDiagnosticResultSchema = z.object({
  status: z.enum(['healthy', 'issues_found', 'check_failed']),
  timestamp: z.string(),
  userDataPath: z.string(),
  checks: z.object({
    settingsStore: StoreCheckResultSchema,
    sessionIndex: StoreCheckResultSchema,
    inboxStore: StoreCheckResultSchema,
    mcpRouterConfig: StoreCheckResultSchema,
    logsAccessible: z.boolean(),
  }),
  issues: z.array(DiagnosticIssueSchema),
  suggestedActions: z.array(z.string()),
  recentLogErrors: z.array(z.string()),
});

export type SafeModeDiagnosticResult = z.infer<typeof SafeModeDiagnosticResultSchema>;

// Diagnostic codes for preflight issues - machine-readable for future localization
export const PreflightDiagnosticCodeSchema = z.enum([
  // Git-related
  'GIT_BUNDLED_MISSING',      // Bundled Git not found (likely AV quarantine during install)
  'GIT_BUNDLED_BLOCKED',      // Bundled Git found but execution blocked (AV real-time protection)
  'GIT_SYSTEM_NOT_INSTALLED', // No system Git installation found
  'GIT_BASH_MISSING',         // Git installed but bash.exe component missing
  'GIT_EXECUTION_TIMEOUT',    // Git found but execution timed out
  // Generic
  'UNKNOWN',
]);
export type PreflightDiagnosticCode = z.infer<typeof PreflightDiagnosticCodeSchema>;

// Schema for individual pre-flight issues
export const PreflightIssueSchema = z.object({
  id: z.string(),
  category: z.enum(['network', 'storage', 'permissions', 'system']),
  title: z.string(),
  description: z.string(),
  severity: z.enum(['blocker', 'warning']),
  remediation: z.string().optional(),
  canRetry: z.boolean(),
  actionType: z.enum(['open-folder', 'open-settings', 'open-url', 'retry-only']).optional(),
  actionPath: z.string().optional(),
  // Enhanced diagnostics for user feedback
  diagnosticCode: PreflightDiagnosticCodeSchema.optional(),
  diagnosticHint: z.string().optional(), // User-friendly explanation of what went wrong
});
export type PreflightIssue = z.infer<typeof PreflightIssueSchema>;

// Schema for pre-flight check result
export const PreflightResultSchema = z.object({
  canProceed: z.boolean(),
  issues: z.array(PreflightIssueSchema),
  checkDurationMs: z.number(),
});
export type PreflightResult = z.infer<typeof PreflightResultSchema>;

export const HeapSnapshotCaptureRequestSchema = z.object({
  trigger: z.enum(['manual', 'watchdog']),
  label: z.string().optional(),
});
export type HeapSnapshotCaptureRequest = z.infer<typeof HeapSnapshotCaptureRequestSchema>;

export const HeapSnapshotCaptureResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('captured'),
    path: z.string(),
    metaPath: z.string(),
    rendererWorkingSetMB: z.number().optional(),
    snapshotFileBytes: z.number(),
    durationMs: z.number(),
  }),
  z.object({
    status: z.literal('skipped_no_window'),
    error: z.string(),
  }),
  z.object({
    status: z.literal('skipped_low_disk'),
    error: z.string(),
    freeBytes: z.number(),
    requiredFreeBytes: z.number(),
    rendererWorkingSetMB: z.number().optional(),
  }),
  z.object({
    status: z.literal('failed'),
    error: z.string(),
  }),
]);
export type HeapSnapshotCaptureResponse = z.infer<typeof HeapSnapshotCaptureResponseSchema>;

export const systemHealthChannels = {
  'system:validate-workspace-access': defineInvokeChannel({
    channel: 'system:validate-workspace-access',
    request: ValidateWorkspaceAccessRequestSchema,
    response: ValidateWorkspaceAccessResponseSchema,
    description: 'Validate that a workspace path is accessible and optionally create it if missing',
  }),

  'system:preflight-check': defineInvokeChannel({
    channel: 'system:preflight-check',
    request: z.void(),
    response: PreflightResultSchema,
    description: 'Run pre-flight checks before onboarding to catch critical system issues early',
  }),

  'system:health-check': defineInvokeChannel({
    channel: 'system:health-check',
    request: z.object({
      tier: HealthCheckTierSchema.optional(),
    }),
    response: SystemHealthReportSchema,
    description: 'Run system health check and return diagnostic report',
  }),

  'system:health-export': defineInvokeChannel({
    channel: 'system:health-export',
    request: z.void(),
    response: z.object({
      markdown: z.string(),
    }),
    description: 'Generate shareable markdown health report',
  }),

  'system:health-export-with-logs': defineInvokeChannel({
    channel: 'system:health-export-with-logs',
    request: z.object({
      logWindowMinutes: z.number().optional(),
    }),
    response: z.object({
      content: z.string(),
      filename: z.string(),
    }),
    description: 'Generate diagnostic bundle with health report and recent application logs',
  }),

  'system:health-export-zip': defineInvokeChannel({
    channel: 'system:health-export-zip',
    request: z.object({
      logWindowMinutes: z.number().optional(),
    }).optional(),
    response: z.object({
      success: z.boolean(),
      data: z.instanceof(ArrayBuffer).optional(),
      filename: z.string().optional(),
      error: z.string().optional(),
      // Additive, back-compat (absent = full bundle). `partial` = the minimal
      // fallback (or a bundle with timed-out sections) was returned;
      // `unavailableSections` lists sections that hit a collector deadline so
      // the renderer can tell the user the bundle is incomplete.
      partial: z.boolean().optional(),
      unavailableSections: z.array(z.string()).optional(),
    }),
    description: 'Generate enhanced diagnostic ZIP bundle with structured JSON files for agent-assisted debugging',
  }),

  'system:preflight-open-path': defineInvokeChannel({
    channel: 'system:preflight-open-path',
    request: z.string(),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Open a folder path in the system file explorer',
  }),

  'system:safe-mode-diagnostics': defineInvokeChannel({
    channel: 'system:safe-mode-diagnostics',
    request: z.void(),
    response: SafeModeDiagnosticResultSchema,
    description: 'Run read-only diagnostic checks on electron-store files (works in Safe Mode)',
  }),

  // Performance tracing
  'system:perf-tracing-start': defineInvokeChannel({
    channel: 'system:perf-tracing-start',
    request: z.object({
      categories: z.array(z.string()).optional(),
      preset: z.enum(['lightweight', 'full', 'startup', 'ipc', 'memory', 'gpu', 'interaction']).optional(),
      durationMs: z.number().optional(),
    }).optional(),
    response: z.object({
      success: z.boolean(),
      isActive: z.boolean(),
    }),
    description: 'Start Chromium content tracing for performance profiling',
  }),

  'system:perf-tracing-stop': defineInvokeChannel({
    channel: 'system:perf-tracing-stop',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      tracePath: z.string().nullable(),
    }),
    description: 'Stop tracing and save trace file (opens folder in file explorer)',
  }),

  'system:perf-tracing-status': defineInvokeChannel({
    channel: 'system:perf-tracing-status',
    request: z.void(),
    response: z.object({
      isActive: z.boolean(),
    }),
    description: 'Check if performance tracing is currently active',
  }),

  'system:perf-renderer-profile': defineInvokeChannel({
    channel: 'system:perf-renderer-profile',
    request: z.object({
      durationMs: z.number().optional(),
    }).optional(),
    response: z.object({
      status: z.enum(['captured', 'skipped_debugger_attached', 'skipped_no_window', 'failed']),
      path: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Capture a renderer CPU profile via CDP (dev:perf only)',
  }),

  'system:heap-snapshot-capture': defineInvokeChannel({
    channel: 'system:heap-snapshot-capture',
    request: HeapSnapshotCaptureRequestSchema,
    response: HeapSnapshotCaptureResponseSchema,
    description: 'Capture a renderer V8 heap snapshot (REBEL_PERF_MODE only)',
  }),

  'system:perf-summary': defineInvokeChannel({
    channel: 'system:perf-summary',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      summaryPath: z.string().nullable(),
      error: z.string().optional(),
    }),
    description: 'Generate a consolidated dev performance summary report',
  }),
} as const;
