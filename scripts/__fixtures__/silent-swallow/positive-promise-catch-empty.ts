declare function maybeFail(): Promise<void>;

export async function run(): Promise<void> {
  await maybeFail().catch(() => {});
}
