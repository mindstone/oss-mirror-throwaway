export async function runInBatches<T>(
  tasks: Array<() => Promise<T>>,
  batchSize: number
): Promise<T[]> {
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error('batchSize must be a positive number');
  }

  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += batchSize) {
    const batch = tasks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map((task) => task()));
    results.push(...batchResults);
  }

  return results;
}
