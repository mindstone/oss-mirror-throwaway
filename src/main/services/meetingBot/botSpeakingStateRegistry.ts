/**
 * Bottom-of-graph registry that breaks the circular import between
 * `botQAService.ts` and `botVoiceService.ts`.
 *
 * `botVoiceService` needs to flag bot-speaking state (so QA logic can pause
 * its own response generation while the bot speaks) and to check the abort
 * flag mid-stream. Routing those reads/writes through this registry lets the
 * voice path call `setBotSpeakingState` / `shouldAbortSpeaking` without a
 * static import on `botQAService` (which itself imports voice helpers like
 * `speakInMeeting`).
 *
 * `botQAService` self-registers its handlers at module load. Pre-registration
 * calls degrade to safe no-ops (and `shouldAbortSpeaking` returns false), so
 * code that boots through botVoiceService first won't crash — once botQA
 * loads, every subsequent call delegates correctly.
 */

type SetBotSpeakingStateFn = (botId: string, speaking: boolean) => void;
type ShouldAbortSpeakingFn = (botId: string) => boolean;

let setBotSpeakingStateFn: SetBotSpeakingStateFn | null = null;
let shouldAbortSpeakingFn: ShouldAbortSpeakingFn | null = null;

export function registerSetBotSpeakingState(fn: SetBotSpeakingStateFn): void {
  setBotSpeakingStateFn = fn;
}

export function setBotSpeakingState(botId: string, speaking: boolean): void {
  if (setBotSpeakingStateFn) {
    setBotSpeakingStateFn(botId, speaking);
  }
}

export function registerShouldAbortSpeaking(fn: ShouldAbortSpeakingFn): void {
  shouldAbortSpeakingFn = fn;
}

export function shouldAbortSpeaking(botId: string): boolean {
  return shouldAbortSpeakingFn ? shouldAbortSpeakingFn(botId) : false;
}
