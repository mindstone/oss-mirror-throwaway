#!/usr/bin/env npx tsx

import fs from 'node:fs';
import path from 'node:path';
import { loadEvalFiles } from '../evals/analyze-knowledge-work-data';
import { loadCanonicalPanel } from '../evals/canonicalPanel';
import {
  classifyJudgeAdequacy,
  resolveConfiguredPanelFromMetadata,
  type AdequacyReason,
  type JudgeAdequacy,
} from '../evals/knowledge-work-judge-adequacy';
import { resolveEvalResultsDir } from '../evals/shared';

const DEFAULT_RESULTS_DIR = resolveEvalResultsDir('knowledge-work');
const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', 'evals', 'configs', 'default.json');
const DEFAULT_SINCE = new Date(Date.UTC(1970, 0, 1));
const DEFAULT_UNTIL = new Date(Date.UTC(2100, 0, 1));

type RemediationType = Extract<JudgeAdequacy, { adequate: false }>['remediation'];

export interface EvalCorpusIssue {
  fileName: string;
  reasons: AdequacyReason[];
  remediation: RemediationType;
  suggestedAction: string;
  inadequateResults: number;
}

export interface EvalCorpusCleanOptions {
  resultsDir?: string;
  json?: boolean;
  limit?: number;
}

export interface EvalCorpusCleanResult {
  exitCode: 0 | 1;
  output: string;
  resultsDir: string;
  scannedFiles: number;
  scannedResults: number;
  issues: EvalCorpusIssue[];
}

function remediationPriority(remediation: RemediationType): number {
  switch (remediation) {
    case 'quarantine_integrity_failure':
      return 0;
    case 'quarantine_no_agent_output':
      return 1;
    case 'quarantine_no_snapshot':
      return 2;
    case 'rejudge_canonical':
    default:
      return 3;
  }
}

function choosePrimaryRemediation(remediations: RemediationType[]): RemediationType {
  return [...remediations].sort((a, b) => remediationPriority(a) - remediationPriority(b))[0];
}

function suggestedAction(remediation: RemediationType): string {
  switch (remediation) {
    case 'rejudge_canonical':
      return 'Run canonical rejudge migration (`npm run eval:remediate-inadequate apply --cost-cap-usd <approved> --epoch <slug>`).';
    case 'quarantine_no_snapshot':
      return 'Quarantine unsalvageable data (`npm run eval:remediate-inadequate quarantine-only --epoch <slug>`).';
    case 'quarantine_no_agent_output':
      return 'Quarantine file (no recoverable snapshot/agent output) and regenerate with a fresh eval run.';
    case 'quarantine_integrity_failure':
      return 'Quarantine + investigate integrity mismatch before reusing this file.';
    default:
      return 'Run remediation tooling and investigate.';
  }
}

