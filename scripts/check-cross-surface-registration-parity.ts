#!/usr/bin/env npx tsx
/**
 * Cross-surface registration parity CI check (Stage T2).
 *
 * Guards the `cross_surface_asymmetry` bug class: a core/shared registration
 * seam (`set*` / `register*` / registration hook field) wired on one surface
 * but missing on another.
 *
 * Source of truth:
 *   docs/project/boundary-registry.yaml -> surface_parity.seams
 *
 * How to add a seam:
 *   1) Add a new row under `surface_parity.seams`.
 *   2) Set `seam`, `definition`, `matcher`, and `required_surfaces`.
 *   3) Declare the real per-surface `call_sites` fileset (not bootstrap-only).
 *
 * How to declare a legitimate asymmetry:
 *   - Set `required_surfaces` to the intentionally-supported subset.
 *   - Add `declared_asymmetry` with `missing_surfaces` + strong rationale.
 *   - The rationale must be specific (>=30 chars; weak placeholders rejected).
 *
 * Fail-loud policy:
 *   - Missing/renamed seam definition -> FAIL.
 *   - Missing/renamed call-site file -> FAIL.
 *   - Required surface lacks seam registration in declared fileset -> FAIL.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = resolve(repoRoot, 'docs/project/boundary-registry.yaml');
const SURFACES = ['desktop', 'cloud'] as const;
type Surface = (typeof SURFACES)[number];

const MIN_STRONG_RATIONALE_LENGTH = 30;
const WEAK_RATIONALE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bTODO\b/iu, label: 'TODO' },
  { pattern: /\bFIXME\b/iu, label: 'FIXME' },
  { pattern: /\bXXX\b/iu, label: 'XXX' },
  { pattern: /\bWIP\b/iu, label: 'WIP' },
  { pattern: /\btemp(orary)?\b/iu, label: 'temp/temporary' },
  { pattern: /\blater\b/iu, label: 'later' },
];

type Matcher = 'call' | 'property_assignment';

interface SurfaceParityBinding {
  call_sites: string[];
}

interface DeclaredAsymmetry {
  missing_surfaces: Surface[];
  rationale: string;
}

interface SurfaceParityEntry {
  id: string;
  seam: string;
  definition: string;
  matcher?: Matcher;
  required_surfaces: Surface[];
  surfaces: Partial<Record<Surface, SurfaceParityBinding>>;
  declared_asymmetry?: DeclaredAsymmetry;
}

interface SurfaceParityRegistry {
  version: number;
  surfaces: Surface[];
  seams: SurfaceParityEntry[];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function propertyNameText(name: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
}

function readSourceFile(relativePath: string): ts.SourceFile {
  const absolutePath = resolve(repoRoot, relativePath);
  const source = readFileSync(absolutePath, 'utf8');
  return ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);
}

function hasSeamDefinition(sourceFile: ts.SourceFile, seam: string, matcher: Matcher): boolean {
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;

    if (matcher === 'call') {
      if (ts.isFunctionDeclaration(node) && node.name?.text === seam) {
        found = true;
        return;
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === seam) {
        found = true;
        return;
      }
      if (ts.isMethodDeclaration(node) && propertyNameText(node.name) === seam) {
        found = true;
        return;
      }
    } else if (matcher === 'property_assignment') {
      if (ts.isPropertySignature(node) && propertyNameText(node.name) === seam) {
        found = true;
        return;
      }
      if (ts.isPropertyDeclaration(node) && propertyNameText(node.name) === seam) {
        found = true;
        return;
      }
      if (ts.isPropertyAssignment(node) && propertyNameText(node.name) === seam) {
        found = true;
        return;
      }
      if (ts.isShorthandPropertyAssignment(node) && node.name.text === seam) {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

function fileContainsSeamRegistration(sourceFile: ts.SourceFile, seam: string, matcher: Matcher): boolean {
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;

    if (matcher === 'call' && ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression) && expression.text === seam) {
        found = true;
        return;
      }
      if (ts.isPropertyAccessExpression(expression) && expression.name.text === seam) {
        found = true;
        return;
      }
    }

    if (matcher === 'property_assignment' && ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === seam) {
          found = true;
          return;
        }
        if (ts.isShorthandPropertyAssignment(property) && property.name.text === seam) {
          found = true;
          return;
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

function validateStrongRationale(rationale: string): string | null {
  const trimmed = rationale.trim();
  if (trimmed.length < MIN_STRONG_RATIONALE_LENGTH) {
    return `rationale is ${trimmed.length} chars (minimum ${MIN_STRONG_RATIONALE_LENGTH})`;
  }
  for (const { pattern, label } of WEAK_RATIONALE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return `rationale contains weak marker '${label}'`;
    }
  }
  return null;
}

function setFromArray(values: readonly string[]): Set<string> {
  return new Set(values);
}

function loadManifest(errors: string[]): SurfaceParityRegistry | null {
  const docRaw = readFileSync(registryPath, 'utf8');
  const parsed = parseYaml(docRaw);
  const root = asObject(parsed);
  if (!root) {
    errors.push(`Registry root is not an object: ${registryPath}`);
    return null;
  }
  const manifestRaw = asObject(root.surface_parity);
  if (!manifestRaw) {
    errors.push(`Missing 'surface_parity' object in ${registryPath}`);
    return null;
  }

  const version = manifestRaw.version;
  if (version !== 1) {
    errors.push(`surface_parity.version must be 1 (received ${String(version)})`);
  }

  const surfacesRaw = manifestRaw.surfaces;
  if (!Array.isArray(surfacesRaw)) {
    errors.push(`surface_parity.surfaces must be an array`);
  } else {
    const invalid = surfacesRaw.filter((surface) => !SURFACES.includes(surface as Surface));
    if (invalid.length > 0) {
      errors.push(`surface_parity.surfaces contains invalid values: ${invalid.map(String).join(', ')}`);
    }
    const missing = SURFACES.filter((surface) => !surfacesRaw.includes(surface));
    if (missing.length > 0) {
      errors.push(`surface_parity.surfaces missing required surfaces: ${missing.join(', ')}`);
    }
  }

  const seamsRaw = manifestRaw.seams;
  if (!Array.isArray(seamsRaw)) {
    errors.push(`surface_parity.seams must be an array`);
    return null;
  }

  return {
    version: 1,
    surfaces: SURFACES.slice(),
    seams: seamsRaw as SurfaceParityEntry[],
  };
}

function main(): void {
  const errors: string[] = [];
  const manifest = loadManifest(errors);
  if (!manifest) {
    printFailure(errors);
    process.exit(1);
  }

  if (manifest.seams.length === 0) {
    errors.push(`surface_parity.seams is empty — refusing vacuous pass`);
  }

  const seenIds = new Set<string>();
  const sourceFileCache = new Map<string, ts.SourceFile>();
  let asymmetryCount = 0;

  const getSourceFile = (relativePath: string): ts.SourceFile => {
    const normalized = normalizePath(relativePath);
    const cached = sourceFileCache.get(normalized);
    if (cached) return cached;
    const sourceFile = readSourceFile(normalized);
    sourceFileCache.set(normalized, sourceFile);
    return sourceFile;
  };

  for (const [index, rawEntry] of manifest.seams.entries()) {
    const loc = `surface_parity.seams[${index}]`;
    const entry = asObject(rawEntry);
    if (!entry) {
      errors.push(`${loc}: entry must be an object`);
      continue;
    }

    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const seam = typeof entry.seam === 'string' ? entry.seam.trim() : '';
    const definition = typeof entry.definition === 'string' ? normalizePath(entry.definition) : '';
    const matcher = (entry.matcher ?? 'call') as Matcher;

    if (!id) errors.push(`${loc}: missing non-empty string 'id'`);
    if (!seam) errors.push(`${loc}: missing non-empty string 'seam'`);
    if (!definition) errors.push(`${loc}: missing non-empty string 'definition'`);
    if (matcher !== 'call' && matcher !== 'property_assignment') {
      errors.push(`${loc}: matcher must be 'call' or 'property_assignment'`);
    }

    if (id) {
      if (seenIds.has(id)) {
        errors.push(`${loc}: duplicate id '${id}'`);
      } else {
        seenIds.add(id);
      }
    }

    const requiredSurfacesRaw = entry.required_surfaces;
    if (!Array.isArray(requiredSurfacesRaw) || requiredSurfacesRaw.length === 0) {
      errors.push(`${loc}: required_surfaces must be a non-empty array`);
      continue;
    }

    const requiredSurfaces = [...new Set(requiredSurfacesRaw.map(String))] as Surface[];
    const invalidRequired = requiredSurfaces.filter((surface) => !SURFACES.includes(surface));
    if (invalidRequired.length > 0) {
      errors.push(`${loc}: required_surfaces contains invalid values: ${invalidRequired.join(', ')}`);
      continue;
    }

    const surfacesObj = asObject(entry.surfaces);
    if (!surfacesObj) {
      errors.push(`${loc}: surfaces must be an object`);
      continue;
    }

    const missingSurfaces = SURFACES.filter((surface) => !requiredSurfaces.includes(surface));
    const declaredAsymmetryObj = asObject(entry.declared_asymmetry);
    if (missingSurfaces.length > 0) {
      asymmetryCount += 1;
      if (!declaredAsymmetryObj) {
        errors.push(
          `${loc}: required_surfaces omits ${missingSurfaces.join(', ')} but declared_asymmetry is missing`,
        );
      } else {
        const missingSurfacesRaw = declaredAsymmetryObj.missing_surfaces;
        const rationale = typeof declaredAsymmetryObj.rationale === 'string'
          ? declaredAsymmetryObj.rationale
          : '';
        if (!Array.isArray(missingSurfacesRaw) || missingSurfacesRaw.length === 0) {
          errors.push(`${loc}: declared_asymmetry.missing_surfaces must be a non-empty array`);
        } else {
          const declaredMissing = [...new Set(missingSurfacesRaw.map(String))];
          const declaredMissingSet = setFromArray(declaredMissing);
          const expectedMissingSet = setFromArray(missingSurfaces);
          const sameSet =
            declaredMissingSet.size === expectedMissingSet.size
            && [...declaredMissingSet].every((surface) => expectedMissingSet.has(surface));
          if (!sameSet) {
            errors.push(
              `${loc}: declared_asymmetry.missing_surfaces must exactly equal omitted surfaces (${missingSurfaces.join(', ')})`,
            );
          }
        }

        const rationaleError = validateStrongRationale(rationale);
        if (rationaleError) {
          errors.push(`${loc}: declared_asymmetry rationale rejected — ${rationaleError}`);
        }
      }
    } else if (declaredAsymmetryObj) {
      errors.push(`${loc}: declared_asymmetry present but required_surfaces already includes all surfaces`);
    }

    if (!definition || !seam) continue;

    const definitionAbsolutePath = resolve(repoRoot, definition);
    if (!existsSync(definitionAbsolutePath)) {
      errors.push(`${loc}: definition file missing: ${definition}`);
      continue;
    }

    try {
      const definitionSourceFile = getSourceFile(definition);
      if (!hasSeamDefinition(definitionSourceFile, seam, matcher)) {
        errors.push(
          `${loc}: seam '${seam}' not found in definition file ${definition} (possible rename; update manifest)`,
        );
      }
    } catch (error) {
      errors.push(
        `${loc}: failed to parse definition file ${definition}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    for (const surface of requiredSurfaces) {
      const binding = asObject(surfacesObj[surface]);
      if (!binding) {
        errors.push(`${loc}: required surface '${surface}' missing surfaces.${surface} binding`);
        continue;
      }

      const callSitesRaw = binding.call_sites;
      if (!Array.isArray(callSitesRaw) || callSitesRaw.length === 0) {
        errors.push(`${loc}: surfaces.${surface}.call_sites must be a non-empty array`);
        continue;
      }

      const callSites = callSitesRaw.map((site) => normalizePath(String(site)));
      let matched = false;
      const existingCallSites: string[] = [];

      for (const callSite of callSites) {
        const callSiteAbsolute = resolve(repoRoot, callSite);
        if (!existsSync(callSiteAbsolute)) {
          errors.push(`${loc}: surfaces.${surface}.call_sites includes missing file: ${callSite}`);
          continue;
        }
        existingCallSites.push(callSite);

        try {
          const sourceFile = getSourceFile(callSite);
          if (fileContainsSeamRegistration(sourceFile, seam, matcher)) {
            matched = true;
            break;
          }
        } catch (error) {
          errors.push(
            `${loc}: failed to parse call-site file ${callSite}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (existingCallSites.length === 0) {
        continue;
      }

      if (!matched) {
        const matchExpectation = matcher === 'call'
          ? `${seam}(...) call`
          : `object property '${seam}'`;
        errors.push(
          `${loc}: seam '${seam}' missing on surface '${surface}' — expected ${matchExpectation} in fileset [${existingCallSites.join(', ')}]`,
        );
      }
    }
  }

  if (errors.length > 0) {
    printFailure(errors);
    process.exit(1);
  }

  console.log(
    `Cross-surface registration parity check passed (${manifest.seams.length} seams; ${asymmetryCount} declared asymmetry entry${asymmetryCount === 1 ? '' : 'ies'}).`,
  );
}

function printFailure(errors: readonly string[]): void {
  console.error('Cross-surface registration parity check FAILED:\n');
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  console.error(`\n${errors.length} violation(s).`);
}

main();
