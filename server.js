import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MinsktransClient, UpstreamError } from './lib/minsktrans.js';
import { StopDirectory } from './lib/directory.js';
import { TtlCache } from './lib/cache.js';
import {
  cleanName,
  normalizeSchedule,
  normalizeScoreboard,
  normalizeVehicles
} from './lib/normalize.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const SCOREBOARD_TTL_MS = 10_000;
const SCHEDULE_TTL_MS = 5 * 60_000;
const VEHICLES_TTL_MS = 10_000;
const NEAREST_TTL_MS = 30_000;
const DIRECTORY_MAX_AGE_MS = 12 * 60 * 60_000;
const BUILD_RETRY_MS = 5 * 60_000;
const TRANSPORT_TYPES = new Set(['bus', 'trolleybus', 'tram']);
const FAVORITE_STOPS_MAX = 25;
const FAVORITE_ROUTES_MAX = 20;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://unpkg.com",
  "img-src 'self' data: blob: https://unpkg.com https://tiles.openfreemap.org",
  "connect-src 'self' https://tiles.openfreemap.org",
  "worker-src 'self' blob:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

const client = new MinsktransClient({ concurrency: 3, minGapMs: 90 });
const directory = new StopDirectory(client, path.join(DATA_DIR, 'stops.json'));
const scoreboards = new TtlCache();
const schedules = new TtlCache();
const vehicles = new TtlCache();
const nearest = new TtlCache();

let nextBuildAttemptAt = 0;
let lastManualBuildAt = 0;

function scheduleBuild() {
  if (directory.building) return;
  if (Date.now() < nextBuildAttemptAt) return;
  nextBuildAttemptAt = Date.now() + BUILD_RETRY_MS;
  directory
    .rebuild()
    .then(() => {
      nextBuildAttemptAt = 0;
      console.log(
        `[directory] готово: ${directory.stops.size} остановок, ${directory.routeKeys.size} маршрутов`
      );
    })
    .catch((error) => {
      console.warn('[directory] не удалось обновить справочник:', error.message);
      nextBuildAttemptAt = Date.now() + BUILD_RETRY_MS;
    });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method_not_allowed' });
  }
  if (pathname === '/') pathname = '/index.html';
  const resolved = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  let data;
  try {
    data = await fs.readFile(resolved);
  } catch {
    return sendJson(res, 404, { error: 'not_found' });
  }
  const extension = path.extname(resolved).toLowerCase();
  const revalidate = ['.html', '.webmanifest', '.js', '.css'].includes(extension);
  const headers = {
    'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
    'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=3600'
  };
  if (extension === '.html') headers['Content-Security-Policy'] = CSP;
  if (path.basename(resolved) === 'sw.js') headers['Cache-Control'] = 'no-cache';
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : data);
}

async function upstreamNearest(lat, lon) {
  const key = `nearest:${lat.toFixed(4)}:${lon.toFixed(4)}`;
  const raw = await nearest.wrap(key, NEAREST_TTL_MS, () =>
    client.nearestStops(lat.toFixed(6), lon.toFixed(6))
  );
  const stops = (raw?.Stops || [])
    .map((stop) => {
      const bearing = Number(stop.Bearing);
      return {
        id: Number(stop.Id),
        name: cleanName(stop.Name),
        lat: Number(stop.Latitude),
        lon: Number(stop.Longitude),
        bearing: Number.isFinite(bearing) && bearing >= 0 ? bearing : null,
        routes: []
      };
    })
    .filter((stop) => Number.isFinite(stop.id));
  return stops;
}

function directoryRoutes(stop) {
  return (stop?.routes || [])
    .map((route) => ({
      type: route.tt,
      number: route.number,
      destination: '',
      arrivals: [],
      vehicles: []
    }))
    .sort((a, b) => a.number.localeCompare(b.number, 'ru', { numeric: true }));
}

function buildStopPayload(raw, id) {
  const data = normalizeScoreboard(raw, directory.byId(id));
  data.stop.id = Number(id);
  if (!data.stop.name) data.stop.name = `Остановка ${id}`;
  if (!data.routes.length) data.routes = directoryRoutes(directory.byId(id));
  return data;
}

