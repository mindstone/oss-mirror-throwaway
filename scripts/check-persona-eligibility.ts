#!/usr/bin/env -S npx tsx --tsconfig tsconfig.node.json

import fs from 'node:fs/promises';
import path from 'node:path';

import { loadPersonas } from '../evals/persona-loader';
import { isPersonaOverlayConfig, MultiTurnSimulationConfigSchema } from '../evals/persona-types';

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIRS = [
  path.join(REPO_ROOT, 'evals/fixtures/knowledge-work'),
  path.join(REPO_ROOT, 'evals/fixtures/knowledge-work-organisation'),
  path.join(REPO_ROOT, 'evals/fixtures/knowledge-work-ws'),
  path.join(REPO_ROOT, 'evals/fixtures/knowledge-work-reproducible'),
];

interface FixtureLite {
  id: string;
  family?: string;
  category?: string;
  multiTurnSimulation?: unknown;
  filePath: string;
}

async function scanDir(dir: string, fixtures: FixtureLite[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await scanDir(fullPath, fixtures);
    } else if (entry.name.endsWith('.json') && !entry.name.startsWith('_')) {
      try {
        const raw = await fs.readFile(fullPath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (typeof parsed.id === 'string') {
          fixtures.push({
            id: parsed.id,
            family: typeof parsed.family === 'string' ? parsed.family : undefined,
            category: typeof parsed.category === 'string' ? parsed.category : undefined,
            multiTurnSimulation: parsed.multiTurnSimulation,
            filePath: fullPath,
          });
        }
      } catch {
        // Skip malformed JSON — knowledge-work harness already surfaces these.
      }
    }
  }
}

async function loadAllFixtures(): Promise<FixtureLite[]> {
  const fixtures: FixtureLite[] = [];
  for (const dir of FIXTURE_DIRS) {
    await scanDir(dir, fixtures);
  }
  fixtures.sort((a, b) => a.id.localeCompare(b.id));
  return fixtures;
}

async function main(): Promise<void> {
  const errors: string[] = [];
  const warnings: string[] = [];

  let personas;
  try {
    personas = await loadPersonas();
  } catch (error) {
    console.error(`[check-persona-eligibility] failed to load personas:\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  if (personas.size === 0) {
    console.error('[check-persona-eligibility] no personas loaded — expected at least 1');
    process.exit(1);
  }

  const personaIds = new Set(personas.keys());
  const fixtures = await loadAllFixtures();

  if (fixtures.length === 0) {
    console.error('[check-persona-eligibility] no fixtures found — fixture directories may be missing');
    process.exit(1);
  }

  const allFixtureCategories = new Set<string>();
  for (const fixture of fixtures) {
    const cat = fixture.category ?? fixture.family;
    if (cat) allFixtureCategories.add(cat);
  }

  for (const persona of personas.values()) {
    for (const cat of persona.eligible_fixture_categories) {
      if (!allFixtureCategories.has(cat)) {
        warnings.push(
          `[persona ${persona.id}] eligible_fixture_categories entry '${cat}' does not match any fixture family or category. Known: ${Array.from(allFixtureCategories).sort().join(', ')}`,
        );
      }
    }
  }

  for (const persona of personas.values()) {
    const matchedFixtures = fixtures.filter((f) => {
      const cat = f.category ?? f.family;
      return cat ? persona.eligible_fixture_categories.includes(cat) : false;
    });
    if (matchedFixtures.length === 0) {
      errors.push(
        `[persona ${persona.id}] has zero eligible fixtures across the entire fixture set. eligible_fixture_categories=${JSON.stringify(persona.eligible_fixture_categories)}`,
      );
    }
  }

  for (const fixture of fixtures) {
    if (fixture.multiTurnSimulation === undefined) continue;
    const parsed = MultiTurnSimulationConfigSchema.safeParse(fixture.multiTurnSimulation);
    if (!parsed.success) {
      errors.push(
        `[fixture ${fixture.id}] multiTurnSimulation failed schema validation:\n${parsed.error.issues
          .map((i) => `    - ${i.path.join('.')}: ${i.message}`)
          .join('\n')}\n    (${fixture.filePath})`,
      );
      continue;
    }
    if (isPersonaOverlayConfig(parsed.data)) {
      for (const pid of parsed.data.eligiblePersonas) {
        if (!personaIds.has(pid)) {
          errors.push(
            `[fixture ${fixture.id}] multiTurnSimulation.eligiblePersonas references unknown persona id '${pid}'. Known persona ids: ${Array.from(personaIds).sort().join(', ')}`,
          );
        }
      }
      if (parsed.data.defaultPersona && !personaIds.has(parsed.data.defaultPersona)) {
        errors.push(
          `[fixture ${fixture.id}] multiTurnSimulation.defaultPersona='${parsed.data.defaultPersona}' is not a known persona id`,
        );
      }
      if (parsed.data.defaultPersona && !parsed.data.eligiblePersonas.includes(parsed.data.defaultPersona)) {
        errors.push(
          `[fixture ${fixture.id}] multiTurnSimulation.defaultPersona='${parsed.data.defaultPersona}' must also appear in eligiblePersonas`,
        );
      }
    }
  }

  if (warnings.length > 0) {
    console.warn(`[check-persona-eligibility] ${warnings.length} warning(s):`);
    for (const w of warnings) console.warn(`  - ${w}`);
  }

  if (errors.length > 0) {
    console.error(`[check-persona-eligibility] ${errors.length} error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(
    `[check-persona-eligibility] OK — ${personas.size} personas, ${fixtures.length} fixtures, ${allFixtureCategories.size} categories covered`,
  );
}

main().catch((error) => {
  console.error(`[check-persona-eligibility] fatal:`, error);
  process.exit(1);
});
