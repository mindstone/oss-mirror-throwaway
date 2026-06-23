import { spawn } from 'node:child_process';
import type { MediaConcatProcessor } from '@core/services/meetings/mediaConcatProcessor';
import { createNodeFsMeetingFileStorage } from './nodeFsMeetingFileStorage';

export class FfmpegMediaConcatProcessor implements MediaConcatProcessor {
  public async concatChunksToSingleFile(opts: {
    sessionDir: string;
    chunkPaths: string[];
    outputPath: string;
    concatListPath: string;
  }): Promise<void> {
    void opts.sessionDir;
    const listFileContents = opts.chunkPaths
      .map((chunkPath) => `file '${chunkPath.replace(/'/g, `'\\''`)}'`)
      .join('\n');

    // Use the same filesystem implementation as the meeting storage adapter for byte-equivalent writes.
    await createNodeFsMeetingFileStorage().writeFile(opts.concatListPath, listFileContents);

    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn(
        'ffmpeg',
        [
          '-f', 'concat',
          '-safe', '0',
          '-i', opts.concatListPath,
          '-c', 'copy',
          '-y',
          opts.outputPath,
        ],
        { windowsHide: true },
      );

      let stderr = '';
      ffmpeg.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`ffmpeg concat failed with exit code ${code}: ${stderr.slice(-500)}`));
      });

      ffmpeg.on('error', (err) => {
        reject(err);
      });
    });
  }
}

export function createFfmpegMediaConcatProcessor(): FfmpegMediaConcatProcessor {
  return new FfmpegMediaConcatProcessor();
}
