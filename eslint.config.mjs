import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import noBareDefaultBypassRule from './eslint-rules/no-bare-default-bypass.js';
import noDirectDispatchPathEqualityRule from './eslint-rules/no-direct-dispatch-path-equality.js';
import noDefaultModelLiteralRule from './eslint-rules/no-default-model-literal.js';
import noDisallowedScanSpacesSideEffectsRule from './eslint-rules/no-disallowed-scanspaces-side-effects.js';
import noDynamicCaptureMessageRule from './eslint-rules/no-dynamic-capture-message.js';
import noDerivedLivenessCastRule from './eslint-rules/no-derived-liveness-cast.js';
import noLocalAssertNeverRule from './eslint-rules/no-local-assert-never.js';
import noLocalStoragePrefixRedeclareRule from './eslint-rules/no-local-storage-prefix-redeclare.js';
import noModelBrandCastsRule from './eslint-rules/no-model-brand-casts.js';
import noModelErrorCatchClobberRule from './eslint-rules/no-model-error-catch-clobber.js';
import noRawBtsModelReadRule from './eslint-rules/no-raw-bts-model-read.js';
import noRawTurnLivenessScalarsRule from './eslint-rules/no-raw-turn-liveness-scalars.js';
import noRawStartupDialogRule from './eslint-rules/no-raw-startup-dialog.js';
import noRawHeadlessCheckRule from './eslint-rules/no-raw-headless-check.js';
import noSilentSwallowRule from './eslint-rules/no-silent-swallow.js';
import noUndeferredNativeCleanupRule from './eslint-rules/no-undeferred-native-cleanup.js';
import noUnusedResultRule from './eslint-rules/no-unused-result.js';
import { coveredSilentSwallowGlobs } from './scripts/silentSwallowSurfaceCoverage.mjs';
import { routingStateWriterGuardSelectors } from './eslint-rules/routing-state-writer-selectors.mjs';
import { busyWaitPersistenceGuardSelectors } from './eslint-rules/busy-wait-persistence-guard-selectors.mjs';
import {
  privateMindstoneSourceGlobs,
  BTS_RAW_READ_FILES,
  BTS_RAW_READ_IGNORES,
  BTS_RAW_READ_SEVERITY,
  btsRawReadLanguageOptions,
} from './eslint-rules/bts-raw-read-config.mjs';

// FD-lifetime guard (PM 260611_searchfiles_fd_leak_ebadf): ban inline
// createInterface({ input: createReadStream(...) }) construction so stream
// ownership always routes through src/core/utils/readLines.ts.
const readlineOwnedStreamGuardSelectors = [
  {
    selector:
      "CallExpression[callee.name='createInterface']" +
      ":has(ObjectExpression > Property[key.name='input'] > CallExpression[callee.name='createReadStream'])",
    message:
      "Do not inline createInterface({ input: createReadStream(...) }). Route through readFileLines() from src/core/utils/readLines.ts so stream lifetime is owned and torn down deterministically. Override only at the canonical helper with: // eslint-disable-next-line no-restricted-syntax -- readline-owner-helper-justified: <reason>. See docs-private/postmortems/260611_searchfiles_fd_leak_ebadf_postmortem.md.",
  },
  {
    selector:
      "CallExpression[callee.name='createInterface']" +
      ":has(ObjectExpression > Property[key.name='input'] > CallExpression[callee.property.name='createReadStream'])",
    message:
      "Do not inline createInterface({ input: createReadStream(...) }). Route through readFileLines() from src/core/utils/readLines.ts so stream lifetime is owned and torn down deterministically. Override only at the canonical helper with: // eslint-disable-next-line no-restricted-syntax -- readline-owner-helper-justified: <reason>. See docs-private/postmortems/260611_searchfiles_fd_leak_ebadf_postmortem.md.",
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name='createInterface']" +
      ":has(ObjectExpression > Property[key.name='input'] > CallExpression[callee.name='createReadStream'])",
    message:
      "Do not inline createInterface({ input: createReadStream(...) }). Route through readFileLines() from src/core/utils/readLines.ts so stream lifetime is owned and torn down deterministically. Override only at the canonical helper with: // eslint-disable-next-line no-restricted-syntax -- readline-owner-helper-justified: <reason>. See docs-private/postmortems/260611_searchfiles_fd_leak_ebadf_postmortem.md.",
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.property.name='createInterface']" +
      ":has(ObjectExpression > Property[key.name='input'] > CallExpression[callee.property.name='createReadStream'])",
    message:
      "Do not inline createInterface({ input: createReadStream(...) }). Route through readFileLines() from src/core/utils/readLines.ts so stream lifetime is owned and torn down deterministically. Override only at the canonical helper with: // eslint-disable-next-line no-restricted-syntax -- readline-owner-helper-justified: <reason>. See docs-private/postmortems/260611_searchfiles_fd_leak_ebadf_postmortem.md.",
  },
];

// Pino logger arg-order selectors: log.level({ bindings }, 'message'), NOT
// log.level('message', { bindings }). Extracted as a constant so the test-files
// override can include them without duplication.
// See: docs-private/postmortems/260329_pino_logger_arg_order_postmortem.md
const pinoArgOrderSelectors = [
  ...['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map(level => ({
    selector: `CallExpression:not([callee.object.name='console'])[callee.property.name='${level}'][arguments.0.type='Literal'][arguments.1.type='ObjectExpression']`,
    message: `Pino arg order: use ${level}({ bindings }, 'message'), not ${level}('message', { bindings }). The object is silently dropped with wrong order.`,
  })),
  ...['trace', 'debug', 'info', 'warn', 'error', 'fatal'].map(level => ({
    selector: `CallExpression:not([callee.object.name='console'])[callee.property.name='${level}'][arguments.0.type='TemplateLiteral'][arguments.1.type='ObjectExpression']`,
    message: `Pino arg order: use ${level}({ bindings }, 'message'), not ${level}(\`template\`, { bindings }). The object is silently dropped with wrong order.`,
  })),
  ...readlineOwnedStreamGuardSelectors,
];

// Loop swallow guard (PM 260611_cloud_pull_stateless_retry_storm): scoped below
// to cloud/file-index background-pass modules. Pure selectors cannot prove every
// possible "no memo write" shape without overmatching current legitimate retry
// loops, so this deliberately flags the high-signal incident approximation:
// logging plus `skipped++` inside a loop catch, unless the catch also records a
// common memo/failure state or exits.
const loopSwallowCatchSelectors = [
  {
    selector:
      ":matches(ForStatement, ForInStatement, ForOfStatement, WhileStatement, DoWhileStatement) CatchClause" +
      ":has(BlockStatement > ExpressionStatement > CallExpression[callee.type='MemberExpression'][callee.property.name=/^(trace|debug|info|warn|error|fatal)$/])" +
      ":has(BlockStatement > ExpressionStatement > UpdateExpression[argument.name='skipped'])" +
      ":not(:has(BlockStatement ThrowStatement))" +
      ":not(:has(BlockStatement ReturnStatement))" +
      ":not(:has(BlockStatement BreakStatement))" +
      ":not(:has(BlockStatement CallExpression[callee.property.name=/^(set|add|recordFailure|recordPullFailure|memoizeFailure|markAttemptFailed|markPermanentlyFailed)$/]))",
    message: "Loop catch swallow guard: logging plus skipped++ inside a background loop repeats failed work without making the next cycle do less. Add a failure memo/change gate or rethrow/break/return; selector intentionally approximates no memo-write to avoid overmatching current legitimate retry loops. See 260611 cloud-pull stateless retry storm postmortem / idle_cpu_stateless_loop family.",
  },
];

const virtualizerGetItemKeyGuardMessage =
  "Renderer virtualizer getItemKey guard: useVirtualizer({ getItemKey }) can retain library caches keyed by never-repeating item ids unless the owning pane remounts or otherwise bounds cache lifetime. This rule is an attention gate, not proof: static lint cannot see the mount site's key. Add a nearby // virtualizer-remount-reviewed: <reason> comment only after reviewing the keyed-remount/bounded-cache pattern. See docs-private/postmortems/260611_virtualizer_elementscache_unbounded_session_switch_postmortem.md and docs/plans/260611_rebel-5d5-renderer-leak/PLAN.md Stage 5.";

// Virtualizer item-key lifetime guard (PM 260611_virtualizer_elementscache_
// unbounded_session_switch): scoped to the ConversationPane chokepoint below.
// This is deliberately a tiny local rule instead of no-restricted-syntax:
// the repo's escape-hatch ratchet forbids new suppression comments, and a pure
// selector cannot read the required virtualizer-remount-reviewed comment.
const virtualizerGetItemKeyReviewRule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require a remount/cache-bound review for useVirtualizer getItemKey call sites',
    },
    messages: {
      missingReview: virtualizerGetItemKeyGuardMessage,
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();

    function hasGetItemKeyOption(node) {
      const [firstArgument] = node.arguments ?? [];
      return firstArgument?.type === 'ObjectExpression' &&
        firstArgument.properties?.some((property) =>
          property?.type === 'Property' &&
          !property.computed &&
          property.key?.type === 'Identifier' &&
          property.key.name === 'getItemKey',
        );
    }

    function hasReviewComment(node) {
      const declaration = node.parent?.parent?.type === 'VariableDeclaration'
        ? node.parent.parent
        : node;
      return sourceCode.getCommentsBefore(declaration).some((comment) =>
        comment.loc?.end.line >= node.loc.start.line - 2 &&
        comment.value.includes('virtualizer-remount-reviewed:'),
      );
    }

    return {
      CallExpression(node) {
        if (node.callee?.type !== 'Identifier' || node.callee.name !== 'useVirtualizer') {
          return;
        }
        if (!hasGetItemKeyOption(node) || hasReviewComment(node)) {
          return;
        }
        context.report({ node, messageId: 'missingReview' });
      },
    };
  },
};

const virtualizerLifetimePlugin = {
  rules: {
    'reviewed-get-item-key': virtualizerGetItemKeyReviewRule,
  },
};

// SDK extractor guard: OpenAI response text extraction must route through
// extractOpenAITextFields() to avoid ad-hoc `.message.content` reads.
// See: docs-private/postmortems/260427_bts_reasoning_content_omission_postmortem.md
const sdkExtractorGuardSelectors = [
  {
    selector: "MemberExpression[property.name='content'][object.type='MemberExpression'][object.property.name='message']",
    message: "Direct .message.content reads on OpenAI response shapes are banned outside the canonical extractor. Route through extractOpenAITextFields() in src/core/rebelCore/clients/openaiTranslators.ts. See 260427 BTS reasoning-content postmortem. Override: // eslint-disable-next-line no-restricted-syntax -- sdk-content-justified: <reason>",
  },
];

const originAutomationDriftGuardMessage =
  "Do not classify automation sessions with `<x>.origin === 'automation'` / `!== 'automation'`: origin is unreliable for visibility/lifecycle decisions. Use isAutomationSession(id) or isBackgroundConversationSession(id) from @shared/sessionKind. Override only for genuine origin-on-persisted-session uses with: // eslint-disable-next-line no-restricted-syntax -- origin-classification-justified: <reason>.";

const originAutomationDriftGuardSelectors = [
  {
    selector: "BinaryExpression[operator='==='][left.type='MemberExpression'][left.property.name='origin'][right.value='automation']",
    message: originAutomationDriftGuardMessage,
  },
  {
    selector: "BinaryExpression[operator='!=='][left.type='MemberExpression'][left.property.name='origin'][right.value='automation']",
    message: originAutomationDriftGuardMessage,
  },
  {
    selector: "BinaryExpression[operator='==='][left.type='Identifier'][left.name=/^(origin|currentSessionOrigin)$/][right.value='automation']",
    message: originAutomationDriftGuardMessage,
  },
  {
    selector: "BinaryExpression[operator='!=='][left.type='Identifier'][left.name=/^(origin|currentSessionOrigin)$/][right.value='automation']",
    message: originAutomationDriftGuardMessage,
  },
];

// Stage 3 of docs/plans/260525_typing-refactor-postmortem-driven/PLAN.md:
// Node engine-floor guard for Node-22-only fs glob APIs while
// package.json engines.node remains >=20.
// See: docs-private/postmortems/260521_outcome_shape_globsync_node20_postmortem.md
const nodeEngineFloorGuardMessage =
  'Node engine-floor mismatch: package.json engines.node is >=20, but this fs glob API is Node 22+. Use fast-glob, globby, or a manual fs.readdir walk. Drop this guard when engine floor bumps to >=22.';

const nodeEngineFloorGuardEntries = [
  {
    object: 'fs',
    property: 'globSync',
    message: nodeEngineFloorGuardMessage,
  },
  {
    object: 'fsPromises',
    property: 'glob',
    message: nodeEngineFloorGuardMessage,
  },
];

const nodeEngineFloorGuardImportEntries = [
  {
    name: 'node:fs',
    importNames: ['globSync'],
    message: nodeEngineFloorGuardMessage,
  },
  {
    name: 'fs',
    importNames: ['globSync'],
    message: nodeEngineFloorGuardMessage,
  },
];

// authService import restriction entries — applied in both the base config block
// AND the Node-engine-floor block at the same rule, because ESLint flat config
// REPLACES (does not merge) `no-restricted-imports` values when multiple matching
// configs define the same rule. The Node-engine-floor block at line ~1742 matches
// every production file under src/**, cloud-service/**, cloud-client/**, evals/**,
// mobile/** — if it omitted these entries, the base config's authService rule
// would be silently dropped for every production file. Reusing the same const in
// both places keeps the guardrail effective everywhere it should fire.
// B3-private files get their own post-Node-engine-floor override below: keep
// nodeEngineFloorGuardImportEntries active, but drop the authService self-import ban.
// See docs/plans/260605_oss-auth-removal/PLAN.md § Amendment A1.6 and the Phase 6 fix
// captured in the Decision Log.
const authServiceImportRestrictionPaths = [
  {
    name: '@main/services/authService',
    message: "Direct imports from @main/services/authService are restricted. Use getRebelAuthProvider() from @core/rebelAuth for interface methods, or getCurrentUserProvider() from @core/currentUserProvider for getCurrentUser. Allowlist for B3-private files: see docs/plans/260605_oss-auth-removal/PLAN.md § Amendment A1.6.",
  },
];

const authServiceImportRestrictionPatterns = [
  {
    group: ['**/services/authService', '**/authService'],
    message: 'Direct imports from authService are restricted. See @core/rebelAuth and @core/currentUserProvider.',
  },
];

// Renderer `@typescript-eslint/no-restricted-imports` path bans, split by
// concern and reusable so a future ban is added to a const here, not a new
// renderer-broad block that would silently clobber the others. ESLint FLAT
// CONFIG REPLACES (does not merge) an array-valued rule when multiple matching
// blocks set it for the same file — last matching block wins — so each block
// below must carry the full set of bans that should apply to the files it
// matches. (Regression net: src/renderer/utils/__tests__/rendererRestrictedImportsClobber.test.ts.)
//
// `rendererReactMarkdownRestrictedPaths`: markdown/hotkey wrappers must go
// through the I10 shared pipeline + contenteditable-safe hotkey wrapper.
const rendererReactMarkdownRestrictedPaths = [
  {
    name: 'react-markdown',
    message:
      'Direct react-markdown imports bypass the I10 shared pipeline (space-path preprocessor + dangerous-scheme URL guard for both <img src> and <a href>). Use SafeMarkdown (desktop reader), MessageMarkdown (chat transcript), or WhatsNewDialog\'s InlineMarkdown instead. See docs/plans/260422_i10_shared_markdown_pipeline_STAGED_PLAN.md.',
    allowTypeImports: true,
  },
  {
    name: 'remark-gfm',
    message:
      'remark-gfm is already included by preprocessMarkdownForRender from @rebel/shared. Importing it directly indicates a non-wrapper surface — migrate via SafeMarkdown/MessageMarkdown/WhatsNewDialog.',
  },
  {
    name: 'react-hotkeys-hook',
    importNames: ['useHotkeys'],
    message:
      "Direct useHotkeys() calls silently miss `enableOnContentEditable: true` and stop firing when focus is in a TipTap composer/document editor. Use useGlobalHotkey from '@renderer/hooks/useGlobalHotkey' for global app shortcuts. See docs/project/KEYBOARD_SHORTCUTS.md and docs/plans/260505_hotkeys_contenteditable_regression_fix.md. (HotkeysProvider remains importable.)",
    allowTypeImports: true,
  },
];

// `rendererSearchFilesRestrictedPaths`: all renderer consumers must use
// searchLibrary from the engine; raw searchFiles is reserved for the engine.
const rendererSearchFilesRestrictedPaths = [
  {
    name: '@renderer/utils/librarySearch',
    importNames: ['searchFiles'],
    message:
      'Use searchLibrary from @renderer/features/library/search/engine instead. Direct searchFiles import is reserved for the engine module.',
  },
];

// Union applied to ordinary renderer files. The two narrow override blocks
// below subtract exactly the one entry each exempt file legitimately needs.
const rendererRestrictedImportPaths = [
  ...rendererReactMarkdownRestrictedPaths,
  ...rendererSearchFilesRestrictedPaths,
];

const privateMindstoneImportRestrictionPatterns = [
  {
    group: ['@private/mindstone', '@private/mindstone/*'],
    message: '@private/mindstone is main-process-only. Route renderer/core/shared access through public core boundaries or IPC instead.',
  },
];

const privateMindstoneRuntimeImportGuardSelectors = [
  {
    selector: "ImportExpression[source.value=/^@private\\/mindstone(\\/|$)/]",
    message: '@private/mindstone dynamic imports are restricted outside the main-process bootstrap boundary. Route renderer/core/shared access through public core boundaries or IPC instead.',
  },
  {
    selector: "CallExpression[callee.name='require'][arguments.0.value=/^@private\\/mindstone(\\/|$)/]",
    message: '@private/mindstone require() calls are restricted outside the main-process bootstrap boundary. Use static imports only at the approved bootstrap seam.',
  },
];

// `privateMindstoneSourceGlobs` is the SSoT-owned binding imported above from
// eslint-rules/bts-raw-read-config.mjs (the BTS raw-read block and the self-test
// share one source for the `files` set; other config blocks reuse it here).

const privateMindstoneServiceSourceGlobs = [
  'private/mindstone/src/services/**/*.{ts,tsx}',
];

// `no-restricted-imports` treats namespace imports (`import * as fs`) as using
// every export from that module, so importNames-based bans also fire on
// namespace imports even when callsites do not use globSync(). Keep the import
// ban active repo-wide, but carve out current namespace-import sites where the
// no-restricted-properties guard (`fs.globSync`) is the effective protection.
const nodeEngineFloorGuardImportExemptions = [
  'src/core/services/folderStore.ts',
  'src/core/services/incrementalSessionStore.ts',
  'src/core/services/versionMarker.ts',
  'src/core/services/workspace/trustedFilesystemRoots.ts',
  'src/core/utils/sessionFileLock.ts',
  'src/main/services/meetingBot/desktopSdkService.ts',
  'src/main/services/localSttModelManager.ts',
  'src/main/services/ollamaRuntimeManager.ts',
  'src/main/services/localSttService.ts',
  'src/main/services/squirrelCleanupService.ts',
  'src/main/services/cloud/cloudContinuityMetadata.ts',
  'src/main/services/cloud/cloudOutbox.ts',
  'src/main/services/cloud/cloudSyncMetadata.ts',
  'src/main/services/cloud/cloudWorkspaceSync.ts',
  'src/main/services/moonshineTranscriber.ts',
  'src/main/services/ollamaService.ts',
  'src/main/services/diagnosticContextService.ts',
  'evals/benchmarks/generate-corpus.ts',
  'evals/benchmarks/tool-search-quality.ts',
  'evals/benchmarks/search-quality.ts',
  'evals/benchmarks/generate-expanded-corpus.ts',
  'evals/benchmarks/semantic-search.ts',
  'evals/conversation-search.ts',
];

const privateMindstoneImportRestrictionNodeGuardExemptions =
  nodeEngineFloorGuardImportExemptions.filter((file) =>
    /^src\/(core|shared|renderer)\//.test(file),
  );

// Native-binding ESM import guard — packaged Electron builds resolve
// `await import('@lancedb/lancedb')` relative to the importing file's path
// INSIDE `app.asar`, where the native binary doesn't exist. The fix is to
// load via `createRequire(unpackedPath)` pointing at `app.asar.unpacked/
// node_modules/.package-lock.json` (the `nativeRequire` pattern already used
// in fileIndexService.ts, conversationIndexService.ts, toolIndexService.ts,
// indexHealthService.ts, plus the worker variant with `unpackedNodeModules`
// passed via workerData in embeddingWorker.ts / preTurnWorker.ts /
// indexHealthWorker.ts). This rule prevents NEW occurrences of the bug class;
// extracting the duplicated nativeRequire pattern into a shared
// loadNativeModule<T>() helper is captured as a FOLLOW-UP.
// See: docs-private/postmortems/251216_lancedb_huggingface_native_module_asar_resolve_postmortem.md
const nativeBindingImportGuardSelectors = [
  {
    selector: "ImportExpression[source.value=/^(@lancedb\\/lancedb|@huggingface\\/transformers|sherpa-onnx-node|onnxruntime-node)$/]",
    message: "Native-binding modules (@lancedb/lancedb, @huggingface/transformers, sherpa-onnx-node, onnxruntime-node) cannot be loaded via `await import(...)` in main-process / worker code — the ESM resolver walks node_modules from inside app.asar and fails. Use `loadNativeModule<T>(spec)` from src/core/utils/loadNativeModule.ts (handles packaged-vs-dev asar.unpacked resolution + caches the NodeRequire). For worker threads, see workers/embeddingWorker.ts:75-93 for the workerData-driven variant. Originating postmortem: docs-private/postmortems/251216_lancedb_huggingface_native_module_asar_resolve_postmortem.md (now has a Resolution / Structural Fix section).",
  },
  ...privateMindstoneRuntimeImportGuardSelectors,
];

const restrictedSelectors = [
  {
    selector: "CallExpression[callee.name=/^(emitTranscriptSaved|emitTranscriptDistributionReady|deferTranscriptSaved)$/]",
    message: 'Direct emit/defer calls are not allowed outside the @core/meetingSource kernel. Route saves through saveMeetingSource() / upgradeAndEmit() / upgradeWithGuardAndEmit() / notifyDistributionReady(). See docs/plans/260519_unify_meeting_save_paths.md Invariant 4.',
  },
];

// openHistorySession wrapper-bypass guard (PM 260416_thread_scroll_jumps_to_top_on_switch):
// the raw engine `openHistorySession(...)` does NOT enforce the scroll-settling
// contract (markPendingHistoryScroll -> pane-hide -> scroll-to-latest); only the
// wrapper does. User-facing opens that call the raw engine directly leave the
// conversation pane at scrollTop=0 ("thread jumps to top"). New code must route
// through navigateToConversation / executeOpenHistorySession, NOT raw
// openHistorySession. Bare-call form only — the member-call form
// `store.getState().openHistorySession()` (callee is a MemberExpression) is the
// engine/store plumbing and is intentionally OUT of scope. The three sanctioned
// raw callers (reconnect bypass, the wrapper's own call, the injected reconnect
// callback) carry per-line `// eslint-disable-next-line no-restricted-syntax`
// overrides at their call sites. See
// docs-private/postmortems/260416_thread_scroll_jumps_to_top_on_switch_postmortem.md.
const openHistorySessionGuardSelectors = [
  {
    selector: "CallExpression[callee.name='openHistorySession']",
    message: "Raw openHistorySession(...) bypasses the scroll-settling contract (PM 260416_thread_scroll_jumps_to_top_on_switch). New code must route through navigateToConversation / executeOpenHistorySession, not the raw engine opener. Sanctioned raw callers override per-line: // eslint-disable-next-line no-restricted-syntax -- openHistorySession-justified: <reason>. See docs-private/postmortems/260416_thread_scroll_jumps_to_top_on_switch_postmortem.md.",
  },
];

// flushSync anti-reintroduction ratchet (PM 260402_flushsync_render_cycle_corruption):
// `flushSync(...)` reached during a React render/commit collides with the
// scheduler ("Should not already be working" corruption); the original bug took
// 64 days to discover. There are zero live flushSync() call expressions in the
// tree, so this is a pure ratchet-at-zero. ESLint cannot statically prove a call
// site is unreachable during render, so any genuinely-required use must carry a
// per-line override justifying that the call site is unreachable during render.
// Two callee shapes are guarded: the bare named import `flushSync(...)` AND the
// namespace/member form `ReactDOM.flushSync(...)` — the latter is the more common
// React idiom and a bare-identifier selector alone would miss it (blind spot
// flagged by the GPT-5.5 changeset review). Both forms are at zero today.
// See docs-private/postmortems/260402_flushsync_render_cycle_corruption_postmortem.md.
const flushSyncGuardSelectors = [
  {
    selector: "CallExpression[callee.name='flushSync']",
    message: "flushSync(...) is unsafe during a React render cycle (PM 260402_flushsync_render_cycle_corruption — causes 'Should not already be working' corruption). Prefer queueMicrotask / a direct state set. If genuinely required, override per-line: // eslint-disable-next-line no-restricted-syntax -- flushSync-justified: call site is unreachable during render, <reason>. See docs-private/postmortems/260402_flushsync_render_cycle_corruption_postmortem.md.",
  },
  {
    selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='flushSync']",
    message: "ReactDOM.flushSync(...) is unsafe during a React render cycle (PM 260402_flushsync_render_cycle_corruption — causes 'Should not already be working' corruption). Prefer queueMicrotask / a direct state set. If genuinely required, override per-line: // eslint-disable-next-line no-restricted-syntax -- flushSync-justified: call site is unreachable during render, <reason>. See docs-private/postmortems/260402_flushsync_render_cycle_corruption_postmortem.md.",
  },
];

