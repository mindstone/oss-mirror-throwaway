/**
 * Plugin Manifest Schema
 *
 * Defines the shape of a plugin manifest and validates it at runtime.
 * Plugins can be registered manually (by Rebel AI writing code) or
 * discovered from workspace files in future stages.
 *
 * @see docs/plans/260322_plugin_extension_system.md
 */

import { z } from 'zod';

export const ChangelogEntrySchema = z.object({
  version: z.string(),
  date: z.string(),
  author: z.string(),
  summary: z.string(),
});

export type ChangelogEntry = z.infer<typeof ChangelogEntrySchema>;

// Single source of truth: shared IPC schema. Avoids independent enum drift.
// See docs/plans/260416_plugin_permissions_followups.md — Stage 1.
import { PluginPermissionIpcSchema } from '@shared/ipc/schemas/plugins';

export const PluginPermissionSchema = PluginPermissionIpcSchema;
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

// ── Param Declarations ──────────────────────────────────────────────────

export const PluginParamSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
});

export type PluginParam = z.infer<typeof PluginParamSchema>;

// ── Surface Declarations ────────────────────────────────────────────────

export const WidgetSizeSchema = z.enum(['small', 'medium', 'large']);
export type WidgetSize = z.infer<typeof WidgetSizeSchema>;

const SidebarSurfaceSchema = z.object({
  enabled: z.boolean().default(true),
});

const HomepageWidgetSurfaceSchema = z.object({
  enabled: z.boolean().default(false),
  defaultSize: WidgetSizeSchema.default('medium'),
});

export const PluginSurfacesSchema = z.object({
  sidebar: SidebarSurfaceSchema.default({ enabled: true }),
  homepageWidget: HomepageWidgetSurfaceSchema.default({ enabled: false, defaultSize: 'medium' }),
});

export type PluginSurfaces = z.infer<typeof PluginSurfacesSchema>;

export const PluginManifestSchema = z.object({
  id: z
    .string()
    .regex(/^(?:__)?[a-z0-9-]+$/, 'Plugin ID must be lowercase alphanumeric with hyphens (optional __ prefix)'),
  name: z.string().min(1),
  description: z.string().optional(),
  documentation: z.string().optional(),
  version: z.string().default('0.1.0'),
  icon: z.string().optional(),
  entryPoint: z.string().min(1),
  maturity: z.enum(['labs', 'stable']).default('labs'),
  /** Tracks which catalog plugin this was forked from */
  forkedFrom: z.string().optional(),
  /** Author identifier (e.g. first name or email hash) — local-only metadata */
  createdBy: z.string().optional(),
  /** Version history with author attribution */
  changelog: z.array(ChangelogEntrySchema).optional(),
  /** List of contributor identifiers */
  contributors: z.array(z.string()).optional(),
  /** ISO timestamp when plugin was archived — if set, plugin is hidden from active lists */
  archivedAt: z.string().optional(),
  permissions: z.array(PluginPermissionSchema).optional().default([]),
  externalDomains: z.array(z.string()).optional().default([]),
  /** Declares which surfaces this plugin renders in. Defaults to sidebar-only for backward compatibility. */
  surfaces: PluginSurfacesSchema.optional().default({ sidebar: { enabled: true }, homepageWidget: { enabled: false, defaultSize: 'medium' } }),
  /** Declares what params this plugin accepts when opened via rebel_plugins_open. For discoverability only — not enforced at runtime. */
  params: z.array(PluginParamSchema).optional(),
  /** Controls where plugin data is stored. 'local' = per-user, 'shared' = in Space directory. Default: 'local'. Independent of where plugin code lives. */
  storageScope: z.enum(['local', 'shared']).default('local').optional(),
  /**
   * Discovery role within a Space. 'hero' marks a plugin as the marquee/featured
   * plugin for its Space (sorted first in the Library Plugins lens with a Hero badge).
   * 'utility' (default) is the standard role for everything else.
   * This is a discovery/sort signal only — it does NOT change render placement, surfaces, or permissions.
   * See docs/plans/260521_plugin_publishing_org_distribution.md (Stage A0).
   */
  role: z.enum(['hero', 'utility']).default('utility'),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export function validateManifest(data: unknown): { ok: true; manifest: PluginManifest } | { ok: false; error: string } {
  const result = PluginManifestSchema.safeParse(data);
  if (result.success) {
    return { ok: true, manifest: result.data };
  }
  const messages = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
  return { ok: false, error: `Invalid plugin manifest: ${messages}` };
}
