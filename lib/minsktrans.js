import { Limiter } from './cache.js';

const ORIGIN = 'https://www.minsktrans.by';
const PAGE_URL = `${ORIGIN}/lookout_yard/Home/Index/minsk`;
const DATA_URL = `${ORIGIN}/lookout_yard/Data/`;
const USER_AGENT = 'MinskTransportBoard/1.0 (unofficial web app; local use)';
const SESSION_TTL_MS = 20 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;

// Сайт обфусцирует параметр v формулой вида «21476 + a», «12602961 ^ a»,
// «35431 + 2*a». Формула генерируется заново на каждую сессию.
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

export class UpstreamError extends Error {
  constructor(message, status = 502, detail = '') {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.detail = detail;
  }
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export class MinsktransClient {
  constructor({ concurrency = 3, minGapMs = 90, maxQueue = 500 } = {}) {
    this.limiter = new Limiter(concurrency, minGapMs, maxQueue);
    this.cookies = new Map();
    this.token = null;
    this.v = null;
    this.sessionAt = 0;
    this.sessionPromise = null;
    this.lastOkAt = 0;
    this.lastError = null;
    this.calls = 0;
  }

  get cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  #rememberCookies(response) {
    const lines =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
    for (const line of lines) {
      for (const part of String(line).split(/,(?=\s*[^;=]+=)/)) {
        const pair = part.split(';')[0];
        const index = pair.indexOf('=');
        if (index < 1) continue;
        this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    }
  }

  async #openSession() {
    let response;
    try {
      response = await fetch(PAGE_URL, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'ru'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20 * 1000)
      });
    } catch (error) {
      throw new UpstreamError('Не удалось подключиться к Минсктрансу', 502, error.message);
    }
    if (!response.ok) {
      throw new UpstreamError(`Сайт Минсктранса ответил ${response.status}`, 502);
    }
    const html = await response.text();
    this.#rememberCookies(response);
    const match =
      html.match(/<input[^>]*name="__RequestVerificationToken"[^>]*value="([^"]+)"/i) ||
      html.match(/<input[^>]*value="([^"]+)"[^>]*name="__RequestVerificationToken"/i) ||
      html.match(/name="__RequestVerificationToken"[^>]*value='([^']+)'/i);
    if (!match) {
      throw new UpstreamError('Не найден токен доступа Минсктранса', 502);
    }
    const vMatch = html.match(/'v':\s*function\s*\(\s*\w+\s*\)\s*\{\s*return\s+([^;]+);/);
    const v = vMatch ? compileV(vMatch[1]) : null;
    if (!v) {
      throw new UpstreamError('Не удалось разобрать формулу запроса Минсктранса', 502);
    }
    this.token = decodeEntities(match[1]);
    this.v = v;
    this.sessionAt = Date.now();
  }

  async #ensureSession(force = false) {
    if (this.sessionPromise) return this.sessionPromise;
    if (!force && this.token && Date.now() - this.sessionAt < SESSION_TTL_MS) return;
    this.sessionPromise = this.#openSession().finally(() => {
      this.sessionPromise = null;
    });
    return this.sessionPromise;
  }

  async post(action, params, { retry = true } = {}) {
    await this.#ensureSession();
    const send = async () => {
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        body.set(key, String(typeof value === 'function' ? value() : value));
      }
      body.set('__RequestVerificationToken', this.token);
      let response;
      try {
        response = await fetch(DATA_URL + action, {
          method: 'POST',
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'ru',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Origin: ORIGIN,
            Referer: PAGE_URL,
            ...(this.cookies.size ? { Cookie: this.cookieHeader } : {})
          },
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
      } catch (error) {
        throw new UpstreamError('Минсктранс не отвечает', 502, error.message);
      }
      this.#rememberCookies(response);
      const text = await response.text();
      return { response, text };
    };

    let { response, text } = await send();
    if ((response.status === 400 || response.status === 401 || response.status === 500) && retry) {
      await this.#ensureSession(true);
      ({ response, text } = await send());
    }

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok || !contentType.includes('json')) {
      this.lastError = { at: Date.now(), action, status: response.status };
      throw new UpstreamError(`Минсктранс вернул ошибку ${response.status}`, 502, text.slice(0, 200));
    }
    // 204 / пустое тело — валидный ответ «прогнозов сейчас нет», а не ошибка.
    if (response.status === 204 || !text.trim()) {
      this.lastOkAt = Date.now();
      this.lastError = null;
      this.calls += 1;
      return null;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new UpstreamError('Некорректный ответ Минсктранса', 502);
    }
    this.lastOkAt = Date.now();
    this.lastError = null;
    this.calls += 1;
    return data;
  }

  routeList(type) {
    return this.limiter.run(() => this.post('RouteList', { p: 'minsk', tt: type }));
  }

  route(type, number) {
    return this.limiter.run(() => this.post('Route', { p: 'minsk', tt: type, r: number }));
  }

  scoreboard(stopId) {
    return this.limiter.run(() =>
      this.post('Scoreboard', { p: 'minsk', s: stopId, v: () => this.v(Number(stopId)) })
    );
  }

  schedulesByStop(stopId) {
    return this.limiter.run(() =>
      this.post('SchedulesByStop', { stopId, place: 'minsk', lang: 'ru' })
    );
  }

  nearestStops(lat, lon) {
    return this.limiter.run(() => this.post('NearestStops', { p: 'minsk', lat, lon }));
  }

  vehicles(type, number) {
    return this.limiter.run(() =>
      this.post('Vehicles', {
        p: 'minsk',
        tt: type,
        r: number,
        v: () => this.v(Number.parseInt(number, 10) || 0)
      })
    );
  }

  status() {
    return {
      calls: this.calls,
      lastOkAt: this.lastOkAt || null,
      lastError: this.lastError,
      sessionAgeMs: this.token ? Date.now() - this.sessionAt : null
    };
  }
}