const turnPolicyRefactorFenceMessage =
  "TurnPolicy refactor (260526_turn_policy_unification.md): read effectivePolicy.<field> instead. Allow-list this only with a justifying comment.";

const turnPolicyRefactorFenceSelectors = [
  {
    selector:
      "Literal[value='automation']" +
      ":not(CallExpression[callee.object.name='z'][callee.property.name='enum'] > ArrayExpression > Literal[value='automation'])" +
      ":not(BinaryExpression[left.type='Identifier'][left.name='rendererSessionKind'] > Literal[value='automation'])" +
      ":not(CallExpression[callee.object.name='agentTurnRegistry'][callee.property.name='setTurnCategory'] > Literal[value='automation'])",
    message: turnPolicyRefactorFenceMessage,
  },
  {
    selector:
      "Identifier[name=/^isAutomation$/]" +
      ":not(TSPropertySignature > Identifier[name='isAutomation'])" +
      ":not(Property[key.name='isAutomation'] > Identifier[name='isAutomation'])" +
      ":not(MemberExpression[property.name='isAutomation'] > Identifier[name='isAutomation'])",
    message: turnPolicyRefactorFenceMessage,
  },
];

const cleanupBypassGuardSelectors = [
  {
    selector: "CallExpression[callee.object.name='councilTurnIds'][callee.property.name='delete']",
    message: 'Direct mutation of councilTurnIds is forbidden outside agentTurnCleanup. Use cleanupTurnAttempt or completeTurnCleanup.',
  },
  {
    selector: "CallExpression[callee.object.name='adHocTurnIds'][callee.property.name='delete']",
    message: 'Direct mutation of adHocTurnIds is forbidden outside agentTurnCleanup. Use cleanupTurnAttempt or completeTurnCleanup.',
  },
  {
    selector: "CallExpression[callee.object.name='councilTurnMeta'][callee.property.name='delete']",
    message: 'Direct mutation of councilTurnMeta is forbidden outside agentTurnCleanup. Use cleanupTurnAttempt or completeTurnCleanup.',
  },
  {
    selector: "CallExpression[callee.object.name='adHocTurnMeta'][callee.property.name='delete']",
    message: 'Direct mutation of adHocTurnMeta is forbidden outside agentTurnCleanup. Use cleanupTurnAttempt or completeTurnCleanup.',
  },
  {
    selector: "CallExpression[callee.object.name='proxyManager'][callee.property.name='removeRoutes']",
    message: 'Direct call to proxyManager.removeRoutes is forbidden outside agentTurnCleanup. Use cleanupTurnAttempt or completeTurnCleanup.',
  },
];

// Timezone safety guard: toLocaleTimeString/toLocaleDateString without explicit
// timeZone option silently uses the host process timezone — correct on desktop
// but wrong on cloud (UTC). Flag calls with ≤1 argument (locale-only, no options).
// See: docs/project/TIMEZONE_AND_DATE_HANDLING_IN_MCPS.md
const timezoneUnsafeSelectors = [
  ...['toLocaleTimeString', 'toLocaleDateString'].map(method => ({
    selector: `CallExpression[callee.property.name='${method}'][arguments.length<=1]`,
    message: `${method}() without options object may use host timezone (wrong on cloud). Add { timeZone } option. See docs/project/TIMEZONE_AND_DATE_HANDLING_IN_MCPS.md`,
  })),
];

// Fire-and-forget guard: ban `void submitQueuedMessage(...)` etc.
// Use fireAndForget() from @shared/utils instead.
// See: docs/plans/260415_fire_and_forget_utility.md
const fireAndForgetGuardSelectors = [
  {
    selector: "UnaryExpression[operator='void'] > CallExpression[callee.name='submitQueuedMessage']",
    message: "Use fireAndForget(submitQueuedMessage(...), 'label') instead of void. Bare void swallows async rejections.",
  },
  {
    selector: "UnaryExpression[operator='void'] > CallExpression[callee.name='handleUserMessage']",
    message: "Use fireAndForget(handleUserMessage(...), 'label') instead of void. Bare void swallows async rejections.",
  },
  {
    selector: "UnaryExpression[operator='void'] > CallExpression[callee.property.name='current'][callee.object.name='submitQueuedMessageRef']",
    message: "Use fireAndForget(submitQueuedMessageRef.current?.(...), 'label') instead of void.",
  },
  {
    selector: "UnaryExpression[operator='void'] > CallExpression[callee.property.name='current'][callee.object.name='handleUserMessageRef']",
    message: "Use fireAndForget(handleUserMessageRef.current?.(...), 'label') instead of void.",
  },
  {
    // Optional chaining variant: void submitQueuedMessageRef.current?.(...)
    // AST: UnaryExpression > ChainExpression > CallExpression > MemberExpression
    selector: "UnaryExpression[operator='void'] > ChainExpression > CallExpression[callee.property.name='current'][callee.object.name='submitQueuedMessageRef']",
    message: "Use fireAndForget(submitQueuedMessageRef.current?.(...), 'label') instead of void.",
  },
  {
    // Optional chaining variant: void handleUserMessageRef.current?.(...)
    selector: "UnaryExpression[operator='void'] > ChainExpression > CallExpression[callee.property.name='current'][callee.object.name='handleUserMessageRef']",
    message: "Use fireAndForget(handleUserMessageRef.current?.(...), 'label') instead of void.",
  },
];

const directWriteFileGuardSelector = {
  selector: "MemberExpression[object.object.name='window'][object.property.name='libraryApi'][property.name='writeFile']",
  message: 'Use writeFileOrFail() from @renderer/utils/libraryWrites instead of calling window.libraryApi.writeFile directly. The wrapper handles failed envelopes uniformly. See docs/plans/260429_document_io_class_a_batch_2_5_structural_consolidation.md for context.',
};

// Stage 1B of docs/plans/260518_spaces_data_centralisation.md.
// All renderer Spaces data reads must go through useSpacesData / fetchSpaces /
// getSpacesSnapshotFor so the shared renderer cache remains the single source
// of truth. Tests are exempt by the test override below; the hook itself uses
// a typed window cast that this direct-call selector intentionally does not
// match.
const directLibraryScanSpacesGuardSelector = {
  selector: "MemberExpression[object.object.name='window'][object.property.name='libraryApi'][property.name='scanSpaces']",
  message: 'Direct window.libraryApi.scanSpaces reads are forbidden in renderer production code. Use useSpacesData(), fetchSpaces(), or getSpacesSnapshotFor() from @renderer/hooks/useSpacesData so Spaces data has one cache/source of truth.',
};

// Stage 6 of docs/plans/260504_cloud_connection_reconciler.md — prevent
// re-introducing side-channel writes to the cloudInstance status fields that
// the CloudConnectionReconciler owns as the single writer.
//
// Companion guard (PM 260608, family cloud_instance_multiwriter_drift): forbid
// any object literal that pairs `mode: 'local'` with a `cloudUrl`/`cloudToken`
// field. That is the persisted-drift signature that stranded a live cloud on
// "Offline (queued)" — disconnect must route through the canonical
// clearCloudInstanceLocally() / CLOUD_INSTANCE_CLEARED full wipe (which sets
// cloudUrl/cloudToken to undefined), never hand-build a local-mode record that
// carries live credentials. The 260504 guard above wired single-writer for
// `cloudInstance.status` but not `mode`/`cloudUrl`, which is exactly where the
// 260608 recurrence lived. The canonical wipe const and the deliberate
// drift-input test fixtures carry per-line overrides.
//
// KNOWN LIMITATION (acknowledged by design — do NOT lean on this guard as
// complete): this selector matches ONLY the literal object-literal property
// form (`{ mode: 'local', cloudUrl, cloudToken }`). It deliberately does NOT
// catch spread-resurrection (`{ ...cloud, mode: 'local' }`), computed/string
// keys, or a variable `mode`, all of which can re-introduce the same
// stale-creds-in-local-mode drift. A sound `no-restricted-syntax` selector for
// arbitrary spread resurrection is not achievable without high false-positive
// risk (any `{ ...x, mode: 'local' }` would trip regardless of whether `x`
// carries creds), so we keep the lint guard narrow on purpose. The REAL
// structural defense against this bug class is the runtime chokepoint, not the
// linter: the canonical `clearCloudInstanceLocally()` / CLOUD_INSTANCE_CLEARED
// full wipe (the single teardown writer — Stage 2 generation guard) plus the
// honest-result handling in the renderer (Stage 1), which together make a
// local-mode record carrying live creds unreachable through the real teardown
// path. This selector is a cheap secondary tripwire for the literal hand-built
// form, not the primary guarantee.
const cloudInstanceLocalModeDriftSelectors = ['cloudUrl', 'cloudToken'].map(field => ({
  selector: `ObjectExpression:has(Property[key.name='mode'][value.value='local']):has(Property[key.name='${field}'])`,
  message: `Object literal pairs cloudInstance mode:'local' with ${field} — that is the persisted-drift state (mode:'local' carrying live credentials) that strands the UI on "Offline (queued)". Route teardown through clearCloudInstanceLocally() / CLOUD_INSTANCE_CLEARED (full wipe) instead of hand-building a local-mode record with creds. Sanctioned sole writer overrides per-line: // eslint-disable-next-line no-restricted-syntax -- cloud-instance-clear-justified: <reason>. See docs-private/postmortems/260608_cloud_teardown_stall_and_drift_postmortem.md.`,
}));

const cloudInstanceStatusDirectWriteSelectors = [
  ...['lastError', 'lastKnownStatus', 'lastSyncedAt'].map(field => ({
    selector: `CallExpression[callee.name='updateSettings'] > ObjectExpression > Property[key.name='cloudInstance'] > ObjectExpression > Property[key.name='${field}']`,
    message: 'Direct write to cloudInstance status fields (lastError, lastKnownStatus, lastSyncedAt) is forbidden outside the CloudConnectionReconciler. Use cloudConnectionReconciler.reconcile() / reportSuccess() / reportFailure() instead. See REBEL-568 postmortem and docs/plans/260504_cloud_connection_reconciler.md.',
  })),
  ...['lastError', 'lastKnownStatus', 'lastSyncedAt'].map(field => ({
    selector: `CallExpression[callee.property.name='updateSettings'] > ObjectExpression > Property[key.name='cloudInstance'] > ObjectExpression > Property[key.name='${field}']`,
    message: 'Direct write to cloudInstance status fields (lastError, lastKnownStatus, lastSyncedAt) is forbidden outside the CloudConnectionReconciler. Use cloudConnectionReconciler.reconcile() / reportSuccess() / reportFailure() instead. See REBEL-568 postmortem and docs/plans/260504_cloud_connection_reconciler.md.',
  })),
  ...cloudInstanceLocalModeDriftSelectors,
];

// Stage 3 of docs/plans/260610_recs-round3-recent/PLAN.md:
// `BrowserWindow.getAllWindows()` is too blunt for renderer-bound action
// targeting: it can choose hidden utility/export windows, silently drop when no
// main window exists, and race renderer reloads. Prefer an injected main-window
// getter/ensure capability for targeted sends, or BroadcastService for genuine
// all-window events. Existing scans are deliberately audited with per-line
// disable comments so the allowlist is visible and shrinkable.
// See docs-private/postmortems/260610_notification_click_conversation_navigation_postmortem.md.
const rendererWindowTargetGetAllWindowsSelectors = [
  {
    selector: "CallExpression[callee.property.name='getAllWindows'][callee.object.name='BrowserWindow']",
    message: "BrowserWindow.getAllWindows() is forbidden in src/main/** without an audited allowlist. Use an injected main-window getter/ensure capability for targeted renderer sends, or BroadcastService for real broadcasts. Override per-line: // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: <reason + migrate-later disposition>. See docs-private/postmortems/260610_notification_click_conversation_navigation_postmortem.md.",
  },
  {
    selector: "CallExpression[callee.property.name='getAllWindows'][callee.object.property.name='BrowserWindow']",
    message: "BrowserWindow.getAllWindows() is forbidden in src/main/** without an audited allowlist. Use an injected main-window getter/ensure capability for targeted renderer sends, or BroadcastService for real broadcasts. Override per-line: // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: <reason + migrate-later disposition>. See docs-private/postmortems/260610_notification_click_conversation_navigation_postmortem.md.",
  },
];

// Stage 4 of docs/plans/260610_recs-round3-recent/PLAN.md:
// provider error classification must be structured-fields-first. New
// status-literal -> kind branches and bare single-word billing substrings
// belong in the explicitly named classifyByStatusHeuristics() fallback, not in
// the primary classifier path. The fallback uses switch(status), so these
// selectors can stay focused on reintroduced status-first if/assignment shapes.
const providerErrorClassifierGuardSelectors = [
  {
    selector: "IfStatement[test.type='BinaryExpression'][test.operator='==='][test.left.name='status'][test.right.type='Literal']:has(ReturnStatement ObjectExpression > Property[key.name='kind'])",
    message: "Provider error classification must inspect structured provider type/code before status heuristics. Move status-literal kind returns into classifyByStatusHeuristics(), and add/extend the provider error body corpus. Override only with: // eslint-disable-next-line no-restricted-syntax -- provider-error-fallback-justified: <reason>. See docs-private/postmortems/260607_provider_error_misclassification_403_billing_postmortem.md.",
  },
  {
    selector: "IfStatement[test.type='BinaryExpression'][test.operator='==='][test.left.name='status'][test.right.type='Literal']:has(AssignmentExpression[left.name='kind'])",
    message: "Provider error classification must not assign ModelError.kind from a bare status branch outside the named fallback. Classify by ProviderErrorShape first, then use classifyByStatusHeuristics(). Override only with: // eslint-disable-next-line no-restricted-syntax -- provider-error-fallback-justified: <reason>.",
  },
  {
    selector: "Literal[value='credits']",
    message: "Do not add a bare 'credits' classifier substring in modelErrors.ts. Use structured provider fields first and keep billing text heuristics in friendlyErrors.ts / classifyByStatusHeuristics with corpus coverage.",
  },
];

// Routing-state writer guard (PM 260601): parent execution state has exactly
// one writer (`activeExecution.commit`), and task routing badges must preserve
// the parent-route/display-overlay split. The selectors live in
// eslint-rules/routing-state-writer-selectors.mjs (SSOT) so the regression test
// (rebelCoreQuery.routingStateWriterLint.test.ts) lints the exact same selectors
// this config applies — imported at the top of this file.

// Stage 5 of docs/plans/260610_improve-sentry-noise/PLAN.md — raw info-level
// captures are forbidden. The PRIMARY guard is type-level
// (ErrorReporterCaptureContext / MainMessageCaptureContext exclude 'info');
// these selectors are the backstop for casts and dynamic call shapes the
// type system can't see. Info telemetry goes through captureKnownCondition
// (registry `sink` policy: ledger-only vs issue-stream) or breadcrumbs/the
// diagnostic ledger. addBreadcrumb({ level: 'info' }) is fine and not matched
// (different callee name). Spread into knownStructuredErrorCaptureSelectors
// (src/core + src/main/services + cloud-service blocks) AND standalone into
// the src/core+src/main block that doesn't carry that family.
const rawInfoCaptureGuardSelectors = [
  {
    selector: "CallExpression[callee.property.name=/^(captureMessage|captureException)$/] ObjectExpression > Property[key.name='level'] > Literal[value='info']",
    message: "Raw info-level Sentry captures are forbidden — info is telemetry, not an issue. Use captureKnownCondition() with a registry entry (sink: 'ledger-only' for pure telemetry, 'issue-stream' only with a reviewed justification) or a breadcrumb/log. See docs/project/ERROR_MONITORING_AND_SENTRY.md and docs/plans/260610_improve-sentry-noise/PLAN.md Stage 5. To override (rare): // eslint-disable-next-line no-restricted-syntax -- raw-info-capture-justified: <reason>",
  },
  {
    selector: "CallExpression[callee.name=/^(captureMainMessage|captureMainMessageWithLogs|captureMainException)$/] ObjectExpression > Property[key.name='level'] > Literal[value='info']",
    message: "Raw info-level Sentry captures are forbidden — info is telemetry, not an issue. Use captureKnownCondition() with a registry entry (sink: 'ledger-only' for pure telemetry, 'issue-stream' only with a reviewed justification) or a breadcrumb/log. See docs/project/ERROR_MONITORING_AND_SENTRY.md and docs/plans/260610_improve-sentry-noise/PLAN.md Stage 5. To override (rare): // eslint-disable-next-line no-restricted-syntax -- raw-info-capture-justified: <reason>",
  },
];

const knownStructuredErrorCaptureSelectors = [
  {
    // Stage 5 of docs/plans/260503_sentry_capture_contract.md.
    // Catches literal-instance captures of known structured-error classes
    // (ModelError, CodexDisconnectedBtsError). Variable-based captures
    // fall through to the Layer-2 runtime guard at src/core/errorReporter.ts.
    // See docs-private/postmortems/260424_sentry_model_error_fingerprint_fragmentation_postmortem.md
    // and docs-private/postmortems/260427_codex_disconnected_bts_sentry_fragmentation_postmortem.md.
    // To override: '// eslint-disable-next-line no-restricted-syntax -- captureException-justified: <reason>'
    // Wave 2 follow-up: type-aware lint for variable-based captures after
    // the current runtime-guard ratchet has soaked.
    selector: "CallExpression[callee.property.name='captureException'][arguments.0.type='NewExpression'][arguments.0.callee.name=/^(ModelError|CodexDisconnectedBtsError)$/]",
    message: 'Use captureKnownCondition() for known structured errors. See docs/project/ERROR_MONITORING_AND_SENTRY.md (Known Condition Registry section) and src/core/sentry/captureKnownCondition.ts. To override (rare): // eslint-disable-next-line no-restricted-syntax -- captureException-justified: <reason>',
  },
  {
    // LOCKSTEP-ANCHOR: regex below mirrors the KnownCondition union members in
    // src/core/sentry/knownConditions.ts. CI parity check at
    // scripts/check-known-conditions.ts (checkLintRegexParity) anchors regex
    // extraction on this exact "LOCKSTEP-ANCHOR:" comment marker — do not
    // remove or rename it without updating the parity check. To add a new
    // condition: (1) add it to the union and KNOWN_CONDITIONS in
    // knownConditions.ts; (2) add it to the regex below; (3) regenerate the
    // snapshot via npm run regenerate:known-conditions-snapshot.
    selector: "CallExpression[callee.property.name='captureException'] ObjectExpression > Property[key.name='tags'] > ObjectExpression > Property[key.name='condition'][value.type='Literal'][value.value=/^(model_error|codex_disconnected_bts|codex_auth_destructive_disconnect|codex_proxy_claude_leak|codex_proxy_unsupported_model|runtime_activity_mapper_failure|cloud_outbox_stuck|bts_profile_missing|bts_summary_failure|bts_quip_failure|bts_warmup_failure|bridge_recent_events_failure|bridge_recent_logs_failure|bridge_log_file_paths_failure|pass_through_redaction_policy|conversation_title_unavailable|time_saved_unavailable|bts_structured_output_fallback|recovery_tool_input_too_large|recovery_managed_model_not_allowed|recovery_billing_quota|recovery_empty_result_anomaly|recovery_pause_detection_missed|recovery_unknown_error|recovery_pipeline_summary_generation_failed|recovery_pipeline_agent_loop_error_before_recovery|recovery_pipeline_agent_loop_error_after_recovery|recovery_pipeline_long_context_fallback_failed|recovery_pipeline_depth_limit_reached|recovery_pipeline_attempt_limit_reached|recovery_pipeline_no_qualifying_profile|recovery_pipeline_rate_limited|recovery_pipeline_no_messages_to_compact|agent_watchdog_self_resolved|agent_watchdog_stalled|agent_watchdog_auto_abort|all_providers_unreachable|cloud_connection_degraded|cloud_connection_degraded_escalated|cloud_connection_recovered|microsoft_oauth_no_pending_callback|providers_reachability_recovered|cloud_sync_boot_rehab_summary|cloud_sync_tombstone_applied|cloud_pressure_capability_missing|fd_pressure_elevated|fd_pressure_critical|sentry_oversized_event_detected|cloud_self_update_credentials_missing|quit_deadlock_detected|update_external_force_kill_fired|file_index_fts_degraded|file_index_semantic_search_failed|route_tag_gate_model_mismatch|route_facts_binding_mismatch|session_index_collapse_detected|corrupt_session_file_skipped)$/]",
    message: "Use captureKnownCondition() for known-condition captures (matched tags.condition literal). See docs/project/ERROR_MONITORING_AND_SENTRY.md (Known Condition Registry section) and src/core/sentry/captureKnownCondition.ts. To override (rare): // eslint-disable-next-line no-restricted-syntax -- captureException-justified: <reason>",
  },
  ...rawInfoCaptureGuardSelectors,
];

// Wave 2c tombstone — captureSentryException was deleted from
// mobile/src/utils/sentry.ts. The legacy helper buried `context` under
// Sentry's `extra` field, which silently strips fingerprint/level/tags.
// All future mobile captures must go through `mobileErrorReporter.captureException`
// (the Stage-0-fixed adapter exported from the same file). Selector matches by
// `imported.name` so aliased imports (`import { captureSentryException as legacyCapture }`)
// also fire. See docs/plans/260503_wave2c_mobile_legacy_and_layer2_hardfail.md.
const mobileLegacyCaptureSentryExceptionSelector = {
  selector: "ImportDeclaration[source.value=/sentry$/] > ImportSpecifier[imported.name='captureSentryException']",
  message: 'captureSentryException was removed in Wave 2c (docs/plans/260503_wave2c_mobile_legacy_and_layer2_hardfail.md). Use mobileErrorReporter.captureException(err, ctx) instead — it passes context through to Sentry as a CaptureContext rather than burying it under `extra`. See mobile/src/utils/sentry.ts.',
};

// Stage 8 of docs/plans/260501_composer_tiptap_atmention_bugfix.md — composer
// surface lint guards. These rules forbid known footguns that bypass the
// override-enabled wire-format pipeline owned by `composerEditorFactory.ts` /
// `composerMarkdownExtensions.ts`. Scoped to `src/renderer/features/composer/**`
// production files only (test files are exempt because contract tests drive
// the editor directly to assert the wire-format invariants).
//
// Each rule's selector is object-name-agnostic by design (the H7 amendment in
// the plan): we forbid the call shape, not the variable name, so renames
// can't silently regress. The single legitimate `editor.getMarkdown()` call
// site lives inside `composerSnapshotCache.ts:getLayerASnapshot()` and uses
// per-line `// eslint-disable-next-line no-restricted-syntax` — that is the
// only sanctioned bypass anywhere in the composer feature.
// Stage 5 of docs-private/investigations/260505_composer_nbsp_recurrence.md —
// forbid silent `... as ComposerWireMarkdown` casts. The brand encodes the
// invariant "this string went through the canonical NBSP-family sanitiser";
// the only sanctioned cast sites are inside `toComposerWireMarkdown`
// (composer/utils/composerMarkdown.ts) which routes through
// `sanitiseCorruptedDraftText`, and `docToMarkdown`
// (composer/utils/promptDoc.ts) which serialises a sanitised TipTap doc.
// Both files override with per-line `// eslint-disable-next-line
// no-restricted-syntax` plus a reason comment naming this stage.
//
// Extracted into its own selector list so it can be applied to both the
// composer feature block AND the broader `src/**` block (covering App.tsx
// and any other surface that might import the brand).
const composerBrandCastGuardSelectors = [
  {
    selector: "TSAsExpression[typeAnnotation.typeName.name='ComposerWireMarkdown']",
    message: "Cast to ComposerWireMarkdown is forbidden. Mint via toComposerWireMarkdown() (or the sanctioned producers getCurrentPromptMarkdown / docToMarkdown). The brand encodes the NBSP-family sanitiser invariant; casting bypasses it and re-introduces the parent-state ingress bypass class. See docs-private/investigations/260505_composer_nbsp_recurrence.md Stage 5.",
  },
  {
    selector: "TSTypeAssertion[typeAnnotation.typeName.name='ComposerWireMarkdown']",
    message: "Type assertion to ComposerWireMarkdown is forbidden. Mint via toComposerWireMarkdown() (or the sanctioned producers getCurrentPromptMarkdown / docToMarkdown). The brand encodes the NBSP-family sanitiser invariant; asserting bypasses it and re-introduces the parent-state ingress bypass class. See docs-private/investigations/260505_composer_nbsp_recurrence.md Stage 5.",
  },
];

