export type ResidencyPoolId = 'cpu-volumes' | 'source-frames' | 'gpu-slices' | 'gpu-3d';

export type MemoryPressureLevel = 'normal' | 'moderate' | 'critical';

export interface ResidencyPool {
  id: ResidencyPoolId;
  /** Soft per-pool budget in bytes. */
  budgetBytes: number;
  /** Higher priority pools are evicted after lower priority pools under global pressure. */
  priority?: number;
  /** Current bytes held by this pool (pinned and unpinned combined). */
  bytes: () => number;
  /** Evicts unpinned entries down to at most `targetBytes` and returns the bytes actually freed. */
  evict: (targetBytes: number) => number;
}

export interface PoolSnapshot {
  id: ResidencyPoolId;
  usedBytes: number;
  pinnedBytes: number;
  budgetBytes: number;
}

export interface ResidencySnapshot {
  globalBudgetBytes: number;
  totalUsedBytes: number;
  totalPinnedBytes: number;
  pressureLevel: MemoryPressureLevel;
  pools: PoolSnapshot[];
}

export const DEFAULT_GLOBAL_BUDGET_BYTES = 1536 * 1024 * 1024;

/**
 * Coordinates CPU volume, source-frame, 2D/MPR GPU, and 3D GPU caches under one global working-set budget.
 * Pinned entries (currently visible viewports and active operations) are protected from eviction.
 */
export class ResidencyManager {
  private readonly pools = new Map<ResidencyPoolId, ResidencyPool>();
  private readonly pins = new Map<ResidencyPoolId, Map<string, number>>();
  private globalBudget: number;
  private pressure: MemoryPressureLevel = 'normal';

  constructor(globalBudgetBytes = DEFAULT_GLOBAL_BUDGET_BYTES) {
    if (!Number.isFinite(globalBudgetBytes) || globalBudgetBytes <= 0) {
      throw new Error('Global residency budget must be a positive finite number.');
    }
    this.globalBudget = globalBudgetBytes;
  }

  get globalBudgetBytes(): number {
    return this.globalBudget;
  }

  setGlobalBudget(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      throw new Error('Global residency budget must be a positive finite number.');
    }
    this.globalBudget = bytes;
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

  unpin(poolId: ResidencyPoolId, key: string): void {
    this.pins.get(poolId)?.delete(key);
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

  totalUsedBytes(): number {
    let total = 0;
    for (const pool of this.pools.values()) total += Math.max(0, pool.bytes());
    return total;
  }

  /**
   * Frees lower-priority unpinned cache entries until `additionalBytes` fits inside the global budget,
   * without dropping any pool below its pinned bytes.
   */
  requestSpace(requestingPool: ResidencyPoolId, additionalBytes: number): { granted: boolean; freedBytes: number } {
    const needed = Math.max(0, additionalBytes);
    const current = this.totalUsedBytes();
    if (current + needed <= this.globalBudget) return { granted: true, freedBytes: 0 };

    let deficit = current + needed - this.globalBudget;
    let freedBytes = 0;
    const ordered = [...this.pools.values()].sort((a, b) => {
      const aSelf = a.id === requestingPool ? 1 : 0;
      const bSelf = b.id === requestingPool ? 1 : 0;
      return aSelf - bSelf || (a.priority ?? 0) - (b.priority ?? 0);
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
      granted: this.totalUsedBytes() + needed <= this.globalBudget,
      freedBytes,
    };
  }

  /** Responds to OS/renderer memory pressure by trimming unpinned cache entries across all pools. */
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

    const goal = Math.floor(this.globalBudget * 0.5);
    let excess = Math.max(0, this.totalUsedBytes() - goal);
    for (const pool of ordered) {
      if (excess <= 0) break;
      const used = Math.max(0, pool.bytes());
      const floor = this.pinnedBytes(pool.id);
      const evictable = Math.max(0, used - floor);
      if (evictable === 0) continue;
      const target = Math.max(floor, used - excess);
      const freed = Math.max(0, pool.evict(target));
      freedBytes += freed;
      excess -= freed;
    }
    return freedBytes;
  }

  clearPressure(): void {
    this.pressure = 'normal';
  }

  snapshot(): ResidencySnapshot {
    const pools: PoolSnapshot[] = [];
    let totalUsedBytes = 0;
    let totalPinnedBytes = 0;
    for (const pool of this.pools.values()) {
      const usedBytes = Math.max(0, pool.bytes());
      const pinned = this.pinnedBytes(pool.id);
      totalUsedBytes += usedBytes;
      totalPinnedBytes += pinned;
      pools.push({ id: pool.id, usedBytes, pinnedBytes: pinned, budgetBytes: pool.budgetBytes });
    }
    return {
      globalBudgetBytes: this.globalBudget,
      totalUsedBytes,
      totalPinnedBytes,
      pressureLevel: this.pressure,
      pools,
    };
  }
}

export const residencyManager = new ResidencyManager();
