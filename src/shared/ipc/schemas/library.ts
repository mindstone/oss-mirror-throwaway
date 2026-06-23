import { z } from 'zod';

/** File node returned by workspace list operations */
const FileNodeUnavailableReasonSchema = z.enum(['realpath-failed', 'listdir-failed']);
export type FileNodeUnavailableReason = z.infer<typeof FileNodeUnavailableReasonSchema>;

interface FileNode {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  children?: FileNode[];
  /** Modification time in milliseconds since epoch. Mirrors `FileNode` in src/shared/types/agent.ts. */
  mtime?: number;
  unavailable?: FileNodeUnavailableReason;
}

export const FileNodeSchema: z.ZodType<FileNode> = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['file', 'directory']),
  children: z.lazy(() => z.array(FileNodeSchema)).optional(),
  mtime: z.number().optional(),
  unavailable: FileNodeUnavailableReasonSchema.optional(),
});
export type { FileNode };

/**
 * Reason the workspace file tree was truncated by a producer budget.
 * Kept in lockstep with `FileTreeTruncationReason` in
 * `src/core/services/workspace/fileTreeService.ts`.
 */
export const FileTreeTruncationReasonSchema = z.enum([
  'global-node-cap',
  'global-byte-cap',
  'per-directory-cap',
  'depth',
  // A node (root or descendant) could not be listed/resolved; the tree no
  // longer fully represents the workspace, so completeness is false.
  'unavailable',
]);
export type FileTreeTruncationReason = z.infer<typeof FileTreeTruncationReasonSchema>;

/**
 * Metadata travelling WITH the file tree so no consumer can observe the tree
 * without observing whether it is complete (the Bug-2 safety invariant —
 * docs/plans/260616_stuck-library-renderer-oom/PLAN.md). `truncated` is true
 * only when an otherwise-eligible node/child was declined by a budget;
 * `complete === !truncated`.
 */
export const FileTreeMetadataSchema = z.object({
  complete: z.boolean(),
  truncated: z.boolean(),
  reasons: z.array(FileTreeTruncationReasonSchema),
  returnedNodes: z.number(),
  nodeLimit: z.number(),
  estimatedBytes: z.number(),
  byteLimit: z.number(),
  /** Count of nodes (root or descendant) that could not be listed/resolved. */
  unavailableNodes: z.number(),
});
export type FileTreeMetadata = z.infer<typeof FileTreeMetadataSchema>;

/**
 * Wrapper response for `library:list-files` — the tree plus completeness
 * metadata. Replaced the bare `z.array(FileNodeSchema)` so a silent partial
 * tree is unrepresentable downstream.
 */
export const LibraryListFilesResponseSchema = z.object({
  nodes: z.array(FileNodeSchema),
  metadata: FileTreeMetadataSchema,
});
export type LibraryListFilesResponse = z.infer<typeof LibraryListFilesResponseSchema>;

/** Google Drive link schema */
export const GoogleDriveLinkSchema = z.object({
  driveName: z.string(),
  sourcePath: z.string(),
  symlinkPath: z.string(),
  createdAt: z.number(),
});
export type GoogleDriveLink = z.infer<typeof GoogleDriveLinkSchema>;

/** Space type schema - determines the template used and routing behavior */
export const SpaceTypeSchema = z.enum(['chief-of-staff', 'personal', 'company', 'team', 'project', 'operator', 'other']);
export type SpaceType = z.infer<typeof SpaceTypeSchema>;

/** Space sharing level schema - determines who can access the space. Accepts 'team' for backward compat but normalizes to 'restricted'. */
export const SpaceSharingLevelSchema = z.enum(['private', 'restricted', 'team', 'company-wide', 'public']);
export type SpaceSharingLevel = z.infer<typeof SpaceSharingLevelSchema>;

/** Storage provider for symlinked spaces */
export const SpaceStorageProviderSchema = z.enum(['google_drive', 'onedrive', 'dropbox', 'box', 'icloud', 'local', 'other']);
export type SpaceStorageProvider = z.infer<typeof SpaceStorageProviderSchema>;

