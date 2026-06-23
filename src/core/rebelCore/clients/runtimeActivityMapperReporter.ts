import { createScopedLogger } from '@core/logger';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';

export type RuntimeActivityMapperProvider =
  | 'anthropic'
  | 'openai-responses'
  | 'openai-chat'
  | 'codex';

const MAX_DEDUPE_KEYS = 256;
const MAX_MESSAGE_CHARS = 200;

const runtimeActivityMapperCapturedKeys = new Set<string>();
let runtimeActivityMapperCapWarned = false;

const log = createScopedLogger({ service: 'runtimeActivityMapperReporter' });

export function reportRuntimeActivityMapperFailure(
  provider: RuntimeActivityMapperProvider,
  err: unknown,
  extra: Record<string, unknown> = {},
): void {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const dedupeMessage = rawMessage.slice(0, MAX_MESSAGE_CHARS);
  const key = `${provider}:${dedupeMessage}`;

  if (runtimeActivityMapperCapturedKeys.has(key)) return;

  if (runtimeActivityMapperCapturedKeys.size >= MAX_DEDUPE_KEYS) {
    if (!runtimeActivityMapperCapWarned) {
      runtimeActivityMapperCapWarned = true;
      try {
        log.warn(
          { capSize: MAX_DEDUPE_KEYS, provider },
          'Runtime activity mapper-failure dedupe cap reached; subsequent unique errors will not be captured for this process lifetime',
        );
      } catch {
        // Never throw from the warn path.
      }
    }
    return;
  }

  runtimeActivityMapperCapturedKeys.add(key);

  try {
    const wrapped = err instanceof Error ? err : new Error(String(err));
    captureKnownCondition(
      'runtime_activity_mapper_failure',
      {
        tags: {
          area: 'runtime-activity',
          condition: 'runtime_activity_mapper_failure',
          provider,
        },
        extra,
      },
      wrapped,
    );
  } catch {
    // Never throw from the capture path — stream processing must continue.
  }
}

/** @internal — test-only. Resets module-level dedupe state. */
// eslint-disable-next-line @typescript-eslint/naming-convention -- Test seam is intentionally prefixed with "__" to make non-production usage obvious.
export function __resetRuntimeActivityMapperDedupeState(): void {
  runtimeActivityMapperCapturedKeys.clear();
  runtimeActivityMapperCapWarned = false;
}
