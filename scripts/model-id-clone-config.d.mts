// Type declarations for model-id-clone-config.mjs. The SSoT is plain .mjs so the
// guard (check-model-id-inference-clone.ts) and its self-test can import it; this
// .d.mts gives those .ts consumers full type safety (tsc -p tsconfig.node.json /
// tsconfig.scripts.json, allowJs off). Same pattern as eslint-rules/bts-raw-read-config.d.mts.

export const CLAUDE_PREFIX_SNIFF_RE: RegExp;

export const GPT_PREFIX_SNIFF_RE: RegExp;

export const SCAN_GLOBS: readonly string[];

export const MODEL_ID_CLONE_ALLOWLIST: readonly string[];

export function normalizePathPosix(filename: string | null | undefined): string;

export function isAllowlisted(filename: string): boolean;

export function isTestFile(filename: string): boolean;

export function hasCloneSignature(source: string): boolean;