function formatTable(issues: EvalCorpusIssue[]): string {
  const header = ['File', 'Reason(s)', 'Suggested action'];
  const rows = issues.map((issue) => [
    issue.fileName,
    issue.reasons.join(', '),
    issue.suggestedAction,
  ]);
  const widths = header.map((title, idx) =>
    Math.max(
      title.length,
      ...rows.map((row) => row[idx].length),
    ),
  );

  const renderRow = (cols: string[]): string =>
    cols.map((col, idx) => col.padEnd(widths[idx])).join(' | ');

  const divider = widths.map((width) => '-'.repeat(width)).join('-|-');
  return [
    renderRow(header),
    divider,
    ...rows.map((row) => renderRow(row)),
  ].join('\n');
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--limit must be an integer >= 1 (received "${raw}")`);
  }
  return value;
}

export async function runEvalCorpusCleanCheck(
  options: EvalCorpusCleanOptions = {},
): Promise<EvalCorpusCleanResult> {
  const resultsDir = path.resolve(options.resultsDir ?? DEFAULT_RESULTS_DIR);
  if (!fs.existsSync(resultsDir) || !fs.statSync(resultsDir).isDirectory()) {
    throw new Error(
      `Eval results directory not found: ${resultsDir}\n`
      + 'Set EVAL_RESULTS_DIR or pass --results-dir <path>.',
    );
  }

  const canonical = loadCanonicalPanel(DEFAULT_CONFIG_PATH);
  const loaded = await loadEvalFiles(resultsDir, DEFAULT_SINCE, DEFAULT_UNTIL, { onCorrupt: 'skip' });
  const files = typeof options.limit === 'number' ? loaded.slice(0, options.limit) : loaded;

  const issues: EvalCorpusIssue[] = [];
  let scannedResults = 0;
  for (const file of files) {
    const configuredPanel = resolveConfiguredPanelFromMetadata(file.metadata, canonical);
    const inadequates = file.results
      .map((result) => classifyJudgeAdequacy(result, canonical, configuredPanel))
      .filter((adequacy): adequacy is Extract<JudgeAdequacy, { adequate: false }> => adequacy.adequate === false);
    scannedResults += file.results.length;
    if (inadequates.length === 0) continue;

    const reasons = [...new Set(inadequates.flatMap((adequacy) => adequacy.reasons))]
      .sort((a, b) => a.localeCompare(b));
    const remediation = choosePrimaryRemediation(inadequates.map((adequacy) => adequacy.remediation));
    issues.push({
      fileName: file._source_file,
      reasons,
      remediation,
      suggestedAction: suggestedAction(remediation),
      inadequateResults: inadequates.length,
    });
  }

  const payload = {
    status: issues.length === 0 ? 'clean' : 'inadequate',
    resultsDir,
    scannedFiles: files.length,
    scannedResults,
    ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
    issues,
  };

  if (options.json === true) {
    return {
      exitCode: issues.length === 0 ? 0 : 1,
      output: `${JSON.stringify(payload, null, 2)}\n`,
      resultsDir,
      scannedFiles: files.length,
      scannedResults,
      issues,
    };
  }

  if (issues.length === 0) {
    return {
      exitCode: 0,
      output:
        `✅ Eval corpus clean: scanned ${files.length} file(s), ${scannedResults} result(s); `
        + 'no inadequate judging detected.\n',
      resultsDir,
      scannedFiles: files.length,
      scannedResults,
      issues,
    };
  }

  const table = formatTable(issues);
  const output = [
    '❌ Inadequate judging data detected in eval corpus.',
    '',
    table,
    '',
    'Run remediation tooling:',
    '  npm run eval:remediate-inadequate report',
    '  npm run eval:remediate-inadequate apply --cost-cap-usd <approved> --epoch <slug>',
    '',
  ].join('\n');

  return {
    exitCode: 1,
    output,
    resultsDir,
    scannedFiles: files.length,
    scannedResults,
    issues,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const resultsDirFlag = args.indexOf('--results-dir');
  const resultsDir = resultsDirFlag >= 0 ? args[resultsDirFlag + 1] : undefined;
  if (resultsDirFlag >= 0 && (!resultsDir || resultsDir.startsWith('--'))) {
    throw new Error('--results-dir requires a path value');
  }
  const limitFlag = args.indexOf('--limit');
  const limit = limitFlag >= 0 ? parseLimit(args[limitFlag + 1]) : undefined;
  if (limitFlag >= 0 && args[limitFlag + 1] == null) {
    throw new Error('--limit requires a numeric value');
  }

  const result = await runEvalCorpusCleanCheck({
    ...(resultsDir ? { resultsDir } : {}),
    ...(typeof limit === 'number' ? { limit } : {}),
    ...(json ? { json: true } : {}),
  });

  if (result.exitCode === 0) {
    process.stdout.write(result.output);
  } else {
    process.stderr.write(result.output);
  }
  process.exit(result.exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[check-eval-corpus-clean] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
