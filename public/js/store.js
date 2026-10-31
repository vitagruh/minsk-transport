const FAVORITES_KEY = 'minsk-transport:favorites:v1';
const SETTINGS_KEY = 'minsk-transport:settings:v1';
const ALL_TYPES = ['bus', 'trolleybus', 'tram', 'metro'];
const THEMES = ['auto', 'light', 'dark'];
const DEFAULT_SETTINGS = {
  refreshSec: 20,
  types: [...ALL_TYPES],
  theme: 'auto'
};

const events = new EventTarget();
let cachedSettings = null;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function coordinate(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeFavorite(item) {
  const id = Number(item?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return {
    id,
    name: String(item?.name || `Остановка ${id}`).slice(0, 160),
    lat: coordinate(item?.lat),
    lon: coordinate(item?.lon),
    savedAt: Number(item?.savedAt) || Date.now()
  };
}

function notify(type) {
  events.dispatchEvent(new CustomEvent(type));
}

export function getFavorites() {
  const raw = read(FAVORITES_KEY, []);
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const result = [];
  for (const item of raw) {
    const favorite = normalizeFavorite(item);
    if (!favorite || seen.has(favorite.id)) continue;
    seen.add(favorite.id);
    result.push(favorite);
  }
  return result;
}

export function isFavorite(id) {
  const target = Number(id);
  return getFavorites().some((item) => item.id === target);
}

export function toggleFavorite(stop) {
  const id = Number(stop?.id);
  if (!Number.isInteger(id) || id <= 0) return false;
  const list = getFavorites();
  const index = list.findIndex((item) => item.id === id);
  let active;
  if (index >= 0) {
    list.splice(index, 1);
    active = false;
  } else {
    list.unshift({
      id,
      name: String(stop.name || `Остановка ${id}`).slice(0, 160),
      lat: coordinate(stop.lat),
      lon: coordinate(stop.lon),
      savedAt: Date.now()
    });
    active = true;
  }
  write(FAVORITES_KEY, list.slice(0, 50));
  notify('favorites');
  return active;
}

export function removeFavorite(id) {
  const target = Number(id);
  const list = getFavorites().filter((item) => item.id !== target);
  write(FAVORITES_KEY, list);
  notify('favorites');
}

export function clearFavorites() {
  write(FAVORITES_KEY, []);
  notify('favorites');
}

function normalizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS, types: [...DEFAULT_SETTINGS.types] };
  if (!raw || typeof raw !== 'object') return settings;
  const refreshSec = Number(raw.refreshSec);
  if (Number.isFinite(refreshSec)) {
    settings.refreshSec = Math.min(120, Math.max(10, Math.round(refreshSec)));
  }
  if (Array.isArray(raw.types)) {
    const types = ALL_TYPES.filter((type) => raw.types.includes(type));
    if (types.length) settings.types = types;
  }
  if (THEMES.includes(raw.theme)) settings.theme = raw.theme;
  return settings;
}

export function getSettings() {
  if (!cachedSettings) cachedSettings = normalizeSettings(read(SETTINGS_KEY, null));
  return { ...cachedSettings, types: [...cachedSettings.types] };
}

export function updateSettings(patch) {
  const next = normalizeSettings({ ...getSettings(), ...patch });
  cachedSettings = next;
  write(SETTINGS_KEY, next);
  applyTheme(next);
  notify('settings');
  return { ...next, types: [...next.types] };
}

export function applyTheme(settings = getSettings()) {
  const theme = THEMES.includes(settings?.theme) ? settings.theme : 'auto';
  document.documentElement.dataset.theme = theme;
}

export function onFavoritesChange(listener) {
  events.addEventListener('favorites', listener);
  return () => events.removeEventListener('favorites', listener);
}

export function onSettingsChange(listener) {
  events.addEventListener('settings', listener);
  return () => events.removeEventListener('settings', listener);
}

window.addEventListener('storage', (event) => {
  if (event.key === FAVORITES_KEY) notify('favorites');
  if (event.key === SETTINGS_KEY) {
    cachedSettings = null;
    applyTheme();
    notify('settings');
  }
});
