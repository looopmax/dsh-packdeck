// Tiny TTL cache. Snapshot is cached per manager for 60 s (CONTRACT §7.2 / design note),
// detection for 60 s, check-updates for 5 min, and any successful mutation drops the
// affected manager's entries.

const store = new Map(); // key -> { value, expiresAt }

export const TTL = {
  snapshot: 60_000,
  detection: 60_000,
  checkUpdates: 5 * 60_000,
  root: 60_000,
  registry: 10 * 60_000,
};

export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

export function cacheSet(key, value, ttlMs) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

export function cacheDrop(key) {
  store.delete(key);
}

/** Remove every entry whose key starts with `prefix`. */
export function cacheDropPrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** Forget everything cached for one manager (called after a successful mutation). */
export function invalidateManager(manager) {
  cacheDropPrefix(`snapshot:${manager}`);
  cacheDropPrefix(`updates:${manager}`);
  cacheDrop(`root:${manager}`);
}
