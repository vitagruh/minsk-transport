export const TYPE_META = {
  bus: { label: 'Автобус', short: 'А' },
  trolleybus: { label: 'Троллейбус', short: 'Т' },
  tram: { label: 'Трамвай', short: '#' },
  metro: { label: 'Метро', short: 'М' },
  other: { label: 'Транспорт', short: '•' }
};

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

export function pluralWord(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export function plural(n, one, few, many) {
  return `${n} ${pluralWord(n, one, few, many)}`;
}

export function routesCount(n) {
  return plural(n, 'маршрут', 'маршрута', 'маршрутов');
}

const timeFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Minsk',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Minsk',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

const clockPartsFormatter = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Minsk',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

export function timeLabel(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '—';
  try {
    return timeFormatter.format(new Date(value));
  } catch {
    return '—';
  }
}

export function formatDate(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '—';
  try {
    return dateFormatter.format(new Date(value));
  } catch {
    return '—';
  }
}

export function minskMinutes() {
  const parts = clockPartsFormatter.formatToParts(new Date());
  const read = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  const minutes = read('hour') * 60 + read('minute');
  return read('hour') < 4 ? minutes + 1440 : minutes;
}

export function relativeDeparture(total) {
  const diff = Number(total) - minskMinutes();
  if (!Number.isFinite(diff)) return '';
  if (diff <= 0) return diff > -2 ? 'сейчас' : '—';
  return `через ${diff} мин`;
}

export function timeAgo(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (seconds < 5) return 'только что';
  if (seconds < 60) return `${seconds} ${pluralWord(seconds, 'секунду', 'секунды', 'секунд')} назад`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${pluralWord(minutes, 'минуту', 'минуты', 'минут')} назад`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${pluralWord(hours, 'час', 'часа', 'часов')} назад`;
}

export function distanceLabel(meters) {
  const value = Number(meters);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1000) {
    const rounded = value >= 100 ? Math.round(value / 10) * 10 : Math.round(value);
    return `${rounded} м`;
  }
  const km = value / 1000;
  return `${(km < 10 ? km.toFixed(1) : km.toFixed(0)).replace('.', ',')} км`;
}

export function visibleRoutes(routes, types) {
  const allowed = new Set(Array.isArray(types) ? types : []);
  return (Array.isArray(routes) ? routes : []).filter(
    (route) => route.type === 'other' || allowed.has(route.type)
  );
}
