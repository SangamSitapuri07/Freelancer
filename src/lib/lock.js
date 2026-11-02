const locks = new Map();

export function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  const next = previous.then(() => fn());
  locks.set(
    key,
    next.catch(() => {}),
  );
  return next;
}
