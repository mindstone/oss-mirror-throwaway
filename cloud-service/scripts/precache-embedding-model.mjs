// Pre-cache the cloud embedding model at image-build time so the cloud-service's
// first boot doesn't download ONNX weights. Run from the Dockerfile builder stage
// (WORKDIR /app/cloud-service) so Node's CJS resolver finds @huggingface/transformers
// in cloud-service/node_modules.
//
// Why a retry: huggingface.co intermittently rate-limits (HTTP 429) during CI image
// builds, which previously failed the whole "Build Cloud Service Image" job (a real,
// recurring flake — e.g. run 26935564414). Transformers.js fetches the model files
// over the network here, so a transient 429/5xx/connection blip is exactly the kind
// of failure a bounded backoff-retry should absorb rather than fail the build.
//
// Transformers.js does NOT honour HF_HOME / TRANSFORMERS_CACHE — its cache dir is the
// library-exported mutable `env.cacheDir`, set below so the next Docker stage's
// `COPY --from=builder /app/cloud-service/models` can pick the weights up.
import { pipeline, env } from '@huggingface/transformers';

const MODEL = 'Xenova/bge-small-en-v1.5';
const CACHE_DIR = '/app/cloud-service/models';
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 30_000;

env.cacheDir = CACHE_DIR;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
      console.log(`Model pre-cached at ${env.cacheDir}`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Model pre-cache attempt ${attempt}/${MAX_ATTEMPTS} failed: ${message}`);
      if (attempt === MAX_ATTEMPTS) {
        // Final failure — log the full error (status/stack) for CI diagnosis, not just message.
        console.error(error);
        process.exit(1);
      }
      const delayMs = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attempt);
      console.error(`Retrying model pre-cache in ${delayMs}ms…`);
      await sleep(delayMs);
    }
  }
}

void main();