const composerCompositionGuardSelectors = [
  ...composerBrandCastGuardSelectors,
  {
    // Forbid direct `editor.getMarkdown()` calls. The audited entry point is
    // `getCurrentPromptMarkdown(editor)` (in TipTapPromptEditor.tsx) which
    // routes through the Layer A snapshot cache and brands the result as
    // `ComposerWireMarkdown`. Direct calls bypass the cache + brand and
    // re-introduce the H7 regression class.
    selector: "CallExpression[callee.property.name='getMarkdown']",
    message: "Direct editor.getMarkdown() is forbidden in src/renderer/features/composer/** — route through getCurrentPromptMarkdown() (which uses the Layer A snapshot cache and brands the result as ComposerWireMarkdown). Override with `// eslint-disable-next-line no-restricted-syntax` only in the wrapper itself. See docs/plans/260501_composer_tiptap_atmention_bugfix.md Stage 8.",
  },
  {
    // Forbid `editor.commands.setContent(_, { contentType: 'markdown' })` with
    // an inline-literal options object. That path uses marked.js parsing,
    // which doesn't understand the composer's wire format (no `&nbsp;`,
    // node-level overrides). Use `markdownToDoc(...)` which produces a
    // JSONContent we can pass to `setContent` as a doc tree.
    selector:
      "CallExpression[callee.property.name='setContent'] > ObjectExpression > Property[key.name='contentType'][value.value='markdown']",
    message: "Direct setContent({ contentType: 'markdown' }, ...) is forbidden in src/renderer/features/composer/** — that path uses marked.js parsing which doesn't understand the composer's wire format. Use markdownToDoc(...) and pass the resulting JSONContent doc tree to setContent instead. See docs/plans/260501_composer_tiptap_atmention_bugfix.md Stage 8.",
  },
  {
    // Best-effort: catch the aliased-options pattern, where `contentType:
    // 'markdown'` lives in a const and is then passed by reference. The
    // residual gap (cross-file/dynamically-built aliases) is documented
    // here; the Stage 2 contract test is the runtime safety net for the
    // residual case.
    selector:
      "VariableDeclarator > ObjectExpression > Property[key.name='contentType'][value.value='markdown']",
    message: "Aliased options object with `contentType: 'markdown'` detected. Direct markdown-content-type setContent is forbidden in src/renderer/features/composer/** — use markdownToDoc(...) instead. The Stage 2 contract test is the runtime backstop for cross-file/dynamic alias variants. See docs/plans/260501_composer_tiptap_atmention_bugfix.md Stage 8.",
  },
  {
    // Forbid `editor.markdown.parse(...)` (any object). Same reason as the
    // setContent guard: marked.js parsing doesn't honour the composer's
    // override-enabled wire format. Use `markdownToDoc(...)` which is the
    // single source of truth for input-side hydration.
    selector:
      "CallExpression[callee.object.property.name='markdown'][callee.property.name='parse']",
    message: "Direct editor.markdown.parse(...) is forbidden in src/renderer/features/composer/** — use markdownToDoc(...) which honours the composer's wire-format overrides. See docs/plans/260501_composer_tiptap_atmention_bugfix.md Stage 8.",
  },
];

// Bug 2 prevention (260616 stuck-library renderer-OOM) — agent-session
// `detail` parse guard. Tool/event `detail` carries unbounded tool output
// (file contents, search results, large MCP payloads, hundreds of MB on a big
// result). A bare `JSON.parse(detail)` materialises an equally large object
// graph and can push the renderer over V8's ~4 GB heap ceiling, crash-looping
// the renderer. This run migrated every agent-session call site to the
// size-guarded `safeParseDetail()` helper
// (src/renderer/features/agent-session/utils/safeParseDetail.ts), which refuses
// to parse anything above MAX_DETAIL_PARSE_BYTES BEFORE calling JSON.parse.
//
// This is a ZERO-BASELINE narrow ratchet: after the migration the agent-session
// surface has no direct `JSON.parse(detail)` left, so the rule fires on zero
// existing code. It is intentionally NOT repository-wide — the broader
// shared/main/core hits are a separate spun-out audit ("repository-wide bounded
// detail parser + lint audit"), not this guard. The canonical helper file
// itself (which legitimately calls `JSON.parse`) and test files are excluded by
// the block's `ignores` below.
//
// Object-name-agnostic by design: we forbid the call shape (a `detail`
// identifier argument, or a `*.detail` member argument), not a specific
// variable name, so renames can't silently regress.
const agentDetailParseGuardMessage =
  "Parse agent-event `detail` via safeParseDetail() (size-guarded) — direct JSON.parse of unbounded detail risks renderer OOM. See Bug 2 / docs-private/postmortems/260616_stuck_library_renderer_oom_postmortem.md. Override only at the canonical helper with: // eslint-disable-next-line no-restricted-syntax -- safe-parse-detail-helper-justified: <reason>.";
const agentDetailParseGuardSelectors = [
  {
    // JSON.parse(detail) — bare identifier named `detail`.
    selector: "CallExpression[callee.object.name='JSON'][callee.property.name='parse'] > Identifier.arguments[name='detail']",
    message: agentDetailParseGuardMessage,
  },
  {
    // JSON.parse(x.detail) / JSON.parse(event.detail) / JSON.parse(toolEvent.detail)
    // — a MemberExpression argument whose property is `detail`.
    selector: "CallExpression[callee.object.name='JSON'][callee.property.name='parse'] > MemberExpression.arguments[property.name='detail']",
    message: agentDetailParseGuardMessage,
  },
];

// Outbound-DNS resolver-choice guard (PM 260617 dns_threadpool_starvation +
// REBEL-6B6 resolver flip): any NEW undici dispatcher — a global one via
// `setGlobalDispatcher(...)` or a per-call `new Agent(...)` / `new UndiciAgent(...)`
// — MUST route through the centralized resolver choice in
// src/core/utils/dnsThreadpoolDecouple.ts. Desktop deliberately defaults to the
// OS resolver (`dns.lookup` / getaddrinfo) so VPN split-DNS is honored; c-ares
// remains opt-in for rollback/cloud. A dispatcher that rolls its own DNS policy
// can silently reintroduce either the 260617 threadpool-starvation class or the
// REBEL-6B6 VPN-bypass class. The governed call-sites today (the canonical helper
// itself and the MCP client's per-call Agent) carry per-line carve-outs because
// they are wired through that centralized selector. This is by design a tripwire,
// NOT proof the connect.lookup is wired: a pure selector cannot read the options
// object, so an intentional dispatcher must add a per-line override.
//
// `new Agent(` is broad-matched (object-name-agnostic) per repo precedent: there
// is no other class literally named `Agent` constructed in src/** or
// cloud-service/** today (grep-confirmed — no http.Agent/https.Agent either), and
// the message tells a legitimate future caller to disable-with-justification.
// Residual false-positive risk: a future non-undici `new Agent(...)` (e.g.
// http(s).Agent or another lib's Agent) would trip and need a carve-out comment.
//
// See docs-private/postmortems/260617_dns_threadpool_starvation_connect_timeouts_postmortem.md
// and src/core/utils/dnsThreadpoolDecouple.ts.
const dnsDecoupleGuardMessage =
  "Outbound undici dispatchers must route through the centralized DNS resolver choice in src/core/utils/dnsThreadpoolDecouple.ts (default OS resolver for VPN split-DNS; c-ares opt-in for rollback/cloud). Do not construct a new undici Agent / set a global dispatcher with ad-hoc DNS policy. An intentional dispatcher wired through that selector must add: // eslint-disable-next-line no-restricted-syntax -- dns-decouple-justified: <reason>. See docs-private/postmortems/260617_dns_threadpool_starvation_connect_timeouts_postmortem.md.";
const dnsThreadpoolDecoupleGuardSelectors = [
  {
    // setGlobalDispatcher(...) — bare call or member form (undici).
    selector: "CallExpression[callee.name='setGlobalDispatcher']",
    message: dnsDecoupleGuardMessage,
  },
  {
    selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='setGlobalDispatcher']",
    message: dnsDecoupleGuardMessage,
  },
  {
    // new Agent(...) / new UndiciAgent(...) — undici dispatcher construction.
    // Broad-match on the constructor name (object-name-agnostic) per repo
    // precedent; see the rationale comment above for the false-positive scope.
    selector: "NewExpression[callee.name=/^(Agent|UndiciAgent)$/]",
    message: dnsDecoupleGuardMessage,
  },
  {
    // new undici.Agent(...) / new ns.UndiciAgent(...) — namespace/member-form
    // construction that the bare-name NewExpression selector above misses
    // (e.g. `import * as undici from 'undici'; new undici.Agent(...)`).
    selector: "NewExpression[callee.type='MemberExpression'][callee.property.name=/^(Agent|UndiciAgent)$/]",
    message: dnsDecoupleGuardMessage,
  },
  {
    // import { Agent } / { Agent as Foo } from 'undici' — catches ALIASED
    // construction at the import site (local name is arbitrary, but
    // `imported.name` is the original undici export), which the NewExpression
    // name-match cannot see. Closes the by-construction false-negative.
    selector: "ImportDeclaration[source.value='undici'] ImportSpecifier[imported.name='Agent']",
    message: dnsDecoupleGuardMessage,
  },
  {
    // import { setGlobalDispatcher } from 'undici' — the global-install entry
    // point; flag the import (bare or aliased) outside the canonical module.
    selector: "ImportDeclaration[source.value='undici'] ImportSpecifier[imported.name='setGlobalDispatcher']",
    message: dnsDecoupleGuardMessage,
  },
  {
    // require('undici') — non-static acquisition (CJS / dynamic destructure,
    // e.g. `const { Agent: A } = require('undici'); new A(...)`). undici require
    // is unusual in src/** ESM, so a broad flag is acceptable per repo precedent.
    selector: "CallExpression[callee.name='require'][arguments.0.value='undici']",
    message: dnsDecoupleGuardMessage,
  },
  {
    // await import('undici') — dynamic import acquisition.
    selector: "ImportExpression[source.value='undici']",
    message: dnsDecoupleGuardMessage,
  },
  {
    // export { Agent as A } from 'undici' — re-export/barrel laundering of the
    // dispatcher constructors; flag it at the re-export source.
    selector: "ExportNamedDeclaration[source.value='undici'] ExportSpecifier[local.name=/^(Agent|setGlobalDispatcher)$/]",
    message: dnsDecoupleGuardMessage,
  },
];
// Governed surface: the app's outbound-HTTP code in `src/**` + `cloud-service/**`
// (everything that rides Node's global fetch / the MCP dispatcher). Bundled MCP
// subprocesses under `resources/mcp/**` are intentionally OUT of scope: they run
// as separate processes and connect to localhost (127.0.0.1, an IP literal — no
// public DNS resolution), so they can't trigger the threadpool-DNS-starvation class.

// Client factory guard: all AnthropicClient/OpenAIClient construction must go
// through clientFactory.ts to ensure correct route-plan-backed provider routing.
const directAnthropicConstructorSelector = {
  selector: "NewExpression[callee.name='Anthropic']",
  message: 'R4: do not construct the Anthropic SDK directly. Use clientFactory/ModelClient, or the canonical direct-plan helper in clients/anthropicClient.ts after ProviderRoutePlan gating. Whitelisted: clients/anthropicClient.ts, the BTS OAuth helper, and documented eval harness scaffolding.',
};

const clientFactoryGuardSelectors = [
  {
    selector: "NewExpression[callee.name='AnthropicClient']",
    message: 'Use createModelClient() or createClientForModel() from clientFactory instead of constructing AnthropicClient directly.',
  },
  {
    selector: "NewExpression[callee.name='OpenAIClient']",
    message: 'Use createModelClient() or createOpenAIClientFromProfile() from clientFactory instead of constructing OpenAIClient directly.',
  },
  directAnthropicConstructorSelector,
];

const clientFactoryGuardSelectorsWithoutDirectAnthropicConstructor = clientFactoryGuardSelectors
  .filter(selector => selector.selector !== directAnthropicConstructorSelector.selector);

// R4 ProviderRoutePlan hardening: routing files must not bypass the closed
// discriminated unions with broad casts or ts-comment escapes.
const providerRoutingTypeSafetySelectors = [
  {
    selector: "TSAsExpression[typeAnnotation.type='TSAnyKeyword']",
    message: 'R4 provider-routing guard: do not cast to any in routing code; narrow the type or extend the ProviderRoutePlan union instead.',
  },
  {
    selector: "TSTypeAssertion[typeAnnotation.type='TSAnyKeyword']",
    message: 'R4 provider-routing guard: do not assert any in routing code; narrow the type or extend the ProviderRoutePlan union instead.',
  },
  {
    selector: "TSAsExpression[typeAnnotation.typeName.name='ProviderRoutePlan']",
    message: 'R4 provider-routing guard: do not cast to ProviderRoutePlan; construct/materialize a real plan.',
  },
  {
    selector: "TSTypeAssertion[typeAnnotation.typeName.name='ProviderRoutePlan']",
    message: 'R4 provider-routing guard: do not assert ProviderRoutePlan; construct/materialize a real plan.',
  },
  {
    // Stage 5 (260604_routing-ssot-divergence): pin the killed sentinel-as-trigger
    // pattern in routing-engine files too (defined alongside the other selectors so
    // it is appended below; full rationale at planningSentinelGuardSelectors).
    selector:
      "CallExpression[callee.name=/^(resolveModelConfig|resolvePlanModeTarget|planModeTargetFromThinkingModel)$/] Identifier[name='PREFERRED_PLANNING_MODEL']",
    message:
      "Do not pass PREFERRED_PLANNING_MODEL into a model-resolution call (resolveModelConfig / resolvePlanModeTarget / planModeTargetFromThinkingModel) — that reintroduces the synthetic-sentinel-as-mode-trigger pattern that force-routed Claude to Anthropic-direct under a non-Anthropic provider (PM 260603_plan_mode_synthetic_claude_planning_sentinel_creds, REBEL-655; family REBEL-538/540). Request plan mode via the typed PlanModeTarget from a real role resolution. Override (rare, sanctioned fallback only): // eslint-disable-next-line no-restricted-syntax -- planning-sentinel-justified: <reason>. See docs/postmortems/260603_plan_mode_synthetic_claude_planning_sentinel_creds_postmortem.md.",
  },
];

// Planning-sentinel-as-mode-trigger guard (PM 260603_plan_mode_synthetic_claude_planning_sentinel_creds,
// REBEL-655 rec #3). Stage 1 of 260604_routing-ssot-divergence killed the pattern
// where the synthetic `PREFERRED_PLANNING_MODEL` ('claude-opus-4-8') was substituted
// positionally into a model-resolution call to *trigger plan mode* — which force-routed
// a Claude model to Anthropic-direct under a non-Anthropic provider with no key
// (REBEL-538/540/655, the recurring `provider_route_plan_missing_axis` family). Plan
// mode is now requested ONLY via the typed `PlanModeTarget` produced by
// `resolvePlanModeTarget` / `planModeTargetFromThinkingModel` from a REAL role
// resolution. This guard pins that kill: it flags `PREFERRED_PLANNING_MODEL` passed as
// a VALUE ARGUMENT into a model-resolution call (`resolveModelConfig`,
// `resolvePlanModeTarget`, `planModeTargetFromThinkingModel`) — reintroducing the
// sentinel-as-trigger. It deliberately does NOT flag the legitimate remaining uses of
// the constant as a fallback VALUE (auth-failure direct-client fallback, 1M downgrade,
// council lead, hero choice, settings-store seed) — those never pass it into a
// model-resolution call. The fallback producers that legitimately need to enter plan
// mode do so by handing the constant to `planModeTargetFromThinkingModel` via the typed
// gate, which decodes a real RoutingModelId — that path is intentionally NOT exempted
// (it must stay typed). If a genuinely-new sanctioned model-resolution caller ever needs
// the constant, override per-line:
//   // eslint-disable-next-line no-restricted-syntax -- planning-sentinel-justified: <reason>
// NOTE: this selector is intentionally SYNTAX-ONLY — it catches the direct-argument
// shape, not an aliased indirection (e.g. `const m = PREFERRED_PLANNING_MODEL;
// planModeTargetFromThinkingModel(m, ...)`). That is acceptable because the eslint rule
// is a tripwire, NOT the by-construction guard: the real kill is the typed PlanModeTarget
// (Stage 1 — the producer names the real thinking model or returns null) plus the typed
// eligibility/preflight results (Stages 2-3), which make an unservable auxiliary model a
// typed ineligible/unavailable result at runtime regardless of how the constant is routed.
const planningSentinelGuardSelectors = [
  {
    selector:
      "CallExpression[callee.name=/^(resolveModelConfig|resolvePlanModeTarget|planModeTargetFromThinkingModel)$/] Identifier[name='PREFERRED_PLANNING_MODEL']",
    message:
      "Do not pass PREFERRED_PLANNING_MODEL into a model-resolution call (resolveModelConfig / resolvePlanModeTarget / planModeTargetFromThinkingModel) — that reintroduces the synthetic-sentinel-as-mode-trigger pattern that force-routed Claude to Anthropic-direct under a non-Anthropic provider (PM 260603_plan_mode_synthetic_claude_planning_sentinel_creds, REBEL-655; family REBEL-538/540). Request plan mode via the typed PlanModeTarget from a real role resolution. Override (rare, sanctioned fallback only): // eslint-disable-next-line no-restricted-syntax -- planning-sentinel-justified: <reason>. See docs/postmortems/260603_plan_mode_synthetic_claude_planning_sentinel_creds_postmortem.md.",
  },
];

// Stage 1 guardrail for docs/plans/260507_model_resolver_and_output_cap_autolearn.md:
// forbid runtime role-resolution fallbacks that hardcode Claude literals.
const modelRoleFallbackGuardSelectors = [
  {
    selector: "LogicalExpression[operator='||'] > Literal[value=/^claude-/]",
    message: 'Do not hardcode Claude fallback literals in runtime role resolution. Use resolveDefaultModelForRole(...) and handle typed failures.',
  },
  {
    selector: "LogicalExpression[operator='??'] > Literal[value=/^claude-/]",
    message: 'Do not hardcode Claude fallback literals in runtime role resolution. Use resolveDefaultModelForRole(...) and handle typed failures.',
  },
  {
    selector: "AssignmentExpression[right.type='Literal'][right.value=/^claude-/]",
    message: 'Do not assign hardcoded Claude fallback literals in runtime role resolution. Use resolveDefaultModelForRole(...) instead.',
  },
  {
    selector: "ReturnStatement > Literal[value=/^claude-/]",
    message: 'Do not return hardcoded Claude fallback literals in runtime role resolution. Use resolveDefaultModelForRole(...) instead.',
  },
  {
    selector: "VariableDeclarator[init.type='Literal'][init.value=/^claude-/]",
    message: 'Do not seed runtime model defaults with hardcoded Claude literals. Resolve per-role models via resolveDefaultModelForRole(...).',
  },
];

// Navigation URL guard: forbid hand-built `rebel://`, `library://`, and
// legacy `workspace://` URLs
// with interpolation. Use `formatNavigationUrl` / `formatLibraryUrl` from
// `@shared/navigation/urlParser` instead so the schema stays centralized.
// See: docs/plans/260416_centralize_cross_surface_links.md
const navigationUrlGuardSelectors = [
  {
    selector: "TemplateLiteral[quasis.0.value.cooked=/^rebel:\\/\\//][expressions.length>0]",
    message: "Hand-built rebel:// URL. Use formatNavigationUrl() from @shared/navigation/urlParser so the schema stays centralized.",
  },
  {
    selector: "TemplateLiteral[quasis.0.value.cooked=/^library:\\/\\//][expressions.length>0]",
    message: "Hand-built library:// URL. Use formatLibraryUrl() from @shared/navigation/urlParser so the schema stays centralized.",
  },
  {
    selector: "TemplateLiteral[quasis.0.value.cooked=/^workspace:\\/\\//][expressions.length>0]",
    message: "Hand-built workspace:// URL. Use formatLibraryUrl() from @shared/navigation/urlParser. The workspace:// scheme is legacy — emit canonical rebel://library/ form instead.",
  },
];

// NOTE: Error dispatch guard (previously `errorDispatchGuardSelectors`) has
// been removed — superseded by the Stage 3 compile-time type-wall in
// `src/core/services/agentEventDispatcher.ts` which narrows `dispatchAgentEvent`
// to exclude `type: 'error'`. See
// docs/plans/260420_inline_error_dispatch_migration.md Stage 3-4.

// AutomationSchedule brand guard: the `& { __brand: 'AutomationSchedule' }`
// intersection is purely compile-time. It's load-bearing because every typed
// caller goes through AutomationSchedule.* constructors or fromUntrusted().
// Casting around the brand silently regresses the entire R6 invariant. The
// only sanctioned cast sites are inside `automationSchedule.ts` itself, after
// the canonical Zod parse. Use per-line `eslint-disable-next-line` comments
// there. See: docs/plans/260427_refactor_schedule_algebra.md
const automationScheduleBrandGuardSelectors = [
  {
    selector: "TSAsExpression[typeAnnotation.typeName.name='AutomationSchedule']",
    message: 'Forbidden cast to AutomationSchedule. Use AutomationSchedule.<branch>(...) constructors or AutomationSchedule.fromUntrusted(value, ctx) instead. The brand makes invalid states unrepresentable; casting bypasses this. See docs/project/AUTOMATIONS.md.',
  },
  {
    selector: "TSTypeAssertion[typeAnnotation.typeName.name='AutomationSchedule']",
    message: 'Forbidden type assertion to AutomationSchedule. Use AutomationSchedule.<branch>(...) constructors or AutomationSchedule.fromUntrusted(value, ctx) instead. See docs/project/AUTOMATIONS.md.',
  },
];

// R2 AgentEvent manifest guard: production code must not bypass the
// closed-strict manifest by casting arbitrary values or event-shaped objects
// to AgentEvent. Tests and src/shared/contracts/** are carved out below.
const agentEventVariantTypePattern = [
  'status',
  'assistant',
  'assistant_delta',
  'thinking_delta',
  'result',
  'tool',
  'error',
  'context_overflow',
  'compaction_started',
  'compaction_summary_ready',
  'compaction_retrying',
  'compaction_completed',
  'compaction_failed',
  'turn_superseded',
  'user_message',
  'warning',
  'user_question',
  'user_question_answered',
  'turn_started',
].join('|');

const agentEventConstructionGuardMessage = 'R2 AgentEvent construction guard: use `buildAgentEvent.<type>` from `src/shared/contracts/agentEventManifest.ts` once S2-C ships, or restrict casts to S2-A1 fixture-construction in `src/shared/contracts/*`.';

const rawAgentEventBroadcastGuardMessage =
  "Raw agent:event broadcasts must route through broadcastSequencedAgentEvent so sequenced renderer payloads require SequencedAgentEvent and assert seq at the boundary. The only raw webContents.send('agent:event', ...) site is dispatchRendererOnlyAgentEvent, which is intentionally unsequenced.";

const rawAgentEventBroadcastGuardSelectors = [
  {
    selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='sendToAllWindows'] Literal[value='agent:event']",
    message: rawAgentEventBroadcastGuardMessage,
  },
  {
    selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='send'][callee.object.type='MemberExpression'][callee.object.property.name='webContents'] Literal[value='agent:event']",
    message: rawAgentEventBroadcastGuardMessage,
  },
];

const agentEventConstructionGuardSelectors = [
  {
    selector: "TSAsExpression[typeAnnotation.type='TSTypeReference'][typeAnnotation.typeName.name='AgentEvent']:not(:has(> TSAsExpression[typeAnnotation.type='TSUnknownKeyword']))",
    message: agentEventConstructionGuardMessage,
  },
  {
    selector: "TSAsExpression[typeAnnotation.type='TSTypeReference'][typeAnnotation.typeName.name='AgentEvent']:has(> TSAsExpression[typeAnnotation.type='TSUnknownKeyword'])",
    message: agentEventConstructionGuardMessage,
  },
  {
    selector: "TSAsExpression[typeAnnotation.type='TSArrayType'][typeAnnotation.elementType.type='TSTypeReference'][typeAnnotation.elementType.typeName.name='AgentEvent']",
    message: agentEventConstructionGuardMessage,
  },
  {
    selector: `TSAsExpression[typeAnnotation.type='TSTypeLiteral'] > TSTypeLiteral > TSPropertySignature[key.name='type'] TSLiteralType > Literal[value=/^(${agentEventVariantTypePattern})$/]`,
    message: agentEventConstructionGuardMessage,
  },
  // Keep this in the AgentEvent guard bundle because later flat-config
  // replacements already respread this bundle to preserve AgentEvent invariants.
  ...rawAgentEventBroadcastGuardSelectors,
];

