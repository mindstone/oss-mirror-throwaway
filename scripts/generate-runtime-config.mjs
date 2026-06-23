#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const CONFIG_DIR = join(projectRoot, 'config');
const TEMPLATE_NAME = 'app-config.template.json';
const OUTPUT_NAME = 'app-config.json';
const PLACEHOLDER_PATTERN = /{{\s*env(\??)\.([A-Z0-9_]+)\s*}}/g;
const ENV_FILES = ['.env', '.env.local'];

function loadEnvFiles() {
  for (const fileName of ENV_FILES) {
    const filePath = join(projectRoot, fileName);
    if (!existsSync(filePath)) {
      continue;
    }
    let contents = '';
    try {
      contents = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }
      const equalsIndex = line.indexOf('=');
      if (equalsIndex === -1) {
        continue;
      }
      const key = line.slice(0, equalsIndex).trim();
      if (!key) {
        continue;
      }
      let value = line.slice(equalsIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}

function resolvePlaceholders(value) {
  if (typeof value !== 'string') {
    return value;
  }

  return value.replace(PLACEHOLDER_PATTERN, (_match, optionalFlag, envKey) => {
    const raw = process.env[envKey];
    if (raw === undefined) {
      if (optionalFlag === '?') {
        return '';
      }
      throw new Error(`Missing required environment variable: ${envKey}`);
    }
    return raw;
  });
}

function transformNode(node) {
  if (Array.isArray(node)) {
    return node.map(transformNode);
  }
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, transformNode(value)]));
  }
  return resolvePlaceholders(node);
}

function main() {
  loadEnvFiles();
  const templatePath = join(CONFIG_DIR, TEMPLATE_NAME);
  const outputPath = join(CONFIG_DIR, OUTPUT_NAME);

  let templateContent;
  try {
    templateContent = readFileSync(templatePath, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read template file ${basename(templatePath)}: ${error.message}`);
  }

  let templateJson;
  try {
    templateJson = JSON.parse(templateContent);
  } catch (error) {
    throw new Error(`Invalid JSON in template ${basename(templatePath)}: ${error.message}`);
  }

  const resolved = transformNode(templateJson);

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(resolved, null, 2));
  console.log(`✅ Generated runtime config at ${outputPath}`);
}

try {
  main();
} catch (error) {
  console.error('❌ Failed to generate runtime config');
  console.error(error.message);
  process.exitCode = 1;
}
