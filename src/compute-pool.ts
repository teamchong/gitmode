// compute-pool.ts — Scatter/gather dispatch to a pool of worker DOs
//
// The network is the computer: each DO is a compute unit with ~128MB memory.
// By fanning out work across a pool of DOs via RPC, we turn Cloudflare's
// edge network into a distributed compute cluster.
//
// The coordinator (RepoStore) dispatches tasks; workers execute independently
// and return results. Each worker has its own R2 access, WASM instance, and
// memory budget — so the total capacity scales with pool size, not single-DO limits.
//
// Pool slots use deterministic IDs (`slot-{N}`) for warm reuse across requests.

/** Maximum concurrent worker slots. */
const POOL_SIZE = 20;

export interface PoolTask<T> {
  /** Index into the pool (round-robin assigned). */
  slotIndex: number;
  /** Payload to send to the worker. */
  payload: T;
}

export interface PoolResult<R> {
  /** The gathered result from the worker. */
  value: R;
}

/**
 * Dispatch tasks to a pool of worker DOs, gather results.
 *
 * Tasks are assigned to pool slots round-robin. Each slot gets a deterministic
 * DO ID for warm reuse. If any task fails, the entire dispatch throws.
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
 */
export function batchForPool<T>(items: T[], batchSize: number): PoolTask<T[]>[] {
  const tasks: PoolTask<T[]>[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    tasks.push({
      slotIndex: tasks.length % POOL_SIZE,
      payload: items.slice(i, i + batchSize),
    });
  }
  return tasks;
}
