import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { cloudLaneOptionForPath, workspaceFs } from '@core/services/boundedWorkspaceFs';
import { safeWalkDirectory } from '@core/utils/safeWalkDirectory';
import { getOperatorFrontmatterWarnings, parseOperatorFrontmatterFromContent } from '@shared/schemas/operatorFrontmatter';
import type { OperatorDefinition, OperatorFrontmatter, OperatorParseFailure, OperatorScanResult } from '@shared/types/operators';
import { createOperatorId } from '@shared/types/operators';

const log = createScopedLogger({ service: 'operatorScanner' });
const VALID_OPERATOR_SLUG = /^[a-z0-9-]+$/u;

function makeScanFailure(args: {
  spacePath: string;
  operatorSlug: string;
  operatorFileAbsolutePath: string;
  errorCode: OperatorParseFailure['errorCode'];
  message: string;
}): OperatorParseFailure {
  const failure: OperatorParseFailure = args;
  log.warn({ ...failure }, 'operator_scan.malformed');
  return failure;
}

function toOperatorDefinition(args: {
  spacePath: string;
  operatorSlug: string;
  operatorFileAbsolutePath: string;
  body: string;
  frontmatter: OperatorFrontmatter;
}): OperatorDefinition {
  const operatorDirAbsolutePath = path.dirname(args.operatorFileAbsolutePath);
  const sourceSpacePath = args.spacePath;
  const warnings = getOperatorFrontmatterWarnings(args.frontmatter, args.body).map((warning) => warning.message);
  if (warnings.length > 0) {
    log.warn(
      {
        spacePath: args.spacePath,
        operatorSlug: args.operatorSlug,
        operatorFileAbsolutePath: args.operatorFileAbsolutePath,
        warnings,
      },
      'operator_scan.author_warnings',
    );
  }
  return {
    id: createOperatorId(args.spacePath, args.operatorSlug),
    operatorSlug: args.operatorSlug,
    spacePath: args.spacePath,
    sourceSpacePath,
    category: sourceSpacePath.replace(/\\/g, '/').toLowerCase().endsWith('/rebel-system') ||
      path.basename(sourceSpacePath).toLowerCase() === 'rebel-system'
      ? 'bundled'
      : 'space',
    operatorDirAbsolutePath,
    operatorFileAbsolutePath: args.operatorFileAbsolutePath,
    groundingPath: path.join(operatorDirAbsolutePath, 'grounding.md'),
    diaryPath: path.join(operatorDirAbsolutePath, 'diary.md'),
    frontmatter: args.frontmatter,
    name: args.frontmatter.name,
    description: args.frontmatter.description,
    consult_when: args.frontmatter.consult_when,
    kind: args.frontmatter.kind,
    roles: args.frontmatter.roles,
    ...(args.frontmatter.extends ? { extends: args.frontmatter.extends } : {}),
    ...(args.frontmatter.proactive_interval_minutes !== undefined
      ? {
          proactiveIntervalMinutes: args.frontmatter.proactive_interval_minutes,
        }
      : {}),
    ...(args.frontmatter.use_cases
      ? {
          useCases: args.frontmatter.use_cases,
        }
      : {}),
    ...(args.frontmatter.consultation_prompt
      ? {
          consultationPrompt: args.frontmatter.consultation_prompt,
        }
      : {}),
    ...(args.frontmatter.live_prompt
      ? {
          livePrompt: args.frontmatter.live_prompt,
        }
      : {}),
    ...(args.frontmatter.display_name
      ? {
          displayName: args.frontmatter.display_name,
        }
      : {}),
    body: args.body,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

async function parseOperatorFile(
  spacePath: string,
  operatorSlug: string,
  operatorFileAbsolutePath: string,
  /**
   * When the operator file belongs to a `forceCloudRoots` space (a scan-discovered
   * Chief-of-Staff SYMLINK absent from `settings.spaces` — the dead-Drive case), its
   * workspace path is pattern-LOCAL and containment never learned it, so
   * `cloudLaneOptionForPath` (which keys off the path STRING via `detectCloudStorage`)
   * returns `undefined` and the CONTENT read would take the bare-fs LOCAL lane and HANG
   * on the dead cloud target — even though the WALK root was forced to the cloud lane
   * (Phase-7 F1 rd4 residual). OR-ing `forceCloud: true` here routes the per-file read
   * through the same killable cloud lane → `reconnecting` instead of a hang.
   */
  forceCloud: boolean,
): Promise<{ operator?: OperatorDefinition; failure?: OperatorParseFailure }> {
  // Route the per-file read through the killable workspace-fs boundary: an OPERATOR.md
  // can live on a cloud-backed Chief-of-Staff/space, and this scan runs on the LIVE
  // turn path (`resolveSystemPrompt` → `buildOperatorPromptMetadata`). A raw unbounded
  // `fs.readFile` on a dead FUSE mount would block the turn (MA1 hang class). The
  // boundary classifies the path FS-free (containment) + `cloudLaneOptionForPath`
  // forces the cloud lane for an explicitly-named cloud-root path (GPT F2); `forceCloud`
  // forces it for a scan-discovered symlink root whose path string looks local (F1).
  const pathLaneOption = cloudLaneOptionForPath(operatorFileAbsolutePath);
  const readOutcome = await workspaceFs.readFile(
    operatorFileAbsolutePath,
    'utf-8',
    forceCloud ? { ...pathLaneOption, forceCloud: true } : pathLaneOption,
  );
  if (readOutcome.status === 'reconnecting') {
    // Dead/slow cloud mount — surface a DISTINCT, calm scan failure so the cause is
    // observable (not a silent drop) and the scan continues to the next file.
    const failure = makeScanFailure({
      spacePath,
      operatorSlug,
      operatorFileAbsolutePath,
      errorCode: 'reconnecting',
      message: 'OPERATOR.md is on a reconnecting cloud drive — skipped this scan.',
    });
    return { failure };
  }
  if (readOutcome.status === 'error') {
    const failure = makeScanFailure({
      spacePath,
      operatorSlug,
      operatorFileAbsolutePath,
      errorCode: 'malformed-frontmatter',
      message: readOutcome.error.message || 'Unable to read OPERATOR.md',
    });
    return { failure };
  }
  const content = readOutcome.value;

  const parsed = parseOperatorFrontmatterFromContent(content);
  if (!parsed.success) {
    const failure = makeScanFailure({
      spacePath,
      operatorSlug,
      operatorFileAbsolutePath,
      errorCode: parsed.errorCode,
      message: parsed.message,
    });
    return { failure };
  }

  return {
    operator: toOperatorDefinition({
      spacePath,
      operatorSlug,
      operatorFileAbsolutePath,
      body: parsed.body,
      frontmatter: parsed.frontmatter,
    }),
  };
}

export async function scanOperators(
  spacePaths: string[],
  /**
   * Resolved (absolute, `path.resolve`-normalised) SPACE roots whose `operators/`
   * directory-walk root `realpath` must be FORCED through the killable cloud lane.
   * The caller (`buildOperatorPromptMetadata`) sets this for a scan-discovered
   * Chief-of-Staff SYMLINK absent from `settings.spaces` (the dead-Drive case): its
   * workspace path is pattern-LOCAL and containment never learned it, so without this
   * the walk root `realpath` would take the bare-fs LOCAL lane and HANG dereferencing
   * the dead cloud symlink target (260622 rd4-analogous; Phase-7 F1). Space roots NOT
   * in this set keep their existing pattern/containment lane selection.
   */
  forceCloudRoots?: ReadonlySet<string>,
): Promise<OperatorScanResult> {
  const operators: OperatorDefinition[] = [];
  const failures: OperatorParseFailure[] = [];

  for (const rawSpacePath of spacePaths) {
    if (!rawSpacePath.trim()) continue;
    const spacePath = path.resolve(rawSpacePath);
    const operatorsDir = path.join(spacePath, 'operators');
    const forceCloudRoot = forceCloudRoots?.has(spacePath) ?? false;
    const operatorFiles: Array<{ operatorSlug: string; operatorFileAbsolutePath: string }> = [];

    const walkResult = await safeWalkDirectory(operatorsDir, {
      maxDepth: 2,
      forceCloudRoot,
      onDirectory: ({ name, depth }) => {
        if (name.startsWith('.')) return false;
        return depth < 2;
      },
      onFile: ({ absolutePath, name }) => {
        if (name !== 'OPERATOR.md') return;
        const relativePath = path.relative(operatorsDir, absolutePath);
        const pathParts = relativePath.split(path.sep);
        if (pathParts.length !== 2 || pathParts[1] !== 'OPERATOR.md') {
          failures.push(makeScanFailure({
            spacePath,
            operatorSlug: pathParts.length > 1 ? pathParts[pathParts.length - 2] : '',
            operatorFileAbsolutePath: absolutePath,
            errorCode: 'invalid-path-shape',
            message: 'OPERATOR.md must live at <space>/operators/<slug>/OPERATOR.md.',
          }));
          return;
        }
        const operatorSlug = pathParts[0];
        if (!VALID_OPERATOR_SLUG.test(operatorSlug)) {
          failures.push(makeScanFailure({
            spacePath,
            operatorSlug,
            operatorFileAbsolutePath: absolutePath,
            errorCode: 'invalid-slug',
            message: 'Operator slug must use lowercase ASCII letters, numbers, and hyphens only.',
          }));
          return;
        }
        operatorFiles.push({
          operatorSlug,
          operatorFileAbsolutePath: absolutePath,
        });
      },
      onTruncated: ({ reasons, entriesVisited }) => {
        log.warn(
          { operatorsDir, reasons, entriesVisited },
          'operator_scan.truncated',
        );
      },
    });

    if (walkResult.truncatedReasons.length > 0) {
      failures.push(makeScanFailure({
        spacePath,
        operatorSlug: '',
        operatorFileAbsolutePath: operatorsDir,
        errorCode: 'scan-truncated',
        message: `Operator scan was incomplete: ${walkResult.truncatedReasons.join(', ')}`,
      }));
    }

    for (const file of operatorFiles.sort((a, b) => a.operatorFileAbsolutePath.localeCompare(b.operatorFileAbsolutePath))) {
      const result = await parseOperatorFile(spacePath, file.operatorSlug, file.operatorFileAbsolutePath, forceCloudRoot);
      if (result.operator) {
        operators.push(result.operator);
      }
      if (result.failure) {
        failures.push(result.failure);
      }
    }
  }

  return { operators, failures };
}
