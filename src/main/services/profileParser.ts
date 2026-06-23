import path from 'node:path';

export const MAX_SUMMARY_TOP_N = 30; // top N functions in summary

export interface CpuProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    scriptId: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  hitCount?: number;
  children?: number[];
}

export interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

export interface FunctionSummary {
  functionName: string;
  url: string;
  lineNumber: number;
  selfTimeUs: number;
  selfTimePercent: number;
  sampleCount: number;
}

export interface ProfileSummary {
  timestamp: string;
  durationMs: number;
  totalSamples: number;
  idlePercent: number;
  gcPercent: number;
  appCpuPercent: number;
  topFunctions: FunctionSummary[];
  topStacks: { selfTimeUs: number; stack: string[] }[];
  profileFile: string;
}

/**
 * Parse a .cpuprofile and compute self-time per function.
 *
 * Self-time is calculated from the samples + timeDeltas arrays:
 * each sample points to a node ID, and the corresponding timeDelta
 * tells us how long that node was the leaf (= self time).
 */
export function parseProfile(profile: CpuProfile): ProfileSummary {
  const nodeMap = new Map<number, CpuProfileNode>();
  for (const node of profile.nodes) {
    nodeMap.set(node.id, node);
  }

  // Accumulate self-time per node ID from samples + timeDeltas
  const selfTimeByNodeId = new Map<number, number>();
  const totalDurationUs = profile.endTime - profile.startTime;

  for (let i = 0; i < profile.samples.length; i++) {
    const nodeId = profile.samples[i];
    const delta = profile.timeDeltas[i] ?? 0;
    selfTimeByNodeId.set(nodeId, (selfTimeByNodeId.get(nodeId) ?? 0) + delta);
  }

  // Aggregate by callFrame identity (functionName + url + lineNumber)
  const byFunction = new Map<string, FunctionSummary>();
  let idleTimeUs = 0;
  let gcTimeUs = 0;

  for (const [nodeId, selfTimeUs] of selfTimeByNodeId) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;

    const { functionName, url, lineNumber } = node.callFrame;

    // Track synthetic frames separately
    if (functionName === '(idle)') {
      idleTimeUs += selfTimeUs;
      continue;
    }
    if (functionName === '(garbage collector)') {
      gcTimeUs += selfTimeUs;
      continue;
    }
    if (functionName === '(root)' || functionName === '(program)') {
      continue;
    }

    const key = `${functionName}|${url}|${lineNumber}`;
    const existing = byFunction.get(key);
    if (existing) {
      existing.selfTimeUs += selfTimeUs;
      existing.sampleCount++;
    } else {
      byFunction.set(key, {
        functionName: functionName || '(anonymous)',
        url,
        lineNumber,
        selfTimeUs,
        selfTimePercent: 0, // filled below
        sampleCount: 1,
      });
    }
  }

  // Sort by self-time descending
  const sorted = [...byFunction.values()].sort((a, b) => b.selfTimeUs - a.selfTimeUs);
  for (const fn of sorted) {
    fn.selfTimePercent = totalDurationUs > 0
      ? Math.round((fn.selfTimeUs / totalDurationUs) * 10000) / 100
      : 0;
  }

  // Build top stacks (representative hot call chains)
  const topStacks: { selfTimeUs: number; stack: string[] }[] = [];
  const topNodes = [...selfTimeByNodeId.entries()]
    .filter(([id]) => {
      const n = nodeMap.get(id);
      return n && !['(idle)', '(root)', '(program)', '(garbage collector)'].includes(n.callFrame.functionName);
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  for (const [nodeId, selfTimeUs] of topNodes) {
    const stack: string[] = [];
    let current = nodeMap.get(nodeId);
    // Walk up via parent lookup (build parent map from children)
    const parentMap = new Map<number, number>();
    for (const node of profile.nodes) {
      if (node.children) {
        for (const childId of node.children) {
          parentMap.set(childId, node.id);
        }
      }
    }
    while (current) {
      const { functionName, url, lineNumber } = current.callFrame;
      if (functionName && functionName !== '(root)') {
        const loc = url ? `${path.basename(url)}:${lineNumber}` : '';
        stack.push(loc ? `${functionName} (${loc})` : functionName);
      }
      const parentId = parentMap.get(current.id);
      current = parentId !== undefined ? nodeMap.get(parentId) : undefined;
    }
    topStacks.push({ selfTimeUs, stack });
  }

  const appTimeUs = totalDurationUs - idleTimeUs;

  return {
    timestamp: new Date().toISOString(),
    durationMs: Math.round(totalDurationUs / 1000),
    totalSamples: profile.samples.length,
    idlePercent: totalDurationUs > 0 ? Math.round((idleTimeUs / totalDurationUs) * 10000) / 100 : 0,
    gcPercent: totalDurationUs > 0 ? Math.round((gcTimeUs / totalDurationUs) * 10000) / 100 : 0,
    appCpuPercent: totalDurationUs > 0 ? Math.round((appTimeUs / totalDurationUs) * 10000) / 100 : 0,
    topFunctions: sorted.slice(0, MAX_SUMMARY_TOP_N),
    topStacks,
    profileFile: '',
  };
}
