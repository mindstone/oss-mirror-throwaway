declare function maybeFail(): Promise<unknown>;

export async function run(): Promise<unknown> {
  return maybeFail().catch(() => null);
}
