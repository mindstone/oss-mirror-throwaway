#!/usr/bin/env npx tsx
/**
 * CI guard: OpenAI-compatible `/chat/completions` egress must pass through the
 * branded param-strip chokepoint before POST.
 *
 * This intentionally uses a conservative call-site heuristic: each detected
 * `/chat/completions` POST must either pass a body through
 * `finalizeChatCompletionsBody` / `serializeChatCompletionsBody` at that call
 * site, or carry an explicit `CHAT_COMPLETIONS_CHOKEPOINT_ALLOWLIST` marker.
 * Typed sinks cover the core OpenAI client; this guard covers direct
 * fetch/axios seams where TypeScript cannot constrain the platform API's body
 * argument.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const SCAN_ROOTS = ['src', 'evals'];
const CHOKEPOINT_MODULE = path.join('src', 'core', 'services', 'chatCompletionsParamCapability.ts');
const BRAND_CAST_RE = /\bas\s+ValidatedChatCompletionsBody\b/;
const BUILD_COMPLETIONS_RE = /\bbuildCompletionsUrl\s*\(/;
const FINALIZE_RE = /\bfinalizeChatCompletionsBody\s*\(/;
const SERIALIZE_RE = /\bserializeChatCompletionsBody\s*\(/;
const CHAT_COMPLETIONS_RE = /\/(?:v1\/)?chat\/completions\b/;
const ALLOWLIST_MARKER = 'CHAT_COMPLETIONS_CHOKEPOINT_ALLOWLIST';
const CALL_START_RE = /\b(?:axios\.)?post\s*\(|\bfetch(?:WithMetadata)?\s*\(|\bpostChatCompletionsJson(?:<[^;\n]*>)?\s*\(/g;
const POST_METHOD_RE = /\bmethod\s*:\s*['"`]POST['"`]/;
const NEARBY_LINE_WINDOW = 120;

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function isTypeScriptFile(filePath: string): boolean {
  return /\.(?:ts|tsx)$/.test(filePath);
}

function isTestFile(relativePath: string): boolean {
  const normalized = toPosix(relativePath);
  return (
    normalized.includes('/__tests__/') ||
    normalized.endsWith('.test.ts') ||
    normalized.endsWith('.test.tsx') ||
    normalized.endsWith('.spec.ts') ||
    normalized.endsWith('.spec.tsx')
  );
}

function shouldSkipDir(dirName: string): boolean {
  return new Set([
    '.git',
    '.local',
    'node_modules',
    'dist',
    'out',
    'coverage',
    'tmp',
  ]).has(dirName);
}

function walkFiles(root: string): string[] {
  const absoluteRoot = path.join(REPO_ROOT, root);
  if (!fs.existsSync(absoluteRoot)) return [];

  const files: string[] = [];
  const stack = [absoluteRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) {
          stack.push(path.join(current, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const absolutePath = path.join(current, entry.name);
      if (isTypeScriptFile(absolutePath)) {
        files.push(absolutePath);
      }
    }
  }
  return files.sort();
}

const allFiles = SCAN_ROOTS.flatMap(walkFiles);

const illegalCasts = allFiles.flatMap((absolutePath) => {
  const relativePath = toPosix(path.relative(REPO_ROOT, absolutePath));
  if (relativePath === CHOKEPOINT_MODULE || isTestFile(relativePath)) return [];
  const text = fs.readFileSync(absolutePath, 'utf8');
  if (!BRAND_CAST_RE.test(text)) return [];
  return text
    .split('\n')
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => BRAND_CAST_RE.test(line))
    .map(({ line, lineNumber }) => `${relativePath}:${lineNumber}: ${line.trim()}`);
});

type ChatCompletionsPostSite = {
  relativePath: string;
  lineNumber: number;
  line: string;
};

function lineNumberForIndex(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function extractCallText(text: string, callStart: number): string | null {
  const openParen = text.indexOf('(', callStart);
  if (openParen < 0) return null;

  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let index = openParen; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(callStart, index + 1);
      }
    }
  }
  return null;
}

function splitTopLevelArgs(callText: string): string[] {
  const openParen = callText.indexOf('(');
  const closeParen = callText.lastIndexOf(')');
  if (openParen < 0 || closeParen <= openParen) return [];
  const argsText = callText.slice(openParen + 1, closeParen);
  const args: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  for (let index = 0; index < argsText.length; index += 1) {
    const char = argsText[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '{' || char === '[' || char === '<') {
      depth += 1;
      continue;
    }
    if (char === ')' || char === '}' || char === ']' || char === '>') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === ',' && depth === 0) {
      args.push(argsText.slice(start, index).trim());
      start = index + 1;
    }
  }
  const finalArg = argsText.slice(start).trim();
  if (finalArg) args.push(finalArg);
  return args;
}

function getNearbyLines(text: string, lineNumber: number): string {
  const lines = text.split('\n');
  const start = Math.max(0, lineNumber - NEARBY_LINE_WINDOW - 1);
  const end = Math.min(lines.length, lineNumber + 4);
  return lines.slice(start, end).join('\n');
}

function getCallLine(text: string, lineNumber: number): string {
  return text.split('\n')[lineNumber - 1]?.trim() ?? '';
}

function hasNearbyAllowlist(text: string, lineNumber: number): boolean {
  const lines = text.split('\n');
  const start = Math.max(0, lineNumber - 4);
  const end = Math.min(lines.length, lineNumber + 3);
  return lines.slice(start, end).some((line) => line.includes(ALLOWLIST_MARKER));
}

function identifierFromExpression(expression: string | undefined): string | null {
  const match = expression?.trim().match(/^(?:this\.)?([A-Za-z_$][\w$]*)$/);
  return match?.[1] ?? null;
}

function nearbyInitializerUses(text: string, lineNumber: number, identifier: string, pattern: RegExp): boolean {
  const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const initializerRe = new RegExp(`\\b(?:const|let|var)\\s+${escapedIdentifier}\\b[^=]*=\\s*[^;\\n]*${pattern.source}`, 's');
  return initializerRe.test(getNearbyLines(text, lineNumber));
}

function isPostCall(callText: string): boolean {
  return /\b(?:axios\.)?post\s*\(/.test(callText)
    || /\bpostChatCompletionsJson(?:<[^;\n]*>)?\s*\(/.test(callText)
    || POST_METHOD_RE.test(callText);
}

function isChatCompletionsTarget(
  relativePath: string,
  text: string,
  callText: string,
  lineNumber: number,
): boolean {
  if (BUILD_COMPLETIONS_RE.test(callText) || CHAT_COMPLETIONS_RE.test(callText)) return true;
  const urlArg = splitTopLevelArgs(callText)[0];
  const urlIdentifier = identifierFromExpression(urlArg);
  if (!urlIdentifier) return false;
  return nearbyInitializerUses(text, lineNumber, urlIdentifier, BUILD_COMPLETIONS_RE)
    || (
      relativePath.startsWith('src/')
      && nearbyInitializerUses(text, lineNumber, urlIdentifier, CHAT_COMPLETIONS_RE)
    );
}

function callBodyIsFinalized(text: string, callText: string, lineNumber: number): boolean {
  if (FINALIZE_RE.test(callText) || SERIALIZE_RE.test(callText)) return true;

  const args = splitTopLevelArgs(callText);
  const candidateBodyArgs = [
    args[1],
    callText.match(/\bbody\s*:\s*([A-Za-z_$][\w$]*)/)?.[1],
  ].filter(Boolean) as string[];

  return candidateBodyArgs.some((arg) => {
    const bodyIdentifier = identifierFromExpression(arg);
    return bodyIdentifier ? nearbyInitializerUses(text, lineNumber, bodyIdentifier, FINALIZE_RE) : false;
  });
}

const unfinalizedEgressSites = allFiles.flatMap((absolutePath): ChatCompletionsPostSite[] => {
  const relativePath = toPosix(path.relative(REPO_ROOT, absolutePath));
  if (isTestFile(relativePath)) return [];
  const text = fs.readFileSync(absolutePath, 'utf8');
  const sites: ChatCompletionsPostSite[] = [];
  for (const match of text.matchAll(CALL_START_RE)) {
    const callText = extractCallText(text, match.index ?? 0);
    if (!callText || !isPostCall(callText)) continue;
    const lineNumber = lineNumberForIndex(text, match.index ?? 0);
    if (!isChatCompletionsTarget(relativePath, text, callText, lineNumber)) continue;
    if (callBodyIsFinalized(text, callText, lineNumber)) continue;
    if (hasNearbyAllowlist(text, lineNumber)) continue;
    sites.push({ relativePath, lineNumber, line: getCallLine(text, lineNumber) });
  }
  return sites;
});

if (illegalCasts.length > 0 || unfinalizedEgressSites.length > 0) {
  if (illegalCasts.length > 0) {
    console.error(
      `❌ ValidatedChatCompletionsBody cast found outside the chokepoint module/tests:\n` +
        `${illegalCasts.join('\n')}\n\n` +
        `Do not forge the Chat-Completions body brand. Call finalizeChatCompletionsBody(...) instead.`,
    );
  }

  if (unfinalizedEgressSites.length > 0) {
    console.error(
      `❌ /chat/completions POST call missing finalizeChatCompletionsBody/serializeChatCompletionsBody:\n` +
        `${unfinalizedEgressSites.map((site) => `- ${site.relativePath}:${site.lineNumber}: ${site.line}`).join('\n')}\n\n` +
        `Each Chat-Completions POST must route its body through the branded chokepoint. ` +
        `If this is an intentional raw capability probe, add ${ALLOWLIST_MARKER} with a one-line justification near the call site.`,
    );
  }

  process.exit(1);
}

console.log('✓ Chat-Completions egress uses the branded finalizeChatCompletionsBody chokepoint');
