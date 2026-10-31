import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanName } from './normalize.js';

const TRANSPORT_TYPES = ['bus', 'trolleybus', 'tram'];

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const radius = 6371000;
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(a));
}

function publicStop(stop, distance = null) {
  const result = {
    id: stop.id,
    name: stop.name,
    lat: stop.lat,
    lon: stop.lon,
    bearing: stop.bearing,
    routes: stop.routes
  };
  if (distance != null) result.distance = Math.round(distance);
  return result;
}

export class StopDirectory {
  constructor(client, filePath) {
    this.client = client;
    this.filePath = filePath;
    this.stops = new Map();
    this.searchIndex = new Map();
    this.routeKeys = new Set();
    this.builtAt = 0;
    this.building = null;
    this.lastError = null;
    this.progress = { total: 0, done: 0, failed: 0, startedAt: null };
  }

  get ready() {
    return this.stops.size > 0;
  }

  get info() {
    return {
      ready: this.ready,
      stops: this.stops.size,
      routes: this.routeKeys.size,
      builtAt: this.builtAt || null,
      building: Boolean(this.building),
      progress: { ...this.progress },
      lastError: this.lastError
    };
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (!Array.isArray(raw?.stops)) return;
      const stops = new Map();
      const routeKeys = new Set();
      for (const stop of raw.stops) {
        if (!Number.isFinite(Number(stop.id))) continue;
        stops.set(String(stop.id), stop);
        for (const route of stop.routes || []) routeKeys.add(`${route.tt}:${route.number}`);
      }
      this.stops = stops;
      this.routeKeys = routeKeys;
      this.builtAt = Number(raw.builtAt) || 0;
      this.searchIndex = new Map(
        [...stops.values()].map((stop) => [String(stop.id), normalizeText(stop.name)])
      );
    } catch {
      // Первый запуск: кэша справочника ещё нет.
    }
  }

  byId(id) {
    return this.stops.get(String(id)) || null;
  }

  search(query, limit = 20) {
    const needle = normalizeText(query);
    if (needle.length < 2) return [];
    const starts = [];
    const contains = [];
    for (const stop of this.stops.values()) {
      const haystack = this.searchIndex.get(String(stop.id)) || '';
      const index = haystack.indexOf(needle);
      if (index < 0) continue;
      (index === 0 ? starts : contains).push(publicStop(stop));
      if (starts.length >= limit * 2 && contains.length >= limit * 2) break;
    }
    const compare = (a, b) =>
      b.routes.length - a.routes.length || a.name.localeCompare(b.name, 'ru');
    starts.sort(compare);
    contains.sort(compare);
    return [...starts, ...contains].slice(0, limit);
  }

  near(lat, lon, { limit = 50, radius = 1500 } = {}) {
    const within = [];
    const all = [];
    for (const stop of this.stops.values()) {
      if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) continue;
      const distance = distanceMeters(lat, lon, stop.lat, stop.lon);
      const item = { stop, distance };
      all.push(item);
      if (distance <= radius) within.push(item);
    }
    const pool = within.length ? within : all;
    pool.sort((a, b) => a.distance - b.distance);
    return pool.slice(0, limit).map(({ stop, distance }) => publicStop(stop, distance));
  }

  async ensureFresh(maxAgeMs) {
    if (this.building) return this.building;
    if (this.ready && Date.now() - this.builtAt < maxAgeMs) return null;
    return this.rebuild();
  }

  rebuild() {
    if (this.building) return this.building;
    this.building = this.#build()
      .catch((error) => {
        this.lastError = error.message;
        this.progress.error = error.message;
        throw error;
      })
      .finally(() => {
        this.building = null;
      });
    return this.building;
  }

  async #build() {
    this.lastError = null;
    this.progress = { total: 0, done: 0, failed: 0, startedAt: Date.now() };

    const lists = await Promise.allSettled(
      TRANSPORT_TYPES.map((type) => this.client.routeList(type))
    );
    const jobs = [];
    lists.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      const type = TRANSPORT_TYPES[index];
      for (const route of result.value?.Routes || []) {
        const number = String(route.Number ?? '').trim();
        if (number) jobs.push({ type, number });
      }
    });
    if (!jobs.length) {
      throw new Error('Минсктранс не вернул список маршрутов');
    }

    this.progress.total = jobs.length;
    const stops = new Map();
    const routeKeys = new Set(jobs.map((job) => `${job.type}:${job.number}`));
    let cursor = 0;

    const worker = async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor];
        cursor += 1;
        try {
          const data = await this.client.route(job.type, job.number);
          const trips = data?.Trips;
          if (trips) {
            this.#addStops(stops, trips.StopsA, trips.StopNamesA, job);
            this.#addStops(stops, trips.StopsB, trips.StopNamesB, job);
          }
        } catch {
          this.progress.failed += 1;
        } finally {
          this.progress.done += 1;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));

    if (!stops.size) {
      throw new Error('Не удалось собрать справочник остановок');
    }

    const serialized = {
      version: 1,
      builtAt: Date.now(),
      partial: this.progress.failed > 0,
      stops: [...stops.values()]
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(serialized));

    this.stops = stops;
    this.routeKeys = routeKeys;
    this.builtAt = serialized.builtAt;
    this.searchIndex = new Map(
      [...stops.values()].map((stop) => [String(stop.id), normalizeText(stop.name)])
    );
    return serialized;
  }

  #addStops(map, rawStops, names, job) {
    if (!Array.isArray(rawStops)) return;
    rawStops.forEach((rawStop, index) => {
      const id = Number(rawStop?.Id);
      if (!Number.isFinite(id)) return;
      const lat = Number(rawStop.Latitude);
      const lon = Number(rawStop.Longitude);
      const bearing = Number(rawStop.Bearing);
      const name = cleanName(names?.[index]);
      const key = String(id);
      let stop = map.get(key);
      if (!stop) {
        stop = {
          id,
          name,
          lat: Number.isFinite(lat) ? lat : null,
          lon: Number.isFinite(lon) ? lon : null,
          bearing: Number.isFinite(bearing) && bearing >= 0 ? bearing : null,
          routes: []
        };
        map.set(key, stop);
      } else {
        if (!stop.name && name) stop.name = name;
        if (stop.lat == null && Number.isFinite(lat)) stop.lat = lat;
        if (stop.lon == null && Number.isFinite(lon)) stop.lon = lon;
      }
      if (!stop.routes.some((route) => route.tt === job.type && route.number === job.number)) {
        stop.routes.push({ tt: job.type, number: job.number });
      }
    });
  }
}