/** Provider identifier as sent by the backend config endpoint */
export const SharedDriveProviderSchema = z.enum(['google-drive', 'onedrive', 'dropbox']);
export type SharedDriveProvider = z.infer<typeof SharedDriveProviderSchema>;

/** Request schema for resolving shared folder paths */
export const ResolveSharedFoldersRequestSchema = z.object({
  provider: SharedDriveProviderSchema,
  folderNames: z.array(z.string()),
});
export type ResolveSharedFoldersRequest = z.infer<typeof ResolveSharedFoldersRequestSchema>;

/** Response schema for resolved shared folders */
export const ResolveSharedFoldersResponseSchema = z.object({
  folders: z.array(z.object({
    name: z.string(),
    sourcePath: z.string(),
    exists: z.boolean(),
  })),
});
export type ResolveSharedFoldersResponse = z.infer<typeof ResolveSharedFoldersResponseSchema>;

/** Space configuration schema - replaces GoogleDriveLink with richer structure */
export const SpaceConfigSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: SpaceTypeSchema,
  isSymlink: z.boolean(),
  sourcePath: z.string().optional(),
  storageProvider: SpaceStorageProviderSchema.optional(),
  companyName: z.string().optional(),
  sharing: SpaceSharingLevelSchema.optional(),
  createdAt: z.number(),
  hasReadme: z.boolean().optional(),
  description: z.string().optional(),
  /**
   * User-local account associations for this space.
   * Undefined preserves legacy README `emails` behavior; [] is explicit local none.
   */
  associatedAccounts: z.array(z.string()).optional(),
  /** Whether the space directory is writable. true = writable, false = read-only, undefined = not yet checked */
  writable: z.boolean().optional(),
});
export type SpaceConfig = z.infer<typeof SpaceConfigSchema>;

/** Space status - whether the space configuration is valid */
export const SpaceStatusSchema = z.enum(['ok', 'needs_attention']);
export type SpaceStatus = z.infer<typeof SpaceStatusSchema>;

/**
 * Per-space cloud SYNC health — DISTINCT from `status` (config health).
 * `status` = "is the frontmatter/README valid"; `syncStatus` = "is the cloud mount
 * behind this space reachable". An orthogonal axis (Stage 8, 260619_cloud-symlink-
 * indexing). `healthy` is the default (and the only value for local spaces / with
 * the experimental cloud-symlink-indexing flag OFF), so a non-cloud space — and the
 * whole product with the flag off — renders exactly as before (inert).
 *  - `healthy`      — mount reachable (or not a cloud space) ⇒ no signal.
 *  - `reconnecting` — mount timing out / flapping / not-yet-probed; last-known files
 *    retained, auto-recovers.
 *  - `not_found`    — the linked folder is structurally gone (dangling symlink);
 *    NOT a transient outage, so no recovery is promised.
 * Mirrors `SpaceSyncStatus` in `src/core/services/cloudSymlinkIndexing.ts`.
 */
export const SpaceSyncStatusSchema = z.enum(['healthy', 'reconnecting', 'not_found']);
export type SpaceSyncStatus = z.infer<typeof SpaceSyncStatusSchema>;