// S7 single-emission-site invariant — the terminal-lifecycle RuntimeActivityEvent
// (`{ kind: 'lifecycle', subkind: 'aborted'|'cancelled'|'superseded',
// rawEventType: 'turn.aborted'|'turn.cancelled'|'turn.superseded' }`) must be
// constructed only inside `recordTerminalLifecycleActivity` in
// `src/main/services/agentTurnExecutor.ts`. Any other site re-introduces the
// REBEL-1AD recurrence class (out-of-band terminal lifecycle emission), which
// caused three regressions in March 2026 before S7 closed it structurally.
//
// LOCKSTEP-ANCHOR: terminal-subkind regex below mirrors the closed terminal
// subkinds in the `RuntimeActivityEvent` union in
// `src/core/rebelCore/runtimeActivity.ts`. If a new terminal subkind is added
// (e.g. `'failed'`), update this regex in lockstep.
//
// To override (canonical helper sites only):
//   // eslint-disable-next-line no-restricted-syntax -- terminal-lifecycle-emission-justified: <reason>
//
// See docs/plans/260503_s7_runtime_activity_event_migration_completion.md
// and docs/plans/260503_post_wave1_invariant_locking_bundle.md (Stage 1).
const terminalLifecycleEmissionGuardSelectors = [
  {
    selector: "ObjectExpression:has(> Property[key.name='kind'][value.value='lifecycle']):has(> Property[key.name='subkind'][value.type='Literal'][value.value=/^(aborted|cancelled|superseded)$/])",
    message: "Terminal-lifecycle RuntimeActivityEvent (kind: 'lifecycle' + subkind: 'aborted'|'cancelled'|'superseded') must be emitted via recordTerminalLifecycleActivity in src/main/services/agentTurnExecutor.ts. Any other site re-introduces the REBEL-1AD recurrence class. See docs/plans/260503_s7_runtime_activity_event_migration_completion.md. To override (canonical helper only): // eslint-disable-next-line no-restricted-syntax -- terminal-lifecycle-emission-justified: <reason>",
  },
];

// Stage 2 of docs/plans/260503_unified_recovery_pipeline.md — counter-axes
// structural fence. The unified recovery pipeline preserves TWO orthogonal
// counter axes (MAX_COMPACTION_ATTEMPTS = within-API-loop retries,
// MAX_COMPACTION_DEPTH = cross-resetConversation retries). Both must be
// canonically declared in src/core/utils/compactionUtils.ts only; no other
// file may declare local shadows.
const compactionCounterShadowGuardMessage =
  'Stage 2 counter-axes fence: MAX_COMPACTION_DEPTH and MAX_COMPACTION_ATTEMPTS are canonically declared in src/core/utils/compactionUtils.ts. Local shadows silently re-introduce the cross-layer drift bug (renderer = 2 vs IPC = 3) that motivated the unified recovery pipeline rebuild. Import from @core/utils/compactionUtils instead. See docs/plans/260503_unified_recovery_pipeline.md § Stage 2.';

const compactionCounterShadowGuardSelectors = [
  // Match local (non-exported, non-imported) declarations only. Exported
  // canonical declarations live under ExportNamedDeclaration > VariableDeclaration;
  // importing the canonical constants is the intended path.
  {
    selector: ":not(ExportNamedDeclaration) > VariableDeclaration > VariableDeclarator[id.type='Identifier'][id.name=/^MAX_COMPACTION_(DEPTH|ATTEMPTS|RECOVERY_)/]",
    message: compactionCounterShadowGuardMessage,
  },
];

// Stage 1 guardrail for docs/plans/260504_unified_provider_model_presentation.md:
// ban direct `{ claude } = settings` destructuring in production code so new
// call sites use the provider-neutral `models` namespace (or accessors).
//
// Stage 4 follow-up of 260505_canonical_settings_accessor_and_lint_enforced_read_path:
// also ban `{ models } = settings` destructuring, mirroring the `.claude`
// destructure guard. Closes the destructuring escape hatch for the parallel
// `.models.*` member-access ban (which is necessarily scoped to literal
// `settings.models` to avoid collisions with unrelated `.models` access in
// provider catalogs, test payloads, etc. — see canonical settings plan
// Stage 4 results for the trade-off rationale).
const modelsNamespaceDestructureGuardSelectors = [
  {
    selector: "Property[key.name='claude'][parent.type='ObjectPattern']",
    message: 'Do not destructure `claude` from settings. Use `models` (preferred) or settings accessors from @core/rebelCore/settingsAccessors.',
  },
  {
    selector: "Property[key.name='models'][parent.type='ObjectPattern']",
    message: 'Do not destructure `models` from settings. Use per-field accessors from @core/rebelCore/settingsAccessors (or @shared/utils/modelSettingsResolver resolveEffectiveModelSettings) so future settings-shape evolutions do not silently drop fields.',
  },
  {
    selector: "LogicalExpression[operator='??'][left.type='MemberExpression'][left.object.type='Identifier'][left.object.name='settings'][left.property.type='Identifier'][left.property.name='models'][right.type='MemberExpression'][right.object.type='Identifier'][right.object.name='settings'][right.property.type='Identifier'][right.property.name='claude']",
    message: 'Do not use whole-block `settings.models ?? settings.claude` fallback. Use resolveModelSettings()/per-field accessors so partial models docs do not drop fields.',
  },
];

// Stage 1 of docs/plans/260505_typed_provider_capability_matrix.md:
// block ad-hoc `providerType === '<literal>'` and `target.kind === '<literal>'`
// gates in shared client primitives. Per-feature predicates live in
// `src/core/rebelCore/providerFeatureGuards.ts`. The plan's [BUG-PREVENTION]
// rationale: 4 bugs (B/C/D/E) shipped in 2-3 weeks, all from ad-hoc literal
// gates added without a typed contract. Selectors close the dominant shapes
// (`===`, `!==`, switch, Set/Array membership). The bare-identifier shape
// (`providerType === 'X'` with `providerType` as a function parameter) is an
// acknowledged hole; future agents' instinct is `this.providerType`/`obj.kind`
// (member-access) when adding methods, which IS caught.
//
// Scope is applied via a dedicated files-block at the bottom of this config
// (see "providerFeatureGate scope" comment) — clients/**, planningMode.ts,
// and behindTheScenesClient.ts. Excluded by file scope: clientFactory.ts,
// providerRouting.ts, providerRouteDecision.ts, providerFeatureGuards.ts.
//
// Override (rare; legitimate non-routing `kind === '<literal>'` discriminator
// such as error/auth kind in BTS):
//   // eslint-disable-next-line no-restricted-syntax -- non-routing kind discriminator: <reason>
const providerFeatureGateGuardSelectors = [
  {
    selector: "BinaryExpression[operator='==='][left.property.name='providerType'][right.type='Literal']",
    message: "Protocol feature gates must read from a predicate in `src/core/rebelCore/providerFeatureGuards.ts`, not `<obj>.providerType === '<literal>'`. Routing decisions belong in `clientFactory.ts` (excluded). See docs/plans/260505_typed_provider_capability_matrix.md.",
  },
  {
    selector: "BinaryExpression[operator='!=='][left.property.name='providerType'][right.type='Literal']",
    message: "Protocol feature gates must read from a predicate in `src/core/rebelCore/providerFeatureGuards.ts`, not `<obj>.providerType !== '<literal>'`. See docs/plans/260505_typed_provider_capability_matrix.md.",
  },
  {
    selector: "BinaryExpression[operator='==='][left.property.name='kind'][right.type='Literal']",
    message: "Provider feature gates must dispatch via a predicate in `src/core/rebelCore/providerFeatureGuards.ts`, not `<obj>.kind === '<literal>'`. Override for legitimate non-routing kind discriminators (error/auth kind): // eslint-disable-next-line no-restricted-syntax -- non-routing kind discriminator: <reason>. See docs/plans/260505_typed_provider_capability_matrix.md.",
  },
  {
    selector: "BinaryExpression[operator='!=='][left.property.name='kind'][right.type='Literal']",
    message: "Provider feature gates must dispatch via a predicate in `src/core/rebelCore/providerFeatureGuards.ts`, not `<obj>.kind !== '<literal>'`. Override for legitimate non-routing kind discriminators: // eslint-disable-next-line no-restricted-syntax -- non-routing kind discriminator: <reason>. See docs/plans/260505_typed_provider_capability_matrix.md.",
  },
  {
    selector: "SwitchStatement[discriminant.property.name='providerType']",
    message: "Protocol feature gates must dispatch via a predicate in `src/core/rebelCore/providerFeatureGuards.ts`. Switching on `<obj>.providerType` directly is the same anti-pattern as `<obj>.providerType === '<literal>'`. See docs/plans/260505_typed_provider_capability_matrix.md.",
  },
  {
    selector: "SwitchStatement[discriminant.property.name='kind']",
    message: "Provider feature gates must dispatch via a predicate in `src/core/rebelCore/providerFeatureGuards.ts`. Switching on `<obj>.kind` directly is the same anti-pattern as `<obj>.kind === '<literal>'`. See docs/plans/260505_typed_provider_capability_matrix.md.",
  },
  {
    selector: "CallExpression[callee.property.name='has'] > MemberExpression[property.name='providerType']",
    message: "Set/Map membership keyed on `<obj>.providerType` is forbidden — add a predicate in `src/core/rebelCore/providerFeatureGuards.ts` instead. See docs/plans/260505_typed_provider_capability_matrix.md.",
  },
  {
    selector: "CallExpression[callee.property.name='has'][arguments.0.type='Identifier'][arguments.0.name='providerType']",
    message: "Set/Map membership keyed on a bare `providerType` identifier is forbidden — add a predicate in `src/core/rebelCore/providerFeatureGuards.ts` instead. Override for legitimate non-feature-gate routing allowlists: // eslint-disable-next-line no-restricted-syntax -- routing-decision: <reason>. See docs/plans/260505_typed_provider_capability_matrix.md.",
  },
  {
    selector: "CallExpression[callee.property.name='includes'] > MemberExpression[property.name='providerType']",
    message: "Array membership keyed on `<obj>.providerType` is forbidden — add a predicate in `src/core/rebelCore/providerFeatureGuards.ts` instead. See docs/plans/260505_typed_provider_capability_matrix.md.",
  },
  {
    selector: "CallExpression[callee.property.name='includes'][arguments.0.type='Identifier'][arguments.0.name='providerType']",
    message: "Array membership keyed on a bare `providerType` identifier is forbidden — add a predicate in `src/core/rebelCore/providerFeatureGuards.ts` instead. Override for legitimate non-feature-gate routing allowlists: // eslint-disable-next-line no-restricted-syntax -- routing-decision: <reason>. See docs/plans/260505_typed_provider_capability_matrix.md.",
  },
];

// Stage 2 amendment of docs/plans/260519_unify_meeting_save_paths.md:
// preserve all pre-existing project-wide no-restricted-syntax selectors in
// the kernel allowlist while omitting only the emit/defer selectors.
const meetingEmitBaseRestrictedSelectors = [
  ...pinoArgOrderSelectors,
  ...clientFactoryGuardSelectors,
  ...fireAndForgetGuardSelectors,
  ...timezoneUnsafeSelectors,
  ...navigationUrlGuardSelectors,
  ...automationScheduleBrandGuardSelectors,
  ...agentEventConstructionGuardSelectors,
  ...cleanupBypassGuardSelectors,
  ...knownStructuredErrorCaptureSelectors,
  ...modelsNamespaceDestructureGuardSelectors,
  ...cloudInstanceStatusDirectWriteSelectors,
  ...rendererWindowTargetGetAllWindowsSelectors,
  ...terminalLifecycleEmissionGuardSelectors,
  ...nativeBindingImportGuardSelectors,
];

const meetingEmitBaseRestrictedSelectorsWithoutReadlineGuard =
  meetingEmitBaseRestrictedSelectors.filter((selector) =>
    !readlineOwnedStreamGuardSelectors.includes(selector),
  );

const providerRoutingGuardRules = {
  'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...clientFactoryGuardSelectors, ...fireAndForgetGuardSelectors, ...timezoneUnsafeSelectors, ...navigationUrlGuardSelectors, ...automationScheduleBrandGuardSelectors, ...providerRoutingTypeSafetySelectors, ...agentEventConstructionGuardSelectors, ...cleanupBypassGuardSelectors, ...knownStructuredErrorCaptureSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...terminalLifecycleEmissionGuardSelectors, ...nativeBindingImportGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
  '@typescript-eslint/ban-ts-comment': ['error', {
    'ts-expect-error': true,
    'ts-ignore': true,
    'ts-nocheck': true,
    'ts-check': false,
    minimumDescriptionLength: 3,
  }],
};

const rebelRoutingPlugin = {
  rules: {
    'no-direct-dispatch-path-equality': noDirectDispatchPathEqualityRule,
  },
};

// Stage 6 of docs/plans/260514_openrouter_sonnet_bypass_remediation.md:
// guard against provider-blind `?? DEFAULT_MODEL` / `?? 'claude-sonnet-4-6'`
// fallbacks. The rule is scoped via a dedicated files-block further down so
// it applies to `src/main/services/**` + `src/shared/utils/**` -- the surface
// where the original Sonnet bypass shipped. The rule's own allowlist
// (NO_DEFAULT_MODEL_LITERAL_ALLOWLIST) exempts three documented files;
// extending that allowlist is gated by the regression test in
// `eslint-rules/__tests__/no-default-model-literal.test.js`.
const noDefaultModelLiteralPlugin = {
  rules: {
    'no-default-model-literal': noDefaultModelLiteralRule,
  },
};

const spaceScanGuardPlugin = {
  rules: {
    'no-disallowed-scanspaces-side-effects': noDisallowedScanSpacesSideEffectsRule,
  },
};

const btsFlowShapePlugin = {
  rules: {
    'no-raw-bts-model-read': noRawBtsModelReadRule,
    'no-model-brand-casts': noModelBrandCastsRule,
    'no-model-error-catch-clobber': noModelErrorCatchClobberRule,
    'no-local-storage-prefix-redeclare': noLocalStoragePrefixRedeclareRule,
  },
};

const assertNeverPlugin = {
  rules: {
    'no-local-assert-never': noLocalAssertNeverRule,
  },
};

const derivedLivenessBrandPlugin = {
  rules: {
    'no-derived-liveness-cast': noDerivedLivenessCastRule,
  },
};

const livenessScalarWritePlugin = {
  rules: {
    'no-raw-turn-liveness-scalars': noRawTurnLivenessScalarsRule,
  },
};

const silentSwallowPlugin = {
  rules: {
    'no-silent-swallow': noSilentSwallowRule,
  },
};

const nativeCleanupPlugin = {
  rules: {
    'no-undeferred-native-cleanup': noUndeferredNativeCleanupRule,
  },
};

const resultUsagePlugin = {
  rules: {
    'no-unused-result': noUnusedResultRule,
  },
};

const switchExhaustivenessPlugin = {
  rules: {
    'no-bare-default-bypass': noBareDefaultBypassRule,
  },
};

const sentryCaptureContractPlugin = {
  rules: {
    'no-dynamic-capture-message': noDynamicCaptureMessageRule,
  },
};

const startupDialogPlugin = {
  rules: {
    'no-raw-startup-dialog': noRawStartupDialogRule,
  },
};

const headlessCheckPlugin = {
  rules: {
    'no-raw-headless-check': noRawHeadlessCheckRule,
  },
};

// Wave G.1 continuity emitters have graduated from the migration exemption.
// Keep this set empty unless a future staged migration needs a temporary,
// explicitly reviewed carve-out.
const legacyContinuityBreadcrumbFiles = new Set([
]);

function normaliseLintPath(filename) {
  return String(filename ?? '').replaceAll('\\', '/');
}

function isLegacyContinuityBreadcrumbFile(filename) {
  const normalised = normaliseLintPath(filename);
  for (const suffix of legacyContinuityBreadcrumbFiles) {
    if (normalised.endsWith(suffix)) return true;
  }
  return false;
}

function isAddBreadcrumbCall(node) {
  return node?.callee?.type === 'MemberExpression' &&
    node.callee.property?.type === 'Identifier' &&
    node.callee.property.name === 'addBreadcrumb';
}

function findProperty(objectExpression, propertyName) {
  return objectExpression.properties.find(property =>
    property.type === 'Property' &&
    (
      (property.key.type === 'Identifier' && property.key.name === propertyName) ||
      (property.key.type === 'Literal' && property.key.value === propertyName)
    )
  );
}

function getLiteralPropertyValue(objectExpression, propertyName) {
  const property = findProperty(objectExpression, propertyName);
  if (!property) return null;
  const value = property.value;
  if (value.type === 'Literal' && typeof value.value === 'string') return value.value;
  if (value.type === 'TemplateLiteral' && value.expressions.length === 0) {
    return value.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function getEnclosingFunctionName(node) {
  let cursor = node.parent;
  while (cursor) {
    if (
      (cursor.type === 'FunctionDeclaration' || cursor.type === 'FunctionExpression') &&
      cursor.id?.type === 'Identifier'
    ) {
      return cursor.id.name;
    }
    if (
      cursor.type === 'VariableDeclarator' &&
      cursor.id?.type === 'Identifier'
    ) {
      return cursor.id.name;
    }
    cursor = cursor.parent;
  }
  return null;
}

function isContinuityBreadcrumbHelper(node) {
  const functionName = getEnclosingFunctionName(node);
  return functionName === 'recordDiagnosticContinuityBreadcrumb' ||
    functionName === 'appendDiagnosticContinuityBreadcrumb';
}

function getEnclosingBlock(node) {
  let cursor = node.parent;
  while (cursor) {
    if (cursor.type === 'BlockStatement') return cursor;
    cursor = cursor.parent;
  }
  return null;
}

const diagnosticsRulesPlugin = {
  rules: {
    'no-auto-loop-provider-probe': {
      meta: {
        type: 'problem',
        docs: {
          description: 'Prevent automatic polling of provider reachability',
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (
              node.callee &&
              node.callee.type === 'Identifier' &&
              (node.callee.name === 'setInterval' || node.callee.name === 'setTimeout')
            ) {
              const sourceCode = context.sourceCode;
              const text = sourceCode.getText(node);
              if (text.includes('probeProviderReachability')) {
                context.report({
                  node,
                  message: 'Do not auto-loop provider reachability probes. Cache invalidates on settings changes instead.',
                });
              }
            }
          }
        };
      }
    },
    'no-raw-continuity-breadcrumb': {
      meta: {
        type: 'problem',
        docs: {
          description: 'Require diagnostic ledger pairing for continuity breadcrumbs',
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (isLegacyContinuityBreadcrumbFile(context.filename)) return;
            if (!isAddBreadcrumbCall(node)) return;

            const [breadcrumbArg] = node.arguments;
            if (!breadcrumbArg || breadcrumbArg.type !== 'ObjectExpression') return;
            const category = getLiteralPropertyValue(breadcrumbArg, 'category');
            if (!category?.startsWith('continuity.')) return;
            if (isContinuityBreadcrumbHelper(node)) return;

            const sourceCode = context.sourceCode;
            const block = getEnclosingBlock(node);
            const blockText = block ? sourceCode.getText(block) : '';
            const paired = blockText.includes('appendDiagnosticEvent') &&
              blockText.includes('toDiagnosticContinuityTransition');
            if (paired) return;

            context.report({
              node,
              message: 'Continuity breadcrumbs must also append to the diagnostic ledger via toDiagnosticContinuityTransition().',
            });
          },
        };
      },
    },
  }
};

const rendererBaseRestrictedSyntaxSelectors = [
  ...pinoArgOrderSelectors,
  ...clientFactoryGuardSelectors,
  ...fireAndForgetGuardSelectors,
  directWriteFileGuardSelector,
  directLibraryScanSpacesGuardSelector,
  ...navigationUrlGuardSelectors,
  ...automationScheduleBrandGuardSelectors,
  ...agentEventConstructionGuardSelectors,
  ...cloudInstanceStatusDirectWriteSelectors,
  ...compactionCounterShadowGuardSelectors,
  ...modelsNamespaceDestructureGuardSelectors,
  ...composerBrandCastGuardSelectors,
  ...openHistorySessionGuardSelectors,
  ...flushSyncGuardSelectors,
  ...privateMindstoneRuntimeImportGuardSelectors,
];

// Media-preview origin guard (PM 260619_pdf_preview_blank_blob_file_origin, Stage 2).
// A renderer-created blob: URL (URL.createObjectURL) is origin-scoped; under the packaged
// `file://` origin it was the shape that left the in-app PDF preview a blank panel. Media
// previews must stream via the privileged `rebel-media://` protocol (origin-independent)
// — see getMediaProtocolUrl. The packaged boot-smoke's PDF gate proves the protocol works
// in the packaged app, but it fetches a *synthetic* URL: it would stay green if the real
// document-editor preview code regressed back to a renderer blob. This selector closes
// that gap by banning URL.createObjectURL across the document-editor feature, so a *new*
// file there cannot silently re-introduce the blob path the smoke can't see. Scoped to
// document-editor only (createObjectURL is legitimate elsewhere in the renderer).
const mediaPreviewBlobUrlGuardSelectors = [
  {
    selector: "CallExpression[callee.object.name='URL'][callee.property.name='createObjectURL']",
    message:
      'Do not build a renderer blob: URL (URL.createObjectURL) in the document-editor feature — ' +
      'a blob:/object URL is origin-scoped and left the packaged (file://) PDF preview blank ' +
      '(PM 260619_pdf_preview_blank_blob_file_origin). Stream the file via the privileged ' +
      'rebel-media:// protocol instead (getMediaProtocolUrl). Genuinely non-preview use ' +
      '(e.g. an image export/download): // eslint-disable-next-line no-restricted-syntax -- media-preview-blob-justified: <reason>.',
  },
];

