#!/usr/bin/env node
// Диагностика неофициального API Минсктранса.
// Запуск: node scripts/check-api.mjs

const ORIGIN = 'https://www.minsktrans.by';
const PAGE = `${ORIGIN}/lookout_yard/Home/Index/minsk`;
const DATA = `${ORIGIN}/lookout_yard/Data`;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20000;

const cookies = new Map();
const checks = [];
let token = null;
let vFn = null;

function compileV(expression) {
  const match = String(expression)
    .replace(/\s+/g, '')
    .match(/^(\d+)([+^])(?:(\d+)\*)?a$/);
  if (!match) return null;
  const base = Number(match[1]);
  const coefficient = Number(match[3] || 1);
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(coefficient)) return null;
  return match[2] === '+'
    ? (id) => base + coefficient * id
    : (id) => base ^ (coefficient * id);
}

function rememberCookies(response) {
  const lines =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
  for (const line of lines) {
    for (const part of String(line).split(/,(?=\s*[^;=]+=)/)) {
      const pair = part.split(';')[0];
      const index = pair.indexOf('=');
      if (index < 1) continue;
      cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }
}

function cookieHeader() {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractToken(html) {
  const patterns = [
    /<input[^>]*name="__RequestVerificationToken"[^>]*value="([^"]+)"/i,
    /<input[^>]*value="([^"]+)"[^>]*name="__RequestVerificationToken"/i,
    /name="__RequestVerificationToken"[^>]*value='([^']+)'/i
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeEntities(match[1]);
  }
  return null;
}