/** Space info schema - detailed space information returned by scan operations */
export const SpaceInfoSchema = z.object({
  name: z.string(),
  path: z.string(),
  absolutePath: z.string(),
  type: SpaceTypeSchema,
  isSymlink: z.boolean(),
  hasReadme: z.boolean(),
  /** True if space has legacy AGENTS.md (but no README.md) - should offer rename */
  hasLegacyAgentsMd: z.boolean().optional(),
  /** True if space has BOTH README.md and AGENTS.md - needs manual resolution */
  hasBothConfigFiles: z.boolean().optional(),
  sourcePath: z.string().optional(),
  description: z.string().optional(),
  /** Custom display name from frontmatter (e.g., "Mindstone - Exec") */
  displayName: z.string().optional(),
  /** Organisation name from frontmatter (e.g., "Mindstone") */
  organisationName: z.string().optional(),
  sharing: z.string().optional(),
  memoryTrust: z.enum(['always_ask', 'balanced', 'always_write']).optional(),
  /** Configuration status - 'ok' if valid, 'needs_attention' if broken/missing frontmatter */
  status: SpaceStatusSchema.default('ok'),
  /** Error message when status is 'needs_attention' */
  statusMessage: z.string().optional(),
  /**
   * Cloud SYNC health (Stage 8) — distinct from `status` (config health). Defaults
   * to 'healthy' so local spaces / a flag-off build carry no signal (inert). Only an
   * ADMITTED cloud space gets a non-'healthy' value.
   */
  syncStatus: SpaceSyncStatusSchema.optional(),
  /** Last reviewed date for personal goals (Chief-of-Staff only). Format: YYYY-MM-DD */
  goalsLastReviewed: z.string().optional(),
  /** Last reviewed date for company values. Format: YYYY-MM-DD */
  valuesLastReviewed: z.string().optional(),
  /** Associated email accounts for this Space (e.g., 'you@example.com', 'company.com' for domain wildcard) */
  emails: z.array(z.string()).optional(),
  /** User-local associated accounts from settings; not read from shared README frontmatter */
  associatedAccounts: z.array(z.string()).optional(),
  /** Whether the space directory is writable. true = writable, false = read-only, undefined = not yet checked */
  writable: z.boolean().optional(),
});
export type SpaceInfo = z.infer<typeof SpaceInfoSchema>;

/** Readiness level for suggested spaces */
export const SuggestionReadinessSchema = z.enum(['ready', 'needs_configuration', 'not_configured']);
export type SuggestionReadiness = z.infer<typeof SuggestionReadinessSchema>;

/** Suggested space info - extends SpaceInfo with readiness indicators */
export const SuggestedSpaceInfoSchema = SpaceInfoSchema.extend({
  /** Readiness level: ready (has frontmatter), needs_configuration (has structure), not_configured (empty) */
  readiness: SuggestionReadinessSchema,
  /** What was detected in this folder (e.g., "Has memory/ folder", "Has README.md") */
  indicators: z.array(z.string()),
  /** User-facing hint explaining the state */
  hint: z.string(),
});
export type SuggestedSpaceInfo = z.infer<typeof SuggestedSpaceInfoSchema>;

/** Create space options schema */
export const CreateSpaceOptionsSchema = z.object({
  name: z.string(),
  type: SpaceTypeSchema,
  location: z.enum(['workspace', 'symlink']),
  sourcePath: z.string().optional(),
  targetPath: z.string().optional(),
  companyName: z.string().optional(),
  organisation: z.string().optional(),
  sharing: SpaceSharingLevelSchema.optional(),
  storageProvider: SpaceStorageProviderSchema.optional(),
  /** Description for the space (will be written to README frontmatter) */
  description: z.string().optional(),
  /** Whether to create standard subfolders (memory, skills, scripts). Defaults to true. */
  createSubfolders: z.boolean().optional(),
  /** Which subfolders to create (only used if createSubfolders is true) */
  selectedSubfolders: z.array(z.string()).optional(),
  /** Memory trust level for the space (undefined = use global setting) */
  memoryTrust: z.enum(['always_ask', 'balanced', 'always_write']).optional(),
  /**
   * Skip writing frontmatter to README.md. Used when adding an existing space
   * that already has frontmatter (from another user or previous setup).
   */
  skipFrontmatterWrite: z.boolean().optional(),
  /** Associated email accounts for this Space (e.g., 'you@example.com', 'company.com' for domain wildcard) */
  emails: z.array(z.string()).optional(),
  /**
   * User-local associated accounts to persist in settings.
   * Undefined means no local decision; [] means explicit local none.
   */
  associatedAccounts: z.array(z.string()).optional(),
});
export type CreateSpaceOptions = z.infer<typeof CreateSpaceOptionsSchema>;

