/**
 * Result bookkeeping for settled subagents.
 *
 * Results are steered into the parent's running turn as soon as they settle,
 * so `pending` is only a retry buffer for deliveries the session refused
 * (shutdown, transient send failure); `agent_settled` flushes it.
 *
 * `delivered` records ids whose output already reached the parent's context.
 * A later subagent_wait uses it to point at that message instead of repeating
 * the whole output, and a restart via subagent_send clears the mark.
 */

/** Ids remembered for the "already delivered" check. Well past MAX_TRACKED. */
const DELIVERED_HISTORY_LIMIT = 256;

export function createDeferredResultDelivery<T extends { id: string }>() {
  const pending = new Map<string, T>();
  const delivered = new Set<string>();

  return {
    defer(result: T) {
      pending.set(result.id, result);
    },
    consume(ids: Iterable<string>) {
      for (const id of ids) pending.delete(id);
    },
    drain() {
      const results = [...pending.values()];
      pending.clear();
      return results;
    },
    /** Record that this result's output is now in the parent's context. */
    markDelivered(id: string) {
      // Re-insert so the id counts as most recent for eviction.
      delivered.delete(id);
      delivered.add(id);
      if (delivered.size > DELIVERED_HISTORY_LIMIT) {
        const oldest = delivered.values().next();
        if (!oldest.done) delivered.delete(oldest.value);
      }
    },
    wasDelivered(id: string) {
      return delivered.has(id);
    },
    /** A restarted subagent produces a fresh result; drop the stale record. */
    forget(id: string) {
      pending.delete(id);
      delivered.delete(id);
    },
    clear() {
      pending.clear();
      delivered.clear();
    },
  };
}
