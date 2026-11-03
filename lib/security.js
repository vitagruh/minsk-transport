const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function canonicalStopId(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,12}$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

export function isSameOriginRequest(req) {
  const origin = req.headers?.origin;
  if (origin) {
    try {
      return new URL(origin).host === req.headers?.host;
    } catch {
      return false;
    }
  }
  const site = req.headers?.['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  return LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress);
}

export function getClientIp(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const header = req.headers?.['x-forwarded-for'];
    const first = (Array.isArray(header) ? header[0] : String(header ?? ''))
      .split(',')[0]
      .trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || 'unknown';
}

export class RateLimiter {
  constructor({ ratePerSec = 10, burst = 120, maxEntries = 10_000, idleMs = 10 * 60_000 } = {}) {
    this.ratePerSec = Math.max(0.1, Number(ratePerSec) || 10);
    this.burst = Math.max(1, Math.floor(Number(burst) || 120));
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries) || 10_000));
    this.idleMs = Math.max(60_000, Number(idleMs) || 600_000);
    this.buckets = new Map();
    this.lastPruneAt = 0;
  }

  take(key, now = Date.now()) {
    this.#prune(now);
    const id = String(key || 'unknown');
    let bucket = this.buckets.get(id);
    if (!bucket) {
      bucket = { tokens: this.burst, at: now };
      this.buckets.set(id, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.at) / 1000;
      bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.ratePerSec);
      bucket.at = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSec: 0 };
    }
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((1 - bucket.tokens) / this.ratePerSec))
    };
  }

  #prune(now) {
    if (now - this.lastPruneAt < 60_000 && this.buckets.size <= this.maxEntries) return;
    this.lastPruneAt = now;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at >= this.idleMs) this.buckets.delete(key);
    }
    while (this.buckets.size > this.maxEntries) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}