function routesForStops(stopIds) {
  const routes = new Map();
  for (const id of stopIds) {
    for (const route of directory.byId(id)?.routes || []) {
      if (!TRANSPORT_TYPES.has(route.tt)) continue;
      const key = `${route.tt}:${route.number}`;
      if (!routes.has(key)) routes.set(key, { type: route.tt, number: route.number });
      if (routes.size >= FAVORITE_ROUTES_MAX) return [...routes.values()];
    }
  }
  return [...routes.values()];
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const params = url.searchParams;
  const isGet = req.method === 'GET';

  if (isGet && parts[1] === 'health') {
    if (Date.now() - directory.builtAt > DIRECTORY_MAX_AGE_MS || !directory.ready) {
      scheduleBuild();
    }
    return sendJson(res, 200, {
      ok: directory.ready,
      now: Date.now(),
      directory: directory.info,
      upstream: client.status()
    });
  }

  if (isGet && parts[1] === 'search') {
    if (!directory.ready) {
      return sendJson(res, 503, {
        error: 'directory_building',
        progress: directory.info.progress
      });
    }
    const query = String(params.get('q') || '').trim();
    if (query.length < 2) return sendJson(res, 200, { results: [] });
    const limit = Math.min(Math.max(Number(params.get('limit')) || 20, 1), 50);
    return sendJson(res, 200, { results: directory.search(query, limit) });
  }

  if (isGet && parts[1] === 'near') {
    const lat = Number(params.get('lat'));
    const lon = Number(params.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return sendJson(res, 400, { error: 'bad_coordinates' });
    }
    const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 150);
    const radius = Math.min(Math.max(Number(params.get('radius')) || 1500, 100), 20000);
    if (directory.ready) {
      return sendJson(res, 200, {
        source: 'directory',
        results: directory.near(lat, lon, { limit, radius })
      });
    }
    return sendJson(res, 200, {
      source: 'upstream',
      results: await upstreamNearest(lat, lon)
    });
  }

  if (isGet && parts[1] === 'stop' && parts.length === 3) {
    const id = parts[2];
    if (!/^\d{1,12}$/.test(id)) return sendJson(res, 400, { error: 'bad_stop_id' });
    const key = `stop:${id}`;
    try {
      const raw = await scoreboards.wrap(key, SCOREBOARD_TTL_MS, () => client.scoreboard(id));
      return sendJson(res, 200, buildStopPayload(raw, id));
    } catch (error) {
      const stale = scoreboards.entry(key);
      if (stale?.value) {
        return sendJson(res, 200, { ...buildStopPayload(stale.value, id), stale: true });
      }
      throw error;
    }
  }

  if (isGet && parts[1] === 'stop' && parts[3] === 'schedule' && parts.length === 4) {
    const id = parts[2];
    if (!/^\d{1,12}$/.test(id)) return sendJson(res, 400, { error: 'bad_stop_id' });
    const key = `schedule:${id}`;
    try {
      const data = await schedules.wrap(key, SCHEDULE_TTL_MS, async () =>
        normalizeSchedule(await client.schedulesByStop(id))
      );
      return sendJson(res, 200, data);
    } catch (error) {
      const stale = schedules.entry(key);
      if (stale) return sendJson(res, 200, { ...stale.value, stale: true });
      throw error;
    }
  }

  if (isGet && parts[1] === 'vehicles' && parts.length === 2) {
    const stopIds = String(params.get('stops') || '')
      .split(',')
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
      .slice(0, FAVORITE_STOPS_MAX);
    if (!stopIds.length) {
      return sendJson(res, 200, { updatedAt: Date.now(), routes: [], vehicles: [] });
    }
    if (!directory.ready) return sendJson(res, 503, { error: 'directory_building' });
    const routes = routesForStops(stopIds);
    const results = await Promise.allSettled(
      routes.map(async (route) => {
        const key = `vehicles:${route.type}:${route.number}`;
        const raw = await vehicles.wrap(key, VEHICLES_TTL_MS, () =>
          client.vehicles(route.type, route.number)
        );
        return normalizeVehicles(raw, route.type).map((vehicle) => ({
          ...vehicle,
          route: route.number
        }));
      })
    );
    const list = [];
    for (const result of results) {
      if (result.status === 'fulfilled') list.push(...result.value);
    }
    return sendJson(res, 200, { updatedAt: Date.now(), routes, vehicles: list });
  }

  if (isGet && parts[1] === 'vehicles' && parts.length === 4) {
    const type = parts[2];
    const route = parts[3];
    if (!TRANSPORT_TYPES.has(type)) return sendJson(res, 400, { error: 'bad_transport_type' });
    if (!/^[0-9A-Za-zА-Яа-яЁё]{1,8}$/.test(route)) {
      return sendJson(res, 400, { error: 'bad_route' });
    }
    const key = `vehicles:${type}:${route}`;
    const raw = await vehicles.wrap(key, VEHICLES_TTL_MS, () => client.vehicles(type, route));
    return sendJson(res, 200, {
      type,
      route,
      updatedAt: Date.now(),
      vehicles: normalizeVehicles(raw, type)
    });
  }

  if (req.method === 'POST' && parts[1] === 'directory' && parts[2] === 'rebuild') {
    if (Date.now() - lastManualBuildAt < 60_000) {
      return sendJson(res, 429, { error: 'too_many_requests' });
    }
    lastManualBuildAt = Date.now();
    nextBuildAttemptAt = 0;
    scheduleBuild();
    return sendJson(res, 202, { started: true });
  }

  return sendJson(res, 404, { error: 'not_found' });
}

async function handleRequest(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: 'bad_request' });
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      return await handleApi(req, res, url);
    } catch (error) {
      if (res.headersSent) return res.end();
      const isUpstream = error instanceof UpstreamError;
      if (!isUpstream) console.error('[api]', url.pathname, error);
      return sendJson(res, isUpstream ? 502 : 500, {
        error: isUpstream ? 'upstream_unavailable' : 'server_error',
        message: isUpstream
          ? 'Минсктранс недоступен или изменил формат API'
          : 'Внутренняя ошибка сервера'
      });
    }
  }

  return serveStatic(req, res, decodeURIComponent(url.pathname));
}

await directory.load();
if (!directory.ready) {
  console.warn('[directory] справочник остановок ещё не собран, запускаю сборку');
  scheduleBuild();
} else if (Date.now() - directory.builtAt > DIRECTORY_MAX_AGE_MS) {
  scheduleBuild();
}

setInterval(() => {
  if (Date.now() - directory.builtAt > DIRECTORY_MAX_AGE_MS) scheduleBuild();
}, 10 * 60_000).unref();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error('[server]', error);
    if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Транспорт Минска: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
