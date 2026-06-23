declare function maybeFail(): void;

export function run(): void {
  try {
    maybeFail();
  } catch (err) {
    console.warn('first message', err);
    console.warn('second message', err);
  }
}
