// compute-pool.ts — Scatter/gather dispatch to a pool of worker DOs
//
// The network is the computer: each DO is a compute unit with ~128MB memory.
// By fanning out work across a pool of DOs via RPC, we turn Cloudflare's
// edge network into a distributed compute cluster.
//
// Pool sizing is dynamic: slots scale with the number of batches, capped
// by a configurable maximum. A 3-file diff uses 1 slot; a 10K-file clone
// uses up to the cap. Deployers tune the cap via POOL_MAX_SLOTS env var.
//
// Pool slots use deterministic IDs (`slot-{N}`) for warm reuse across requests.

/** Default max pool slots. Overridable via POOL_MAX_SLOTS env var. */
const DEFAULT_MAX_SLOTS = 20;

/** Absolute ceiling — even if configured higher, never exceed this. */
const HARD_MAX_SLOTS = 100;

export interface PoolConfig {
  /** Maximum number of concurrent worker slots. Defaults to 20. */
  maxSlots?: number;
}

export interface PoolTask<T> {
  /** Index into the pool (round-robin assigned). */
  slotIndex: number;
  /** Payload to send to the worker. */
  payload: T;
}

/**
 * Resolve the effective pool size cap from config or env var.
 */
export function resolveMaxSlots(envValue?: string, configOverride?: number): number {
  if (configOverride !== undefined) {
    return Math.max(1, Math.min(configOverride, HARD_MAX_SLOTS));
  }
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return Math.min(parsed, HARD_MAX_SLOTS);
    }
  }
  return DEFAULT_MAX_SLOTS;
}

/**
 * Dispatch tasks to a pool of worker DOs, gather results.
 *
 * Only as many slots are used as there are tasks — a 3-task dispatch
 * uses 3 slots, not 20. The pool scales up to maxSlots then wraps
 * round-robin so multiple batches share a slot.
 *
 * If any task fails, the entire dispatch throws (no partial results).
 *
 * @param pool - The DurableObjectNamespace for worker DOs
 * @param tasks - Array of { slotIndex, payload } to dispatch
 * @param send - Function that sends a payload to a worker DO and returns a result
 * @returns Array of results in the same order as tasks
 */
export async function dispatchToPool<T, R>(
  pool: DurableObjectNamespace,
  tasks: PoolTask<T>[],
  send: (worker: Fetcher, payload: T) => Promise<R>,
): Promise<R[]> {
  const results = await Promise.allSettled(
    tasks.map(async ({ slotIndex, payload }) => {
      const id = pool.idFromName(`slot-${slotIndex}`);
      const worker = pool.get(id);
      return send(worker, payload);
    })
  );

  // Fail-fast: don't return partial results
  const values: R[] = [];
  const failures: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      values.push(r.value);
    } else {
      failures.push(`task ${i}: ${r.reason}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Pool dispatch failed: ${failures.join("; ")}`);
  }
  return values;
}

/**
 * Split items into batches, assign round-robin to pool slots.
 *
 * Pool size scales with the number of batches:
 *   - 3 batches → 3 slots (each gets its own worker)
 *   - 50 batches, maxSlots=20 → 20 slots (round-robin wraps)
 *
 * @param items - Items to batch
 * @param batchSize - Max items per batch
 * @param maxSlots - Cap on pool slots (from resolveMaxSlots)
 */
export function batchForPool<T>(items: T[], batchSize: number, maxSlots = DEFAULT_MAX_SLOTS): PoolTask<T[]>[] {
  const tasks: PoolTask<T[]>[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    tasks.push({
      slotIndex: tasks.length % maxSlots,
      payload: items.slice(i, i + batchSize),
    });
  }
  return tasks;
}