// Same-process busy-wait guard for the session-persistence layer
// (PM 260618_quit_save_sync_lock_contention_dropped_final_save, rec 2 / implement_now).
// Selectors live in eslint-rules/busy-wait-persistence-guard-selectors.mjs (SSOT) so the
// regression test can lint the EXACT production selectors against a minimal non-type-aware
// config (the old test booted the full type-aware config via lintText() and flaked under
// parallel CI load). Scoped below to the persistence CONSUMER (lockedSessionPersistence.ts).

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      '**/dist/**',
      'out/**',
      'build/**',
      '**/build/**',
      'release/**',
      '.vite/**',
      '*.config.js',
      '*.config.cjs',
      '*.config.mjs',
      'forge.config.cjs',
      'scripts/**/*.js',
      'scripts/**/*.mjs',
      // scripts/ negative-rule fixtures — deliberately invalid TS exercised by
      // the custom-rule self-tests (switch-exhaustiveness, assertNever-
      // consolidation). Same treatment as the __lint_fixtures__ below: keep out
      // of `npm run lint` so the negative tests don't break CI.
      'scripts/**/__fixtures__/**',
      'resources/**',
      'rebel-system/**',
      'super-mcp/**',
      // R1 phase-to-phase rule negative fixtures — deliberately invalid; the
      // dedicated `turnPipelineLintFixtures.test.ts` runs ESLint over them
      // with `--no-ignore` to assert the rule fires. Keeping them out of
      // `npm run lint` prevents the negative tests from breaking CI.
      'src/main/services/turnPipeline/__lint_fixtures__/**',
      'src/main/services/__lint_fixtures__/**',
      'src/core/services/turnPipeline/__lint_fixtures__/**',
      'src/core/services/diagnostics/__lint_fixtures__/**',
      // Stage 2 of 260505_canonical_settings_accessor_and_lint_enforced_read_path:
      // negative lint fixtures for the models-namespace `claude` ban.
      'src/shared/utils/__lint_fixtures__/**',
      // Stage 1 of 260505_typed_provider_capability_matrix: negative lint
      // fixtures for the provider-feature-gate `providerType`/`kind` ban.
      'src/core/rebelCore/__lint_fixtures__/**',
      // Stage 2 of 260519_unify_meeting_save_paths: deliberate direct-emitter
      // violations exercised by saveMeetingSource.eslintRuleSelfTest.
      'src/main/services/**/__eslintViolationFixtures__/**',
      // Stage 6 of 260611_rebel-5d5-renderer-leak: deliberate renderer
      // virtualizer getItemKey violation exercised by eslintRuleSelfTest.
      'src/renderer/**/__eslintViolationFixtures__/**',
      // Stage 4 of 260612_recs-round5: deliberate ConnectionCardOps raw-global
      // violations exercised by connectionCardOps.eslintRuleSelfTest with
      // ignore:false. Keep them out of normal `npm run lint`.
      'src/renderer/features/settings/components/__lint_fixtures__/**',
      // Stage 2 of 260505_canonical_settings_accessor_and_lint_enforced_read_path:
      // evals/ root added to lint scope; ignore eval-runtime artifacts that
      // are not source code (workspace snapshots, eval-GUI client bundle, and
      // built/bundled scripts).
      'evals/.workspace-snapshot/**',
      'evals/.built*.mjs',
      'evals/.built*.mjs.map',
      'evals/gui/**',
      // Generated event-envelope validator — header `eslint-disable` is
      // documented in scripts/generate-event-envelope-validator.ts but the
      // file has no actual violations to suppress, so flat-config's
      // reportUnusedDisableDirectives flags the directive as unused.
      'cloud-client/src/utils/eventEnvelopeValidator.generated.ts',
    ],
  },
  {
    files: ['mobile/**/*.ts', 'mobile/**/*.tsx'],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'rebel-native-cleanup': nativeCleanupPlugin,
    },
    rules: {
      'rebel-native-cleanup/no-undeferred-native-cleanup': 'warn',
    },
  },
  // Stage 2 of docs/plans/260522_compile-time-reliability/PLAN.md:
  // warn first, ratchet later for catch/fallback silent swallows. Tests are
  // exempt so fixture-style fallback assertions do not have to add local
  // helper calls; dedicated rule fixtures below keep the guard covered.
  {
    // `files` is derived from the single source of truth in
    // scripts/silentSwallowSurfaceCoverage.mjs so the rule's coverage cannot
    // drift from the audited-surface list. Flip a surface to 'covered' there to
    // extend the rule (staged); the parity guard in check-eslint-warnings.ts
    // fails loudly if an audited surface is left unclassified.
    files: coveredSilentSwallowGlobs(),
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'rebel-silent-swallow': silentSwallowPlugin,
    },
    rules: {
      'rebel-silent-swallow/no-silent-swallow': 'warn',
    },
  },
  // Stage 3 of docs/plans/260522_compile-time-reliability/PLAN.md:
  // non-type-aware default-arm guard that warns on bare bypasses
  // (`default: break`, `default: return`, `default: return undefined`,
  // empty default) unless the arm contains assertNever(...) or
  // invariant(false, ...). Stage 6's type-aware check remains authoritative.
  {
    files: [
      'src/**/*.ts',
      'src/**/*.tsx',
      ...privateMindstoneSourceGlobs,
      'scripts/__fixtures__/switch-exhaustiveness/**/*.ts',
    ],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'rebel-switch-exhaustiveness': switchExhaustivenessPlugin,
    },
    rules: {
      'rebel-switch-exhaustiveness/no-bare-default-bypass': 'error',
    },
  },
  // Sentry capture contract: prevent high-cardinality fragmentation from
  // dynamic/interpolated capture messages. Use a static capture message plus
  // structured context, or route known classes via captureKnownCondition().
  {
    files: [
      'src/**/*.ts',
      'src/**/*.tsx',
      ...privateMindstoneSourceGlobs,
      'cloud-service/**/*.ts',
      'cloud-service/**/*.tsx',
      'mobile/**/*.ts',
      'mobile/**/*.tsx',
    ],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      '**/__lint_fixtures__/**',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'rebel-sentry': sentryCaptureContractPlugin,
    },
    rules: {
      'rebel-sentry/no-dynamic-capture-message': 'error',
    },
  },
  // Startup-dialog gate (kills the `startup_modal_blocks_automated_boot` class):
  // raw `dialog.showMessageBox` in the startup surface must route through
  // `showStartupMessageBox` (src/main/startup/startupDialog.ts), which no-ops in
  // automated/headless contexts. Scoped to the install-hygiene services + the
  // startup dir (where startup dialogs live); the wrapper module itself is
  // exempt. NOT repo-wide, so window-parented / post-startup dialogs elsewhere
  // are unaffected. See eslint-rules/no-raw-startup-dialog.js.
  {
    files: [
      'src/main/startup/**/*.ts',
      'src/main/bootstrap.ts',
      'src/main/services/appRelocationService.ts',
      'src/main/services/appInstallIntegrityService.ts',
    ],
    ignores: ['src/main/startup/startupDialog.ts', '**/__tests__/**'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: {
      'rebel-startup-dialog': startupDialogPlugin,
    },
    rules: {
      'rebel-startup-dialog/no-raw-startup-dialog': 'error',
    },
  },
  // Headless-check consolidation gate: the "is this the headless CLI?" signal has
  // ONE definition — isHeadlessCli() (src/core/utils/headlessCli.ts, re-exported
  // from src/main/utils/testIsolation.ts). Forbid re-inlining a raw env/argv/switch
  // check anywhere in src/** so the consolidation can't silently drift back.
  // The SSOT module + test files are exempt. See eslint-rules/no-raw-headless-check.js.
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: [
      'src/core/utils/headlessCli.ts',
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: {
      'rebel-headless': headlessCheckPlugin,
    },
    rules: {
      'rebel-headless/no-raw-headless-check': 'error',
    },
  },
  // R2 AgentEvent construction guard. This broad production block covers
  // surfaces that do not have their own no-restricted-syntax block (notably
  // mobile) and documents the intended scope. Existing production overrides
  // below include the same selectors so flat-config rule replacement does not
  // accidentally drop the guard.
  {
    files: [
      'src/**/*.ts',
      'src/**/*.tsx',
      ...privateMindstoneSourceGlobs,
      'cloud-service/**/*.ts',
      'cloud-service/**/*.tsx',
      'cloud-client/**/*.ts',
      'cloud-client/**/*.tsx',
      'mobile/**/*.ts',
      'mobile/**/*.tsx',
    ],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      'src/shared/contracts/**',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooksPlugin,
      'diagnostics': diagnosticsRulesPlugin,
    },
    rules: {
      'diagnostics/no-auto-loop-provider-probe': 'error',
      'diagnostics/no-raw-continuity-breadcrumb': 'error',
      'no-restricted-syntax': ['error', ...agentEventConstructionGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // Bug 2 prevention (260616) — repo-wide `detail` parse guard for the
  // @rebel/shared package. The broad production block above covers src/,
  // cloud-service/, cloud-client/, mobile/ and private-mindstone; packages/
  // shared/src is its own workspace and gets a DEDICATED block applying ONLY
  // the size-guard selectors (not the broader production guards) so the detail
  // rule reaches the canonical package without dragging unrelated guards onto
  // it. The canonical helper itself (which legitimately calls JSON.parse) and
  // tests are excluded. See docs/plans/260616_detail-parse-class-kill/PLAN.md.
  {
    files: [
      'packages/shared/src/**/*.ts',
      'packages/shared/src/**/*.tsx',
    ],
    ignores: [
      'packages/shared/src/utils/safeParseDetail.ts',
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      'no-restricted-syntax': ['error', ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // Wave 2c — Mobile-specific tombstone block. Adds the
  // `captureSentryException` import-ban on top of the R2 AgentEvent
  // construction guard. The selectors are spread together because flat-config
  // rule replacement otherwise drops the upstream R2 guard for mobile/**.
  // See docs/plans/260503_wave2c_mobile_legacy_and_layer2_hardfail.md.
  {
    files: ['mobile/**/*.ts', 'mobile/**/*.tsx'],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      'no-restricted-syntax': ['error', ...agentEventConstructionGuardSelectors, mobileLegacyCaptureSentryExceptionSelector, ...cloudInstanceStatusDirectWriteSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },
  // Stage 1.5 of docs/plans/260522_compile-time-reliability/PLAN.md:
  // `assertNever` is canonical in src/shared/utils/assertNever.ts so all
  // exhaustiveness guards throw the shared InvariantViolationError subclass.
  // Local declarations drifted in five files; this rule prevents recurrence.
  {
    files: [
      'src/**/*.ts',
      'src/**/*.tsx',
      ...privateMindstoneSourceGlobs,
      'cloud-service/**/*.ts',
      'cloud-service/**/*.tsx',
      'cloud-client/**/*.ts',
      'cloud-client/**/*.tsx',
      'mobile/**/*.ts',
      'mobile/**/*.tsx',
      'evals/**/*.ts',
      'evals/**/*.tsx',
      'scripts/__fixtures__/assertNever-consolidation/**/*.ts',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'rebel-assert-never': assertNeverPlugin,
    },
    rules: {
      'rebel-assert-never/no-local-assert-never': 'error',
    },
  },
  {
    files: [
      'src/**/*.ts',
      'src/**/*.tsx',
      ...privateMindstoneSourceGlobs,
      'cloud-service/**/*.ts',
      'cloud-service/**/*.tsx',
      'cloud-client/**/*.ts',
      'cloud-client/**/*.tsx',
      'mobile/**/*.ts',
      'mobile/**/*.tsx',
      'evals/**/*.ts',
      'evals/**/*.tsx',
    ],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
      'src/core/services/conversationState/turnLiveness.ts',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'rebel-liveness-brand': derivedLivenessBrandPlugin,
    },
    rules: {
      'rebel-liveness-brand/no-derived-liveness-cast': 'error',
    },
  },
  {
    files: [
      'src/**/*.ts',
      'src/**/*.tsx',
      ...privateMindstoneSourceGlobs,
      'cloud-service/**/*.ts',
      'cloud-service/**/*.tsx',
      'cloud-client/**/*.ts',
      'cloud-client/**/*.tsx',
      'packages/**/*.ts',
      'packages/**/*.tsx',
      'mobile/**/*.ts',
      'mobile/**/*.tsx',
      'web-companion/**/*.ts',
      'web-companion/**/*.tsx',
      'evals/**/*.ts',
      'scripts/**/*.ts',
    ],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'rebel-liveness-scalars': livenessScalarWritePlugin,
    },
    rules: {
      'rebel-liveness-scalars/no-raw-turn-liveness-scalars': 'error',
    },
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', ...privateMindstoneSourceGlobs, 'mirror/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      // TypeScript rules
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // Naming conventions
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          // Test-only reset/setup helpers conventionally use either a `_` or `__`
          // prefix as a visual marker that they exist solely for tests
          // (e.g. `_resetXxxForTesting`, `__setYyyDepsForTests`). Allow either prefix
          // on functions/variables whose name ends with `ForTesting`/`ForTests` so the
          // marker is preserved without per-line eslint-disable noise.
          selector: ['function', 'variable'],
          filter: { regex: '(ForTesting|ForTests)$', match: true },
          format: ['camelCase'],
          leadingUnderscore: 'allowSingleOrDouble',
        },
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'function',
          format: ['camelCase', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'enumMember',
          format: ['PascalCase', 'UPPER_CASE'],
        },
      ],

      // React Hooks rules
      'react-hooks/rules-of-hooks': 'error',
      // Promoted to `error` after the 260502 sweep cleared all 15 outstanding
      // sites — ratchet at zero so the bug class (stale closures, missing deps
      // in custom hooks) cannot quietly re-accumulate. The escape valve for
      // genuine false positives is `additionalHooks` (regex above) plus
      // line-level `eslint-disable react-hooks/exhaustive-deps` for principled
      // exceptions. See Appendix B of docs/tutorials/260502b_react_hooks_lint_in_rebel.html.
      //
      // useIpcEvent is intentionally NOT in additionalHooks. The hook signature
      // is (subscribe, handler, deps); the lint plugin assumes callback at arg 0
      // and would emit "received a function whose dependencies are unknown" for
      // every call site (32 false positives). The hook's ref-based handler
      // (handlerRef.current = handler) is the real stale-closure protection;
      // re-subscription on subscribe-identity changes is covered by an internal
      // effect dep on `subscribe`. See docs/plans/260426_use_ipc_event_extraction.md
      // and docs/plans/260502_post_merge_test_health_recovery.md.
      'react-hooks/exhaustive-deps': 'error',

      // Temporal dead zone guard: catch const/let/class references before
      // declaration. Prevents the exact TDZ crash that killed EventSeriesBanner
      // (useEffect referencing a useCallback declared later in the same scope).
      // Function declarations hoist safely so are excluded.
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': [
        'warn',
        {
          functions: false,
          classes: true,
          variables: true,
          allowNamedExports: false,
          ignoreTypeReferences: true,
        },
      ],

      // General rules
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-restricted-imports': ['error', {
        paths: authServiceImportRestrictionPaths,
        patterns: authServiceImportRestrictionPatterns,
      }],
      // Promoted to `error` after the 260525_no-empty-drain-and-extend sweep
      // (b95a8ef79) drained all 16 src/** sites via ignoreBestEffortCleanup.
      // Ratchet at zero so the bare-catch bug class (silent error swallow →
      // undiagnosed production failures, cited in 3 high-severity postmortems
      // — see docs/plans/260525_typing-refactor-postmortem-driven/PLAN.md
      // Stage 4) cannot quietly re-accumulate. Escape valve: use the canonical
      // helper `ignoreBestEffortCleanup(error, { operation, reason })` from
      // @shared/utils/intentionalSwallow; in genuine never-throws sites (rare)
      // a line-level `eslint-disable no-empty` with justifying comment is fine.
      'no-empty': ['error', { allowEmptyCatch: false }],
      'prefer-const': 'warn',
      'no-var': 'error',

      // Pino arg-order guard + Client factory guard + Fire-and-forget guard + Navigation URL guard + AutomationSchedule brand guard + Counter-axes shadow guard + openHistorySession wrapper-bypass guard (PM 260416) + flushSync render-cycle ratchet (PM 260402) (see constants above).
      // Test files override this below to keep Pino guard but drop factory/fire-and-forget guards.
      'no-restricted-syntax': ['error', ...rendererBaseRestrictedSyntaxSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },
  {
    files: [
      'src/renderer/features/agent-session/components/ConversationPane.tsx',
      'src/renderer/features/agent-session/components/__eslintViolationFixtures__/**/*.{ts,tsx}',
    ],
    plugins: {
      'rebel-virtualizer-lifetime': virtualizerLifetimePlugin,
    },
    rules: {
      'rebel-virtualizer-lifetime/reviewed-get-item-key': 'error',
    },
  },
  // Stage 3 of docs/plans/260508_dispatch_path_discriminator_structural_refactor.md:
  // production code must route dispatch decisions through the typed
  // `dispatchPath` helper predicates, not ad-hoc literal equality or the old
  // `transport === 'anthropic-compatible-local-proxy' && routeScope` heuristic.
  // Tests are exempt so inline route-decision mocks can remain local and clear.
  {
    files: [
      'src/**/*.ts',
      'src/**/*.tsx',
      ...privateMindstoneSourceGlobs,
      'cloud-service/**/*.ts',
      'cloud-service/**/*.tsx',
      'cloud-client/**/*.ts',
      'cloud-client/**/*.tsx',
      'mobile/**/*.ts',
      'mobile/**/*.tsx',
      'evals/**/*.ts',
      'evals/**/*.tsx',
    ],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'rebel-routing': rebelRoutingPlugin,
    },
    rules: {
      'rebel-routing/no-direct-dispatch-path-equality': 'error',
    },
  },

  // Stage 6 of docs/plans/260514_openrouter_sonnet_bypass_remediation.md:
  // forbid provider-blind fallbacks to `DEFAULT_MODEL` / `'claude-sonnet-4-6'`
  // in main/services + shared/utils. The rule itself owns the three-file
  // allowlist (see `eslint-rules/no-default-model-literal.js` and its
  // regression test). Tests are exempt because unit-test fixtures commonly
  // build pre-resolved Anthropic settings that include the literal as a
  // property value -- the rule already ignores property values in
  // non-fallback positions, but we belt-and-suspenders the test scope here
  // so future test refactors (e.g. inline `?? DEFAULT_MODEL` mocks) do not
  // need to add per-line disables.
  {
    files: [
      'src/main/services/**/*.{ts,tsx}',
      ...privateMindstoneServiceSourceGlobs,
      'src/shared/utils/**/*.{ts,tsx}',
    ],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    plugins: {
      'rebel-provider-defaults': noDefaultModelLiteralPlugin,
    },
    rules: {
      'rebel-provider-defaults/no-default-model-literal': 'error',
    },
  },

  // Stage 5 of docs/plans/260526_perf-cpu-heat-regression/PLAN.md:
  // writable scan calls must be explicit and tightly allowlisted.
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', ...privateMindstoneSourceGlobs],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      '**/*.spec.tsx',
    ],
    plugins: {
      'rebel-space-scan': spaceScanGuardPlugin,
    },
    rules: {
      'rebel-space-scan/no-disallowed-scanspaces-side-effects': ['error', {
        allowlistSuffixes: [
          'src/main/ipc/libraryHandlers.ts',
          'src/core/services/space/spaceService.ts',
          'src/main/services/sharedDriveService.ts',
        ],
      }],
    },
  },

  // S4.5 (docs/plans/260518_bts_model_prefix_decoder_phase2a.md):
  // block raw settings reads of behindTheScenesModel/behindTheScenesOverrides
  // outside the reviewed allowlist. This is a flow-shape guardrail (settings
  // field read), not a literal-prefix guardrail.
  //
  // files / ignores / severity / languageOptions are sourced from the SSoT
  // (eslint-rules/bts-raw-read-config.mjs) so the standalone self-test
  // (scripts/check-bts-prefix-decoder-rule.ts) lints with the IDENTICAL surface
  // and cannot drift. Edit the allowlist there, not here (the drift + snapshot
  // tests enforce this). The 260518 S6 audit notes live alongside the SSoT
  // ignores.
  {
    files: BTS_RAW_READ_FILES,
    ignores: BTS_RAW_READ_IGNORES,
    languageOptions: btsRawReadLanguageOptions(tsparser),
    plugins: {
      'bts-flow-shape': btsFlowShapePlugin,
    },
    rules: {
      'bts-flow-shape/no-raw-bts-model-read': BTS_RAW_READ_SEVERITY,
    },
  },

  {
    files: ['src/**/*.{ts,tsx}', 'private/mindstone/src/**/*.{ts,tsx}', 'evals/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'bts-flow-shape': btsFlowShapePlugin,
    },
    rules: {
      'bts-flow-shape/no-model-brand-casts': 'error',
      'bts-flow-shape/no-model-error-catch-clobber': 'error',
      'bts-flow-shape/no-local-storage-prefix-redeclare': 'error',
    },
  },

  // AgentEvent manifest modules legitimately construct S2-A1/S2-A2 fixture
  // events while deriving the closed-strict contract. Keep the existing
  // generic guards here, but drop the AgentEvent construction guard.
  {
    files: ['src/shared/contracts/**/*.ts', 'src/shared/contracts/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...clientFactoryGuardSelectors, ...fireAndForgetGuardSelectors, ...navigationUrlGuardSelectors, ...automationScheduleBrandGuardSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // Stage 3 of docs/plans/260525_typing-refactor-postmortem-driven/PLAN.md:
  // prohibit Node-22-only fs glob APIs while engines.node stays >=20.
  {
    files: [
      'src/**/*.ts',
      'src/**/*.tsx',
      ...privateMindstoneSourceGlobs,
      'cloud-service/**/*.ts',
      'cloud-service/**/*.tsx',
      'cloud-client/**/*.ts',
      'cloud-client/**/*.tsx',
      'evals/**/*.ts',
      'evals/**/*.tsx',
      'mobile/**/*.ts',
      'mobile/**/*.tsx',
    ],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      ...nodeEngineFloorGuardImportExemptions,
    ],
    rules: {
      'no-restricted-properties': ['error', ...nodeEngineFloorGuardEntries],
    },
  },
  {
    files: [
      'src/**/*.ts',
      'src/**/*.tsx',
      ...privateMindstoneSourceGlobs,
      'cloud-service/**/*.ts',
      'cloud-service/**/*.tsx',
      'cloud-client/**/*.ts',
      'cloud-client/**/*.tsx',
      'evals/**/*.ts',
      'evals/**/*.tsx',
      'mobile/**/*.ts',
      'mobile/**/*.tsx',
    ],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      ...nodeEngineFloorGuardImportExemptions,
    ],
    rules: {
      // IMPORTANT: in ESLint flat config, when multiple matching config objects define
      // the same rule, the LATER value REPLACES the earlier (rule arrays do not merge).
      // This block matches every production file under src/**, cloud-service/**, etc.,
      // so we MUST include the authService restriction entries here too — otherwise the
      // base config's authService rule at the top of the file is silently dropped for
      // every production file. See Phase 6 fix in docs/plans/260605_oss-auth-removal/
      // PLAN.md Decision Log.
      'no-restricted-imports': ['error', {
        paths: [
          ...nodeEngineFloorGuardImportEntries,
          ...authServiceImportRestrictionPaths,
        ],
        patterns: authServiceImportRestrictionPatterns,
      }],
    },
  },

  // Private Mindstone files must be able to import the moved authService within
  // their own root, but still need the Node engine-floor named-import guard.
  {
    files: ['private/mindstone/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { paths: nodeEngineFloorGuardImportEntries }],
    },
  },

  // Stage 1 of docs/plans/260606_b3-private-mindstone-carveout:
  // @private/mindstone is a main-process-only alias. The renderer build
  // intentionally has no matching Vite alias, and this guard prevents core,
  // shared, or renderer code from adding imports that would either leak
  // private code or bypass the IPC/core boundary.
  {
    files: [
      'src/core/**/*.{ts,tsx}',
      'src/shared/**/*.{ts,tsx}',
      'src/renderer/**/*.{ts,tsx}',
    ],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          ...nodeEngineFloorGuardImportEntries,
          ...authServiceImportRestrictionPaths,
        ],
        patterns: [
          ...authServiceImportRestrictionPatterns,
          ...privateMindstoneImportRestrictionPatterns,
        ],
      }],
    },
  },
  {
    files: [
      'src/core/**/__tests__/**/*.{ts,tsx}',
      'src/core/**/*.{test,spec}.{ts,tsx}',
      'src/shared/**/__tests__/**/*.{ts,tsx}',
      'src/shared/**/*.{test,spec}.{ts,tsx}',
      'src/renderer/**/__tests__/**/*.{ts,tsx}',
      'src/renderer/**/*.{test,spec}.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        paths: authServiceImportRestrictionPaths,
        patterns: [
          ...authServiceImportRestrictionPatterns,
          ...privateMindstoneImportRestrictionPatterns,
        ],
      }],
    },
  },
  {
    files: privateMindstoneImportRestrictionNodeGuardExemptions,
    rules: {
      // These files are exempt from the Node-engine-floor namespace-import
      // guard because they import `fs`/`node:fs` namespaces without calling
      // globSync(). Keep the B3 private-Mindstone ban active for them so that
      // the node exemption cannot become a private-code bypass.
      'no-restricted-imports': ['error', {
        paths: authServiceImportRestrictionPaths,
        patterns: [
          ...authServiceImportRestrictionPatterns,
          ...privateMindstoneImportRestrictionPatterns,
        ],
      }],
    },
  },

  // Stage 1 models-namespace guardrail: production settings access should use
  // `models` (or per-field accessors), not direct `.claude` reads/writes.
  // Scoped to the migration surfaces to avoid blocking unrelated legacy areas.
  // Stage 2 of 260505_canonical_settings_accessor_and_lint_enforced_read_path:
  // extended scope to `evals/**` (excl. tests) — closes regression vector for
  // future eval harnesses.
  // Stage 3 of 260505_canonical_settings_accessor_and_lint_enforced_read_path:
  // extended scope to `src/shared/data/**`, `src/renderer/hooks/**`,
  // `src/renderer/features/onboarding/**`, and
  // `src/renderer/features/agent-session/**` once those surfaces' direct
  // `.claude` reads were migrated to per-field accessors / resolveModelSettings.
  // Stage 4 of 260505_canonical_settings_accessor_and_lint_enforced_read_path:
  // extended preventive scope to `cloud-client/src/**` and `mobile/**` so new
  // direct namespace reads fail by default even though both surfaces are clean.
  // Stage 4 also adds a parallel `.models.*` restriction (same scoped surfaces;
  // same test-file ignores) and keeps the canonical allowlist minimal.
  {
    files: [
      'src/core/**/*.ts',
      'src/core/**/*.tsx',
      'src/main/**/*.ts',
      'src/main/**/*.tsx',
      ...privateMindstoneSourceGlobs,
      'src/shared/utils/**/*.ts',
      'src/shared/utils/**/*.tsx',
      'src/shared/data/**/*.ts',
      'src/shared/data/**/*.tsx',
      'src/shared/types/settings.ts',
      'cloud-service/src/**/*.ts',
      'cloud-service/src/**/*.tsx',
      'cloud-client/src/**/*.ts',
      'cloud-client/src/**/*.tsx',
      'mobile/**/*.ts',
      'mobile/**/*.tsx',
      'src/renderer/App.tsx',
      'src/renderer/features/library/providers/LibraryNavigatorProvider.tsx',
      'src/renderer/features/agent-session/**/*.ts',
      'src/renderer/features/agent-session/**/*.tsx',
      'src/renderer/features/settings/**/*.ts',
      'src/renderer/features/settings/**/*.tsx',
      'src/renderer/features/onboarding/**/*.ts',
      'src/renderer/features/onboarding/**/*.tsx',
      'src/renderer/hooks/**/*.ts',
      'src/renderer/hooks/**/*.tsx',
      'evals/**/*.ts',
      'evals/**/*.tsx',
    ],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          property: 'claude',
          message: 'Do not read or write settings.claude directly. Use `models` or @core/rebelCore/settingsAccessors.',
        },
        // Stage 4 trade-off (canonical settings accessor plan): the rule is
        // scoped via `object: 'settings'` rather than the symmetric `property:
        // 'models'` shape used for `claude` above because `.models` is a
        // common identifier on unrelated objects (PROVIDER_PRESETS.X.models,
        // preset.models, payload.models in tests, etc.). A bare property
        // restriction would create 100+ false positives. Acknowledged hole:
        // aliased reads (`const s = settings; s.models.thinkingModel`,
        // `currentSettings.models`, `draftSettings.models`, `normalized.models`)
        // are NOT caught here. Those are caught by (a) the destructure guard
        // above (`{ models } = settings`), (b) the modelsNamespaceDestructureGuardSelectors
        // settings.models??settings.claude guard, and (c) code review when
        // adding new write-path projections. See planning doc Stage 4
        // Failure Mode Matrix and Round-2 review notes.
        {
          object: 'settings',
          property: 'models',
          message: 'Do not read settings.models.* directly. Use @core/rebelCore/settingsAccessors per-field accessors or @shared/utils/modelSettingsResolver resolveEffectiveModelSettings.',
        },
        ...nodeEngineFloorGuardEntries,
      ],
    },
  },

  // Stage 4 allowlist: canonical `.claude.*` reader/writer exemptions for the
  // migration window (minimal set; each entry documents why it is exempt).
  {
    files: [
      // reason: canonical @shared resolver uses hasOwnProperty field-level legacy fallback reads.
      'src/shared/utils/modelSettingsResolver.ts',
      // reason: normalizeSettings materializes models from legacy claude input but does not emit the mirror.
      'src/shared/utils/settingsUtils.ts',
    ],
    rules: {
      'no-restricted-properties': ['error', ...nodeEngineFloorGuardEntries],
    },
  },

  // Stage 4 allowlist: canonical `.models.*` reader/writer exemptions mirror
  // the `.claude.*` allowlist so both namespace bans share one minimal set.
  {
    files: [
      // reason: canonical per-field accessor layer reads canonical models namespace fields.
      'src/core/rebelCore/settingsAccessors.ts',
      // reason: renderer-safe pure twin of settingsAccessors; no logger/errorReporter imports.
      'src/core/rebelCore/settingsAccessorsPure.ts',
      // reason: provider-routing fallback reads canonical models namespace values.
      'src/core/rebelCore/providerRouting.ts',
      // reason: boot-time settings store normalization reads canonical models namespace input.
      'src/main/settingsStore.ts',
      // reason: canonical @shared resolver reads canonical models namespace via field-level projection.
      'src/shared/utils/modelSettingsResolver.ts',
      // reason: normalizeSettings writer reads/writes canonical models namespace state.
      'src/shared/utils/settingsUtils.ts',
      // reason: settings type definitions intentionally define canonical models namespace shape.
      'src/shared/types/settings.ts',
      // reason: canonical renderer-safe per-field accessor module reads canonical models namespace via field-level projection.
      'src/renderer/features/settings/utils/modelAuthAccessors.ts',
    ],
    rules: {
      'no-restricted-properties': ['error', ...nodeEngineFloorGuardEntries],
    },
  },

  // Timezone safety guard: only for src/core and src/main (not renderer —
  // browser TZ = user TZ so these calls are safe in the renderer).
  // NOTE: Catches calls with no options object (0-1 args). Does NOT catch
  // calls with options but missing timeZone — AST selectors can't inspect
  // object property names. See docs/project/TIMEZONE_AND_DATE_HANDLING_IN_MCPS.md.
  {
    files: ['src/core/**/*.ts', 'src/core/**/*.tsx', 'src/main/**/*.ts', 'src/main/**/*.tsx', ...privateMindstoneSourceGlobs],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...clientFactoryGuardSelectors, ...fireAndForgetGuardSelectors, ...timezoneUnsafeSelectors, ...navigationUrlGuardSelectors, ...automationScheduleBrandGuardSelectors, ...agentEventConstructionGuardSelectors, ...cleanupBypassGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...rendererWindowTargetGetAllWindowsSelectors, ...compactionCounterShadowGuardSelectors, ...modelsNamespaceDestructureGuardSelectors, ...terminalLifecycleEmissionGuardSelectors, ...nativeBindingImportGuardSelectors, ...rawInfoCaptureGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // Stage 5 of docs/plans/260503_sentry_capture_contract.md — literal
  // captures of known structured-error classes in the selected backend layers
  // must use captureKnownCondition() so stable fingerprints stay centralized.
  // `meetingEmitBaseRestrictedSelectors` now includes `nativeBindingImportGuardSelectors`
  // (F12 prevention) — see its definition above — so this block automatically
  // re-applies the F12 guard to `src/main/services/**` and `src/core/**`, which
  // would otherwise lose it because flat config REPLACES same-name rule entries
  // from later blocks for overlapping files.
  // F12 postmortem: docs-private/postmortems/251216_lancedb_huggingface_native_module_asar_resolve_postmortem.md
  {
    files: ['src/core/**/*.ts', 'src/main/services/**/*.ts', ...privateMindstoneServiceSourceGlobs],
    rules: {
      'no-restricted-syntax': ['error', ...meetingEmitBaseRestrictedSelectors, ...restrictedSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // Canonical line-reader ownership helper is the single sanctioned site that
  // may compose readline + file stream directly (with deterministic finally
  // teardown). Keep the full backend selector set, excluding only the
  // createInterface(createReadStream(...)) guard this helper implements.
  {
    files: ['src/core/utils/readLines.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...meetingEmitBaseRestrictedSelectorsWithoutReadlineGuard, ...restrictedSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // Stage 8 of docs/plans/260611_perf-idle-churn/PLAN.md:
  // scoped drain-now guard for the stateless re-derivation loop class. This
  // block re-declares the prior src/main/services/** selector set because
  // ESLint flat config replaces same-name rule arrays for later matches.
  {
    files: [
      'src/main/services/cloud/**/*.ts',
      'src/main/services/fileIndexService/**/*.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...meetingEmitBaseRestrictedSelectors, ...restrictedSelectors, ...loopSwallowCatchSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // Stage 4 of docs/plans/260610_recs-round3-recent/PLAN.md:
  // modelErrors.ts is the provider-error classification chokepoint. Re-declare
  // the prior backend selector set plus the classifier-specific guard because
  // ESLint flat config replaces same-name rule arrays for later matching blocks.
  {
    files: ['src/core/rebelCore/modelErrors.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...meetingEmitBaseRestrictedSelectors, ...restrictedSelectors, ...compactionCounterShadowGuardSelectors, ...providerErrorClassifierGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // Stage 2 of docs/plans/260620_recs-drain-prevention-gates/PLAN.md
  // (PM 260618_quit_save_sync_lock_contention_dropped_final_save, rec 2 / implement_now):
  // kill the same-process sync-lock-contention class by construction. Re-declares the prior
  // src/core/** backend selector set (flat config REPLACES same-name rule arrays for later
  // matching blocks — this is the LAST block matching the file) plus the busy-wait guard.
  // Scoped to the persistence CONSUMER (lockedSessionPersistence.ts — the only acquire*Sync
  // caller); the lock primitive sessionFileLock.ts stays the sanctioned busy-wait home.
  // Add new same-process persistence services that take sync locks to this files list.
  {
    files: ['src/core/services/lockedSessionPersistence.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...meetingEmitBaseRestrictedSelectors, ...restrictedSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors, ...busyWaitPersistenceGuardSelectors],
    },
  },

  // Stage 5 of docs/plans/260526_turn_policy_unification.md:
  // lock turn-pipeline call-sites against reintroducing sessionType==='automation'
  // (or `isAutomation` locals derived from sessionType) now that policy
  // fields are the canonical behavior source.
  {
    files: [
      'src/core/services/turnPipeline/agentTurnExecute.ts',
      'src/core/services/turnPipeline/turnAdmission.ts',
      'src/core/services/agentTurnService.ts',
      'src/core/services/turnPipeline/headlessTurnRunner.ts',
      'src/core/services/turnConcurrencyLimiter.ts',
      'src/core/services/watchdogJudge.ts',
      'src/main/services/promptTemplateService.ts',
      'src/core/services/promptTemplateService.ts',
      'src/main/services/mcpService.ts',
      // Negative lint fixtures exercised by turnPipelineLintFixtures.test.ts
      // via the lintFile (CLI subprocess) path. The fixtures live in a
      // globally-ignored directory; this entry re-applies the fence rule
      // when the test runs ESLint with --no-ignore.
      'src/core/services/turnPipeline/__lint_fixtures__/**',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...meetingEmitBaseRestrictedSelectors,
        ...restrictedSelectors,
        ...turnPolicyRefactorFenceSelectors,
        ...planningSentinelGuardSelectors,
        ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors,
      ],
    },
  },

  // safeStorage token-store decode guard
  // (docs-private/investigations/260506_safestorage_token_corruption_ufffd.md):
  // these loaders must route every plain-utf-8 decode through
  // src/core/services/safeStorageDecode.ts so the v10/v11-prefix guard,
  // per-store validators, and Sentry dedupe latch stay symmetric. Direct
  // `buffer.toString('utf-8')` of opaque store payloads re-introduces the
  // U+FFFD-poisoned bearer-header bug. The helper module itself is
  // deliberately not in this scope — it is the single legitimate decode
  // site.
  {
    files: [
      'src/core/services/tokenStorage/authTokenStorage.ts',
      'src/core/services/tokenStorage/providerTokenStorage.ts',
      'src/core/services/tokenStorage/openRouterTokenStorage.ts',
      'src/core/services/tokenStorage/flyTokenStorage.ts',
      'src/core/services/tokenStorage/codexTokenStorage.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...pinoArgOrderSelectors,
        ...clientFactoryGuardSelectors,
        ...fireAndForgetGuardSelectors,
        ...timezoneUnsafeSelectors,
        ...navigationUrlGuardSelectors,
        ...automationScheduleBrandGuardSelectors,
        ...agentEventConstructionGuardSelectors,
        ...cleanupBypassGuardSelectors,
        ...knownStructuredErrorCaptureSelectors,
        ...modelsNamespaceDestructureGuardSelectors,
        ...cloudInstanceStatusDirectWriteSelectors,
        ...terminalLifecycleEmissionGuardSelectors,
        ...nativeBindingImportGuardSelectors,
        {
          selector: "CallExpression[callee.property.name='toString'][arguments.0.value=/^utf-?8$/]",
          message: "Token storage: do not decode raw buffers as utf-8 directly. Use the guarded decoder in safeStorageDecode.ts (decodeStringStore / decodeJsonStore) — the v10/v11 prefix check + per-store validator prevents the U+FFFD-poisoned bearer-header bug. See docs-private/investigations/260506_safestorage_token_corruption_ufffd.md.",
        },
        ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors,
      ],
    },
  },

  // The reconciler and canonical settings adapter are the sanctioned
  // cloudInstance status write path; retain the existing backend guards but
  // omit the single-writer guard for these files.
  {
    files: [
      'src/core/services/cloud/cloudConnectionReconciler.ts',
      'src/core/services/settingsStore.ts',
      'src/main/services/cloud/cloudConnectionReconcilerSingleton.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...clientFactoryGuardSelectors, ...fireAndForgetGuardSelectors, ...timezoneUnsafeSelectors, ...navigationUrlGuardSelectors, ...automationScheduleBrandGuardSelectors, ...agentEventConstructionGuardSelectors, ...cleanupBypassGuardSelectors, ...knownStructuredErrorCaptureSelectors, ...terminalLifecycleEmissionGuardSelectors, ...nativeBindingImportGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // agentTurnCleanup owns the registered cleanup helpers, so direct mutation is
  // allowed only in that file.
  {
    files: ['src/main/services/agentTurnCleanup.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...clientFactoryGuardSelectors, ...fireAndForgetGuardSelectors, ...timezoneUnsafeSelectors, ...navigationUrlGuardSelectors, ...automationScheduleBrandGuardSelectors, ...agentEventConstructionGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...compactionCounterShadowGuardSelectors, ...modelsNamespaceDestructureGuardSelectors, ...nativeBindingImportGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // R1 turnPipeline phase-to-phase import guards (Stage 1):
  //
  // 1) `queryOptionsBuilder.ts`, `agentQueryRunner.ts`, `turnErrorRecovery.ts`
  //    MUST NOT import from `turnPipeline/*`. These three peer modules are
  //    consumed BY the orchestrator + phases; allowing them to import phase
  //    impls would create cycles.
  //
  // 2) Files in `src/main/services/turnPipeline/*.ts` MUST NOT import another
  //    sibling phase module — only `types.ts`, `index.ts`, and `runPhase.ts`
  //    are shared. Phase outputs flow only through the orchestrator.
  //
  //    Round 4 form (finding #8) — POSITIVE ENUMERATION of every forbidden
  //    sibling in both relative (./turnXxx) and path-alias forms. No regex
  //    bypasses; the index-re-export bypass is closed by the structural test
  //    on `turnPipeline/index.ts` (type-only-export invariant).
  //
  // See docs/plans/260427_refactor_agent_turn_executor_pipeline.md § Stage 1.
  {
    files: [
      'src/main/services/queryOptionsBuilder.ts',
      'src/main/services/agentQueryRunner.ts',
      'src/main/services/turnErrorRecovery.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        patterns: [
          {
            group: [
              './turnPipeline',
              './turnPipeline/*',
              '@main/services/turnPipeline',
              '@main/services/turnPipeline/*',
            ],
            message:
              'R1 cycle-prevention: queryOptionsBuilder / agentQueryRunner / turnErrorRecovery are peer modules consumed BY turnPipeline. Importing turnPipeline back would create a cycle.',
          },
        ],
      }],
    },
  },

  // Stage 2 of docs/plans/260519_unify_meeting_save_paths.md:
  // direct emit/defer calls are kernel-owned. The kernel itself and
  // transcriptEventBus internals are explicit allowlist sites.
  {
    files: [
      'src/core/meetingSource/**',
      'src/main/services/meetingBot/transcriptEventBus.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...meetingEmitBaseRestrictedSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },
  {
    files: ['src/main/services/turnPipeline/**/*.ts'],
    ignores: [
      'src/main/services/turnPipeline/types.ts',
      'src/main/services/turnPipeline/index.ts',
      'src/main/services/turnPipeline/runPhase.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', {
        patterns: [
          {
            group: [
              './turnAdmission',
              './preTurnContextAssembler',
              './turnModelMcpAssembler',
              './turnRoutingProxyAssembler',
              './turnHookGraphBuilder',
              './turnPrimaryQueryShell',
              './turnCompletion',
              './turnWatchdog',
              '@main/services/turnPipeline/turnAdmission',
              '@main/services/turnPipeline/preTurnContextAssembler',
              '@main/services/turnPipeline/turnModelMcpAssembler',
              '@main/services/turnPipeline/turnRoutingProxyAssembler',
              '@main/services/turnPipeline/turnHookGraphBuilder',
              '@main/services/turnPipeline/turnPrimaryQueryShell',
              '@main/services/turnPipeline/turnCompletion',
              '@main/services/turnPipeline/turnWatchdog',
              // index.ts type-only-export invariant means importing through
              // `@main/services/turnPipeline` (the barrel) is forbidden for
              // value-imports; the structural test on index.ts catches a
              // future agent re-exporting an impl from the barrel.
              '@main/services/turnPipeline',
              './index',
            ],
            message:
              'R1 phase-to-phase import forbidden: phase modules must not import each other. Only `types.ts`, `index.ts`, and `runPhase.ts` are shared. Phase outputs flow only through the orchestrator.',
          },
        ],
      }],
    },
  },

  // R4 ProviderRoutePlan guard: routing contracts are closed unions. These
  // files must not bypass them with `as any`, `as ProviderRoutePlan`, or
  // ts-comment escape hatches.
  {
    files: [
      'src/core/rebelCore/providerRouting.ts',
      'src/core/rebelCore/providerRouteDecision.ts',
      'src/core/rebelCore/providerAuthPlan.ts',
      'src/core/rebelCore/providerRouteHeaders.ts',
      'src/core/rebelCore/providerRoutePlan.ts',
      'src/core/rebelCore/providerRoutePlanTypes.ts',
      'src/core/rebelCore/ensureDirectAnthropicCapable.ts',
      'src/core/rebelCore/clientFactory.ts',
      'src/core/rebelCore/rebelCoreQuery.ts',
      'src/core/rebelCore/queryRouter.ts',
      'src/core/rebelCore/agentTool.ts',
      'src/core/services/behindTheScenesClient.ts',
      'src/core/utils/authEnvUtils.ts',
      'src/main/services/agentTurnExecutor.ts',
      'src/main/services/queryOptionsBuilder.ts',
      'src/main/services/turnErrorRecovery.ts',
      'src/main/services/behindTheScenesClient.ts',
      'src/main/services/councilService.ts',
      'src/main/services/localModelProxyServer.ts',
      'src/main/services/promptCacheWarmupService.ts',
      'src/main/services/useCaseGeneratorService.ts',
    ],
    rules: providerRoutingGuardRules,
  },

  // Routing-state keying-discipline guard (PM 260601): scoped only to
  // rebelCoreQuery.ts, where parent execution state and task badge metadata are
  // written. Keep this after providerRoutingGuardRules so the file-specific
  // no-restricted-syntax replacement preserves the routing guard selectors.
  {
    files: ['src/core/rebelCore/rebelCoreQuery.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...clientFactoryGuardSelectors, ...fireAndForgetGuardSelectors, ...timezoneUnsafeSelectors, ...navigationUrlGuardSelectors, ...automationScheduleBrandGuardSelectors, ...providerRoutingTypeSafetySelectors, ...agentEventConstructionGuardSelectors, ...cleanupBypassGuardSelectors, ...knownStructuredErrorCaptureSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...terminalLifecycleEmissionGuardSelectors, ...nativeBindingImportGuardSelectors, ...routingStateWriterGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // Stage 1 model-role resolver guard: prevent hardcoded Claude defaults in
  // runtime role-resolution entry points.
  {
    files: [
      'src/core/rebelCore/agentTool.ts',
      'src/core/rebelCore/planningMode.ts',
      'src/core/rebelCore/providerRouting.ts',
      'src/core/rebelCore/modelRoleResolver.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...clientFactoryGuardSelectors, ...fireAndForgetGuardSelectors, ...timezoneUnsafeSelectors, ...navigationUrlGuardSelectors, ...automationScheduleBrandGuardSelectors, ...providerRoutingTypeSafetySelectors, ...modelRoleFallbackGuardSelectors, ...agentEventConstructionGuardSelectors, ...cleanupBypassGuardSelectors, ...knownStructuredErrorCaptureSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...terminalLifecycleEmissionGuardSelectors, ...nativeBindingImportGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // Evals are not part of `npm run lint`, but when linted explicitly they should
  // still inherit the Anthropic-construction guard unless a harness is listed in
  // the documented eval-only whitelist below.
  {
    files: ['evals/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      // The agent-event `detail` parse guard is intentionally NOT applied to
      // evals/ — eval harnesses legitimately parse raw/oversized fixture detail.
      // See docs/plans/260616_detail-parse-class-kill/PLAN.md (Stage 2 excludes evals/**).
      'no-restricted-syntax': ['error', ...clientFactoryGuardSelectors],
    },
  },

  // R4 eval whitelist: these raw harnesses instantiate Anthropic directly to
  // score/control eval runs outside the Rebel agent loop. Production routing
  // still goes through ProviderRoutePlan; do not add app code here.
  //
  // The agent-event `detail` parse guard (agentDetailParseGuardSelectors) is
  // intentionally NOT re-added here: it is excluded from evals/** uniformly (see
  // the general evals block above), because eval harnesses legitimately parse
  // raw/oversized fixture detail. Re-adding it here previously contradicted that
  // exclude story. See docs/plans/260616_detail-parse-class-kill/PLAN.md.
  {
    files: [
      'evals/conflict-resolution-live-agent.ts',
      'evals/knowledge-work.ts',
      'evals/rebel-core-loop.ts',
      'evals/claim-audit-mutation-test.ts',
      'evals/llm-predicate.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...clientFactoryGuardSelectorsWithoutDirectAnthropicConstructor],
    },
  },

  // Cloud packages: apply TDZ guard to cloud-client and cloud-service.
  // Full lint coverage for these directories is a separate effort; this
  // ensures the no-use-before-define protection extends beyond src/.
  {
    files: [
      'cloud-client/src/**/*.ts',
      'cloud-client/src/**/*.tsx',
      'cloud-service/src/**/*.ts',
      'cloud-service/src/**/*.tsx',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': [
        'warn',
        {
          functions: false,
          classes: true,
          variables: true,
          allowNamedExports: false,
          ignoreTypeReferences: true,
        },
      ],
      // Apply AutomationSchedule brand guard to cloud as well — the brand
      // is shared across surfaces and casting around it on cloud is just as
      // dangerous as on desktop.
      'no-restricted-syntax': ['error', ...automationScheduleBrandGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },
  {
    files: [
      'cloud-client/src/**/*.ts',
      'cloud-client/src/**/*.tsx',
      'cloud-service/src/**/*.ts',
      'cloud-service/src/**/*.tsx',
    ],
    ignores: [
      'cloud-client/src/**/__tests__/**',
      'cloud-client/src/**/*.test.ts',
      'cloud-client/src/**/*.test.tsx',
      'cloud-service/src/**/__tests__/**',
      'cloud-service/src/**/*.test.ts',
      'cloud-service/src/**/*.test.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...automationScheduleBrandGuardSelectors, ...agentEventConstructionGuardSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },
  {
    files: ['cloud-service/src/**/*.ts'],
    ignores: [
      'cloud-service/src/**/__tests__/**',
      'cloud-service/src/**/*.test.ts',
      'cloud-service/src/**/*.test.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...automationScheduleBrandGuardSelectors, ...agentEventConstructionGuardSelectors, ...knownStructuredErrorCaptureSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // Stage 3 of docs/plans/260514_surface_capabilities_and_quick_wins.md —
  // cross-surface import discipline (secondary, belt-and-suspenders).
  //
  // The primary enforcement is `scripts/check-cross-surface-imports.ts`,
  // which catches BOTH static and dynamic forms and is wired into
  // `validate:fast`. ESLint adds a fast dev-loop signal for the static
  // form. There are NO file-level overrides — each currently allowlisted
  // import site uses a per-line `/* eslint-disable-next-line
  // @typescript-eslint/no-restricted-imports */` comment so each exception
  // is reviewable in source.
  {
    files: [
      'cloud-service/src/**/*.ts',
      'cloud-service/src/**/*.tsx',
      // `.mts` added so the @sentry/electron* shim guard (merged into the
      // `paths` below) covers the same cloud-service file set as the standalone
      // override it replaced. `no-restricted-imports` REPLACES (does not merge)
      // across matching objects, so the electron ban MUST live in this block to
      // coexist with the `@main/*` cross-surface restriction.
      'cloud-service/src/**/*.mts',
      'mobile/src/**/*.ts',
      'mobile/src/**/*.tsx',
      'mobile/app/**/*.ts',
      'mobile/app/**/*.tsx',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          // Cloud Sentry shim guard: the cloud build (cloud-service/build.mjs)
          // aliases `@sentry/electron` and `@sentry/electron/main` to the no-op
          // stub src/sentryShim.ts. A VALUE import of either from cloud-service
          // source bundles GREEN but SILENTLY no-ops (dead telemetry) — the
          // dangerous half of the silent/loud asymmetry. Ban value imports here;
          // `import type` is fine (erased at compile, no runtime resolution).
          // Use `@sentry/node` for real Sentry in the cloud. `@sentry/core` is
          // NO LONGER aliased, so it is not guarded. These entries only matter
          // for cloud-service files; mobile never imports @sentry/electron*.
          // See docs/plans/260621_cloud-sentry-shim-offline-transport/PLAN.md.
          paths: [
            {
              name: '@sentry/electron',
              message:
                '`@sentry/electron*` is aliased to a no-op shim in the cloud build — a value import silently no-ops (dead telemetry). Use `@sentry/node` for real Sentry; `import type` is fine.',
              allowTypeImports: true,
            },
            {
              name: '@sentry/electron/main',
              message:
                '`@sentry/electron*` is aliased to a no-op shim in the cloud build — a value import silently no-ops (dead telemetry). Use `@sentry/node` for real Sentry; `import type` is fine.',
              allowTypeImports: true,
            },
          ],
          patterns: [
            {
              group: ['@main/*'],
              message:
                'cloud-service/** and mobile/** must not import from src/main/. Move shared logic into @core/* (boundary interfaces) so it runs across desktop, cloud, and mobile. See docs/plans/260514_surface_capabilities_and_quick_wins.md Stage 3. The canonical enforcement is scripts/check-cross-surface-imports.ts (catches dynamic imports too); ESLint is the secondary signal. To override (allowlisted deferred migration only): add the (file, specifier) pair to ALLOWLIST in scripts/check-cross-surface-imports.ts AND prefix the import line with: // eslint-disable-next-line @typescript-eslint/no-restricted-imports -- allowlisted in scripts/check-cross-surface-imports.ts',
              allowTypeImports: false,
            },
          ],
        },
      ],
    },
  },

  // recs-drain #38: mobile/** (ONLY — NOT cloud-service, which has all root
  // deps and legitimately value-imports these barrels) must not VALUE-import a
  // broad `@shared` barrel (the `export *` index modules). They transitively
  // pull runtime deps (e.g. luxon via @shared/ipc/schemas) not declared in
  // mobile/package.json, breaking Metro/Jest resolution. Type-only imports are
  // fine (allowTypeImports) — they erase at compile. Canonical enforcement is
  // scripts/check-mobile-barrel-imports.ts (catches dynamic import() +
  // require() + value re-exports); ESLint is the secondary dev-loop signal.
  // Import the specific leaf module instead.
  {
    files: ['mobile/src/**/*.ts', 'mobile/src/**/*.tsx', 'mobile/app/**/*.ts', 'mobile/app/**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@shared/ipc/schemas',
              message:
                "Don't value-import the @shared/ipc/schemas barrel from mobile/** — it transitively pulls runtime deps (e.g. luxon) not in mobile/package.json. Import the specific leaf, e.g. @shared/ipc/schemas/feedback. Type-only imports are allowed. See scripts/check-mobile-barrel-imports.ts.",
              allowTypeImports: true,
            },
            {
              name: '@shared/ipc/channels',
              message:
                "Don't value-import the @shared/ipc/channels barrel from mobile/** — import the specific leaf module instead. Type-only imports are allowed. See scripts/check-mobile-barrel-imports.ts.",
              allowTypeImports: true,
            },
            {
              name: '@shared/types',
              message:
                "Don't value-import the @shared/types barrel from mobile/** — import the specific leaf, e.g. @shared/types/userQuestion. Type-only imports are allowed. See scripts/check-mobile-barrel-imports.ts.",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },

  // Test files: relax rules that add noise without meaningful safety value.
  // Non-null assertions in tests fail loudly at runtime (TypeError) which is
  // the correct behavior. `any` in test mocks/fixtures is pragmatic — the
  // alternative (verbose casts) reduces readability without improving safety.
  {
    files: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'src/**/__tests__/**/*.ts',
      'src/**/__tests__/**/*.tsx',
      'private/mindstone/src/**/*.test.ts',
      'private/mindstone/src/**/*.test.tsx',
      'private/mindstone/src/**/__tests__/**/*.ts',
      'private/mindstone/src/**/__tests__/**/*.tsx',
    ],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-properties': 'off',
      // Tests construct AnthropicClient/OpenAIClient directly for unit testing.
      // Tests also legitimately build rebel:///library:// URL fixtures to feed the parser.
      // Override to keep Pino guard + fire-and-forget guard + AutomationSchedule brand guard,
      // drop factory + nav URL guards.
      // NOTE: the agent-event `detail` parse guard (agentDetailParseGuardSelectors)
      // is intentionally NOT applied to test files — tests legitimately build
      // oversized/raw detail fixtures and call JSON.parse directly. See
      // docs/plans/260616_detail-parse-class-kill/PLAN.md (Stage 2 excludes
      // __tests__/*.test.*).
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...fireAndForgetGuardSelectors, ...automationScheduleBrandGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...privateMindstoneRuntimeImportGuardSelectors],
    },
  },

  // Stage 8 of docs/plans/260501_composer_tiptap_atmention_bugfix.md —
  // composer-surface lint guards. Forbids known wire-format-bypass footguns
  // (`.getMarkdown()`, `setContent({ contentType: 'markdown' })` inline +
  // aliased, `.markdown.parse()`) inside production composer files. Test
  // files under `src/renderer/features/composer/**/__tests__/**` and
  // `*.test.{ts,tsx}` are exempt — contract tests legitimately drive the
  // editor directly to assert wire-format invariants. The single audited
  // `editor.getMarkdown()` call site lives in `composerSnapshotCache.ts`
  // and uses a per-line `// eslint-disable-next-line no-restricted-syntax`
  // comment naming this plan.
  //
  // Rule definitions live in `composerCompositionGuardSelectors` near the top
  // of this file; the composite list below preserves the broader src/**
  // production rules so the composer block does not silently drop the Pino /
  // client-factory / fire-and-forget / nav-URL / automation / agent-event
  // guards while extending them with the four composer-specific selectors.
  {
    files: [
      'src/renderer/features/composer/**/*.ts',
      'src/renderer/features/composer/**/*.tsx',
    ],
    ignores: [
      'src/renderer/features/composer/**/__tests__/**',
      'src/renderer/features/composer/**/*.test.ts',
      'src/renderer/features/composer/**/*.test.tsx',
      // Spike fixtures live alongside the contract tests and intentionally
      // exercise banned shapes to validate the override-channel behaviour.
      'src/renderer/features/composer/**/*.spike.test.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...pinoArgOrderSelectors,
        ...clientFactoryGuardSelectors,
        ...fireAndForgetGuardSelectors,
        directWriteFileGuardSelector,
        ...navigationUrlGuardSelectors,
        ...automationScheduleBrandGuardSelectors,
        ...agentEventConstructionGuardSelectors,
        ...composerCompositionGuardSelectors,
        ...cloudInstanceStatusDirectWriteSelectors,
        ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors,
      ],
    },
  },

  // Bug 2 prevention (260616 stuck-library renderer-OOM) — agent-session
  // `detail` parse guard. Forbids direct `JSON.parse(detail)` /
  // `JSON.parse(*.detail)` inside production agent-session files; all such
  // parses must route through the size-guarded `safeParseDetail()` helper.
  // Zero-baseline: this run migrated every agent-session call site, so the
  // rule fires on no existing code. The canonical helper file
  // (`utils/safeParseDetail.ts`, which legitimately calls `JSON.parse`) and
  // test files (`__tests__/**`, `*.test.{ts,tsx}`) are excluded via `ignores`.
  //
  // Rule definitions live in `agentDetailParseGuardSelectors` near the top of
  // this file; the composite list re-includes the broader renderer production
  // guards (rendererBaseRestrictedSyntaxSelectors) so this block does not
  // silently drop them while extending with the two detail-parse selectors.
  // (Flat config replaces, not merges, `no-restricted-syntax` for matching
  // blocks, and this block is the last one matching agent-session files.)
  {
    files: [
      'src/renderer/features/agent-session/**/*.ts',
      'src/renderer/features/agent-session/**/*.tsx',
    ],
    ignores: [
      // Canonical size-guarded helper — the one sanctioned JSON.parse(detail).
      'src/renderer/features/agent-session/utils/safeParseDetail.ts',
      'src/renderer/features/agent-session/**/__tests__/**',
      'src/renderer/features/agent-session/**/*.test.ts',
      'src/renderer/features/agent-session/**/*.test.tsx',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...rendererBaseRestrictedSyntaxSelectors,
        ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors,
      ],
    },
  },

  // PDF/media preview origin guard for the document-editor feature
  // (PM 260619_pdf_preview_blank_blob_file_origin, Stage 2). Bans renderer
  // URL.createObjectURL so a new preview file can't re-introduce the origin-scoped blob
  // path that left the packaged (file://) PDF preview blank. Tests/fixtures are excluded
  // (they may reference the API as a string in source-text guards). Re-spreads the broader
  // renderer production guards so flat-config replacement does not silently drop them — this
  // block is the last one matching document-editor files. (Flat config REPLACES, not merges,
  // `no-restricted-syntax`; mirrors the agent-session block above.)
  {
    files: [
      'src/renderer/features/document-editor/**/*.ts',
      'src/renderer/features/document-editor/**/*.tsx',
    ],
    ignores: [
      'src/renderer/features/document-editor/**/__tests__/**',
      'src/renderer/features/document-editor/**/*.test.ts',
      'src/renderer/features/document-editor/**/*.test.tsx',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...rendererBaseRestrictedSyntaxSelectors,
        ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors,
        ...mediaPreviewBlobUrlGuardSelectors,
      ],
    },
  },

  // clientFactory.ts is the one place that legitimately constructs clients.
  // Keep Pino guard + fire-and-forget guard, drop client factory guard.
  {
    files: ['src/core/rebelCore/clientFactory.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...fireAndForgetGuardSelectors, ...navigationUrlGuardSelectors, ...providerRoutingTypeSafetySelectors, ...agentEventConstructionGuardSelectors, ...knownStructuredErrorCaptureSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...nativeBindingImportGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // libraryWrites.ts is the one sanctioned renderer wrapper around
  // window.libraryApi.writeFile. Keep all other syntax guards active.
  {
    files: ['src/renderer/utils/libraryWrites.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...clientFactoryGuardSelectors, ...fireAndForgetGuardSelectors, ...navigationUrlGuardSelectors, ...automationScheduleBrandGuardSelectors, ...agentEventConstructionGuardSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // R4 whitelist: the core Anthropic client wrapper remains a legitimate
  // direct SDK construction site during Stage 2.
  {
    files: [
      'src/core/rebelCore/clients/anthropicClient.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...fireAndForgetGuardSelectors, ...navigationUrlGuardSelectors, ...agentEventConstructionGuardSelectors, ...knownStructuredErrorCaptureSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...nativeBindingImportGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // src/shared/navigation is the one place that legitimately constructs rebel://
  // and library:// URLs. Keep Pino + client factory + fire-and-forget guards, drop
  // navigation URL guard.
  {
    files: ['src/shared/navigation/**/*.ts', 'src/shared/navigation/**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...clientFactoryGuardSelectors, ...fireAndForgetGuardSelectors, ...agentEventConstructionGuardSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // src/shared/data boundary: static data + helpers consumed by renderer (UI),
  // main (bundled bridge, MCP routes), cloud-service, and mobile. Must stay
  // platform-agnostic so all four surfaces can import it. Runtime imports from
  // electron, electron-store, react, react-native, and surface-specific path
  // aliases are forbidden. Tests under src/shared/data/**/__tests__/** are
  // exempt so fixtures can mock platform-side concerns.
  // See: docs/plans/260503_centralize_session_overrides_and_quality_tiers.md
  // (qualityTiers move from renderer to @shared/data was the trigger).
  {
    files: ['src/shared/data/**/*.ts', 'src/shared/data/**/*.tsx'],
    ignores: ['src/shared/data/**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                '@shared/data is platform-agnostic. Electron imports belong in src/main; @shared/data is consumed by all four surfaces (renderer, main, cloud, mobile).',
            },
            {
              name: 'electron-store',
              message:
                '@shared/data is platform-agnostic. electron-store belongs in src/main.',
            },
            {
              name: 'react',
              message:
                '@shared/data must not depend on React. Hooks and components belong in src/renderer.',
            },
            {
              name: 'react-native',
              message:
                '@shared/data must not depend on React Native. RN-specific code belongs in mobile/.',
            },
          ],
          patterns: [
            {
              group: ['@renderer/*', '@main/*'],
              message:
                '@shared/data must not depend on surface-specific modules. The whole point of @shared/data is that all four surfaces (renderer, main, cloud, mobile) can import the same data + pure helpers.',
            },
          ],
        },
      ],
    },
  },

  // src/core/navigation boundary: the core resolver is platform-agnostic and
  // must stay usable from desktop renderer, desktop main, cloud-service, and
  // mobile. Runtime imports from electron, react, react-native, or any
  // surface-specific path alias are forbidden so the boundary stays clean.
  // See: docs/plans/260416_centralize_cross_surface_links.md — Stage C.
  {
    files: ['src/core/navigation/**/*.ts', 'src/core/navigation/**/*.tsx'],
    ignores: ['src/core/navigation/**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                '@core/navigation is platform-agnostic. Electron imports belong in src/main/services/navigation adapters.',
            },
            {
              name: 'electron-store',
              message:
                '@core/navigation is platform-agnostic. electron-store belongs in src/main.',
            },
            {
              name: 'react',
              message:
                '@core/navigation must not depend on React. Hooks and context belong in src/renderer dispatchers.',
            },
            {
              name: 'react-native',
              message:
                '@core/navigation must not depend on React Native. RN-specific code belongs in mobile/.',
            },
          ],
          patterns: [
            {
              group: ['@renderer/*', '@main/*'],
              message:
                '@core/navigation must not depend on surface-specific modules. Use boundary interfaces (SpaceResolver) so adapters inject platform behaviour.',
            },
          ],
        },
      ],
    },
  },

  // src/core/services/recovery boundary: the unified recovery pipeline is
  // platform-agnostic and must stay usable from desktop main, cloud-service,
  // and mobile-via-cloud. Runtime imports from electron, the desktop turn
  // registry, and the desktop event dispatcher are forbidden so adapters
  // (RecoveryAdapter) inject platform behaviour. Surface-specific path
  // aliases (@main/*, @renderer/*) are also banned. Tests under
  // src/core/services/recovery/**/__tests__/** are exempt so fixtures can
  // mock the boundary. See:
  //   docs/plans/260503_unified_recovery_pipeline.md — Stage 0 / Stage 1
  //   docs/plans/260503_unified_recovery_pipeline_stage0_spike.md
  {
    files: ['src/core/services/recovery/**/*.ts', 'src/core/services/recovery/**/*.tsx'],
    ignores: ['src/core/services/recovery/**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'src/core/services/recovery/** is platform-agnostic. Electron imports belong in src/main adapters; inject behaviour via RecoveryAdapter instead.',
            },
            {
              name: 'electron-store',
              message:
                'src/core/services/recovery/** is platform-agnostic. electron-store belongs in src/main.',
            },
            {
              name: 'app',
              message:
                'src/core/services/recovery/** must not depend on electron.app. Inject platform behaviour via RecoveryAdapter.',
            },
            {
              name: 'ipcMain',
              message:
                'src/core/services/recovery/** must not depend on electron.ipcMain. The pipeline is invoked through the core boundary, not IPC directly.',
            },
            {
              name: 'BrowserWindow',
              message:
                'src/core/services/recovery/** must not reference BrowserWindow. Renderer dispatch flows through RecoveryAdapter.dispatchEvent.',
            },
          ],
          patterns: [
            {
              group: [
                '@main/*',
                '@renderer/*',
                '@main/services/agentTurnRegistry',
                '*/agentTurnRegistry',
              ],
              message:
                'src/core/services/recovery/** must not depend on surface-specific modules or the desktop turn registry. Use RecoveryAdapter (recordFallback / dispatchEvent) so adapters inject platform behaviour. See docs/plans/260503_unified_recovery_pipeline.md § Stage 1.',
            },
            {
              group: [
                '*/agentEventDispatcher',
                '@core/services/agentEventDispatcher',
              ],
              message:
                'src/core/services/recovery/** must not call dispatchAgentEvent / dispatchAgentErrorEvent directly. Recovery events flow through RecoveryAdapter.dispatchEvent so cloud and mobile surfaces stay parity-correct. See docs/plans/260503_unified_recovery_pipeline.md § Stage 3.',
            },
          ],
        },
      ],
    },
  },

  // Renderer process boundary: block runtime imports from @core/ (which may
  // use Node.js APIs unavailable in the renderer Vite build). Type-only imports
  // are allowed — renderer legitimately uses @core/ types. Runtime sharing
  // between processes should go through @shared/ or IPC.
  //
  // Exception: `@core/navigation` is deliberately platform-agnostic (its own
  // boundary rule above prevents Node/Electron/React imports), so it is safe
  // in the renderer Vite build. The renderer NavigationContext uses it as
  // the link resolver — see Stage D of
  // docs/plans/260416_centralize_cross_surface_links.md.
  // Renderer @typescript-eslint/no-restricted-imports — BROAD block (lowest
  // precedence; the two narrow override blocks further down subtract one entry
  // each for the files that legitimately need it).
  //
  // The former broad `@core/**` runtime ban that lived here was DELIBERATELY
  // DROPPED (260623 render-drop-followups). It was stale: the renderer is
  // core-first by design and legitimately runtime-imports ~30 pure `@core`
  // modules (sessionIngestGuard, conversationState, modelRoleResolver, …), so
  // an `@core/**`-with-carveouts ban is both wrong and not even expressible
  // (this plugin's `patterns.group` ignores `!`-negation globs — see the
  // councilProfiles.ts note below). The true invariant (no node-only poison
  // reachable from the renderer Vite bundle) is enforced — better — by the
  // graph check scripts/check-renderer-core-rn-safety.ts (in validate:fast),
  // which supersedes this ESLint ban entirely.
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
    ignores: [
      'src/renderer/**/__tests__/**',
      'src/renderer/**/*.test.ts',
      'src/renderer/**/*.test.tsx',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [...rendererRestrictedImportPaths],
        },
      ],
    },
  },

  // Stage 7 of docs/plans/260618_multiprovider-foundation/PLAN.md:
  // Renderer code must use getDisplayProviderChain() (active-at-head, for the
  // "main + backups" editor view) rather than getEnabledProviders() (raw list-priority,
  // for the router). The two accessors have opposite semantics at the head — the
  // router needs the raw list; the settings UI needs activeProvider first.
  // Tests are exempt (they may test either accessor directly).
  {
    files: ['src/renderer/**/*.ts', 'src/renderer/**/*.tsx'],
    ignores: [
      'src/renderer/**/__tests__/**',
      'src/renderer/**/*.test.ts',
      'src/renderer/**/*.test.tsx',
    ],
    rules: {
      // Re-spread the base authService ban (paths + patterns) so it stays live
      // for renderer files alongside the getEnabledProviders ban — flat config
      // REPLACES this rule, so without the re-spread the base block's
      // authService ban (the only renderer protection) would be silently dead.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...authServiceImportRestrictionPaths,
            {
              name: '@shared/utils/settingsUtils',
              importNames: ['getEnabledProviders'],
              message:
                'Renderer code must not import getEnabledProviders directly. Use getDisplayProviderChain from @shared/utils/settingsUtils instead — it coerces activeProvider to the head for the "main + backups" editor view. (getEnabledProviders returns the raw list for the router, which has opposite head semantics.) See docs/plans/260618_multiprovider-foundation/PLAN.md — Stage 7.',
            },
          ],
          patterns: [...authServiceImportRestrictionPatterns],
        },
      ],
    },
  },

  // src/shared boundary: runtime @core/ imports inside src/shared/** transitively
  // leak into the renderer Vite bundle (because the renderer freely imports from
  // @shared/). See the 260511 renderer crash where @shared/utils/councilProfiles
  // imported @core/rebelCore/settingsAccessors, which pulled in @core/logger and
  // node:fs.mkdirSync at module-eval time — bricking `npm run dev`.
  //
  // Carveouts:
  // - @core/navigation: platform-agnostic, enforced by its own boundary rule.
  // - @core/rebelCore/settingsAccessorsPure: deliberate pure twin of
  //   settingsAccessors with no node:fs / electron / logger imports, created
  //   specifically so renderer-reachable code in @shared/ can read settings
  //   keys without dragging in main-process modules.
  // Type-only imports are exempt via allowTypeImports.
  // Tests under src/shared/**/__tests__/** are exempt because they run in
  // Vitest (node), not in the renderer bundle.
  {
    files: ['src/shared/**/*.ts', 'src/shared/**/*.tsx'],
    ignores: ['src/shared/**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@core/**', '!@core/navigation', '!@core/navigation/**'],
              message:
                'Runtime @core/ imports inside src/shared/** leak into the renderer Vite bundle via @shared/ consumers. Use @shared/ utilities, IPC, or platform-safe pure twins (e.g. @core/rebelCore/settingsAccessorsPure). Type-only imports (import type) are allowed.',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },

  // Per-file carveout: councilProfiles.ts deliberately imports
  // @core/rebelCore/settingsAccessorsPure (the pure, renderer-safe twin of
  // settingsAccessors with no node:fs / electron / logger transitive deps).
  // This was the surgical fix for the 260511 renderer crash; the pure twin
  // exists specifically so this file can read setting keys without dragging
  // node:fs.mkdirSync into the Vite bundle.
  //
  // The shared-** rule above can't express a
  // "deny @core/** except @core/rebelCore/settingsAccessorsPure" carveout:
  // @typescript-eslint/no-restricted-imports' `patterns.group` in this
  // plugin version does not honor negation globs (`!`-prefixed entries) the
  // way minimatch's CLI does. Three glob shapes were tried at the general
  // shared-** block AND at this per-file override block — all rejected the
  // legitimate pure-twin import. Disabling the rule for this single,
  // explicitly audited file is the cleanest expressible alternative; the
  // general shared-** block above continues to enforce the policy on every
  // other file under src/shared/**.
  {
    files: ['src/shared/utils/councilProfiles.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
    },
  },

  // @rebel/shared boundary (Stage 0 of
  // docs/plans/260416_centralize_approval_and_diff_viewing_ux.md):
  // The shared package is platform-agnostic. It must not import from Electron,
  // Zustand, React, cloud-client, desktop renderer/main/core, or any platform layer.
  // React is allowed ONLY in packages/shared/src/hooks/** where legitimate
  // hook primitives live (e.g. useSmoothStream). F-R2-4 aligns the ESLint
  // rule with this policy.
  // Existing test files in packages/shared/src/__tests__ are exempt so the
  // rule doesn't block bootstrapping.
  {
    files: ['packages/shared/src/**/*.ts', 'packages/shared/src/**/*.tsx'],
    ignores: ['packages/shared/src/**/__tests__/**', 'packages/shared/src/hooks/**'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                '@rebel/shared is platform-agnostic. Electron imports are banned. Move platform-specific code to src/main or cloud-service.',
            },
            {
              name: 'zustand',
              message:
                '@rebel/shared must stay state-library-neutral. Zustand stores belong in cloud-client or src/renderer.',
            },
            {
              name: 'react',
              message:
                '@rebel/shared must stay React-free outside of packages/shared/src/hooks/. Move React hooks to that directory or to cloud-client.',
            },
          ],
          patterns: [
            {
              group: ['@core/*', '@main/*', '@renderer/*', '@shared/*', '@rebel/cloud-client', '@rebel/cloud-client/*'],
              message:
                '@rebel/shared must not depend on platform layers or cloud-client. Reverse-coupling defeats the shared package.',
            },
          ],
        },
      ],
    },
  },
  // @rebel/shared hooks exception: React IS allowed in packages/shared/src/hooks/
  // where legitimate hook primitives live (e.g. useSmoothStream). All other
  // @rebel/shared boundary rules still apply. F-R2-4.
  {
    files: ['packages/shared/src/hooks/**/*.ts', 'packages/shared/src/hooks/**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                '@rebel/shared is platform-agnostic. Electron imports are banned.',
            },
            {
              name: 'zustand',
              message:
                '@rebel/shared must stay state-library-neutral. Zustand stores belong in cloud-client or src/renderer.',
            },
            // NOTE: 'react' is intentionally NOT banned here — this is the
            // hooks directory where React imports are legitimate (F-R2-4).
          ],
          patterns: [
            {
              group: ['@core/*', '@main/*', '@renderer/*', '@shared/*', '@rebel/cloud-client', '@rebel/cloud-client/*'],
              message:
                '@rebel/shared must not depend on platform layers or cloud-client.',
            },
          ],
        },
      ],
    },
  },

  // @rebel/cloud-client boundary (Stage 0 of
  // docs/plans/260416_centralize_approval_and_diff_viewing_ux.md):
  // cloud-client is the cross-surface client layer. It must not import from
  // Electron or the desktop renderer/main. It may import from @rebel/shared
  // (the upstream pure layer) and from @core type-only where unavoidable.
  // Existing test files under cloud-client/src/__tests__ are exempt so the
  // rule doesn't block bootstrapping.
  {
    files: ['cloud-client/src/**/*.ts', 'cloud-client/src/**/*.tsx'],
    ignores: ['cloud-client/src/**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                '@rebel/cloud-client is cross-surface (desktop + mobile + web). Electron imports are banned. Use a transport adapter (see cloud-client/src/transport/approvalTransport.ts).',
            },
          ],
          patterns: [
            {
              group: ['@renderer/*', '@main/*'],
              message:
                '@rebel/cloud-client must not depend on desktop process layers. Move platform-specific code to its respective adapter.',
            },
            {
              group: ['@core/*', '@shared/*'],
              message:
                '@rebel/cloud-client should not take runtime deps on @core/* or @shared/*. Pure cross-surface code belongs in @rebel/shared; IPC contracts may be imported type-only.',
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },

  // react-markdown import guard (I10 Stage F):
  // All markdown rendering must go through the shared pipeline
  // (`preprocessMarkdownForRender` + `findBlockedUrlScheme`) exposed by the
  // wrapper components. Direct `react-markdown` or `remark-gfm` imports skip
  // the space-path preprocessor and the dangerous-scheme URL guard (both
  // `<img src>` and `<a href>`); direct useHotkeys() misses the
  // contenteditable-safe wrapper.
  // See: docs/plans/260422_i10_shared_markdown_pipeline_STAGED_PLAN.md § Stage F.
  //
  // NARROW OVERRIDE — wrapper files. These files (MessageMarkdown / SafeMarkdown
  // / WhatsNewDialog / exportUtils / useGlobalHotkey) legitimately import
  // react-markdown / remark-gfm / useHotkeys, so the broad union above must NOT
  // ban those for them. This override re-applies ONLY the searchFiles ban (the
  // rest of the union) so they stay covered there. Without re-spreading,
  // flat-config REPLACE would leave these files with zero renderer import bans.
  {
    files: [
      'src/renderer/components/MessageMarkdown.tsx',
      'src/renderer/components/SafeMarkdown.tsx',
      'src/renderer/components/WhatsNewDialog.tsx',
      'src/renderer/utils/exportUtils.ts',
      'src/renderer/hooks/useGlobalHotkey.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [...rendererSearchFilesRestrictedPaths],
        },
      ],
    },
  },
  {
    files: ['web-companion/src/**/*.ts', 'web-companion/src/**/*.tsx'],
    ignores: [
      'web-companion/src/components/SafeWebMarkdown.tsx',
      'web-companion/src/**/__tests__/**',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-markdown',
              message:
                'Direct react-markdown imports bypass the I10 shared pipeline (space-path preprocessor + dangerous-scheme URL guard for both <img src> and <a href>). Use SafeWebMarkdown from web-companion/src/components/SafeWebMarkdown.tsx instead. See docs/plans/260422_i10_shared_markdown_pipeline_STAGED_PLAN.md.',
              allowTypeImports: true,
            },
            {
              name: 'remark-gfm',
              message:
                'remark-gfm is already included by preprocessMarkdownForRender from @rebel/shared. Importing it directly indicates a non-wrapper surface — migrate via SafeWebMarkdown.',
            },
          ],
        },
      ],
    },
  },

  // Web-companion hygiene parity with src/** — I10 follow-up F5.
  // Mirrors the shared TS + react-hooks + naming-convention rules so the
  // cloud companion doesn't accumulate hygiene drift.
  //
  // Type-aware `no-floating-promises` enabled via `parserOptions.project` as
  // of the 260423 floating-promises rollout (OW-6): 44 sites migrated to the
  // local `fireAndForget` helper across Stage 1/1.5/1.6/2; this block turns
  // the rule on so future regressions fail lint instead of shipping silently.
  // The rule is ALSO duplicated into the web-companion test override below so
  // it applies to test files — we keep the `__tests__` ignore on this block
  // to avoid broadening naming/no-console/hooks rules onto tests (Option B of
  // the Phase-0 DA critique). See
  // docs/plans/260423_web_companion_no_floating_promises_rollout.md (v2.2)
  // and docs/plans/260422_i10_followups_STAGED_PLAN.md.
  {
    files: ['web-companion/src/**/*.ts', 'web-companion/src/**/*.tsx'],
    ignores: ['web-companion/src/**/__tests__/**'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
        project: './web-companion/tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      // TypeScript hygiene
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // Naming conventions (parity with src/**)
      '@typescript-eslint/naming-convention': [
        'warn',
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'function',
          format: ['camelCase', 'PascalCase'],
          leadingUnderscore: 'allow',
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'enumMember',
          format: ['PascalCase', 'UPPER_CASE'],
        },
      ],

      // React Hooks — rule definitions required so existing
      // `eslint-disable react-hooks/exhaustive-deps` comments don't error.
      // useIpcEvent is intentionally NOT in additionalHooks (parity with src/**).
      // exhaustive-deps promoted to `error` for parity with src/** (260502 sweep).
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',

      // TDZ guard (parity with src/**)
      'no-use-before-define': 'off',
      '@typescript-eslint/no-use-before-define': [
        'warn',
        {
          functions: false,
          classes: true,
          variables: true,
          allowNamedExports: false,
          ignoreTypeReferences: true,
        },
      ],

      // General
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'warn',
      'no-var': 'error',

      // Type-aware: forbid unhandled promises + `void promise`. Every fire-
      // and-forget detach point must go through `fireAndForget(p, 'label')`
      // (web-companion/src/utils/fireAndForget.ts) so rejections are logged
      // with a searchable breadcrumb instead of vanishing into the browser's
      // unhandled-rejection warning. See
      // docs/plans/260423_web_companion_no_floating_promises_rollout.md.
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
    },
  },

  // Web-companion test override: relax rules that add noise in fixtures.
  // Parser options repeated so the TS parser loads for test files (the
  // default eslint parser fails on `interface` and JSX type imports).
  // `parserOptions.project` and `no-floating-promises` are duplicated here
  // (rather than removing the `__tests__` ignore from the hygiene block
  // above) so floating-promise enforcement applies uniformly to production
  // and test code WITHOUT broadening naming/no-console/hooks hygiene onto
  // tests. See docs/plans/260423_web_companion_no_floating_promises_rollout.md
  // Phase-0 DA critique (Option B).
  {
    files: [
      'web-companion/src/**/__tests__/**/*.ts',
      'web-companion/src/**/__tests__/**/*.tsx',
      'web-companion/src/**/*.test.ts',
      'web-companion/src/**/*.test.tsx',
    ],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
        project: './web-companion/tsconfig.test.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
    },
  },

  // Selective type-aware linting (renderer-only strict block): catch floating
  // promises + misused promise returns in high-risk renderer files at `error`
  // severity. Originally introduced by docs/plans/260415_selective_type_aware_eslint.md.
  // The renderer surface uses a dedicated parser program
  // (`tsconfig.eslint-strict.json` extending `tsconfig.renderer.json`) because
  // renderer JSX/DOM types aren't in `tsconfig.node.json`. Runs during both
  // `npm run lint` and `npm run lint:strict`.
  {
    files: [
      'src/renderer/App.tsx',
      'src/renderer/hooks/useModelRoles.ts',
      'src/renderer/features/focus/components/FocusNoCalendar.tsx',
      'src/renderer/features/library/components/LibraryLensBar.tsx',
      'src/renderer/features/library/components/LibraryNavigator.tsx',
      'src/renderer/features/plugins/components/PluginSurface.tsx',
      'src/renderer/features/homepage/HomepagePanel.tsx',
      'src/renderer/features/homepage/components/CoachSection.tsx',
      'src/renderer/features/settings/components/tabs/PluginsTab.tsx',
      'src/renderer/features/agent-session/components/MeetingCompanionManager.tsx',
    ],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint-strict.json',
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': ['error', {
        checksVoidReturn: { attributes: false },
        checksConditionals: true,
      }],
    },
  },

  // Stages 6.1 + 6.2 + 6.3 of docs/plans/260522_compile-time-reliability/PLAN.md:
  // type-aware lint extended across the entire src/main/** + src/core/**
  // surface (~398 kLOC) under a single shared program (`tsconfig.node.json`)
  // to avoid per-block program-creation memory pressure (was causing v8 OOM
  // when split into 3 separate programs — empirical observation 2026-05-25).
  //
  // All 4 rules land at `warn` severity by default with ratchet baselines
  // absorbing existing populations. The Stage 6.1 hot zone (5 high-traffic
  // files in the agent-turn / mcpService / safeStorage path) gets an
  // OVERRIDE block below that promotes the 3 binary-decision rules to
  // `error` for those files (switch-exhaustiveness stays at `warn` until
  // DI-22 cleans up the 3 baseline switches). Promotion of the broader
  // surface to `error` is tracked by DI-22 (switch-exhaustiveness),
  // DI-23 (no-floating-promises), DI-24 (no-misused-promises), DI-25
  // (await-thenable) and folded into Stage 6.5's CI wiring sweep.
  //
  // Cost: spike Stage 6.0 measured +9.2s cold lint wall for this surface
  // under a single program block (subagent_reports/260525_1210_implementer-stage06-spike.md).
  {
    files: ['src/main/**/*.ts', 'src/main/**/*.tsx', ...privateMindstoneSourceGlobs, 'src/core/**/*.ts', 'src/core/**/*.tsx'],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
      // Synthetic file paths used by scripts/check-bts-prefix-decoder-rule.ts
      // (lint-rule smoke test): paths don't exist on disk so typescript-eslint's
      // type-aware parser silently skips the file (and all rules including the
      // bts-flow-shape rule under test). Excluding these synthetic names lets
      // the BTS rule self-test continue to verify behavior at these paths.
      'src/main/services/new-leaker.ts',
      'src/main/services/new-destructure-leaker.ts',
      'src/main/services/new-safe-reader.ts',
    ],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.node.json',
      },
    },
    plugins: {
      'rebel-result': resultUsagePlugin,
    },
    rules: {
      // DI-26 (260607): result-object analog of no-floating-promises — flags a
      // discarded discriminated Result union. warn + ratchet (baseline measured
      // before shipping); see scripts/check-eslint-warnings.ts.
      'rebel-result/no-unused-result': 'warn',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }], // DI-23 (260607): promoted across src/main+src/core after clearing all sites (void→fireAndForget). With cloud-service already error, the async-safety trio (DI-23/24/25) is now error codebase-wide.
      '@typescript-eslint/no-misused-promises': ['error', { // DI-24 (260606): promoted after clearing 34 baseline sites.
        checksVoidReturn: { attributes: false },
        checksConditionals: true,
      }],
      '@typescript-eslint/await-thenable': 'error', // DI-25 (260606): promoted to error after clearing 25 baseline violations across src/main + src/core + cloud-service.
      // DI-22 (260603): promoted to `error` across src/main/** + src/core/** after
      // clearing the 28 baseline switch-exhaustiveness + 7 no-bare-default violations.
      // A non-exhaustive switch over a closed union (the #1 recurring bug class —
      // `incomplete_implementation`) now fails the build instead of warning.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },

  // Stage 6.1 hot-zone override: promote 3 of the 4 type-aware rules to
  // `error` severity for the 5 highest-blast-radius files. Inherits
  // parserOptions from the broad block above (same tsconfig.node.json
  // program — no new TS program created).
  {
    files: [
      'src/core/services/turnPipeline/agentTurnExecute.ts',
      'src/core/services/agentTurnService.ts',
      'src/core/services/agentTurnRegistry.ts',
      'src/core/services/safeStorageDecode.ts',
      'src/main/services/mcpService.ts',
    ],
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
      '@typescript-eslint/no-misused-promises': ['error', {
        checksVoidReturn: { attributes: false },
        checksConditionals: true,
      }],
      '@typescript-eslint/await-thenable': 'error',
      // switch-exhaustiveness-check is now `error` for the hot zone too, inherited
      // from the broad src/main+src/core block above (DI-22 landed 260603).
    },
  },

  // Stage 6.4 of docs/plans/260522_compile-time-reliability/PLAN.md: type-aware
  // lint extended to cloud-service/src/**. Same rule set + severity as 6.2/6.3.
  // Uses cloud-service's own tsconfig (separate TS program — cloud-service
  // includes ../src/main + ../src/shared via its tsconfig include paths but
  // that overlap doesn't double the cost because typescript-eslint shares
  // SourceFile instances across programs by path).
  {
    files: ['cloud-service/src/**/*.ts', 'cloud-service/src/**/*.tsx'],
    ignores: ['**/__tests__/**', '**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts'],
    languageOptions: {
      parserOptions: {
        project: './cloud-service/tsconfig.json',
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }], // DI-23 (260606): cloud-service/src cleared (incl. sendJson chokepoint) + promoted; src/main+src/core block still warn until its sites clear.
      '@typescript-eslint/no-misused-promises': ['error', { // DI-24 (260606): promoted after clearing 34 baseline sites.
        checksVoidReturn: { attributes: false },
        checksConditionals: true,
      }],
      '@typescript-eslint/await-thenable': 'error', // DI-25 (260606): promoted to error after clearing 25 baseline violations across src/main + src/core + cloud-service.
      // DI-22 (260603): cloud-service/src/** is also clean (0 violations), so the
      // guard is `error` here too — consistent with src/main + src/core.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },

  // vi.mock guard: rule is DISABLED (severity 'off') — see Stage 1 of
  // docs/plans/260515_eslint_warning_floor_and_ratchet.md and the note in
  // docs/project/CODING_PRINCIPLES.md for rationale. The rule and its
  // metadata are intentionally retained for future re-evaluation (per-test-file
  // override, codemod-then-relight cycle, etc.).
  // Architectural preference (still in force, enforced via review not lint):
  // prefer dependency injection or @internal exports over module mocking.
  {
    files: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'src/**/__tests__/**/*.ts',
      'src/**/__tests__/**/*.tsx',
    ],
    rules: {
      // Rule is 'off' — the message metadata below is documentary only and
      // will not fire. Do NOT add `// eslint-disable-next-line no-restricted-properties`
      // directives when calling `vi.mock` / `vi.doMock`: the rule is silent
      // and any such directive becomes an unused-disable warning that trips
      // BASELINE_NULL_RULE=0 in the per-rule ratchet (scripts/check-eslint-warnings.ts).
      'no-restricted-properties': [
        'off',
        {
          object: 'vi',
          property: 'mock',
          message:
            'Architectural preference (not enforced by lint): prefer dependency injection or @internal exports over vi.mock(). See docs/plans/260515_eslint_warning_floor_and_ratchet.md for rationale.',
        },
        {
          object: 'vi',
          property: 'doMock',
          message:
            'Architectural preference (not enforced by lint): prefer dependency injection or @internal exports over vi.doMock(). See docs/plans/260515_eslint_warning_floor_and_ratchet.md for rationale.',
        },
      ],
    },
  },

  // providerFeatureGate scope (Stage 1 of
  // docs/plans/260505_typed_provider_capability_matrix.md). Three sibling
  // blocks scoped to the shared client primitives where the bug class lives:
  // the OpenAI-client family under `src/core/rebelCore/clients/**` (plus
  // `planningMode.ts`), `anthropicClient.ts`, and `behindTheScenesClient.ts`.
  // Each block re-declares the prior matching block's `no-restricted-syntax`
  // selectors plus `providerFeatureGateGuardSelectors` so the new rule is the
  // LAST match (flat-config rule replacement). Excluded by virtue of NOT
  // matching: clientFactory.ts (`src/core/rebelCore/clientFactory.ts`),
  // providerRouting.ts, providerRouteDecision.ts, providerFeatureGuards.ts.
  // Test files under __tests__/ inherit the broader test override (which
  // drops the providerFeatureGate selectors so unit tests can construct
  // discriminated values directly).
  //
  // Why 3 blocks rather than 1: anthropicClient.ts has its own earlier
  // override that intentionally drops the client-factory guard (it's the
  // sanctioned direct-construction site); the OpenAI-client family +
  // planningMode.ts get the standard core selectors; behindTheScenesClient.ts
  // gets the providerRoutingGuardRules selectors (which also include the R4
  // ProviderRoutePlan type-safety guard). Each block respread is faithful to
  // its prior-match block so we don't drop unrelated rules.
  //
  // Why a glob for the OpenAI block: sibling files under `clients/` (e.g.
  // `openaiTranslators.ts`, future shared helpers) are part of the same
  // shared-primitive surface and should not become a back-door for ad-hoc
  // gates. anthropicClient.ts also matches this glob, but the next block
  // (anthropicClient-specific) wins via flat-config rule replacement.
  {
    files: [
      'src/core/rebelCore/clients/**/*.{ts,tsx}',
      'src/core/rebelCore/planningMode.ts',
    ],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...clientFactoryGuardSelectors, ...fireAndForgetGuardSelectors, ...timezoneUnsafeSelectors, ...navigationUrlGuardSelectors, ...automationScheduleBrandGuardSelectors, ...agentEventConstructionGuardSelectors, ...cleanupBypassGuardSelectors, ...knownStructuredErrorCaptureSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...terminalLifecycleEmissionGuardSelectors, ...providerFeatureGateGuardSelectors, ...nativeBindingImportGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },
  {
    files: ['src/core/rebelCore/clients/anthropicClient.ts'],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...fireAndForgetGuardSelectors, ...navigationUrlGuardSelectors, ...agentEventConstructionGuardSelectors, ...knownStructuredErrorCaptureSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...providerFeatureGateGuardSelectors, ...nativeBindingImportGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },
  {
    files: ['src/core/services/behindTheScenesClient.ts'],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...clientFactoryGuardSelectors, ...fireAndForgetGuardSelectors, ...timezoneUnsafeSelectors, ...navigationUrlGuardSelectors, ...automationScheduleBrandGuardSelectors, ...providerRoutingTypeSafetySelectors, ...agentEventConstructionGuardSelectors, ...cleanupBypassGuardSelectors, ...knownStructuredErrorCaptureSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...terminalLifecycleEmissionGuardSelectors, ...providerFeatureGateGuardSelectors, ...nativeBindingImportGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // Stage 1 of docs/plans/260525_typing-refactor-postmortem-driven/PLAN.md:
  // SDK extractor guard scope (F3) — forbid direct `.message.content` reads on
  // OpenAI response shapes outside the canonical extractor helper.
  //
  // The scoped blocks below mirror existing selector arrays so flat-config
  // rule replacement preserves prior selectors while appending the new
  // sdkExtractorGuardSelectors. Refinement (Phase 6): include additional
  // extractor consumers in src/core/services/behindTheScenesClient.ts and
  // src/main/services/localModelProxyServer.ts.
  {
    files: ['src/core/rebelCore/clients/**/*.ts'],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...clientFactoryGuardSelectors, ...fireAndForgetGuardSelectors, ...timezoneUnsafeSelectors, ...navigationUrlGuardSelectors, ...automationScheduleBrandGuardSelectors, ...agentEventConstructionGuardSelectors, ...cleanupBypassGuardSelectors, ...knownStructuredErrorCaptureSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...terminalLifecycleEmissionGuardSelectors, ...providerFeatureGateGuardSelectors, ...sdkExtractorGuardSelectors, ...nativeBindingImportGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },
  {
    files: ['src/core/rebelCore/clients/anthropicClient.ts'],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...fireAndForgetGuardSelectors, ...navigationUrlGuardSelectors, ...agentEventConstructionGuardSelectors, ...knownStructuredErrorCaptureSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...providerFeatureGateGuardSelectors, ...sdkExtractorGuardSelectors, ...nativeBindingImportGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },
  {
    files: ['src/main/services/behindTheScenesClient.ts'],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...clientFactoryGuardSelectors, ...fireAndForgetGuardSelectors, ...timezoneUnsafeSelectors, ...navigationUrlGuardSelectors, ...automationScheduleBrandGuardSelectors, ...providerRoutingTypeSafetySelectors, ...agentEventConstructionGuardSelectors, ...cleanupBypassGuardSelectors, ...knownStructuredErrorCaptureSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...terminalLifecycleEmissionGuardSelectors, ...providerFeatureGateGuardSelectors, ...sdkExtractorGuardSelectors, ...nativeBindingImportGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },
  {
    files: ['src/core/services/behindTheScenesClient.ts'],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...clientFactoryGuardSelectors, ...fireAndForgetGuardSelectors, ...timezoneUnsafeSelectors, ...navigationUrlGuardSelectors, ...automationScheduleBrandGuardSelectors, ...providerRoutingTypeSafetySelectors, ...agentEventConstructionGuardSelectors, ...cleanupBypassGuardSelectors, ...knownStructuredErrorCaptureSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...terminalLifecycleEmissionGuardSelectors, ...providerFeatureGateGuardSelectors, ...sdkExtractorGuardSelectors, ...nativeBindingImportGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },
  {
    files: ['src/main/services/localModelProxyServer.ts'],
    ignores: [
      '**/__tests__/**',
      '**/*.test.ts',
      '**/*.test.tsx',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...clientFactoryGuardSelectors, ...fireAndForgetGuardSelectors, ...timezoneUnsafeSelectors, ...navigationUrlGuardSelectors, ...automationScheduleBrandGuardSelectors, ...providerRoutingTypeSafetySelectors, ...agentEventConstructionGuardSelectors, ...cleanupBypassGuardSelectors, ...knownStructuredErrorCaptureSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...terminalLifecycleEmissionGuardSelectors, ...sdkExtractorGuardSelectors, ...nativeBindingImportGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // SDK extractor allowlist: the helper itself is the canonical extraction
  // site, so keep prior syntax guards but omit sdkExtractorGuardSelectors.
  {
    files: ['src/core/rebelCore/clients/openaiTranslators.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...clientFactoryGuardSelectors, ...fireAndForgetGuardSelectors, ...timezoneUnsafeSelectors, ...navigationUrlGuardSelectors, ...automationScheduleBrandGuardSelectors, ...agentEventConstructionGuardSelectors, ...cleanupBypassGuardSelectors, ...knownStructuredErrorCaptureSelectors, ...modelsNamespaceDestructureGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...terminalLifecycleEmissionGuardSelectors, ...providerFeatureGateGuardSelectors, ...nativeBindingImportGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // SDK extractor allowlist: settings profile-validation reads intentionally
  // parse user-pasted OpenAI JSON payloads and are outside SDK extraction.
  {
    files: ['src/main/ipc/settingsHandlers.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...pinoArgOrderSelectors, ...clientFactoryGuardSelectors, ...fireAndForgetGuardSelectors, ...timezoneUnsafeSelectors, ...navigationUrlGuardSelectors, ...automationScheduleBrandGuardSelectors, ...agentEventConstructionGuardSelectors, ...cleanupBypassGuardSelectors, ...cloudInstanceStatusDirectWriteSelectors, ...compactionCounterShadowGuardSelectors, ...modelsNamespaceDestructureGuardSelectors, ...terminalLifecycleEmissionGuardSelectors, ...nativeBindingImportGuardSelectors, ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors],
    },
  },

  // Lint regression fixtures for the providerFeatureGate rule. The fixtures
  // under `src/core/rebelCore/__lint_fixtures__/providerFeatureGate/` contain
  // deliberate violations and are excluded from `npm run lint` via the
  // top-of-file `ignores` block. The dedicated test runner shells out to
  // ESLint with `--no-ignore` to assert each shape fires (or stays clean for
  // the negative fixtures). See
  // docs/plans/260505_typed_provider_capability_matrix.md Stage 1.

  // Stage 6 of docs/plans/260524_library_search_centralization.md:
  // The shared library search engine at
  // src/renderer/features/library/search/engine.ts is the single canonical
  // entry point for library search. All renderer consumers must import
  // `searchLibrary` from the engine, not `searchFiles` from
  // `@renderer/utils/librarySearch` (which is reserved for the engine and
  // legacy resolution paths).
  //
  // NARROW OVERRIDE — engine files. engine.ts and librarySearch.tsx are the
  // only files allowed to import searchFiles, so the broad union above must NOT
  // ban searchFiles for them. This override re-applies ONLY the react-markdown
  // set (the rest of the union) so they stay covered there. Without
  // re-spreading, flat-config REPLACE would leave these files with zero
  // renderer import bans.
  {
    files: [
      'src/renderer/features/library/search/engine.ts',
      'src/renderer/utils/librarySearch.tsx',
    ],
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [...rendererReactMarkdownRestrictedPaths],
        },
      ],
    },
  },

  // Stage 4 of docs/plans/260612_recs-round5/PLAN.md:
  // connection cards must reach restart-blocking MCP settings operations only
  // through ConnectionCardOps. Scope is deliberately narrow: the type system
  // owns the old prop shape, and this lint backstop covers only the raw global
  // escape hatch in the two card-family files. The ops factory is intentionally
  // not in this file list.
  {
    files: [
      'src/renderer/features/settings/components/ExpandedConnectionCard.tsx',
      'src/renderer/features/settings/components/McpAccountsExtension.tsx',
      'src/renderer/features/settings/components/__lint_fixtures__/connectionCardOps/**/*.fixture.tsx',
    ],
    rules: {
      // Flat config replaces, not merges, `no-restricted-syntax` for matching
      // files. Re-spread the renderer base selectors before adding the scoped
      // ConnectionCardOps guard so unrelated guards (Pino arg-order,
      // fire-and-forget, navigation URL, …) stay live on these files.
      'no-restricted-syntax': [
        'error',
        ...rendererBaseRestrictedSyntaxSelectors,
        {
          selector:
            "MemberExpression[object.type='MemberExpression'][object.object.name='window'][object.property.name='settingsApi'][property.name=/^(mcpAddBundledServer|mcpUpsertServer|mcpRemoveServer|mcpToggleServerEnabled)$/]",
          message:
            'Connection cards must use ConnectionCardOps for restart-blocking MCP settings operations; raw window.settingsApi.mcp* calls bypass the tracked-op chokepoint.',
        },
        ...originAutomationDriftGuardSelectors, ...dnsThreadpoolDecoupleGuardSelectors, ...agentDetailParseGuardSelectors,
      ],
    },
  },

  // Lint-fixture parser carve-out (must be the LAST block so its parser /
  // rule overrides win for matching files). These fixture files under
  // `**/__lint_fixtures__/` exercise lint rules via tests that shell out to
  // ESLint with `--no-ignore`. Some fixture paths are deliberately excluded
  // from `tsconfig.node.json` (e.g. `src/main/services/turnPipeline/__lint_fixtures__/`)
  // so the type-aware parser fatals before any rule fires when type-aware
  // blocks above match. Disable type-aware parsing (and the four typed rules
  // whose `create()` requires parser-services) only for these fixtures —
  // syntactic rules (`no-restricted-syntax`, `no-restricted-imports`, etc.)
  // remain fully active so the negative fixtures still trigger their guards.
  {
    files: [
      '**/__lint_fixtures__/**/*.fixture.ts',
      '**/__lint_fixtures__/**/*.fixture.js',
      '**/__lint_fixtures__/**/*.fixture.tsx',
    ],
    languageOptions: {
      parserOptions: { project: null, projectService: false },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': 'off',
    },
  },
];
