import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderRouter, resolveProviderRoutePlan } from '../providerRouting';
import { canonicalizePlan } from './fixtures/canonicalize';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.join(dirname, 'fixtures', 'providerRoutePlan');

const activeProviderSchema = z.enum(['anthropic', 'openrouter', 'codex']).nullish().transform((value) => value ?? undefined);
const providerTypeSchema = z.enum(['anthropic', 'openai', 'google', 'together', 'cerebras', 'openrouter', 'other', 'local']).optional();
const routeScopeSchema = z.enum(['normal-turn', 'council', 'ad-hoc', 'retry', 'fallback', 'eval']).optional();
const codexConnectivitySchema = z.enum(['connected', 'disconnected', 'unknown', 'unsupported']);
const fallbackHintSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('long-context-profile'), profileId: z.string() }),
  z.object({ kind: z.literal('thinking-downgrade'), reason: z.literal('thinking-not-supported') }),
  z.object({ kind: z.literal('alt-model'), model: z.string() }),
  z.object({
    kind: z.literal('configured-role-fallback'),
    role: z.enum(['working', 'thinking', 'background']),
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('model'), model: z.string() }),
      z.object({ kind: z.literal('profile'), profileId: z.string() }),
    ]),
    failedModel: z.string().optional(),
    errorKind: z.string().optional(),
  }),
  z.object({ kind: z.literal('codex-rate-limit-tier'), tier: z.enum(['standard', 'priority']) }),
  z.object({ kind: z.literal('codex-rate-limit-provider'), forceNonCodexTransport: z.literal(true).optional() }),
]).optional();

const modelProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  authSource: z.literal('codex-subscription').optional(),
  providerType: providerTypeSchema,
  serverUrl: z.string(),
  model: z.string().optional(),
  apiKey: z.string().optional(),
  createdAt: z.number(),
  customProviderId: z.string().optional(),
  enabled: z.boolean().optional(),
  councilEnabled: z.boolean().optional(),
}).passthrough();

const settingsSchema = z.object({
  activeProvider: activeProviderSchema,
  models: z.object({
    apiKey: z.string().nullable().optional(),
    oauthToken: z.string().nullable().optional(),
    authMethod: z.enum(['api-key', 'oauth-token']).optional(),
    model: z.string().optional(),
    thinkingModel: z.string().optional(),
    workingProfileId: z.string().optional(),
    thinkingProfileId: z.string().optional(),
    thinkingFallback: z.string().optional(),
    workingFallback: z.string().optional(),
  }).optional(),
  openRouter: z.object({
    enabled: z.boolean().optional(),
    oauthToken: z.string().nullable().optional(),
    selectedModel: z.string().optional(),
  }).optional(),
  localModel: z.object({
    activeProfileId: z.string().nullable().optional(),
    profiles: z.array(modelProfileSchema).optional(),
  }).optional(),
  providerKeys: z.record(z.string(), z.string()).optional(),
});

const fixtureSchema = z.object({
  name: z.string(),
  description: z.string(),
  input: z.object({
    settings: settingsSchema,
    model: z.string().optional(),
    codexConnectivity: codexConnectivitySchema,
    routeScope: routeScopeSchema,
    fallbackHint: fallbackHintSchema,
    role: z.enum(['execution', 'planning']).optional(),
  }),
});

type Fixture = z.infer<typeof fixtureSchema>;
type FixtureKind = 'forTurn' | 'forBTS' | 'forSubagent';

function loadFixtures(kind: FixtureKind): ReadonlyArray<Fixture> {
  const dir = path.join(fixturesRoot, kind);
  return fs.readdirSync(dir)
    .filter((fileName) => fileName.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) => fixtureSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8'))));
}

function loadFixture(kind: FixtureKind, name: string): Fixture {
  const fixture = loadFixtures(kind).find((candidate) => candidate.name === name);
  if (!fixture) {
    throw new Error(`Missing ${kind} fixture ${name}`);
  }
  return fixture;
}

function resolveFixture(kind: FixtureKind, fixture: Fixture) {
  switch (kind) {
    case 'forTurn':
      return ProviderRouter.forTurn(fixture.input);
    case 'forBTS':
      return ProviderRouter.forBTS(fixture.input);
    case 'forSubagent':
      return ProviderRouter.forSubagent(fixture.input);
  }
}

async function resolveFixturePlan(kind: FixtureKind, fixture: Fixture) {
  switch (kind) {
    case 'forTurn':
      return resolveProviderRoutePlan({ kind, input: fixture.input });
    case 'forBTS':
      return resolveProviderRoutePlan({ kind, input: fixture.input });
    case 'forSubagent':
      return resolveProviderRoutePlan({ kind, input: fixture.input });
  }
}

describe('ProviderRouter snapshot fixture corpus', () => {
  for (const kind of ['forTurn', 'forBTS', 'forSubagent'] satisfies ReadonlyArray<FixtureKind>) {
    describe(kind, () => {
      for (const fixture of loadFixtures(kind)) {
        it(`${fixture.name}: ${fixture.description}`, () => {
          const decision = resolveFixture(kind, fixture);
          expect(canonicalizePlan(decision)).toMatchSnapshot(`${kind}/${fixture.name}`);
        });
      }
    });
  }

  describe('runtime endpoint metadata', () => {
    for (const { kind, name } of [
      { kind: 'forTurn', name: 'profile_ref_openai' },
      { kind: 'forTurn', name: 'local_profile' },
    ] satisfies ReadonlyArray<{ kind: FixtureKind; name: string }>) {
      it(`${kind}/${name} includes endpoint baseURL`, async () => {
        const plan = await resolveFixturePlan(kind, loadFixture(kind, name));
        expect(canonicalizePlan(plan)).toMatchSnapshot(`runtime/${kind}/${name}`);
      });
    }
  });
});
