import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runEvalCorpusCleanCheck } from '../check-eval-corpus-clean';

const CANONICAL_JUDGES = [
  'anthropic/claude-opus-4-7',
  'openai/gpt-5.4',
  'google/gemini-3.1-pro-preview',
] as const;

let tmpDir: string;

function makeParseableJudge(input: {
  provider: string;
  model: string;
  verdict?: 'pass' | 'fail';
  score?: number;
}) {
  const score = input.score ?? 4;
  const verdict = input.verdict ?? (score >= 3 ? 'pass' : 'fail');
  return {
    provider: input.provider,
    model: input.model,
    role: 'primary',
    response: {
      weighted_score: score,
      verdict,
      dimensions: {
        grounded_accuracy: score,
      },
    },
  };
}

function buildPayload(input: {
  metadataJudges: string[];
  configured: number;
  succeeded: number;
  arbitratorTriggered: boolean;
  fixtureId?: string;
  score?: number;
}) {
  const score = input.score ?? 4;
  const verdict = score >= 3 ? 'pass' : 'fail';
  return {
    metadata: {
      judges: input.metadataJudges,
      analysisSchemaVersion: '1.4',
      workingModel: 'claude-sonnet-4-6',
      engine: 'rebel-core',
      timestamp: '2026-05-15T00:00:00.000Z',
    },
    results: [
      {
        fixtureId: input.fixtureId ?? 'fixture-a',
        family: 'research',
        completed: true,
        finalVerdict: verdict,
        arbitratorTriggered: input.arbitratorTriggered,
        judgePanelStatus: {
          configured: input.configured,
          succeeded: input.succeeded,
          failedByCategory: {},
        },
        consensus: {
          meanScore: score,
          medianScore: score,
        },
        judges: [
          makeParseableJudge({ provider: 'anthropic', model: 'claude-opus-4-7', score }),
          makeParseableJudge({ provider: 'openai', model: 'gpt-5.4', score }),
        ],
      },
    ],
  };
}

function writeResultFile(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

describe('check-eval-corpus-clean', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-eval-corpus-clean-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns exit 0 for an all-clean corpus', async () => {
    writeResultFile(
      path.join(tmpDir, '260515_clean.json'),
      buildPayload({
        metadataJudges: [...CANONICAL_JUDGES],
        configured: 3,
        succeeded: 2,
        arbitratorTriggered: false,
      }),
    );

    const result = await runEvalCorpusCleanCheck({ resultsDir: tmpDir });

    expect(result.exitCode).toBe(0);
    expect(result.issues).toHaveLength(0);
    expect(result.output).toContain('Eval corpus clean');
  });

  it('returns exit 1 with table output when one file is inadequate', async () => {
    writeResultFile(
      path.join(tmpDir, '260515_inadequate.json'),
      buildPayload({
        metadataJudges: [
          'anthropic/claude-opus-4-7',
          'openai/gpt-5.4',
        ],
        configured: 2,
        succeeded: 2,
        arbitratorTriggered: false,
      }),
    );

    const result = await runEvalCorpusCleanCheck({ resultsDir: tmpDir });

    expect(result.exitCode).toBe(1);
    expect(result.issues).toHaveLength(1);
    expect(result.output).toContain('260515_inadequate.json');
    expect(result.output).toContain('panel_signature_mismatch');
    expect(result.output).toContain('Suggested action');
  });

  it('ignores inadequate files under obsolete/', async () => {
    writeResultFile(
      path.join(tmpDir, '260515_clean.json'),
      buildPayload({
        metadataJudges: [...CANONICAL_JUDGES],
        configured: 3,
        succeeded: 2,
        arbitratorTriggered: false,
      }),
    );
    writeResultFile(
      path.join(tmpDir, 'obsolete', '260515_policy', '260515_inadequate.json'),
      buildPayload({
        metadataJudges: [
          'anthropic/claude-opus-4-7',
          'openai/gpt-5.4',
        ],
        configured: 2,
        succeeded: 2,
        arbitratorTriggered: false,
      }),
    );

    const result = await runEvalCorpusCleanCheck({ resultsDir: tmpDir });

    expect(result.exitCode).toBe(0);
    expect(result.issues).toHaveLength(0);
  });

  it('emits machine-readable JSON in --json mode', async () => {
    writeResultFile(
      path.join(tmpDir, '260515_inadequate.json'),
      buildPayload({
        metadataJudges: [
          'anthropic/claude-opus-4-7',
          'openai/gpt-5.4',
        ],
        configured: 2,
        succeeded: 2,
        arbitratorTriggered: false,
      }),
    );

    const result = await runEvalCorpusCleanCheck({ resultsDir: tmpDir, json: true });
    const parsed = JSON.parse(result.output) as {
      status: string;
      scannedFiles: number;
      issues: Array<{ fileName: string; reasons: string[] }>;
    };

    expect(result.exitCode).toBe(1);
    expect(parsed.status).toBe('inadequate');
    expect(parsed.scannedFiles).toBe(1);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].fileName).toBe('260515_inadequate.json');
    expect(parsed.issues[0].reasons).toContain('panel_signature_mismatch');
  });
});
