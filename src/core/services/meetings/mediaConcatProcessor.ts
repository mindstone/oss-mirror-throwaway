export interface MediaConcatProcessor {
  concatChunksToSingleFile(opts: {
    sessionDir: string;
    chunkPaths: string[];
    outputPath: string;
    concatListPath: string;
  }): Promise<void>;
}
