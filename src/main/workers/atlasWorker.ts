/**
 * Atlas Worker Thread
 *
 * Runs dimensionality reduction in a separate thread to avoid blocking
 * the main Electron process. Projects 384D file embeddings to 3D for visualization.
 *
 * Uses simple PCA (Principal Component Analysis) instead of UMAP because:
 * - UMAP's recursive algorithms cause stack overflow on large datasets (2000+ files)
 * - PCA is O(n*d) and handles any dataset size instantly
 * - Embeddings already encode semantic similarity, so PCA preserves clustering
 *
 * Communication protocol:
 * - project: Run PCA projection on file embeddings
 */

// MUST be the very first import — see docs/plans/260428_graceful_fs_emfile_fix.md
import '../startup/installGracefulFs';
import { parentPort } from 'worker_threads';

// Types
interface ProjectRequest {
  type: 'project';
  id: string;
  fileVectors: number[][];  // Averaged embeddings per file (384D)
  filePaths: string[];      // Corresponding file paths
  config?: {
    nComponents?: number;   // Output dimensions (default 3)
  };
}

interface ProjectResponse {
  type: 'result';
  id: string;
  projected: Array<{
    path: string;
    x: number;
    y: number;
    z: number;
  }>;
}

interface ErrorResponse {
  type: 'error';
  id: string;
  error: string;
}

type WorkerMessage = ProjectRequest;
type WorkerResponse = ProjectResponse | ErrorResponse;

function sendResponse(response: WorkerResponse): void {
  parentPort?.postMessage(response);
}

/**
 * Simple PCA implementation using power iteration
 * Finds the top k principal components of the data
 */
function simplePCA(data: number[][], nComponents: number): number[][] {
  const n = data.length;
  const d = data[0].length;
  
  // 1. Center the data (subtract mean)
  const mean = new Array(d).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < d; j++) {
      mean[j] += data[i][j];
    }
  }
  for (let j = 0; j < d; j++) {
    mean[j] /= n;
  }
  
  const centered = data.map(row => row.map((val, j) => val - mean[j]));
  
  // 2. Find principal components using power iteration
  const components: number[][] = [];
  const projectedData = centered.map(row => [...row]);
  
  for (let comp = 0; comp < nComponents; comp++) {
    // Initialize random vector
    let pc = new Array(d).fill(0).map(() => Math.random() - 0.5);
    
    // Normalize
    let norm = Math.sqrt(pc.reduce((sum, v) => sum + v * v, 0));
    pc = pc.map(v => v / norm);
    
    // Power iteration (20 iterations is usually enough)
    for (let iter = 0; iter < 20; iter++) {
      // Compute X^T * X * pc
      const newPc = new Array(d).fill(0);
      
      // First: X * pc (project data onto pc)
      const scores = projectedData.map(row => 
        row.reduce((sum, val, j) => sum + val * pc[j], 0)
      );
      
      // Then: X^T * scores
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < d; j++) {
          newPc[j] += projectedData[i][j] * scores[i];
        }
      }
      
      // Normalize
      norm = Math.sqrt(newPc.reduce((sum, v) => sum + v * v, 0));
      if (norm > 0) {
        pc = newPc.map(v => v / norm);
      }
    }
    
    components.push(pc);
    
    // Deflate: remove this component from the data
    const scores = projectedData.map(row =>
      row.reduce((sum, val, j) => sum + val * pc[j], 0)
    );
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < d; j++) {
        projectedData[i][j] -= scores[i] * pc[j];
      }
    }
  }
  
  // 3. Project original centered data onto components
  const result = centered.map(row => {
    return components.map(pc =>
      row.reduce((sum, val, j) => sum + val * pc[j], 0)
    );
  });
  
  // 4. Scale to reasonable range [-10, 10]
  const maxAbs = result.reduce((max, row) => 
    Math.max(max, ...row.map(Math.abs)), 0.001
  );
  const scale = 10 / maxAbs;
  
  return result.map(row => row.map(v => v * scale));
}

function handleProject(msg: ProjectRequest): void {
  try {
    const { fileVectors, filePaths, config = {} } = msg;
    
    if (fileVectors.length !== filePaths.length) {
      throw new Error(`Mismatch: ${fileVectors.length} vectors vs ${filePaths.length} paths`);
    }
    
    if (fileVectors.length === 0) {
      sendResponse({ type: 'result', id: msg.id, projected: [] });
      return;
    }
    
    // Handle edge case: too few points
    if (fileVectors.length < 3) {
      const projected = filePaths.map((path, i) => ({
        path, x: i * 2, y: 0, z: 0
      }));
      sendResponse({ type: 'result', id: msg.id, projected });
      return;
    }
    
    const nComponents = config.nComponents ?? 3;
    
    // Run PCA - fast O(n*d*k) where k=3
    const embedding = simplePCA(fileVectors, nComponents);
    
    // Map results to file paths
    const projected = filePaths.map((path, idx) => ({
      path,
      x: embedding[idx][0],
      y: embedding[idx][1],
      z: embedding[idx][2] ?? 0
    }));
    
    sendResponse({ type: 'result', id: msg.id, projected });
    
  } catch (error) {
    sendResponse({
      type: 'error',
      id: msg.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function handleMessage(msg: WorkerMessage): void {
  switch (msg.type) {
    case 'project':
      handleProject(msg);
      break;
    default:
      sendResponse({
        type: 'error',
        id: (msg as { id?: string }).id ?? 'unknown',
        error: `Unknown message type: ${(msg as { type: string }).type}`
      });
  }
}

parentPort?.on('message', (msg: WorkerMessage) => {
  handleMessage(msg);
});
