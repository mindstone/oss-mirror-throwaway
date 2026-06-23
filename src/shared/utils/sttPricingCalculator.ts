/**
 * STT (Speech-to-Text) pricing calculator.
 *
 * Duration-based pricing for OpenAI Whisper models.
 * Returns null for unknown models (ElevenLabs, custom, local).
 *
 * Pricing last verified: 2026-03-17
 * Source: https://platform.openai.com/docs/pricing
 */

// Per-second USD rates (price-per-minute / 60)
const STT_RATES: Record<string, number> = {
  'gpt-4o-mini-transcribe': 0.003 / 60,
  'gpt-4o-transcribe': 0.006 / 60,
  'whisper-1': 0.006 / 60,
};

/**
 * Calculate the cost of an STT transcription.
 *
 * @param model - STT model name (may include date suffix like `-2025-12-15`)
 * @param durationMs - Audio duration in milliseconds
 * @returns Cost in USD, or null if model is unknown or duration is invalid
 */
export function calculateSttCost(model: string | undefined, durationMs: number | undefined): number | null {
  if (!model || !durationMs || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }

  const normalised = model.toLowerCase().trim();

  // Direct lookup
  let rate = STT_RATES[normalised];

  // Strip date suffix (e.g. gpt-4o-mini-transcribe-2025-12-15 → gpt-4o-mini-transcribe)
  if (rate === undefined) {
    const base = normalised.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    rate = STT_RATES[base];
  }

  if (rate === undefined) {
    return null;
  }

  const durationSec = durationMs / 1000;
  return durationSec * rate;
}
