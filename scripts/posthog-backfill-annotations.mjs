#!/usr/bin/env node

// INTERNAL ONLY — Mindstone team release pipeline tooling.
// Reads MINDSTONE_POSTHOG_TOKEN from environment; not consumed by the public OSS app.

/**
 * One-time script: Backfill PostHog annotations for all past changelog versions.
 *
 * Usage:
 *   POSTHOG_PERSONAL_API_KEY=phx_xxx POSTHOG_PROJECT_ID=12345 node scripts/posthog-backfill-annotations.mjs [--dry-run]
 *
 * Reads rebel-system/help-for-humans/changelog.md, extracts each version's
 * highlights and improvements, resolves the release date, and creates a
 * project-scoped PostHog annotation for each.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CHANGELOG_PATH = resolve(ROOT, 'rebel-system/help-for-humans/changelog.md');
const MAX_ANNOTATION_LENGTH = 1000;
const DELAY_BETWEEN_REQUESTS_MS = 500;

function parseReleaseDateFromString(dateStr) {
  if (!dateStr) return null;

  // Handle formats like:
  //   "Feb 17-20, 2026"       → Feb 20, 2026
  //   "Jan 31 - Feb 5, 2026"  → Feb 5, 2026
  //   "Dec 28, 2025"          → Dec 28, 2025
  //   "Nov 30, 2025"          → Nov 30, 2025

  // Try cross-month range: "Jan 31 - Feb 5, 2026"
  const crossMonth = dateStr.match(/(\w+)\s+\d+\s*-\s*(\w+)\s+(\d+),?\s*(\d{4})/);
  if (crossMonth) {
    return new Date(`${crossMonth[2]} ${crossMonth[3]}, ${crossMonth[4]}`);
  }

  // Try same-month range: "Feb 17-20, 2026"
  const sameMonth = dateStr.match(/(\w+)\s+\d+-(\d+),?\s*(\d{4})/);
  if (sameMonth) {
    return new Date(`${sameMonth[1]} ${sameMonth[2]}, ${sameMonth[3]}`);
  }

  // Try single date: "Dec 28, 2025"
  const single = dateStr.match(/(\w+)\s+(\d+),?\s*(\d{4})/);
  if (single) {
    return new Date(`${single[1]} ${single[2]}, ${single[3]}`);
  }

  return null;
}

function extractAllVersions(markdown) {
  const lines = markdown.split(/\r?\n/);
  const versions = [];
  let currentVersion = null;
  let inHighlights = false;
  let inImprovements = false;
  let inFixes = false;

  for (const line of lines) {
    const versionMatch = line.match(/^## (v[\d.]+)\s*[-—]?\s*(.*)$/);
    if (versionMatch) {
      if (currentVersion) versions.push(currentVersion);
      currentVersion = {
        version: versionMatch[1],
        dateStr: versionMatch[2]?.trim() || '',
        highlights: [],
        improvements: [],
        fixCount: 0,
      };
      inHighlights = false;
      inImprovements = false;
      inFixes = false;
      continue;
    }

    if (!currentVersion) continue;

    if (line.startsWith('### Highlights')) {
      inHighlights = true; inImprovements = false; inFixes = false;
    } else if (line.startsWith('### Improvements')) {
      inHighlights = false; inImprovements = true; inFixes = false;
    } else if (line.startsWith('### Fixes')) {
      inHighlights = false; inImprovements = false; inFixes = true;
    } else if (line.startsWith('### ')) {
      inHighlights = false; inImprovements = false; inFixes = false;
    } else if (line.startsWith('- **')) {
      const match = line.match(/^- \*\*(.+?)\*\*\s*[-—]?\s*(.*)$/);
      if (match) {
        const entry = { title: match[1], description: match[2] || '' };
        if (inHighlights) currentVersion.highlights.push(entry);
        else if (inImprovements) currentVersion.improvements.push(entry);
        else if (inFixes) currentVersion.fixCount++;
      }
    } else if (line.startsWith('- ') && inFixes) {
      currentVersion.fixCount++;
    }
  }
  if (currentVersion) versions.push(currentVersion);
  return versions;
}

function formatAnnotation(v) {
  const parts = [];
  parts.push(`${v.version} — ${v.dateStr}`);

  if (v.highlights.length > 0) {
    parts.push('');
    parts.push('HIGHLIGHTS:');
    for (const h of v.highlights) {
      parts.push(`• ${h.title}: ${h.description}`);
    }
  }

  if (v.improvements.length > 0) {
    const titles = v.improvements.map(i => i.title);
    parts.push('');
    parts.push(`IMPROVEMENTS: ${titles.join(', ')}`);
  }

  if (v.fixCount > 0) {
    parts.push(`FIXES: ${v.fixCount} bug fixes`);
  }

  let text = parts.join('\n');
  if (text.length > MAX_ANNOTATION_LENGTH) {
    text = text.slice(0, MAX_ANNOTATION_LENGTH - 3) + '...';
  }
  return text;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function createAnnotation(content, dateMarker, host, projectId, apiKey) {
  const url = `${host}/api/projects/${projectId}/annotations/`;
  const body = {
    content,
    date_marker: dateMarker,
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
  const dryRun = process.argv.includes('--dry-run');

  const apiKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const host = process.env.POSTHOG_HOST || 'https://eu.posthog.com';

  if (!dryRun && (!apiKey || !projectId)) {
    console.error('Set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID environment variables.');
    console.error('Or use --dry-run to preview annotations without creating them.');
    process.exit(1);
  }

  const markdown = readFileSync(CHANGELOG_PATH, 'utf-8');
  const versions = extractAllVersions(markdown);

  console.log(`Found ${versions.length} versions in changelog.\n`);

  let created = 0;
  let skipped = 0;

  for (const v of versions) {
    const releaseDate = parseReleaseDateFromString(v.dateStr);
    if (!releaseDate || isNaN(releaseDate.getTime())) {
      console.log(`SKIP ${v.version} — could not parse date from "${v.dateStr}"`);
      skipped++;
      continue;
    }

    if (v.highlights.length === 0 && v.improvements.length === 0) {
      console.log(`SKIP ${v.version} — no highlights or improvements`);
      skipped++;
      continue;
    }

    const annotationText = formatAnnotation(v);
    const dateMarker = releaseDate.toISOString();

    if (dryRun) {
      console.log(`[dry-run] ${v.version} @ ${dateMarker}`);
      console.log(annotationText);
      console.log(`--- (${annotationText.length} chars)\n`);
      created++;
      continue;
    }

    try {
      const result = await createAnnotation(annotationText, dateMarker, host, projectId, apiKey);
      console.log(`CREATED ${v.version} @ ${dateMarker} (annotation id: ${result.id})`);
      created++;
      await sleep(DELAY_BETWEEN_REQUESTS_MS);
    } catch (err) {
      console.error(`FAILED ${v.version}: ${err.message}`);
    }
  }

  console.log(`\nDone. Created: ${created}, Skipped: ${skipped}`);
}

main();
