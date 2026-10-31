export class TtlCache {
  constructor() {
    this.items = new Map();
    this.flights = new Map();
  }

  entry(key) {
    const item = this.items.get(key);
    if (!item) return null;
    return { value: item.value, at: item.at, age: Date.now() - item.at };
  }

  set(key, value) {
    this.items.set(key, { value, at: Date.now() });
  }

  async wrap(key, ttlMs, fn) {
    const item = this.items.get(key);
    if (item && Date.now() - item.at < ttlMs) return item.value;
    const inFlight = this.flights.get(key);
    if (inFlight) return inFlight;
    const promise = (async () => {
      try {
        const value = await fn();
        this.set(key, value);
        return value;
      } finally {
        this.flights.delete(key);
      }
    })();
    this.flights.set(key, promise);
    return promise;
  }
}

export class Limiter {
  constructor(max = 2, minGapMs = 0) {
    this.max = max;
    this.minGapMs = minGapMs;
    this.active = 0;
    this.lastStart = 0;
    this.queue = [];
    this.timer = null;
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.#pump();
    });
  }

  #pump() {
    if (this.timer) return;
    if (this.active >= this.max || this.queue.length === 0) return;
    const wait = this.minGapMs - (Date.now() - this.lastStart);
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.#pump();
      }, wait);
      return;
    }
    const job = this.queue.shift();
    this.active += 1;
    this.lastStart = Date.now();
    Promise.resolve()
      .then(job.fn)
      .then(job.resolve, job.reject)
      .finally(() => {
        this.active -= 1;
        this.#pump();
      });
  }
}
