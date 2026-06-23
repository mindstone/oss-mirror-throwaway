import { z } from 'zod';

// ── Plugin Export ────────────────────────────────────────────────────────────

export const PluginExportRequestSchema = z.object({
  pluginId: z.string(),
});
export type PluginExportRequest = z.infer<typeof PluginExportRequestSchema>;

export const PluginExportResultSchema = z.object({
  ok: z.boolean(),
  filePath: z.string().optional(),
  error: z.string().optional(),
});
export type PluginExportResult = z.infer<typeof PluginExportResultSchema>;

// ── Plugin Import ────────────────────────────────────────────────────────────

export const PluginImportResultSchema = z.object({
  ok: z.boolean(),
  manifest: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    version: z.string().optional(),
    forkedFrom: z.string().optional(),
    documentation: z.string().optional(),
    createdBy: z.string().optional(),
    changelog: z.array(z.object({
      version: z.string(),
      date: z.string(),
      author: z.string(),
      summary: z.string(),
    })).optional(),
    contributors: z.array(z.string()).optional(),
  }).optional(),
  source: z.string().optional(),
  error: z.string().optional(),
});
export type PluginImportResult = z.infer<typeof PluginImportResultSchema>;
