// Type declarations for silentSwallowSurfaceCoverage.mjs (the SSoT is plain
// .mjs so eslint.config.mjs can import it at config-load time without a TS
// loader; these declarations give the .ts consumers full type safety).

export type SurfaceCoverage = 'covered' | { exempt: string };

export const SILENT_SWALLOW_SURFACE_COVERAGE: Readonly<Record<string, SurfaceCoverage>>;

export const SILENT_SWALLOW_FIXTURE_GLOBS: readonly string[];

export function coveredSilentSwallowGlobs(): string[];

export function coveredSilentSwallowSurfaces(): string[];