/** Inferred category for path analysis */
export const InferredCategorySchema = z.enum(['personal', 'work', 'unknown']);
export type InferredCategory = z.infer<typeof InferredCategorySchema>;

/** Path analysis error types */
export const PathAnalysisErrorSchema = z.enum(['permission_denied', 'not_found', 'unknown_error']);
export type PathAnalysisError = z.infer<typeof PathAnalysisErrorSchema>;

/**
 * Path validation issue types for space creation.
 * Grouped by severity: errors (blocking) and warnings (advisory).
 */
export const PathValidationIssueTypeSchema = z.enum([
  // Basic structural issues (blocking errors)
  'path_is_file',           // Selected a file, not a directory

  // Dangerous paths (blocking errors)
  'root_filesystem',        // / or any drive root (C:\, D:\, etc.)
  'home_directory',         // ~ or /Users/username
  'system_folder',          // /System, /Library, C:\Windows, etc.
  'temp_directory',         // /tmp, /var/folders, %TEMP%
  'app_data_directory',     // Rebel's own userData folder (corruption risk)
  'trash_directory',        // macOS Trash, Windows Recycle Bin

  // Already-managed paths (blocking errors)
  'is_core_directory',      // The coreDirectory itself
  'inside_core_directory',  // Subfolder of coreDirectory (would create nested space)
  'is_chief_of_staff',      // Chief-of-Staff folder
  'is_existing_space',      // Already a space (has README.md with rebel_space_description)
  'space_structure_folder', // Selected skills/, memory/, scripts/ inside a space (mis-click)
  'subfolder_of_space',     // Inside an existing space
  'parent_of_space',        // Would contain existing space(s) - WARNING not error

  // Cloud storage issues (warnings or errors)
  'cloud_storage_root',     // Cloud account root without deeper path
  'shared_drives_root',     // Shared Drives/ without selecting specific drive
  'cloud_storage_offline_recommended', // Cloud storage folder should be kept offline for performance

  // Permission/structural issues
  'permission_denied',      // Existing error type
  'not_found',              // Existing error type
  'symlink_broken',         // Symlink points to non-existent path
]);
export type PathValidationIssueType = z.infer<typeof PathValidationIssueTypeSchema>;

/** Path validation issue with severity and user-friendly message */
export const PathValidationIssueSchema = z.object({
  type: PathValidationIssueTypeSchema,
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  suggestion: z.string().optional(),
});
export type PathValidationIssue = z.infer<typeof PathValidationIssueSchema>;

/**
 * Existing frontmatter schema - lightweight snapshot of frontmatter detected in a folder.
 * Used when a user selects a folder that already has README.md with rebel_space_description.
 * This is NOT a full SpaceInfo - it's just the frontmatter fields we can extract.
 */
export const ExistingFrontmatterSchema = z.object({
  /** rebel_space_description from frontmatter */
  description: z.string().optional(),
  /** space_type from frontmatter */
  space_type: SpaceTypeSchema.optional(),
  /** sharing from frontmatter */
  sharing: SpaceSharingLevelSchema.optional(),
  /** memoryTrust from frontmatter */
  memoryTrust: z.enum(['always_ask', 'balanced', 'always_write']).optional(),
  /** organisation_name from frontmatter */
  organisation_name: z.string().optional(),
  /** Associated email accounts */
  emails: z.array(z.string()).optional(),
});
export type ExistingFrontmatter = z.infer<typeof ExistingFrontmatterSchema>;

/** Analyze path request schema */
export const AnalyzePathRequestSchema = z.object({
  path: z.string(),
});
export type AnalyzePathRequest = z.infer<typeof AnalyzePathRequestSchema>;

