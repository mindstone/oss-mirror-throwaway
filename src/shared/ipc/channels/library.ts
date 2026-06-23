import { FileLocationSchema } from '@rebel/shared';
import { z } from 'zod';
import {
  defineInvokeChannel,
  LibraryListFilesResponseSchema,
  GoogleDriveLinkSchema,
  SpaceInfoSchema,
  SuggestedSpaceInfoSchema,
  SpaceTypeSchema,
  SpaceSharingLevelSchema,
  CreateSpaceOptionsSchema,
  AnalyzePathRequestSchema,
  AnalyzePathResponseSchema,
  GenerateSpaceDescriptionRequestSchema,
  GenerateSpaceDescriptionResponseSchema,
  CheckSymlinkRequestSchema,
  CheckSymlinkResponseSchema,
  CreateSubfoldersRequestSchema,
  CreateSubfoldersResponseSchema,
  NormalizePathsRequestSchema,
  NormalizePathsResponseSchema,
  ResolveSharedFoldersRequestSchema,
  ResolveSharedFoldersResponseSchema,
} from '../schemas';

const SkillChangeNotificationSchema = z.object({
  id: z.string(),
  skillName: z.string(),
  skillWorkspacePath: z.string(),
  spacePath: z.string(),
  location: FileLocationSchema.optional(),
  actorLabel: z.string(),
  actorKind: z.enum(['human', 'agent']),
  recipientReason: z.enum(['previous_editor', 'creator_fallback']),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const SkillOutputShapeContractSchema = z.object({
  default_surface: z.enum([
    'chat_summary',
    'chat_answer',
    'file_artifact',
    'interactive_view',
    'expandable_report',
  ]).optional(),
  chat_contract: z.enum([
    'concise_summary',
    'direct_answer',
    'decision_brief',
    'blocker_only',
  ]).optional(),
  artifact_expected: z.boolean().optional(),
  max_chat_words: z.number().int().positive().max(2_000).optional(),
  source_policy: z.enum([
    'inline_key_sources',
    'artifact_sources',
    'none',
  ]).optional(),
}).optional();

export const LibraryChangedSourceSchema = z.enum(['user', 'watcher']);

export const LibraryChangedWriterKindSchema = z.enum([
  'editor',
  'agent',
  'file-watcher',
  'cloud-sync',
]);

export const LibraryChangedEventPayloadSchema = z.object({
  timestamp: z.number(),
  affectsTree: z.boolean(),
  writerKind: LibraryChangedWriterKindSchema.optional(),
  changedPath: z.string().optional(),
  source: LibraryChangedSourceSchema,
});

export type LibraryChangedSource = z.infer<typeof LibraryChangedSourceSchema>;
export type LibraryChangedWriterKind = z.infer<typeof LibraryChangedWriterKindSchema>;
export type LibraryChangedEventPayload = z.infer<typeof LibraryChangedEventPayloadSchema>;

export const libraryChannels = {
  'library:list-files': defineInvokeChannel({
    channel: 'library:list-files',
    request: z.object({
      includeHidden: z.boolean().optional(),
    }).optional(),
    response: LibraryListFilesResponseSchema,
    description: 'List all files in the workspace directory tree (bounded by a global node/byte budget; metadata reports completeness)',
  }),

  'library:read-file': defineInvokeChannel({
    channel: 'library:read-file',
    request: z.string(),
    response: z.object({
      path: z.string(),
      content: z.string(),
      updatedAt: z.number().optional(),
    }),
    description: 'Read the contents of a file in the workspace',
  }),

  'library:read-file-base64': defineInvokeChannel({
    channel: 'library:read-file-base64',
    request: z.union([
      z.string(),
      z.object({
        target: z.string(),
        basePath: z.string().optional(),
      }),
    ]),
    response: z.object({
      base64: z.string(),
      mtimeMs: z.number(),
      size: z.number(),
    }),
    description: 'Read a workspace-relative or absolute file path and return base64 content plus file metadata. When basePath is provided, relative paths are resolved relative to dirname(basePath).',
  }),

  'library:stat-file': defineInvokeChannel({
    channel: 'library:stat-file',
    request: z.union([
      z.string(),
      z.object({
        target: z.string(),
        basePath: z.string().optional(),
      }),
    ]),
    response: z.object({
      exists: z.boolean(),
      mtimeMs: z.number().nullable(),
      size: z.number().nullable(),
    }),
    description: 'Stat a workspace-relative or absolute file path. Returns existence, modified time, and size. ENOENT returns exists=false rather than throwing. Workspace-escape still throws so callers can classify the same way as library:read-file-base64.',
  }),

  'library:write-file': defineInvokeChannel({
    channel: 'library:write-file',
    request: z.object({
      path: z.string(),
      content: z.string(),
      /** SHA-256 hex of file content last read in the editor; rejects if disk changed externally */
      baseContentHash: z.string().optional(),
    }),
    response: z.discriminatedUnion('result', [
      z.object({
        result: z.literal('ok'),
        path: z.string(),
        updatedAt: z.number().optional(),
        currentHash: z.string().optional(),
      }),
      z.object({
        result: z.literal('conflict'),
        path: z.string(),
        currentHash: z.string(),
      }),
      z.object({
        result: z.literal('failed'),
        errorCode: z.string(),
      }),
    ]),
    description: 'Write content to a file in the workspace',
  }),

  'library:import-image-asset': defineInvokeChannel({
    channel: 'library:import-image-asset',
    request: z.object({
      documentPath: z.string(),
      fileName: z.string(),
      mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
      base64Data: z.string(),
    }),
    response: z.object({
      assetPath: z.string(),
      relativeMarkdownPath: z.string(),
      fileName: z.string(),
      mimeType: z.string(),
      sizeBytes: z.number(),
    }),
    description: 'Import an image asset into a document-local assets folder',
  }),

  'library:create-file': defineInvokeChannel({
    channel: 'library:create-file',
    request: z.object({
      parentPath: z.string().optional(),
      fileName: z.string(),
    }),
    response: z.object({
      path: z.string(),
      name: z.string(),
    }),
    description: 'Create a new empty file in the workspace',
  }),

  'library:create-folder': defineInvokeChannel({
    channel: 'library:create-folder',
    request: z.object({
      parentPath: z.string().optional(),
      folderName: z.string(),
    }),
    response: z.object({
      path: z.string(),
      name: z.string(),
    }),
    description: 'Create a new folder in the workspace',
  }),

  'library:rename-item': defineInvokeChannel({
    channel: 'library:rename-item',
    request: z.object({
      itemPath: z.string(),
      newName: z.string(),
    }),
    response: z.object({
      path: z.string(),
      name: z.string().optional(),
    }),
    description: 'Rename a file or folder in the workspace',
  }),

  'library:move-item': defineInvokeChannel({
    channel: 'library:move-item',
    request: z.object({
      itemPath: z.string(),
      targetDirectoryPath: z.string(),
    }),
    response: z.object({
      path: z.string(),
      moved: z.boolean().optional(),
    }),
    description: 'Move a file or folder to a different directory',
  }),

  'library:delete-item': defineInvokeChannel({
    channel: 'library:delete-item',
    request: z.object({
      itemPath: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Delete a file or folder from the workspace',
  }),

  'library:create-symlink': defineInvokeChannel({
    channel: 'library:create-symlink',
    request: z.object({
      sourcePath: z.string(),
      driveName: z.string(),
      companyName: z.string().optional(),
      targetRelativePath: z.string().optional(),
    }),
    response: z.object({
      success: z.boolean(),
      link: GoogleDriveLinkSchema.optional(),
      error: z.string().optional(),
    }),
    description: 'Create a symlink from a Google Drive folder into the workspace',
  }),

  'library:remove-symlink': defineInvokeChannel({
    channel: 'library:remove-symlink',
    request: z.object({
      symlinkPath: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Remove a previously created symlink from the workspace',
  }),

  'library:scan-drive-symlinks': defineInvokeChannel({
    channel: 'library:scan-drive-symlinks',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      links: z.array(GoogleDriveLinkSchema),
      error: z.string().optional(),
    }),
    description: 'Scan the workspace for existing Google Drive symlinks',
  }),

  'library:scan-spaces': defineInvokeChannel({
    channel: 'library:scan-spaces',
    request: z.object({
      withRepair: z.boolean().optional(),
    }).optional(),
    response: z.object({
      success: z.boolean(),
      spaces: z.array(SpaceInfoSchema),
      error: z.string().optional(),
      errors: z.array(z.object({
        kind: z.literal('access'),
        path: z.string(),
        operation: z.enum(['workspace-root-readdir', 'workspace-work-readdir']).optional(),
        code: z.string().optional(),
      })).optional(),
      /** Paths with frontmatter parse warnings (e.g., malformed YAML) */
      parseWarnings: z.array(z.object({
        path: z.string(),
        message: z.string(),
      })).optional(),
    }),
    description: 'Scan the workspace for all spaces (folders with README.md containing rebel_space_description)',
  }),

  'library:create-space': defineInvokeChannel({
    channel: 'library:create-space',
    request: CreateSpaceOptionsSchema,
    response: z.object({
      success: z.boolean(),
      space: SpaceInfoSchema.optional(),
      error: z.string().optional(),
    }),
    description: 'Create a new space (folder or symlink) with README.md from template',
  }),

  'library:init-space-agents': defineInvokeChannel({
    channel: 'library:init-space-agents',
    request: z.object({
      spacePath: z.string(),
      type: SpaceTypeSchema,
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Initialize README.md in an existing space folder from template',
  }),

  'library:remove-space': defineInvokeChannel({
    channel: 'library:remove-space',
    request: z.object({
      spacePath: z.string(),
      removeSymlinkOnly: z.boolean().optional(),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Remove a space from the workspace (symlinks only by default)',
  }),

  'library:move-space': defineInvokeChannel({
    channel: 'library:move-space',
    request: z.object({
      spacePath: z.string(),
      destinationDir: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      newPath: z.string().optional(),
      wasCrossDevice: z.boolean().optional(),
      error: z.string().optional(),
    }),
    description: 'Move a space folder to a destination outside the workspace (for non-symlink spaces)',
  }),

  'library:scan-skills': defineInvokeChannel({
    channel: 'library:scan-skills',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      groups: z.array(z.object({
        source: z.string(),
        label: z.string(),
        type: z.enum(['platform', 'space', 'workspace']),
        categories: z.record(z.string(), z.array(z.object({
          name: z.string(),
          relativePath: z.string(),
          absolutePath: z.string(),
          category: z.string(),
          frontmatter: z.object({
            description: z.string(),
            use_cases: z.array(z.string()).optional(),
            last_updated: z.string().optional(),
            tools_required: z.array(z.string()).optional(),
            agent_type: z.enum(['main_agent', 'subagent']).optional(),
            dependencies: z.array(z.string()).optional(),
            extends: z.string().optional(),
            extension_type: z.enum(['overlay', 'replace']).optional(),
            author: z.string().optional(),
            author_id: z.string().optional(),
            author_email: z.string().optional(),
            author_source: z.enum(['created', 'migrated', 'confirmed']).optional(),
            contributed: z.array(z.string()).optional(),
            contributors: z.array(z.string()).optional(),
            last_modified_by: z.string().optional(),
            last_modified_by_id: z.string().optional(),
            last_modified_by_email: z.string().optional(),
            last_modified_at: z.string().optional(),
            last_modified_context: z.string().optional(),
            output_shape: SkillOutputShapeContractSchema,
          }).optional(),
          hasFrontmatter: z.boolean(),
          examples: z.array(z.string()).optional(),
          usageCount: z.number().optional(),
          lastUsedAt: z.number().optional(),
          qualityScore: z.number().optional(),
          qualityBand: z.enum(['seedling', 'growing', 'solid', 'exemplary']).optional(),
          qualityTopImprovement: z.object({
            dimension: z.string(),
            suggestion: z.string(),
          }).optional(),
        }))),
        count: z.number(),
        isBuiltIn: z.boolean().optional(),
        relativePath: z.string().optional(),
        absolutePath: z.string().optional(),
        isSymlink: z.boolean().optional(),
        storageProvider: z.enum(['google_drive', 'onedrive', 'dropbox', 'box', 'icloud', 'local', 'other']).optional(),
        sharing: z.enum(['private', 'restricted', 'team', 'company-wide', 'public']).optional(),
        companyName: z.string().optional(),
      })),
      totalCount: z.number(),
      error: z.string().optional(),
    }),
    description: 'Scan workspace for skill files across platform, spaces, and workspace root',
  }),

  'library:get-example-metas': defineInvokeChannel({
    channel: 'library:get-example-metas',
    request: z.object({
      skillRelativePath: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      metas: z.array(z.object({
        path: z.string(),
        description: z.string().optional(),
        type: z.enum(['positive', 'counter-example']),
        hasFrontmatter: z.boolean(),
        lastModifiedMs: z.number().optional(),
      })),
      error: z.string().optional(),
    }),
    description: 'Get metadata for example files in a skill folder (lazy load)',
  }),

  'library:update-space-frontmatter': defineInvokeChannel({
    channel: 'library:update-space-frontmatter',
    request: z.object({
      spacePath: z.string(),
      updates: z.object({
        memoryTrust: z.enum(['always_ask', 'balanced', 'always_write']).optional(),
        rebel_space_description: z.string().optional(),
        space_type: SpaceTypeSchema.optional(),
        sharing: SpaceSharingLevelSchema.optional(),
        organisation_name: z.string().optional(),
        emails: z.array(z.string()).optional(),
      }),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Update frontmatter fields in a space README.md',
  }),

  'library:update-space-associated-accounts': defineInvokeChannel({
    channel: 'library:update-space-associated-accounts',
    request: z.object({
      spacePath: z.string(),
      associatedAccounts: z.array(z.string()),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Update user-local associated accounts for a space',
  }),

  'library:detect-google-drive': defineInvokeChannel({
    channel: 'library:detect-google-drive',
    request: z.void(),
    response: z.object({
      installed: z.boolean(),
      signedIn: z.boolean(),
      accounts: z.array(z.string()),
      suggestedCompanyName: z.string().nullable(),
    }),
    description: 'Detect if Google Drive for Desktop is installed and which accounts are signed in',
  }),

  'library:detect-onedrive': defineInvokeChannel({
    channel: 'library:detect-onedrive',
    request: z.void(),
    response: z.object({
      installed: z.boolean(),
      configured: z.boolean(),
      roots: z.array(z.string()),
    }),
    description: 'Detect if OneDrive is installed and configured (signed in and syncing)',
  }),

  'library:validate-path': defineInvokeChannel({
    channel: 'library:validate-path',
    request: z.object({
      path: z.string(),
    }),
    response: z.object({
      valid: z.boolean(),
      errors: z.array(z.string()),
      warnings: z.array(z.string()),
    }),
    description: 'Validate a workspace path for write access, disk space, and common issues',
  }),

  'library:analyze-path': defineInvokeChannel({
    channel: 'library:analyze-path',
    request: AnalyzePathRequestSchema,
    response: AnalyzePathResponseSchema,
    description: 'Analyze a path to detect storage provider, infer sharing level, and determine category',
  }),

  'library:generate-space-description': defineInvokeChannel({
    channel: 'library:generate-space-description',
    request: GenerateSpaceDescriptionRequestSchema,
    response: GenerateSpaceDescriptionResponseSchema,
    description: 'Generate a description for a space folder using Haiku AI based on folder contents and README',
  }),

  'library:search-content': defineInvokeChannel({
    channel: 'library:search-content',
    request: z.object({
      query: z.string(),
      maxResults: z.number().optional(),
      caseSensitive: z.boolean().optional(),
    }),
    response: z.object({
      results: z.array(z.object({
        filePath: z.string(),
        relativePath: z.string(),
        matches: z.array(z.object({
          lineNumber: z.number(),
          lineContent: z.string(),
          matchStart: z.number(),
          matchEnd: z.number(),
        })),
      })),
      totalMatches: z.number(),
      searchedFiles: z.number(),
      truncated: z.boolean(),
    }),
    description: 'Search file contents within the workspace (grep-like)',
  }),

  'library:check-symlink': defineInvokeChannel({
    channel: 'library:check-symlink',
    request: CheckSymlinkRequestSchema,
    response: CheckSymlinkResponseSchema,
    description: 'Check if a path is a symlink and return its target if so',
  }),

  'library:create-subfolders': defineInvokeChannel({
    channel: 'library:create-subfolders',
    request: CreateSubfoldersRequestSchema,
    response: CreateSubfoldersResponseSchema,
    description: 'Create multiple subfolders within a base path',
  }),

  'library:suggest-spaces': defineInvokeChannel({
    channel: 'library:suggest-spaces',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      suggestions: z.array(SuggestedSpaceInfoSchema),
      error: z.string().optional(),
    }),
    description: 'Scan workspace for potential spaces outside scanSpaces() scope, with readiness indicators',
  }),

  'library:get-stats': defineInvokeChannel({
    channel: 'library:get-stats',
    request: z.object({
      includeHidden: z.boolean().optional(),
    }).optional(),
    response: z.object({
      totalFiles: z.number(),
      totalDirs: z.number(),
      truncated: z.boolean(),
    }),
    description: 'Get accurate total file and directory counts for the workspace (not limited by tree display caps)',
  }),

  'library:migrate-legacy-agents-md': defineInvokeChannel({
    channel: 'library:migrate-legacy-agents-md',
    request: z.object({
      spacePath: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      migrated: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Rename AGENTS.md to README.md in a space (legacy migration)',
  }),

  'library:rename-space': defineInvokeChannel({
    channel: 'library:rename-space',
    request: z.object({
      spacePath: z.string(),
      newName: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      oldPath: z.string(),
      newPath: z.string(),
      settingsUpdated: z.array(z.string()),
      warnings: z.array(z.string()).optional(),
      error: z.string().optional(),
    }),
    description: 'Rename a space (folder or symlink) and migrate all path references in settings',
  }),

  'library:normalize-paths': defineInvokeChannel({
    channel: 'library:normalize-paths',
    request: NormalizePathsRequestSchema,
    response: NormalizePathsResponseSchema,
    description: 'Convert real/resolved file paths to workspace-relative paths (handles symlinks)',
  }),

  'library:resolve-shared-folders': defineInvokeChannel({
    channel: 'library:resolve-shared-folders',
    request: ResolveSharedFoldersRequestSchema,
    response: ResolveSharedFoldersResponseSchema,
    description: 'Resolve shared folder names to actual filesystem paths for a cloud storage provider',
  }),

  'library:resolve-space-link': defineInvokeChannel({
    channel: 'library:resolve-space-link',
    request: z.object({
      spaceName: z.string(),
      filePath: z.string().optional(),
      folderPath: z.string().optional(),
    }),
    response: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), workspaceRelativePath: z.string() }),
      z.object({ ok: z.literal(false), error: z.enum(['space-not-found', 'file-not-found', 'path-invalid']) }),
    ]),
    description: 'Resolve a rebel://space/ link to a workspace-relative path',
  }),

  'library:file-to-space-link': defineInvokeChannel({
    channel: 'library:file-to-space-link',
    request: z.object({ filePath: z.string() }),
    response: z.object({
      spaceName: z.string(),
      relativePath: z.string(),
    }).nullable(),
    description: 'Convert an absolute file path to a shareable rebel://space/ link',
  }),

  'library:compute-skill-quality': defineInvokeChannel({
    channel: 'library:compute-skill-quality',
    request: z.object({
      skillRelativePath: z.string(),
    }),
    response: z.object({
      skillName: z.string(),
      total: z.number(),
      band: z.enum(['seedling', 'growing', 'solid', 'exemplary']),
      topImprovement: z.object({
        dimension: z.string(),
        suggestion: z.string(),
      }).optional(),
      breakdown: z.record(z.string(), z.object({
        score: z.number(),
        max: z.number(),
      })).optional(),
    }).nullable(),
    description: 'Compute quality score for a single skill by relative path (used for before/after comparison)',
  }),

  'library:list-skill-change-notifications': defineInvokeChannel({
    channel: 'library:list-skill-change-notifications',
    request: z.void(),
    response: z.array(SkillChangeNotificationSchema),
    description: 'List unread shared-skill change notifications addressed to the current user',
  }),

  'library:dismiss-skill-change-notification': defineInvokeChannel({
    channel: 'library:dismiss-skill-change-notification',
    request: z.object({
      id: z.string(),
      spacePath: z.string().optional(),
    }),
    response: z.object({
      success: z.boolean(),
    }),
    description: 'Dismiss a shared-skill change notification',
  }),
} as const;
