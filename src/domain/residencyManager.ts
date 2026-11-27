export type ResidencyPoolId = 'cpu-volumes' | 'source-frames' | 'gpu-slices' | 'gpu-3d';
type ResidencyDomain = 'cpu' | 'gpu';

type MemoryPressureLevel = 'normal' | 'moderate' | 'critical';

interface ResidencyBudgets {
  cpuBudgetBytes?: number;
  gpuBudgetBytes?: number;
}

interface ResidencyPool {
  id: ResidencyPoolId;
  /** Soft per-pool budget in bytes. */
  budgetBytes: number;
  /** Higher priority pools are evicted after lower priority pools within their domain and under global pressure. */
  priority?: number;
  /** Current bytes held by this pool (pinned and unpinned combined). */
  bytes: () => number;
  /** Evicts unpinned entries down to at most `targetBytes` and returns the bytes actually freed. */
  evict: (targetBytes: number) => number;
}

interface PoolSnapshot {
  id: ResidencyPoolId;
  domain: ResidencyDomain;
  usedBytes: number;
  pinnedBytes: number;
  budgetBytes: number;
}

interface ResidencySnapshot {
  cpuBudgetBytes: number;
  gpuBudgetBytes: number;
  cpuUsedBytes: number;
  gpuUsedBytes: number;
  totalUsedBytes: number;
  totalPinnedBytes: number;
  pressureLevel: MemoryPressureLevel;
  pools: PoolSnapshot[];
}

const DEFAULT_CPU_BUDGET_BYTES = 1536 * 1024 * 1024;
const DEFAULT_GPU_BUDGET_BYTES = 1024 * 1024 * 1024;

function domainOf(poolId: ResidencyPoolId): ResidencyDomain {
  return poolId === 'gpu-slices' || poolId === 'gpu-3d' ? 'gpu' : 'cpu';
}

/**
 * Coordinates CPU (decoded volumes and source frames) and GPU (2D/MPR slice and 3D volume textures) caches
 * under separate domain working-set budgets so GPU uploads never evict cached CPU volumes.
 * Pinned entries (currently visible viewports and active operations) are protected from eviction.
 */
export class ResidencyManager {
  private readonly pools = new Map<ResidencyPoolId, ResidencyPool>();
  private readonly pins = new Map<ResidencyPoolId, Map<string, number>>();
  private readonly budgets: Record<ResidencyDomain, number>;
  private pressure: MemoryPressureLevel = 'normal';

  constructor(budgets: ResidencyBudgets = {}) {
    const cpu = budgets.cpuBudgetBytes ?? DEFAULT_CPU_BUDGET_BYTES;
    const gpu = budgets.gpuBudgetBytes ?? DEFAULT_GPU_BUDGET_BYTES;
    if (!Number.isFinite(cpu) || cpu <= 0 || !Number.isFinite(gpu) || gpu <= 0) {
      throw new Error('Residency budgets must be positive finite numbers.');
    }
    this.budgets = { cpu, gpu };
  }

  registerPool(pool: ResidencyPool): () => void {
    this.pools.set(pool.id, pool);
    if (!this.pins.has(pool.id)) this.pins.set(pool.id, new Map());
    return () => {
      if (this.pools.get(pool.id) === pool) this.unregisterPool(pool.id);
    };
  }

  unregisterPool(id: ResidencyPoolId): void {
    this.pools.delete(id);
    this.pins.delete(id);
  }

  pin(poolId: ResidencyPoolId, key: string, bytes: number): void {
    let entries = this.pins.get(poolId);
    if (!entries) {
      entries = new Map();
      this.pins.set(poolId, entries);
    }
    entries.set(key, Math.max(0, bytes));
  }

  clearPins(poolId: ResidencyPoolId): void {
    this.pins.get(poolId)?.clear();
  }

  pinnedBytes(poolId?: ResidencyPoolId): number {
    if (poolId !== undefined) {
      const entries = this.pins.get(poolId);
      if (!entries) return 0;
      let sum = 0;
      for (const value of entries.values()) sum += value;
      return sum;
    }
    let total = 0;
    for (const entries of this.pins.values()) {
      for (const value of entries.values()) total += value;
    }
    return total;
  }

  domainUsedBytes(domain: ResidencyDomain): number {
    let total = 0;
    for (const pool of this.pools.values()) {
      if (domainOf(pool.id) === domain) total += Math.max(0, pool.bytes());
    }
    return total;
  }