async function openSession() {
  const response = await fetch(PAGE, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'ru'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  rememberCookies(response);
  if (!response.ok) throw new Error(`страница ответила HTTP ${response.status}`);
  const html = await response.text();
  token = extractToken(html);
  if (!token) throw new Error('не найден __RequestVerificationToken');
  const vMatch = html.match(/'v':\s*function\s*\(\s*\w+\s*\)\s*\{\s*return\s+([^;]+);/);
  vFn = vMatch ? compileV(vMatch[1]) : null;
  if (!vFn) throw new Error('не удалось разобрать формулу параметра v');
}

async function post(action, params, retry = true) {
  if (!token) await openSession();
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    body.set(key, String(typeof value === 'function' ? value() : value));
  }
  body.set('__RequestVerificationToken', token);

  const response = await fetch(`${DATA}/${action}`, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'ru',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: ORIGIN,
      Referer: PAGE,
      ...(cookies.size ? { Cookie: cookieHeader() } : {})
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  rememberCookies(response);
  const text = await response.text();

  if ((response.status === 400 || response.status === 401 || response.status === 500) && retry) {
    token = null;
    await openSession();
    return post(action, params, false);
  }

  const contentType = response.headers.get('content-type') || '';
  if (response.status === 204 || (response.ok && !text.trim())) return null;
  if (!response.ok || !contentType.includes('json')) {
    throw new Error(`${action}: HTTP ${response.status}, content-type ${contentType || '—'}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${action}: ответ не является JSON`);
  }
}

function report(ok, label, detail) {
  checks.push(ok);
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${label.padEnd(34, ' ')} ${detail}`);
}

async function main() {
  console.log('Минсктранс · диагностика неофициального API');
  console.log('─'.repeat(64));

  try {
    await openSession();
    report(true, 'Страница и токен', `сессия открыта, ${cookies.size} cookie`);
  } catch (error) {
    report(false, 'Страница и токен', error.message);
    console.log('\nДальнейшие проверки невозможны: сайт недоступен или изменил форму.');
    return;
  }

  let routeList = null;
  try {
    const data = await post('RouteList', { p: 'minsk', tt: 'bus' });
    routeList = Array.isArray(data?.Routes) ? data.Routes : [];
    report(routeList.length > 0, 'RouteList (автобусы)', `${routeList.length} маршрутов`);
  } catch (error) {
    report(false, 'RouteList (автобусы)', error.message);
  }

  let stopId = null;
  let routeNumber = null;
  if (routeList?.length) {
    const candidate =
      routeList.find((route) => route.IsWorkToday) ||
      routeList.find((route) => /^\d+$/.test(String(route.Number).trim())) ||
      routeList[0];
    routeNumber = String(candidate.Number ?? '').trim();
    try {
      const data = await post('Route', { p: 'minsk', tt: 'bus', r: routeNumber });
      const trips = data?.Trips || {};
      const stopsA = Array.isArray(trips.StopsA) ? trips.StopsA : [];
      const namesA = Array.isArray(trips.StopNamesA) ? trips.StopNamesA : [];
      const index = stopsA.findIndex((stop) => Number.isFinite(Number(stop?.Id)));
      if (index >= 0) stopId = Number(stopsA[index].Id);
      report(
        stopsA.length > 0,
        `Route (автобус ${routeNumber})`,
        `${stopsA.length} остановок в направлении A${
          index >= 0 && namesA[index] ? `, первая «${namesA[index]}»` : ''
        }`
      );
    } catch (error) {
      report(false, `Route (автобус ${routeNumber})`, error.message);
    }
  }

  if (stopId) {
    try {
      const data = await post('Scoreboard', { p: 'minsk', s: stopId, v: () => vFn(stopId) });
      if (data === null) {
        report(true, `Scoreboard (stop ${stopId})`, '204: прогнозов сейчас нет (штатный ответ)');
      } else {
        const routes = Array.isArray(data.Routes) ? data.Routes : [];
        report(
          Array.isArray(data.Routes),
          `Scoreboard (stop ${stopId})`,
          `${routes.length} маршрутов, «${data.StopName || 'без названия'}»`
        );
      }
    } catch (error) {
      report(false, `Scoreboard (stop ${stopId})`, error.message);
    }

    try {
      const data = await post('SchedulesByStop', {
        stopId,
        place: 'minsk',
        lang: 'ru'
      });
      const schedules = Array.isArray(data?.Schedules) ? data.Schedules : [];
      report(Array.isArray(data?.Schedules), `SchedulesByStop (stop ${stopId})`, `${schedules.length} расписаний`);
    } catch (error) {
      report(false, `SchedulesByStop (stop ${stopId})`, error.message);
    }
  }

  try {
    const data = await post('NearestStops', { p: 'minsk', lat: '53.9023', lon: '27.5619' });
    const stops = Array.isArray(data?.Stops) ? data.Stops : [];
    report(stops.length > 0, 'NearestStops (центр Минска)', `${stops.length} остановок`);
  } catch (error) {
    report(false, 'NearestStops (центр Минска)', error.message);
  }

  const numeric = (routeList || []).find((route) => /^\d+$/.test(String(route.Number).trim()));
  if (numeric) {
    const number = String(numeric.Number).trim();
    try {
      const data = await post('Vehicles', {
        p: 'minsk',
        tt: 'bus',
        r: number,
        v: () => vFn(Number.parseInt(number, 10))
      });
      const vehicles = Array.isArray(data?.Vehicles) ? data.Vehicles : [];
      report(Array.isArray(data?.Vehicles), `Vehicles (автобус ${number})`, `${vehicles.length} машин`);
    } catch (error) {
      report(false, `Vehicles (автобус ${number})`, error.message);
    }
  } else {
    console.log('- Vehicles: числовой автобусный маршрут не найден, проверка пропущена');
  }

  const failed = checks.filter((ok) => !ok).length;
  console.log('');
  if (failed) {
    console.log(`Проблемы: ${failed} из ${checks.length}. Вероятно, API изменился или сайт ограничил доступ.`);
    process.exitCode = 1;
  } else {
    console.log(`Все проверки пройдены (${checks.length}). API отвечает ожидаемым образом.`);
  }
}

main().catch((error) => {
  console.error('Диагностика не удалась:', error.message);
  process.exitCode = 1;
});
