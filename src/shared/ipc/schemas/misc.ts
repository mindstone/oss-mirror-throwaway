import { z } from 'zod';

/** Analytics status payload */
export const AnalyticsStatusPayloadSchema = z.object({
  state: z.enum(['disabled', 'pending', 'healthy', 'error']),
  enabled: z.boolean(),
  error: z.string().nullable().optional(),
});
export type AnalyticsStatusPayload = z.infer<typeof AnalyticsStatusPayloadSchema>;

/** Renderer analytics health payload (pushed from renderer to main for diagnostics) */
export const RendererAnalyticsHealthSchema = z.object({
  state: z.enum(['disabled', 'pending', 'healthy', 'error']),
  enabled: z.boolean(),
  error: z.string().nullable(),
  hasKnownUserId: z.boolean(),
});
export type RendererAnalyticsHealth = z.infer<typeof RendererAnalyticsHealthSchema>;

/** Voice transcription payload */
export const VoiceTranscriptionPayloadSchema = z.object({
  audio: z.instanceof(ArrayBuffer),
  mimeType: z.string(),
});

/** Conversation title transcript entry */
export const ConversationTitleTranscriptEntrySchema = z.object({
  role: z.enum(['user', 'assistant', 'result']),
  text: z.string(),
});

/** Conversation title request payload */
export const ConversationTitleRequestPayloadSchema = z.object({
  sessionId: z.string(),
  transcript: z.array(ConversationTitleTranscriptEntrySchema),
});

/** Attention suggestion schema */
export const AttentionSuggestionSchema = z.object({
  id: z.string(),
  icon: z.string(),
  title: z.string(),
  detail: z.string(),
  iCan: z.string(),
  prompt: z.string(),
  type: z.enum(['email', 'slack', 'teams', 'file', 'generic', 'calendar', 'linear', 'git']).optional(),
  urgency: z.enum(['high', 'medium', 'low']).optional(),
  timestamp: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type AttentionSuggestion = z.infer<typeof AttentionSuggestionSchema>;

/** Runtime config schema */
export const RuntimeConfigSchema = z.object({
  appVersion: z.string(),
  platform: z.string(),
  isPackaged: z.boolean(),
  userData: z.string(),
  logsPath: z.string(),
});

/** Update manifest platform info schema */
export const UpdateManifestPlatformSchema = z.object({
  url: z.string(),
  sha256: z.string().optional(),
  size: z.number().optional(),
  releaseNotesUrl: z.string().optional(),
});

/** Update manifest schema (from latest.json) */
export const UpdateManifestSchema = z.object({
  version: z.string(),
  buildTimestamp: z.string().optional(),
  platforms: z.record(z.string(), UpdateManifestPlatformSchema),
});
export type UpdateManifest = z.infer<typeof UpdateManifestSchema>;

/** Python runtime detection status */
export const PythonRuntimeStatusSchema = z.object({
  /** Primary indicator - uvx is what Python MCPs actually need */
  uvxAvailable: z.boolean(),
  uvxVersion: z.string().nullable(),
  uvxPath: z.string().nullable(),
  /** Secondary info - helpful for debugging but not primary indicator */
  pythonAvailable: z.boolean(),
  pythonVersion: z.string().nullable(),
  pythonPath: z.string().nullable(),
  /** Timestamp for cache invalidation */
  checkedAt: z.number(),
});
export type PythonRuntimeStatus = z.infer<typeof PythonRuntimeStatusSchema>;
