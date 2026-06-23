declare module 'wink-bm25-text-search' {
  interface BM25Engine {
    defineConfig(config: { fldWeights: Record<string, number> }): void;
    definePrepTasks(tasks: Array<(text: string) => string[]>): void;
    addDoc(doc: Record<string, string>, id: string): void;
    consolidate(): void;
    search(query: string, limit?: number): Array<[string, number]>;
    reset(): void;
  }
  function bm25Constructor(): BM25Engine;
  export default bm25Constructor;
}
