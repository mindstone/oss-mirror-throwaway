/**
 * Usage History Utilities — CSV export for the ledger-based daily breakdown.
 *
 * Lives in @shared/ so the renderer (Settings → Usage) can import it.
 * Only the ledger CSV export survives here; the session-aggregation helpers
 * were removed when the Usage page switched to the cost ledger as its single
 * source of truth for totals and daily breakdown.
 */

/**
 * A single day's aggregated cost data from the ledger.
 * Mirrors `DailyBreakdownEntry` from `@core/services/costLedgerService`
 * but defined here to avoid cross-process import issues (shared → core).
 */
export interface LedgerDailyBreakdown {
  date: string; // YYYY-MM-DD
  cost: number;
  turns: number;
  totalEntries: number;
  inTok: number;
  outTok: number;
  cacheReadTok: number;
  cacheCreateTok: number;
}

/**
 * Export ledger-based daily breakdown to CSV format.
 * Matches the hero metric and category breakdown (all sourced from the cost ledger).
 * Token columns will be 0 for pre-migration entries that lack token data.
 */
export function exportLedgerDailyToCsv(dailyBreakdown: LedgerDailyBreakdown[]): string {
  const header =
    'Date,Cost (USD),Turns,Total Entries,Input Tokens,Output Tokens,Cache Read Tokens,Cache Create Tokens';
  const rows = dailyBreakdown.map(
    (d) =>
      `${d.date},${d.cost.toFixed(4)},${d.turns},${d.totalEntries},${d.inTok},${d.outTok},${d.cacheReadTok},${d.cacheCreateTok}`,
  );
  return [header, ...rows].join('\n');
}
