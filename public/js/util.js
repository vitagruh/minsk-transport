export function debounce(fn, wait = 250) {
  let timer = null;
  const wrapped = (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

export function pollEvery(intervalMs, task) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    if (document.visibilityState !== 'visible') return;
    running = true;
    try {
      await task();
    } catch {
      // Задача сама отображает состояние ошибки.
    } finally {
      running = false;
    }
  }, Math.max(2000, intervalMs));
  return () => clearInterval(timer);
}

export async function mapLimit(items, limit, fn) {
  const list = [...items];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), list.length) }, async () => {
    while (cursor < list.length) {
      const index = cursor;
      cursor += 1;
      await fn(list[index], index);
    }
  });
  await Promise.all(workers);
}
