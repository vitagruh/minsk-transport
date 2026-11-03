export class OverloadError extends Error {
  constructor(message = 'Сервер перегружен') {
    super(message);
    this.name = 'OverloadError';
    this.code = 'overloaded';
  }
}

export class TtlCache {
  constructor({ maxEntries = 2000, maxFlights = 256 } = {}) {
    this.items = new Map();
    this.flights = new Map();
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries) || 2000));
    this.maxFlights = Math.max(1, Math.floor(Number(maxFlights) || 256));
  }

  entry(key) {
    const item = this.items.get(key);
    if (!item) return null;
    return { value: item.value, at: item.at, age: Date.now() - item.at };
  }

  set(key, value) {
    this.items.delete(key);
    if (this.items.size >= this.maxEntries) {
      const oldest = this.items.keys().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
    this.items.set(key, { value, at: Date.now() });
  }

  async wrap(key, ttlMs, fn) {
    const item = this.items.get(key);
    if (item && Date.now() - item.at < ttlMs) return item.value;
    const inFlight = this.flights.get(key);
    if (inFlight) return inFlight;
    if (this.flights.size >= this.maxFlights) {
      throw new OverloadError('Слишком много одновременных запросов к источнику');
    }
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
  constructor(max = 2, minGapMs = 0, maxQueue = 500) {
    this.max = max;
    this.minGapMs = minGapMs;
    this.maxQueue = Math.max(1, Math.floor(Number(maxQueue) || 500));
    this.active = 0;
    this.lastStart = 0;
    this.queue = [];
    this.timer = null;
  }

  run(fn) {
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new OverloadError('Очередь запросов к источнику заполнена'));
    }
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
