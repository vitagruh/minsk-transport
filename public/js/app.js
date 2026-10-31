import { api } from './api.js';
import { applyTheme } from './store.js';
import { errorCard } from './components.js';
import * as favoritesView from './views/favorites.js';
import * as stopView from './views/stop.js';
import * as searchView from './views/search.js';
import * as mapView from './views/map.js';
import * as settingsView from './views/settings.js';

const viewEl = document.getElementById('view');
const refreshBtn = document.getElementById('refresh-page');
const statusEl = document.getElementById('status');
const statusLabel = document.getElementById('status-label');
const tabs = [...document.querySelectorAll('[data-tab]')];
const toastEl = document.getElementById('toast');

const DEFAULT_TITLE = 'Транспорт Минска — табло остановок';

let cleanup = null;
let previousHash = null;
let lastRenderedHash = null;
let toastTimer = null;
let healthInFlight = false;

applyTheme();

function toast(message) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  requestAnimationFrame(() => toastEl.classList.add('is-visible'));
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('is-visible');
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
      toastTimer = null;
    }, 250);
  }, 2600);
}

function parseRoute() {
  const hash = location.hash || '#/';
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [pathPart = '/', queryPart = ''] = (raw || '/').split('?');
  const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  return {
    path,
    parts: path.split('/').filter(Boolean),
    params: new URLSearchParams(queryPart)
  };
}

function resolveView(route) {
  const [first, second] = route.parts;
  if (!first) return favoritesView;
  if (first === 'stop' && /^\d{1,12}$/.test(second || '')) return stopView;
  if (first === 'map') return mapView;
  if (first === 'search') return searchView;
  if (first === 'settings') return settingsView;
  return null;
}

function updateTab(route) {
  const first = route.parts[0] || '';
  const active =
    first === ''
      ? 'home'
      : first === 'map'
        ? 'map'
        : first === 'search'
          ? 'search'
          : first === 'settings'
            ? 'settings'
            : '';
  for (const tab of tabs) tab.classList.toggle('is-active', tab.dataset.tab === active);
}

function render() {
  if (cleanup) {
    try {
      cleanup();
    } catch (error) {
      console.error('[view cleanup]', error);
    }
    cleanup = null;
  }

  const route = parseRoute();
  const view = resolveView(route);
  if (!view) {
    location.replace('#/');
    return;
  }

  const hash = location.hash || '#/';
  previousHash = lastRenderedHash;
  lastRenderedHash = hash;

  viewEl.innerHTML = '';
  viewEl.className = `view${view === mapView ? ' view--map' : ''}`;
  viewEl.scrollTop = 0;
  document.title = DEFAULT_TITLE;
  updateTab(route);

  const ctx = {
    route,
    toast,
    setTitle: (title) => {
      document.title = title ? `${title} — Транспорт Минска` : DEFAULT_TITLE;
    },
    back: () => {
      if (previousHash && previousHash !== hash) location.hash = previousHash;
      else location.hash = '#/';
    }
  };

  try {
    const result = view.mount(viewEl, ctx);
    cleanup = typeof result === 'function' ? result : null;
  } catch (error) {
    console.error('[view mount]', error);
    viewEl.innerHTML = `<div class="page">${errorCard({
      title: 'Не удалось открыть экран',
      text: 'Обновите страницу — возможно, приложение обновилось не полностью.',
      action: '<button class="btn btn--primary" type="button" data-reload>Перезагрузить</button>'
    })}</div>`;
    viewEl.querySelector('[data-reload]')?.addEventListener('click', () => location.reload());
  }
}

async function refreshHealth(force = false) {
  if (healthInFlight) return;
  if (!force && document.visibilityState !== 'visible') return;
  healthInFlight = true;
  try {
    const data = await api.health();
    const directory = data.directory || {};
    if (directory.building) {
      statusEl.className = 'status is-building';
      statusLabel.textContent = 'Сборка';
      const done = Number(directory.progress?.done) || 0;
      const total = Number(directory.progress?.total) || 0;
      statusEl.title = `Справочник остановок собирается: ${done}${total ? ` из ${total}` : ''}`;
    } else {
      statusEl.className = 'status is-online';
      statusLabel.textContent = 'Онлайн';
      statusEl.title = `Справочник: ${Number(directory.stops) || 0} остановок · обновлён ${new Date(
        Number(directory.builtAt) || Date.now()
      ).toLocaleString('ru-RU')}`;
    }
  } catch {
    statusEl.className = 'status is-offline';
    statusLabel.textContent = 'Нет связи';
    statusEl.title =
      'Сервер приложения недоступен. Офлайн доступен только сохранённый интерфейс.';
  } finally {
    healthInFlight = false;
  }
}

refreshBtn.addEventListener('click', () => {
  refreshBtn.classList.add('is-spinning');
  setTimeout(() => refreshBtn.classList.remove('is-spinning'), 700);
  window.dispatchEvent(new CustomEvent('app:refresh'));
  void refreshHealth(true);
});

window.addEventListener('hashchange', render);
window.addEventListener('online', () => {
  void refreshHealth(true);
  window.dispatchEvent(new CustomEvent('app:refresh'));
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    void refreshHealth(true);
    window.dispatchEvent(new CustomEvent('app:refresh'));
  }
});

setInterval(() => {
  void refreshHealth();
}, 30000);

if ('serviceWorker' in navigator) {
  const host = location.hostname;
  const secure =
    location.protocol === 'https:' ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]';
  if (secure) {
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      location.reload();
    });
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {
      // Офлайн-режим необязателен для работы приложения.
    });
  }
}

render();
void refreshHealth(true);
