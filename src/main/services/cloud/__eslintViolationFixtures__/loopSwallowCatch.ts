type FixtureLogger = {
  warn(bindings: Record<string, unknown>, message: string): void;
};

export async function loopSwallowCatchFixture(
  items: readonly string[],
  log: FixtureLogger,
  runItem: (item: string) => Promise<void>,
): Promise<number> {
  let skipped = 0;

  for (const item of items) {
    try {
      await runItem(item);
    } catch (err) {
      log.warn({ err, item }, 'fixture item failed');
      skipped++;
    }
  }

  return skipped;
}