  totalUsedBytes(): number {
    let total = 0;
    for (const pool of this.pools.values()) total += Math.max(0, pool.bytes());
    return total;
  }

  /**
   * Frees lower-priority unpinned cache entries within the requesting pool's own memory domain (CPU or GPU)
   * until `additionalBytes` fits inside that domain's budget, without dropping any pool below its pinned bytes.
   */
  requestSpace(requestingPool: ResidencyPoolId, additionalBytes: number): { granted: boolean; freedBytes: number } {
    const needed = Math.max(0, additionalBytes);
    const domain = domainOf(requestingPool);
    const budget = this.budgets[domain];
    const current = this.domainUsedBytes(domain);
    if (current + needed <= budget) return { granted: true, freedBytes: 0 };

    let deficit = current + needed - budget;
    let freedBytes = 0;
    const ordered = [...this.pools.values()]
      .filter(pool => domainOf(pool.id) === domain)
      .sort((a, b) => {
        const byPriority = (a.priority ?? 0) - (b.priority ?? 0);
        if (byPriority !== 0) return byPriority;
        const aSelf = a.id === requestingPool ? 1 : 0;
        const bSelf = b.id === requestingPool ? 1 : 0;
        return aSelf - bSelf;
      });

    for (const pool of ordered) {
      if (deficit <= 0) break;
      const used = Math.max(0, pool.bytes());
      const floor = this.pinnedBytes(pool.id);
      const evictable = Math.max(0, used - floor);
      if (evictable === 0) continue;
      const target = Math.max(floor, used - deficit);
      const freed = Math.max(0, pool.evict(target));
      freedBytes += freed;
      deficit -= freed;
    }

    return {
      granted: this.domainUsedBytes(domain) + needed <= budget,
      freedBytes,
    };
  }

  /** Responds to OS/renderer memory pressure by trimming unpinned cache entries across both CPU and GPU domains. */
  handleMemoryPressure(level: Exclude<MemoryPressureLevel, 'normal'>): number {
    this.pressure = level;
    const ordered = [...this.pools.values()].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    let freedBytes = 0;

    if (level === 'critical') {
      for (const pool of ordered) {
        const floor = this.pinnedBytes(pool.id);
        freedBytes += Math.max(0, pool.evict(floor));
      }
      return freedBytes;
    }

    for (const domain of ['cpu', 'gpu'] as const) {
      const goal = Math.floor(this.budgets[domain] * 0.5);
      let excess = Math.max(0, this.domainUsedBytes(domain) - goal);
      for (const pool of ordered) {
        if (excess <= 0) break;
        if (domainOf(pool.id) !== domain) continue;
        const used = Math.max(0, pool.bytes());
        const floor = this.pinnedBytes(pool.id);
        const evictable = Math.max(0, used - floor);
        if (evictable === 0) continue;
        const target = Math.max(floor, used - excess);
        const freed = Math.max(0, pool.evict(target));
        freedBytes += freed;
        excess -= freed;
      }
    }
    return freedBytes;
  }

  clearPressure(): void {
    this.pressure = 'normal';
  }

  snapshot(): ResidencySnapshot {
    const pools: PoolSnapshot[] = [];
    let cpuUsedBytes = 0;
    let gpuUsedBytes = 0;
    let totalPinnedBytes = 0;
    for (const pool of this.pools.values()) {
      const domain = domainOf(pool.id);
      const usedBytes = Math.max(0, pool.bytes());
      const pinned = this.pinnedBytes(pool.id);
      if (domain === 'cpu') cpuUsedBytes += usedBytes;
      else gpuUsedBytes += usedBytes;
      totalPinnedBytes += pinned;
      pools.push({ id: pool.id, domain, usedBytes, pinnedBytes: pinned, budgetBytes: pool.budgetBytes });
    }
    return {
      cpuBudgetBytes: this.budgets.cpu,
      gpuBudgetBytes: this.budgets.gpu,
      cpuUsedBytes,
      gpuUsedBytes,
      totalUsedBytes: cpuUsedBytes + gpuUsedBytes,
      totalPinnedBytes,
      pressureLevel: this.pressure,
      pools,
    };
  }
}

export const residencyManager = new ResidencyManager();