/** Analyze path response schema */
export const AnalyzePathResponseSchema = z.object({
  storageProvider: SpaceStorageProviderSchema,
  inferredSharing: SpaceSharingLevelSchema,
  inferredCategory: InferredCategorySchema,
  error: PathAnalysisErrorSchema.optional(),
  /** Structured validation issues (errors and warnings) for the path */
  validationIssues: z.array(PathValidationIssueSchema).optional(),
  /** False if any error-severity issues exist. True or undefined means valid. */
  isValid: z.boolean().optional(),
  /** True if the path is inside the configured coreDirectory. False means external (needs symlink). */
  isInsideWorkspace: z.boolean().optional(),
  /** For internal paths, the path relative to coreDirectory (e.g., 'work/Mindstone/General'). */
  workspaceRelativePath: z.string().optional(),
  /** True if the folder has README.md with rebel_space_description frontmatter (already a space). */
  hasExistingFrontmatter: z.boolean().optional(),
  /** Frontmatter extracted from existing README.md, if detected. Enables 'add-existing' wizard mode. */
  existingFrontmatter: ExistingFrontmatterSchema.optional(),
});
export type AnalyzePathResponse = z.infer<typeof AnalyzePathResponseSchema>;

/** Generate space description request schema */
export const GenerateSpaceDescriptionRequestSchema = z.object({
  path: z.string(),
});
export type GenerateSpaceDescriptionRequest = z.infer<typeof GenerateSpaceDescriptionRequestSchema>;

/** Description generation status */
export const DescriptionGenerationStatusSchema = z.enum(['success', 'timeout', 'error']);
export type DescriptionGenerationStatus = z.infer<typeof DescriptionGenerationStatusSchema>;

/** Description source indicating how the description was generated */
export const DescriptionSourceSchema = z.enum(['haiku', 'readme', 'fallback']);
export type DescriptionSource = z.infer<typeof DescriptionSourceSchema>;

/** Generate space description response schema */
export const GenerateSpaceDescriptionResponseSchema = z.object({
  description: z.string(),
  source: DescriptionSourceSchema,
  status: DescriptionGenerationStatusSchema,
});
export type GenerateSpaceDescriptionResponse = z.infer<typeof GenerateSpaceDescriptionResponseSchema>;

/** Check symlink request schema */
export const CheckSymlinkRequestSchema = z.object({
  path: z.string(),
});
export type CheckSymlinkRequest = z.infer<typeof CheckSymlinkRequestSchema>;

/** Check symlink response schema */
export const CheckSymlinkResponseSchema = z.object({
  isSymlink: z.boolean(),
  target: z.string().optional(),
});
export type CheckSymlinkResponse = z.infer<typeof CheckSymlinkResponseSchema>;

/** Subfolder creation error schema */
export const SubfolderCreationErrorSchema = z.object({
  path: z.string(),
  error: z.string(),
});
export type SubfolderCreationError = z.infer<typeof SubfolderCreationErrorSchema>;

/** Create subfolders request schema */
export const CreateSubfoldersRequestSchema = z.object({
  basePath: z.string(),
  subfolders: z.array(z.string()),
});
export type CreateSubfoldersRequest = z.infer<typeof CreateSubfoldersRequestSchema>;

/** Create subfolders response schema */
export const CreateSubfoldersResponseSchema = z.object({
  created: z.array(z.string()),
  errors: z.array(SubfolderCreationErrorSchema),
});
export type CreateSubfoldersResponse = z.infer<typeof CreateSubfoldersResponseSchema>;

/** Normalize paths request schema - batch convert real paths to workspace-relative paths */
export const NormalizePathsRequestSchema = z.object({
  paths: z.array(z.string()),
});
export type NormalizePathsRequest = z.infer<typeof NormalizePathsRequestSchema>;

/** Normalize paths response schema */
export const NormalizePathsResponseSchema = z.object({
  /** Map of input path -> normalized workspace-relative path (or original if can't be normalized) */
  normalized: z.record(z.string(), z.string()),
});
export type NormalizePathsResponse = z.infer<typeof NormalizePathsResponseSchema>;

/** Shared skill target shape from shared-skill path classification. */
export { SharedSkillTargetSchema } from '@rebel/shared';
export type { SharedSkillTarget } from '@rebel/shared';
