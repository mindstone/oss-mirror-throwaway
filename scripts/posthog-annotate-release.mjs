#!/usr/bin/env node

// INTERNAL ONLY — Mindstone team release pipeline tooling.
// Reads MINDSTONE_POSTHOG_TOKEN from environment; not consumed by the public OSS app.

/**
 * Extracts changelog highlights for a given version and creates a PostHog annotation.
 *
 * Usage:
 *   node scripts/posthog-annotate-release.mjs <version> <channel> [--dry-run]
 *
 * Environment variables:
 *   POSTHOG_PERSONAL_API_KEY - PostHog personal API key (annotation:write scope)
 *   POSTHOG_PROJECT_ID       - PostHog project ID
 *   POSTHOG_HOST              - PostHog host (default: https://eu.posthog.com)
 *
 * The script reads rebel-system/help-for-humans/changelog.md and extracts the
 * Highlights + Improvements sections for the specified version, formatting them
 * into a concise annotation that appears on all PostHog dashboard charts.
 */

import { readFileSync, appendFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Override hook for tests; defaults to the bundled help-for-humans changelog.
const CHANGELOG_PATH =
  process.env.POSTHOG_ANNOTATE_CHANGELOG_PATH || resolve(ROOT, 'rebel-system/help-for-humans/changelog.md');
const MAX_ANNOTATION_LENGTH = 1000;

function extractVersionContent(markdown, targetVersion) {
  const normalizedTarget = targetVersion.replace(/^v/, '');
  const lines = markdown.split(/\r?\n/);

  let inTargetVersion = false;
  let inHighlights = false;
  let inImprovements = false;
  let inFixes = false;

  const highlights = [];
  const improvements = [];
  const fixes = [];
  let versionDate = '';

  for (const line of lines) {
    const versionMatch = line.match(/^## (v[\d.]+)\s*[-—]?\s*(.*)$/);
    if (versionMatch) {
      const version = versionMatch[1].replace(/^v/, '');
      if (version === normalizedTarget) {
        inTargetVersion = true;
        versionDate = versionMatch[2]?.trim() || '';
      } else if (inTargetVersion) {
        break;
      }
      inHighlights = false;
      inImprovements = false;
      inFixes = false;
      continue;
    }

    if (!inTargetVersion) continue;

    if (line.startsWith('### Highlights')) {
      inHighlights = true;
      inImprovements = false;
      inFixes = false;
    } else if (line.startsWith('### Improvements')) {
      inHighlights = false;
      inImprovements = true;
      inFixes = false;
    } else if (line.startsWith('### Fixes')) {
      inHighlights = false;
      inImprovements = false;
      inFixes = true;
    } else if (line.startsWith('### ')) {
      inHighlights = false;
      inImprovements = false;
      inFixes = false;
    } else if (line.startsWith('- **')) {
      const match = line.match(/^- \*\*(.+?)\*\*\s*[-—]?\s*(.*)$/);
      if (match) {
        const entry = { title: match[1], description: match[2] || '' };
        if (inHighlights) highlights.push(entry);
        else if (inImprovements) improvements.push(entry);
        else if (inFixes) fixes.push(entry);
      }
    }
  }

  return { highlights, improvements, fixes, versionDate };
}

function formatAnnotation(version, channel, content) {
  const { highlights, improvements, fixes, versionDate } = content;

  const parts = [];

  // Header
  const header = `v${version.replace(/^v/, '')} (${channel})`;
  parts.push(header);

  if (versionDate) {
    parts[0] += ` — ${versionDate}`;
  }

  // Highlights — these are the big features
  if (highlights.length > 0) {
    const highlightLines = highlights.map(h => `• ${h.title}: ${h.description}`);
    parts.push('');
    parts.push('HIGHLIGHTS:');
    parts.push(...highlightLines);
  }

  // Improvements — show titles only, more compact
  if (improvements.length > 0) {
    const titles = improvements.map(i => i.title);
    parts.push('');
    parts.push(`IMPROVEMENTS: ${titles.join(', ')}`);
  }

  // Fixes — show titles (same style as improvements) so fix-only releases are informative
  if (fixes.length > 0) {
    const fixTitles = fixes.map(f => f.title);
    parts.push('');
    parts.push(`FIXES: ${fixTitles.join(', ')}`);
  }

  let text = parts.join('\n');

  // Truncate if needed, preserving readability
  if (text.length > MAX_ANNOTATION_LENGTH) {
    text = text.slice(0, MAX_ANNOTATION_LENGTH - 3) + '...';
  }

  return text;
}

async function createAnnotation(content, host, projectId, apiKey) {
  const url = `${host}/api/projects/${projectId}/annotations/`;
  const body = {
    content,
    date_marker: new Date().toISOString(),
    scope: 'project',
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`PostHog API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positionalArgs = args.filter(a => !a.startsWith('--'));

  if (positionalArgs.length < 2) {
    console.error('Usage: node scripts/posthog-annotate-release.mjs <version> <channel> [--dry-run]');
    process.exit(1);
  }

  const [version, channel] = positionalArgs;

  // Read changelog
  let markdown;
  try {
    markdown = readFileSync(CHANGELOG_PATH, 'utf-8');
  } catch (err) {
    console.error(`Failed to read changelog at ${CHANGELOG_PATH}: ${err.message}`);
    process.exit(1);
  }

  // Extract content for this version
  const content = extractVersionContent(markdown, version);

  if (content.highlights.length === 0 && content.improvements.length === 0 && content.fixes.length === 0) {
    console.log(`No changelog content found for version ${version}. Skipping annotation.`);
    process.exit(0);
  }

  // Format annotation
  const annotationText = formatAnnotation(version, channel, content);
  console.log('--- Annotation content ---');
  console.log(annotationText);
  console.log(`--- (${annotationText.length} chars) ---`);

  if (dryRun) {
    console.log('\n[dry-run] Would have created PostHog annotation. Exiting.');
    process.exit(0);
  }

  // Validate environment
  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const host = process.env.POSTHOG_HOST || 'https://eu.posthog.com';

  // Missing config is a LOUD SKIP, not a hard failure: the secret may be
  // legitimately absent (forks, manual dev runs), but a regression that drops
  // it on the real pipeline must be visible — not silently swallowed by the
  // job's continue-on-error. We emit a GitHub `::warning::` and a step output
  // so the workflow can alert (Slack) instead of concluding green in silence.
  // Genuine API errors below remain hard failures (exit 1).
  if (!apiKey || !projectId) {
    const missing = [
      !apiKey && 'POSTHOG_PERSONAL_API_KEY',
      !projectId && 'POSTHOG_PROJECT_ID',
    ]
      .filter(Boolean)
      .join(', ');
    console.log(
      `::warning title=PostHog annotation skipped::Missing ${missing} — release v${version.replace(/^v/, '')} (${channel}) was published but NOT annotated on PostHog dashboards. Set the repo secret(s) to restore annotations.`,
    );
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `skipped=missing-config\n`);
      appendFileSync(process.env.GITHUB_OUTPUT, `skip_reason=Missing ${missing}\n`);
    }
    process.exit(0);
  }

  // Create annotation
  try {
    const result = await createAnnotation(annotationText, host, projectId, apiKey);
    console.log(`PostHog annotation created (id: ${result.id})`);
  } catch (err) {
    console.error(`Failed to create PostHog annotation: ${err.message}`);
    process.exit(1);
  }
}

main();
