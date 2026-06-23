/**
 * Daily Spark Domain IPC Handlers
 *
 * NO-LOG RULE: Spark `body` and `captionOverride` text must never appear in
 * logs, telemetry, or analytics payloads. Format names, ids, counts, and
 * timing are fine — spark text is not.
 *
 * @see docs/plans/260512_daily_spark.md
 */

import { registerHandler } from './utils/registerHandler';
import { dailySparkChannels } from '@shared/ipc/channels/dailySpark';
import {
  dismissToday,
  getCurrentBatch,
  getTodaySpark,
  recordLessLikeThis,
} from '@core/services/dailySparkStore';
import { generateDailySparkNow } from '../services/dailySparkScheduler';

export function registerDailySparkHandlers(): void {
  const getTodayChannel = dailySparkChannels['daily-spark:get-today'];
  registerHandler(getTodayChannel.channel, async () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = new Date();
    const { spark, isFirstAppearance } = getTodaySpark(now, tz);
    const current = getCurrentBatch();
    return {
      spark,
      isFirstAppearance,
      toneGauge: current ? current.toneGauge : null,
    };
  });

  const dismissChannel = dailySparkChannels['daily-spark:dismiss-today'];
  registerHandler(dismissChannel.channel, async (_event, ...args) => {
    const validated = dismissChannel.request.parse(args[0]);
    const ok = dismissToday(validated.sparkId);
    return { ok };
  });

  const feedbackChannel = dailySparkChannels['daily-spark:feedback-less-like-this'];
  registerHandler(feedbackChannel.channel, async (_event, ...args) => {
    const validated = feedbackChannel.request.parse(args[0]);
    const ok = recordLessLikeThis(validated.sparkId);
    return { ok };
  });

  const generateNowChannel = dailySparkChannels['daily-spark:generate-now'];
  registerHandler(generateNowChannel.channel, async () => {
    try {
      const batch = await generateDailySparkNow();
      return { batch };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { batch: null, error: msg };
    }
  });
}
