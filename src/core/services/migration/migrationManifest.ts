import { z } from 'zod';
import type { CloudProvider } from '@core/utils/cloudStorageUtils';

export const MIGRATION_BUNDLE_MANIFEST_SCHEMA_VERSION = 1;

const CloudProviderSchema = z.enum(['onedrive', 'google_drive', 'dropbox', 'icloud', 'box']);

const RelativePathSchema = z.string()
  .min(1)
  .refine((value) => !value.startsWith('/'), 'relative paths must not be absolute')
  .refine((value) => !/^[a-zA-Z]:[\\/]/.test(value), 'relative paths must not contain Windows drive roots')
  .refine((value) => !value.split(/[\\/]+/).includes('..'), 'relative paths must not traverse upward');

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const MigrationSpaceClassificationSchema = z.enum([
  'internal-local',
  'cloud-backed',
  'external-symlink',
]);

export const MigrationSpaceDetectionEvidenceSchema = z.object({
  inputPath: z.string().min(1).optional(),
  resolvedPath: z.string().min(1).optional(),
  provider: CloudProviderSchema.optional(),
  relativeSuffix: z.string().optional(),
  readmeSha256: Sha256Schema.optional(),
  frontmatterSha256: Sha256Schema.optional(),
  coreDirectoryIsCloudBacked: z.boolean().optional(),
  isSymlink: z.boolean().optional(),
}).strict();

export const MigrationBundleManifestSchema = z.object({
  schemaVersion: z.literal(MIGRATION_BUNDLE_MANIFEST_SCHEMA_VERSION),
  createdAt: z.string().datetime({ offset: true }),
  importId: z.string().uuid(),
  sourceAppVersion: z.string().min(1),
  sourceDataSchemaEpoch: z.number().int().nonnegative(),
  oldPaths: z.object({
    userDataPath: z.string().min(1),
    coreDirectory: z.string().min(1).nullable(),
    mcpConfigFile: z.string().min(1).nullable(),
  }).strict(),
  spaces: z.array(z.object({
    name: z.string().min(1),
    relPath: RelativePathSchema,
    classification: MigrationSpaceClassificationSchema,
    provider: CloudProviderSchema.optional(),
    detectionEvidence: MigrationSpaceDetectionEvidenceSchema.optional(),
  }).strict()),
  entries: z.array(z.object({
    relPath: RelativePathSchema,
    sha256: Sha256Schema,
    bytes: z.number().int().nonnegative(),
  }).strict()),
  exclusions: z.object({
    derived: z.array(RelativePathSchema),
    keychain: z.array(RelativePathSchema),
    cloud: z.array(RelativePathSchema),
    transient: z.array(RelativePathSchema),
  }).strict(),
  reAuthChecklist: z.object({
    providerKeys: z.array(z.string().min(1)),
    connectors: z.array(z.string().min(1)),
    cloudRepairRequired: z.boolean(),
  }).strict(),
}).strict();

export type MigrationSpaceClassification = z.infer<typeof MigrationSpaceClassificationSchema>;
export type MigrationSpaceDetectionEvidence = z.infer<typeof MigrationSpaceDetectionEvidenceSchema>;
export type MigrationBundleManifest = z.infer<typeof MigrationBundleManifestSchema> & {
  spaces: Array<z.infer<typeof MigrationBundleManifestSchema>['spaces'][number] & {
    provider?: CloudProvider;
    detectionEvidence?: MigrationSpaceDetectionEvidence & { provider?: CloudProvider };
  }>;
};

export type MigrationManifestParseResult =
  | { ok: true; manifest: MigrationBundleManifest }
  | { ok: false; reason: string; issues: z.ZodIssue[] };

export function parseMigrationBundleManifest(input: unknown): MigrationManifestParseResult {
  const parsed = MigrationBundleManifestSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, manifest: parsed.data as MigrationBundleManifest };
  }
  return {
    ok: false,
    reason: parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', '),
    issues: parsed.error.issues,
  };
}
