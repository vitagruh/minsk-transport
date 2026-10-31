export class ApiError extends Error {
  constructor(message, { status = 0, code = 'request_failed', payload = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export function isAbort(error) {
  return error?.name === 'AbortError';
}

async function request(path, { method = 'GET', timeout = 15000, signal } = {}) {
  const timeoutSignal = AbortSignal.timeout(timeout);
  const combined =
    signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeoutSignal])
      : signal || timeoutSignal;

  let response;
  let text;
  try {
    response = await fetch(path, {
      method,
      headers: { Accept: 'application/json' },
      signal: combined,
      cache: 'no-store'
    });
    text = await response.text();
  } catch (error) {
    if (isAbort(error)) throw error;
    if (error?.name === 'TimeoutError') {
      throw new ApiError('Сервер не ответил вовремя', { code: 'timeout' });
    }
    throw new ApiError('Нет связи с сервером', { code: 'network' });
  }

  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw new ApiError(payload?.message || `Ошибка сервера (${response.status})`, {
      status: response.status,
      code: payload?.error || 'http_error',
      payload
    });
  }
  if (payload == null) {
    throw new ApiError('Некорректный ответ сервера', {
      status: response.status,
      code: 'bad_response'
    });
  }
  return payload;
}

export const api = {
  health: (options = {}) => request('/api/health', { timeout: 5000, ...options }),
  search: (query, limit = 20, options = {}) =>
    request(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`, options),
  near: ({ lat, lon, limit = 80, radius = 1500 }, options = {}) =>
    request(`/api/near?lat=${lat}&lon=${lon}&limit=${limit}&radius=${radius}`, options),
  stop: (id, options = {}) => request(`/api/stop/${encodeURIComponent(id)}`, options),
  schedule: (id, options = {}) =>
    request(`/api/stop/${encodeURIComponent(id)}/schedule`, options),
  vehicles: (type, route, options = {}) =>
    request(`/api/vehicles/${encodeURIComponent(type)}/${encodeURIComponent(route)}`, options),
  vehiclesByStops: (ids, options = {}) =>
    request(`/api/vehicles?stops=${ids.map((id) => encodeURIComponent(id)).join(',')}`, options),
  rebuild: (options = {}) => request('/api/directory/rebuild', { method: 'POST', ...options })
};
