/**
 * One-time migration (v2): retroactively tag historical cost ledger entries
 * with auth method based on model name + current settings heuristics.
 *
 * Before the auth tagging fix (April 2026), all profile-routed turns
 * (including Codex/ChatGPT subscription and Claude Max) were written
 * with auth: undefined. This migration reads the ledger and tags entries
 * so historical subscription savings show correctly.
 *
 * Conservative strategy — only tag strong-evidence cases:
 *
 * GPT-model entries (auth: null):
 *   - Codex connected + no OpenAI API key (shared or per-profile) → 'codex-subscription'
 *   - Any OpenAI key present, or neither connected → leave null ('Before cost tracking')
 *
 * Claude-model entries (auth: null):
 *   - oauthMigratedAt set + entry timestamp < migration date → 'oauth-token'
 *   - oauthMigratedAt set but no timestamp or after migration → leave null
 *   - No oauthMigratedAt → leave null
 *
 * Versioned marker: v2 re-runs on users who already ran v1 (which only
 * handled GPT entries naively). v2 does NOT modify already-tagged entries
 * — only null-auth entries are candidates for tagging.
 *
 * Must be awaited (not fire-and-forget) to prevent write races with
 * the append-based cost ledger during startup.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import { getOauthMigratedAt } from '@core/rebelCore/settingsAccessors';
import type { AppSettings } from '@shared/types/settings';

const log = createScopedLogger({ service: 'costLedgerAuthMigration' });

const MARKER_FILENAME = '.cost-ledger-auth-migrated-v2';

function getLedgerPath(): string {
  return path.join(getDataPath(), 'cost-ledger.jsonl');
}

function getMarkerPath(): string {
  return path.join(getDataPath(), MARKER_FILENAME);
}

interface MigrationSignals {
  codexConnected: boolean;
  hasAnyOpenAiKey: boolean;
  oauthMigratedAtMs: number | null;
}

function isGptModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes('gpt') || lower.includes('o1') || lower.includes('o3') || lower.includes('o4-mini');
}

function isClaudeModel(model: string): boolean {
  return model.toLowerCase().includes('claude');
}

function inferAuth(
  entry: { auth?: string | null; m?: string; ts?: number },
  signals: MigrationSignals,
): string | null {
  if (entry.auth != null) return null; // already tagged — don't touch
  if (typeof entry.m !== 'string') return null; // no model — can't infer

  if (isGptModel(entry.m)) {
    // Strong evidence: Codex connected and no separate OpenAI key (shared or per-profile)
    if (signals.codexConnected && !signals.hasAnyOpenAiKey) return 'codex-subscription';
    // Ambiguous (has an OpenAI key, or neither connected) — leave untagged.
    // We do NOT tag profile-direct here because we can't distinguish which
    // profile was used for a historical entry.
    return null;
  }

  if (isClaudeModel(entry.m)) {
    // Strong evidence: user was a Claude Max subscriber and entry predates migration
    if (signals.oauthMigratedAtMs != null) {
      const entryTs = typeof entry.ts === 'number' ? entry.ts : 0;
      if (entryTs > 0 && entryTs < signals.oauthMigratedAtMs) return 'oauth-token';
    }
    return null;
  }

  return null; // non-GPT, non-Claude model — leave untagged
}

export interface CostLedgerAuthMigrationResult {
  skipped: boolean;
  entriesUpdated: number;
  entriesTotal: number;
  error?: string;
}

/**
 * Collect migration signals from current settings and auth state.
 * Accepts getters as params so callers can inject them (testability).
 */
export function collectMigrationSignals(
  settings: AppSettings,
  checkCodexConnected: () => boolean,
): MigrationSignals {
  // Check shared OpenAI key
  const hasSharedKey = !!settings.providerKeys?.openai;
  // Check per-profile OpenAI keys (any profile with providerType 'openai' and its own apiKey)
  const hasProfileKey = settings.localModel?.profiles?.some(
    (p) => p.providerType === 'openai' && !!p.apiKey,
  ) ?? false;

  const oauthMigratedAt = getOauthMigratedAt(settings);
  const oauthMigratedAtMs = oauthMigratedAt ? Date.parse(oauthMigratedAt) : null;

  return {
    codexConnected: checkCodexConnected(),
    hasAnyOpenAiKey: hasSharedKey || hasProfileKey,
    oauthMigratedAtMs: oauthMigratedAtMs != null && !Number.isNaN(oauthMigratedAtMs)
      ? oauthMigratedAtMs
      : null,
  };
}

export async function runCostLedgerAuthMigration(
  settings: AppSettings,
  checkCodexConnected: () => boolean,
): Promise<CostLedgerAuthMigrationResult> {
  const markerPath = getMarkerPath();

  if (fs.existsSync(markerPath)) {
    return { skipped: true, entriesUpdated: 0, entriesTotal: 0 };
  }

  const ledgerPath = getLedgerPath();

  if (!fs.existsSync(ledgerPath)) {
    fs.writeFileSync(markerPath, new Date().toISOString(), 'utf8');
    return { skipped: true, entriesUpdated: 0, entriesTotal: 0 };
  }

  const signals = collectMigrationSignals(settings, checkCodexConnected);
  log.info(
    { codexConnected: signals.codexConnected, hasAnyOpenAiKey: signals.hasAnyOpenAiKey, hasOauthHistory: signals.oauthMigratedAtMs != null },
    'Starting cost ledger auth migration v2 (one-time)',
  );

  try {
    const content = fs.readFileSync(ledgerPath, 'utf8');
    const lines = content.split('\n');
    const updatedLines: string[] = [];
    let entriesUpdated = 0;
    let entriesTotal = 0;

    for (const line of lines) {
      if (!line.trim()) {
        updatedLines.push(line);
        continue;
      }

      try {
        const entry = JSON.parse(line);
        entriesTotal++;

        const newAuth = inferAuth(entry, signals);
        if (newAuth != null) {
          entry.auth = newAuth;
          updatedLines.push(JSON.stringify(entry));
          entriesUpdated++;
        } else {
          updatedLines.push(line);
        }
      } catch {
        updatedLines.push(line);
      }
    }

    if (entriesUpdated > 0) {
      const tempPath = ledgerPath + '.migration-tmp';
      fs.writeFileSync(tempPath, updatedLines.join('\n'), 'utf8');
      fs.renameSync(tempPath, ledgerPath);

      log.info(
        { entriesUpdated, entriesTotal },
        'Cost ledger auth migration v2 complete',
      );
    } else {
      log.info({ entriesTotal }, 'Cost ledger auth migration v2: no entries needed updating');
    }

    fs.writeFileSync(markerPath, JSON.stringify({
      version: 2,
      migratedAt: new Date().toISOString(),
      signals: {
        codexConnected: signals.codexConnected,
        hasAnyOpenAiKey: signals.hasAnyOpenAiKey,
        hadOauthHistory: signals.oauthMigratedAtMs != null,
      },
      entriesUpdated,
      entriesTotal,
    }), 'utf8');

    return { skipped: false, entriesUpdated, entriesTotal };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.warn({ err }, 'Cost ledger auth migration v2 failed (non-fatal) — will retry on next startup');
    return { skipped: false, entriesUpdated: 0, entriesTotal: 0, error: errorMsg };
  }
}
