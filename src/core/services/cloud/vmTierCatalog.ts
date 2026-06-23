/**
 * Cloud VM performance tier catalog (Fly.io BYOK only).
 *
 * Three tiers per chief-designer directive (Standard / Faster / Heavy work).
 *
 * CRITICAL invariants:
 * - `standard` MUST equal current hardcoded provisioning config
 *   (cpu_kind: 'shared', cpus: 4, memory_mb: 4096) so existing users
 *   provisioned before this feature map cleanly to it. NO MEMORY
 *   REGRESSION.
 * - Pricing is illustrative monthly estimate based on Fly's per-second
 *   billing. Update when Fly pricing changes.
 *
 * @see docs/plans/260503_cloud_robustness_vm_tiers_and_data_hygiene.md
 */

export interface VmTier {
  id: 'standard' | 'faster' | 'heavy-work';
  label: string;
  description: string;
  cpuKind: 'shared' | 'performance';
  cpus: number;
  memoryMb: number;
  estimatedMonthlyCostUsd: number;
  workingRoom: 'Standard' | 'Double';
  speedRank: 1 | 2 | 3;
  isDefault?: boolean;
}

type VmTierBase = Omit<VmTier, 'workingRoom' | 'speedRank'>;

const FLY_VM_TIER_BASE_CATALOG = [
  {
    id: 'standard',
    label: 'Standard',
    description: 'Handles most workloads',
    cpuKind: 'shared',
    cpus: 4,
    memoryMb: 4096,
    estimatedMonthlyCostUsd: 12.77,
    isDefault: true,
  },
  {
    id: 'faster',
    label: 'Faster',
    description: 'Dedicated CPU, snappier responses',
    cpuKind: 'performance',
    cpus: 2,
    memoryMb: 4096,
    estimatedMonthlyCostUsd: 63.84,
    isDefault: false,
  },
  {
    id: 'heavy-work',
    label: 'Heavy work',
    description: 'For power users with heavy concurrent use',
    cpuKind: 'performance',
    cpus: 4,
    memoryMb: 8192,
    estimatedMonthlyCostUsd: 127.68,
    isDefault: false,
  },
] as const satisfies readonly VmTierBase[];

function deriveWorkingRoom(memoryMb: number): VmTier['workingRoom'] {
  if (memoryMb === 4096) return 'Standard';
  if (memoryMb === 8192) return 'Double';
  throw new Error(`Unsupported VM tier memory size for display labels: ${memoryMb}MB`);
}

function deriveSpeedRank(tier: VmTierBase): VmTier['speedRank'] {
  const sortedByCost = [...FLY_VM_TIER_BASE_CATALOG].sort(
    (left, right) => left.estimatedMonthlyCostUsd - right.estimatedMonthlyCostUsd,
  );
  const rank = sortedByCost.findIndex((candidate) => candidate.id === tier.id) + 1;
  if (rank !== 1 && rank !== 2 && rank !== 3) {
    throw new Error(`Unsupported VM tier speed rank for display labels: ${tier.id}`);
  }
  return rank;
}

export const FLY_VM_TIER_CATALOG: readonly VmTier[] = FLY_VM_TIER_BASE_CATALOG.map((tier) => ({
  ...tier,
  workingRoom: deriveWorkingRoom(tier.memoryMb),
  speedRank: deriveSpeedRank(tier),
}));

export function getDisplayLabels(tier: VmTier): Pick<VmTier, 'workingRoom' | 'speedRank'> {
  return {
    workingRoom: tier.workingRoom,
    speedRank: tier.speedRank,
  };
}

export function getTierById(id: string | undefined): VmTier | undefined {
  if (!id) return undefined;
  return FLY_VM_TIER_CATALOG.find((tier) => tier.id === id);
}

export function getDefaultTier(): VmTier {
  const defaultTier = FLY_VM_TIER_CATALOG.find((tier) => tier.isDefault);
  if (!defaultTier) {
    throw new Error('VM tier catalog is missing a default tier.');
  }
  return defaultTier;
}

/** Build the Fly machine guest config from a tier. */
export function toFlyGuestConfig(tier: VmTier): {
  cpu_kind: 'shared' | 'performance';
  cpus: number;
  memory_mb: number;
} {
  return {
    cpu_kind: tier.cpuKind,
    cpus: tier.cpus,
    memory_mb: tier.memoryMb,
  };
}

const CPU_KIND_RANK: Record<VmTier['cpuKind'], number> = {
  shared: 0,
  performance: 1,
};

function parseCpuKind(cpuKind: string | undefined): VmTier['cpuKind'] | undefined {
  if (cpuKind === 'shared' || cpuKind === 'performance') {
    return cpuKind;
  }
  return undefined;
}

/**
 * Map a Fly machine guest config to the highest catalog tier it fully dominates.
 *
 * Best-fit dominance (never overstates CPU/RAM). See docs/project/CLOUD_ARCHITECTURE.md
 * "VM tier detection — Intent & Design Rationale" before changing this metric or the
 * cloud-health memory budget that must use actual guest memory, not catalog memory.
 */
export function getTierFromGuest(guest: {
  cpuKind?: string;
  cpus?: number;
  memoryMb?: number;
}): VmTier | undefined {
  const cpuKind = parseCpuKind(guest.cpuKind);
  const cpus = guest.cpus;
  const memoryMb = guest.memoryMb;
  if (
    !cpuKind
    || typeof cpus !== 'number'
    || !Number.isFinite(cpus)
    || typeof memoryMb !== 'number'
    || !Number.isFinite(memoryMb)
  ) {
    return undefined;
  }

  const dominated = FLY_VM_TIER_CATALOG.filter(
    (tier) => (
      CPU_KIND_RANK[cpuKind] >= CPU_KIND_RANK[tier.cpuKind]
      && cpus >= tier.cpus
      && memoryMb >= tier.memoryMb
    ),
  );
  if (dominated.length === 0) {
    return undefined;
  }

  return dominated.reduce(
    (best, candidate) => (candidate.speedRank > best.speedRank ? candidate : best),
  );
}

export function summarizeTierMatch(
  tier: VmTier | undefined,
  raw: { cpuKind?: string; cpus?: number; memoryMb?: number },
): { state: 'exact' | 'approx' | 'none'; exceeds: Array<'cpus' | 'memoryMb'> } {
  if (!tier) {
    return { state: 'none', exceeds: [] };
  }

  const isExact = raw.cpuKind === tier.cpuKind && raw.cpus === tier.cpus && raw.memoryMb === tier.memoryMb;
  if (isExact) {
    return { state: 'exact', exceeds: [] };
  }

  const exceeds: Array<'cpus' | 'memoryMb'> = [];
  if (typeof raw.cpus === 'number' && raw.cpus > tier.cpus) {
    exceeds.push('cpus');
  }
  if (typeof raw.memoryMb === 'number' && raw.memoryMb > tier.memoryMb) {
    exceeds.push('memoryMb');
  }
  return { state: 'approx', exceeds };
}
