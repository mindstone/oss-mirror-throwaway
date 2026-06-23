import os from 'node:os';
import path from 'node:path';
import { getPlatformConfig } from '@core/platform';

const HEX_TOKEN_REGEX = /\b[a-f0-9]{32,}\b/gi;
const GENERIC_FILESYSTEM_PATH_REGEXES = [
  /\/(?:Users|Applications)\/[^\s"'`)\]}]+(?:\/[^\s"'`)\]}]+)*/g,
  /[A-Za-z]:\\(?:Users|Program Files)\\[^\s"'`)\]}]+(?:\\[^\s"'`)\]}]+)*/g,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replacePathLikeMatches(raw: string, needle: string, replacement: string): string {
  if (!needle) {
    return raw;
  }

  const escaped = escapeRegExp(needle);
  const pattern = new RegExp(`${escaped}(?:[^\\s"'\\])}]*)?`, 'g');
  return raw.replace(pattern, replacement);
}

function collectSensitivePathPrefixes(): string[] {
  const prefixes = new Set<string>();

  try {
    const platformConfig = getPlatformConfig();
    prefixes.add(platformConfig.userDataPath);
    prefixes.add(path.join(platformConfig.userDataPath, 'mcp', 'rebeloffice'));
  } catch {
    // PlatformConfig is not always initialised in isolated tests.
  }

  return Array.from(prefixes).filter(Boolean).sort((a, b) => b.length - a.length);
}

export function redactPathsAndTokens(raw: string): string {
  let redacted = raw.replace(HEX_TOKEN_REGEX, '<REDACTED_TOKEN>');

  for (const candidate of collectSensitivePathPrefixes()) {
    redacted = replacePathLikeMatches(redacted, candidate, '<REDACTED_PATH>');
  }

  const homeDir = os.homedir();
  if (homeDir) {
    redacted = replacePathLikeMatches(redacted, homeDir, '<HOME>');
  }

  for (const pattern of GENERIC_FILESYSTEM_PATH_REGEXES) {
    redacted = redacted.replace(pattern, '<REDACTED_PATH>');
  }

  return redacted;
}
