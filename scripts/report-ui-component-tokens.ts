#!/usr/bin/env npx tsx
/**
 * UI Component Token Inventory Report
 *
 * Scans `src/renderer/components/ui` and generates:
 * - src/renderer/components/ui/manifests/ui_component_token_inventory.md
 * - src/renderer/components/ui/manifests/ui_component_token_inventory.json
 *
 * The report is intentionally read-only and non-invasive:
 * it documents existing components/variants/tokens without changing runtime code.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

type TokenDefinitionMap = Map<string, Set<string>>;

interface ComponentReport {
  component: string;
  sourceFile: string;
  styleFiles: string[];
  cssTokens: string[];
  undefinedCssTokens: string[];
  utilitySemanticClasses: string[];
  cvaVariants: Record<string, string[]>;
  unionProps: Record<string, string[]>;
}

const ROOT = path.join(__dirname, '..');
const UI_DIR = path.join(ROOT, 'src', 'renderer', 'components', 'ui');
const STYLE_ROOT = path.join(ROOT, 'src', 'renderer', 'styles');
const OUTPUT_MD = path.join(ROOT, 'src', 'renderer', 'components', 'ui', 'manifests', 'ui_component_token_inventory.md');
const OUTPUT_JSON = path.join(ROOT, 'src', 'renderer', 'components', 'ui', 'manifests', 'ui_component_token_inventory.json');

function listFilesRecursive(dir: string, include: (fileName: string) => boolean): string[] {
  const files: string[] = [];

  const walk = (currentDir: string): void => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__') continue;
        walk(fullPath);
        continue;
      }
      if (include(entry.name)) {
        files.push(fullPath);
      }
    }
  };

  walk(dir);
  return files;
}

function toRepoRelative(filePath: string): string {
  return path.relative(ROOT, filePath).replaceAll(path.sep, '/');
}

function dedupeSorted(items: Iterable<string>): string[] {
  return [...new Set(items)].sort((a, b) => a.localeCompare(b));
}

function parseDefinedTokensFromCss(cssContent: string): string[] {
  const tokens: string[] = [];
  const definitionRegex = /(--[a-zA-Z0-9-_]+)\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = definitionRegex.exec(cssContent)) !== null) {
    tokens.push(match[1]);
  }
  return dedupeSorted(tokens);
}

function buildTokenDefinitionMap(): TokenDefinitionMap {
  const cssFiles = listFilesRecursive(STYLE_ROOT, (name) => name.endsWith('.css'));
  const map: TokenDefinitionMap = new Map();

  for (const cssFile of cssFiles) {
    const content = fs.readFileSync(cssFile, 'utf8');
    const tokens = parseDefinedTokensFromCss(content);
    const relative = toRepoRelative(cssFile);

    for (const token of tokens) {
      const existing = map.get(token) ?? new Set<string>();
      existing.add(relative);
      map.set(token, existing);
    }
  }

  return map;
}

function extractImportedStyleFiles(tsxContent: string, tsxPath: string): string[] {
  const styleFiles = new Set<string>();

  const importRegex = /import\s+(?:[\w*\s{},]+\s+from\s+)?['"](\.\/[^'"]+\.(?:css|module\.css))['"];?/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(tsxContent)) !== null) {
    const imported = path.resolve(path.dirname(tsxPath), match[1]);
    if (fs.existsSync(imported)) {
      styleFiles.add(imported);
    }
  }

  // Fallback: include colocated css files even if imported indirectly
  const baseName = path.basename(tsxPath, '.tsx');
  const fallbackPaths = [
    path.join(path.dirname(tsxPath), `${baseName}.module.css`),
    path.join(path.dirname(tsxPath), `${baseName}.css`),
  ];
  for (const fallback of fallbackPaths) {
    if (fs.existsSync(fallback)) {
      styleFiles.add(fallback);
    }
  }

  return dedupeSorted([...styleFiles].map((p) => toRepoRelative(p)));
}

function extractCssTokens(cssContent: string): string[] {
  const tokens: string[] = [];
  const usageRegex = /var\(\s*(--[a-zA-Z0-9-_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = usageRegex.exec(cssContent)) !== null) {
    tokens.push(match[1]);
  }
  return dedupeSorted(tokens);
}

function extractStringLiterals(source: string): string[] {
  const strings: string[] = [];
  const regex = /(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(source)) !== null) {
    strings.push(match[2]);
  }
  return strings;
}

function extractUtilitySemanticClasses(tsxContent: string): string[] {
  const semanticMarkers = [
    'primary',
    'secondary',
    'tertiary',
    'foreground',
    'background',
    'border',
    'ring',
    'destructive',
    'accent',
    'muted',
    'success',
    'warning',
    'danger',
    'info',
    'popover',
    'card',
    'input',
  ];

  const matches = new Set<string>();
  const classRegex = /\b(?:bg|text|border|ring|from|to|via)-([a-z][a-z0-9-]*)\b/g;

  for (const literal of extractStringLiterals(tsxContent)) {
    let classMatch: RegExpExecArray | null;
    classRegex.lastIndex = 0;
    while ((classMatch = classRegex.exec(literal)) !== null) {
      const suffix = classMatch[1];
      if (semanticMarkers.some((marker) => suffix.includes(marker))) {
        matches.add(`${classMatch[0]}`);
      }
    }
  }

  return dedupeSorted(matches);
}

function extractBalancedObject(source: string, openBraceIndex: number): string | null {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openBraceIndex, i + 1);
      }
    }
  }
  return null;
}

function splitTopLevelEntries(objectContentWithoutBraces: string): string[] {
  const entries: string[] = [];
  let current = '';
  let depth = 0;
  let quote: "'" | '"' | '`' | null = null;

  for (let i = 0; i < objectContentWithoutBraces.length; i += 1) {
    const char = objectContentWithoutBraces[i];
    const prev = i > 0 ? objectContentWithoutBraces[i - 1] : '';

    if ((char === "'" || char === '"' || char === '`') && prev !== '\\') {
      if (quote === char) {
        quote = null;
      } else if (quote === null) {
        quote = char;
      }
      current += char;
      continue;
    }

    if (quote !== null) {
      current += char;
      continue;
    }

    if (char === '{' || char === '[' || char === '(') depth += 1;
    if (char === '}' || char === ']' || char === ')') depth -= 1;

    if (char === ',' && depth === 0) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        entries.push(trimmed);
      }
      current = '';
      continue;
    }

    current += char;
  }

  const tail = current.trim();
  if (tail.length > 0) {
    entries.push(tail);
  }

  return entries;
}

function parseObjectKeys(objectLiteral: string): string[] {
  const body = objectLiteral.trim().replace(/^\{/, '').replace(/\}$/, '');
  const entries = splitTopLevelEntries(body);
  const keys: string[] = [];

  for (const entry of entries) {
    const keyMatch = entry.match(/^([a-zA-Z0-9_$-]+)\s*:/);
    if (keyMatch) {
      keys.push(keyMatch[1]);
    }
  }

  return dedupeSorted(keys);
}

function extractCvaVariants(tsxContent: string): Record<string, string[]> {
  const variantsIndex = tsxContent.indexOf('variants:');
  if (variantsIndex < 0) return {};

  const firstBrace = tsxContent.indexOf('{', variantsIndex);
  if (firstBrace < 0) return {};

  const variantsObject = extractBalancedObject(tsxContent, firstBrace);
  if (!variantsObject) return {};

  const result: Record<string, string[]> = {};
  const topEntries = splitTopLevelEntries(variantsObject.slice(1, -1));

  for (const entry of topEntries) {
    const keyMatch = entry.match(/^([a-zA-Z0-9_$-]+)\s*:\s*(\{[\s\S]*\})$/);
    if (!keyMatch) continue;
    const groupName = keyMatch[1];
    const groupObject = keyMatch[2];
    result[groupName] = parseObjectKeys(groupObject);
  }

  return result;
}

function extractUnionProps(tsxContent: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const propRegex = /([a-zA-Z0-9_]+)\??:\s*('[^']+'\s*\|\s*'[^']+'(?:\s*\|\s*'[^']+')*)/g;
  let match: RegExpExecArray | null;

  while ((match = propRegex.exec(tsxContent)) !== null) {
    const propName = match[1];
    const unionSource = match[2];
    const values = [...unionSource.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    if (values.length > 0) {
      result[propName] = dedupeSorted(values);
    }
  }

  return result;
}

function buildComponentReport(tokenDefinitions: TokenDefinitionMap): ComponentReport[] {
  const tsxFiles = listFilesRecursive(
    UI_DIR,
    (name) =>
      name.endsWith('.tsx') &&
      !name.endsWith('.test.tsx') &&
      !name.endsWith('.spec.tsx') &&
      !name.endsWith('.stories.tsx') &&
      !name.endsWith('.story.tsx'),
  ).filter((file) => path.basename(file) !== 'index.tsx');

  const reports: ComponentReport[] = [];

  for (const tsxFile of tsxFiles) {
    const componentName = path.basename(tsxFile, '.tsx');
    if (componentName === 'index' || componentName === 'README') continue;

    const tsxContent = fs.readFileSync(tsxFile, 'utf8');
    const styleFiles = extractImportedStyleFiles(tsxContent, tsxFile);

    const cssTokens = new Set<string>();
    for (const styleFileRelative of styleFiles) {
      const styleFileAbsolute = path.join(ROOT, styleFileRelative);
      if (!fs.existsSync(styleFileAbsolute)) continue;
      const styleContent = fs.readFileSync(styleFileAbsolute, 'utf8');
      for (const token of extractCssTokens(styleContent)) {
        cssTokens.add(token);
      }
    }

    const undefinedCssTokens = dedupeSorted(
      [...cssTokens].filter((token) => !tokenDefinitions.has(token)),
    );

    reports.push({
      component: componentName,
      sourceFile: toRepoRelative(tsxFile),
      styleFiles,
      cssTokens: dedupeSorted(cssTokens),
      undefinedCssTokens,
      utilitySemanticClasses: extractUtilitySemanticClasses(tsxContent),
      cvaVariants: extractCvaVariants(tsxContent),
      unionProps: extractUnionProps(tsxContent),
    });
  }

  return reports.sort((a, b) => a.component.localeCompare(b.component));
}

function formatVariantSummary(report: ComponentReport): string {
  const variantPairs: string[] = [];

  for (const [name, values] of Object.entries(report.cvaVariants)) {
    if (values.length > 0) {
      variantPairs.push(`${name}: ${values.join(' | ')}`);
    }
  }

  for (const [name, values] of Object.entries(report.unionProps)) {
    if (values.length > 0 && !report.cvaVariants[name]) {
      variantPairs.push(`${name}: ${values.join(' | ')}`);
    }
  }

  if (variantPairs.length === 0) {
    return 'n/a';
  }

  return variantPairs.join(' ; ');
}

function writeReports(componentReports: ComponentReport[], tokenDefinitions: TokenDefinitionMap): void {
  const generatedAt = new Date().toISOString();
  const allUsedCssTokens = dedupeSorted(componentReports.flatMap((r) => r.cssTokens));
  const allUndefinedCssTokens = dedupeSorted(componentReports.flatMap((r) => r.undefinedCssTokens));

  const summaryRows = componentReports
    .map((report) =>
      `| \`${report.component}\` | \`${report.sourceFile}\` | ${report.styleFiles.length} | ${report.cssTokens.length} | ${report.undefinedCssTokens.length} | ${report.utilitySemanticClasses.length} |`,
    )
    .join('\n');

  const detailSections = componentReports
    .map((report) => {
      const styleFiles = report.styleFiles.length > 0 ? report.styleFiles.map((f) => `\`${f}\``).join(', ') : 'none';
      const cssTokens = report.cssTokens.length > 0 ? report.cssTokens.map((t) => `\`${t}\``).join(', ') : 'none';
      const undefinedTokens =
        report.undefinedCssTokens.length > 0
          ? report.undefinedCssTokens.map((t) => `\`${t}\``).join(', ')
          : 'none';
      const utilitySemanticClasses =
        report.utilitySemanticClasses.length > 0
          ? report.utilitySemanticClasses.map((c) => `\`${c}\``).join(', ')
          : 'none';

      return [
        `### ${report.component}`,
        `- Source: \`${report.sourceFile}\``,
        `- Style files: ${styleFiles}`,
        `- Variant-like props detected: ${formatVariantSummary(report)}`,
        `- CSS var tokens used (${report.cssTokens.length}): ${cssTokens}`,
        `- CSS tokens without renderer style definition (${report.undefinedCssTokens.length}): ${undefinedTokens}`,
        `- Semantic utility classes in TSX (${report.utilitySemanticClasses.length}): ${utilitySemanticClasses}`,
      ].join('\n');
    })
    .join('\n\n');

  const markdown = `# UI Component Token Inventory

Generated: ${generatedAt}

This report inventories existing UI components in \`src/renderer/components/ui\` and the tokens they use.
It is documentation-only: no component behavior changes.

## Summary

- Components scanned: **${componentReports.length}**
- Unique CSS var tokens used by UI components: **${allUsedCssTokens.length}**
- Tokens defined across renderer styles: **${tokenDefinitions.size}**
- CSS tokens used by components but not found in renderer style definitions: **${allUndefinedCssTokens.length}**

## Component Matrix

| Component | Source | Style files | CSS tokens | Undefined tokens | Semantic utility classes |
|---|---|---:|---:|---:|---:|
${summaryRows}

## Undefined Token Watchlist

${allUndefinedCssTokens.length > 0 ? allUndefinedCssTokens.map((token) => `- \`${token}\``).join('\n') : '- none'}

## Component Details

${detailSections}
`;

  const json = JSON.stringify(
    {
      generatedAt,
      summary: {
        componentCount: componentReports.length,
        uniqueCssTokensUsed: allUsedCssTokens.length,
        tokensDefinedInRendererStyles: tokenDefinitions.size,
        undefinedCssTokensCount: allUndefinedCssTokens.length,
      },
      undefinedCssTokens: allUndefinedCssTokens,
      components: componentReports,
    },
    null,
    2,
  );

  fs.mkdirSync(path.dirname(OUTPUT_MD), { recursive: true });
  fs.writeFileSync(OUTPUT_MD, markdown, 'utf8');
  fs.writeFileSync(OUTPUT_JSON, json, 'utf8');
}

function main(): void {
  const tokenDefinitions = buildTokenDefinitionMap();
  const componentReports = buildComponentReport(tokenDefinitions);
  writeReports(componentReports, tokenDefinitions);

  console.log('UI component token inventory generated.');
  console.log(`- ${toRepoRelative(OUTPUT_MD)}`);
  console.log(`- ${toRepoRelative(OUTPUT_JSON)}`);
}

main();

