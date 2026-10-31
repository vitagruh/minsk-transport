import { api, isAbort } from '../api.js';
import {
  getFavorites,
  getSettings,
  isFavorite,
  onFavoritesChange,
  toggleFavorite
} from '../store.js';
import { distanceLabel, esc, routesCount, timeLabel, visibleRoutes } from '../format.js';
import { ICONS, errorCard, serviceRow, skeletonBoard } from '../components.js';
import { pollEvery } from '../util.js';

const MINSK = { lat: 53.9023, lon: 27.5619 };
const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron';
const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';
const VEHICLE_POLL_MS = 15000;
const FAVORITE_STOPS_MAX = 25;
const FAVORITE_VEHICLES_MAX = 200;

const TYPE_LABEL = { bus: 'автобус', trolleybus: 'троллейбус', tram: 'трамвай' };

function waitForMapLibre(timeoutMs = 8000) {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.maplibregl) {
        clearInterval(timer);
        resolve(window.maplibregl);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('MapLibre не загрузился'));
      }
    }, 100);
  });
}

function themeName() {
  const setting = document.documentElement.dataset.theme || 'auto';
  if (setting === 'dark' || setting === 'light') return setting;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function styleUrl() {
  return themeName() === 'dark' ? STYLE_DARK : STYLE_LIGHT;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

export function mount(root, ctx) {
  root.innerHTML = `
    <div class="map-view">
      <div class="map" data-map></div>
      <div class="map__top">
        <button class="map-pill" type="button" data-locate>${ICONS.locate} Рядом</button>
        <button class="map-pill" type="button" data-vehicles-toggle aria-pressed="true" hidden>${ICONS.bus} Транспорт</button>
        <a class="map-pill map-pill--icon" href="#/search" aria-label="Поиск остановки" title="Поиск остановки">${ICONS.search}</a>
      </div>
      <div data-sheet></div>
    </div>`;

  const mapEl = root.querySelector('[data-map]');
  const sheetEl = root.querySelector('[data-sheet]');
  const locateBtn = root.querySelector('[data-locate]');
  const vehiclesToggle = root.querySelector('[data-vehicles-toggle]');

  let disposed = false;
  let map = null;
  let ml = null;
  let activeStyle = null;

  const stopMarkers = new Map();
  const selectedVehicleMarkers = new Map();
  const favoriteVehicleMarkers = new Map();

  let selectedId = null;
  let sheetStop = null;
  let sheetController = null;
  let sheetPoll = null;
  let vehiclesController = null;
  let vehiclePoll = null;
  let activeVehicleKey = null;
  let focusSheet = false;

  let nearController = null;
  let viewportTimer = null;

  let favoriteVehiclesOn = true;
  let favoriteVehiclesController = null;
  let favoriteVehiclePoll = null;

  const deepStopId = Number(ctx.route.params.get('stop'));

  function pinLabel(stop) {
    const count = stop.routes?.length || 0;
    return count > 99 ? '99+' : String(count || '•');
  }

  function syncPinElement(entry) {
    const { element, stop } = entry;
    element.textContent = pinLabel(stop);
    element.classList.toggle('is-selected', stop.id === selectedId);
    element.classList.toggle('is-favorite', isFavorite(stop.id));
    const name = stop.name || `Остановка ${stop.id}`;
    element.title = name;
    element.setAttribute('aria-label', `${name}, ${routesCount(stop.routes?.length || 0)}`);
    entry.wrapper.style.zIndex = stop.id === selectedId ? '4' : '';
  }

  function createStopMarker(stop) {
    const wrapper = document.createElement('div');
    wrapper.className = 'map-marker stop-pin-wrap';
    wrapper.setAttribute('role', 'none');
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'stop-pin';
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void openSheet(stop);
    });
    wrapper.append(element);
    const entry = { stop, wrapper, element, marker: null };
    syncPinElement(entry);
    entry.marker = new ml.Marker({ element: wrapper, anchor: 'center', keyboard: false })
      .setLngLat([stop.lon, stop.lat])
      .addTo(map);
    return entry;
  }

  function refreshPinStyles() {
    for (const entry of stopMarkers.values()) syncPinElement(entry);
  }

  function renderStops(stops) {
    if (!map) return;
    const seen = new Set();
    for (const stop of stops) {
      if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) continue;
      seen.add(stop.id);
      const entry = stopMarkers.get(stop.id);
      if (entry) {
        entry.stop = stop;
        syncPinElement(entry);
        continue;
      }
      stopMarkers.set(stop.id, createStopMarker(stop));
    }
    for (const [id, entry] of stopMarkers) {
      if (!seen.has(id)) {
        entry.marker.remove();
        stopMarkers.delete(id);
      }
    }
  }

  async function loadViewport() {
    if (!map || disposed) return;
    const zoom = map.getZoom();
    if (zoom < 12) return;
    const center = map.getCenter();
    const northEast = map.getBounds().getNorthEast();
    const radius = Math.min(
      20000,
      Math.max(
        300,
        Math.round(distanceMeters(center.lat, center.lng, northEast.lat, northEast.lng))
      )
    );
    const limit = zoom >= 16 ? 150 : zoom >= 14 ? 100 : 60;
    if (nearController) nearController.abort();
    nearController = new AbortController();
    try {
      const data = await api.near(
        { lat: center.lat, lon: center.lng, limit, radius },
        { signal: nearController.signal }
      );
      if (disposed) return;
      renderStops(data.results || []);
    } catch (error) {
      if (isAbort(error)) return;
    }
  }

  function scheduleViewport() {
    if (viewportTimer) clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => {
      viewportTimer = null;
      void loadViewport();
    }, 350);
  }

  function vehicleElement(type, number) {
    const wrapper = document.createElement('div');
    wrapper.className = 'map-marker vpin-wrap';
    wrapper.setAttribute('role', 'none');
    wrapper.style.zIndex = '5';
    const element = document.createElement('div');
    element.className = `vpin type--${type}`;
    element.textContent = number;
    wrapper.append(element);
    return wrapper;
  }

  function vehiclePopup(vehicle, type, number) {
    const label = TYPE_LABEL[type] || 'транспорт';
    const direction = vehicle.direction === 'A' ? 'A' : 'B';
    return new ml.Popup({ offset: 16, closeButton: false, className: 'vehicle-popup' }).setText(
      `№ ${vehicle.id ?? '—'} · ${label} ${number} · направление ${direction}`
    );
  }

  function clearSelectedVehicles() {
    for (const entry of selectedVehicleMarkers.values()) entry.marker.remove();
    selectedVehicleMarkers.clear();
  }

  function renderSelectedVehicles(vehicles, type, number) {
    if (!map) return;
    const seen = new Set();
    for (const vehicle of vehicles) {
      const key = vehicle.id != null ? `id:${vehicle.id}` : `${vehicle.lat}:${vehicle.lon}`;
      seen.add(key);
      const existing = selectedVehicleMarkers.get(key);
      if (existing) {
        existing.marker.setLngLat([vehicle.lon, vehicle.lat]);
        continue;
      }
      const marker = new ml.Marker({
        element: vehicleElement(type, number),
        anchor: 'center',
        keyboard: false
      })
        .setLngLat([vehicle.lon, vehicle.lat])
        .setPopup(vehiclePopup(vehicle, type, number))
        .addTo(map);
      selectedVehicleMarkers.set(key, { marker });
    }
    for (const [key, entry] of selectedVehicleMarkers) {
      if (!seen.has(key)) {
        entry.marker.remove();
        selectedVehicleMarkers.delete(key);
      }
    }
  }

  function stopVehicles({ resumeFavorites = true } = {}) {
    if (vehiclePoll) {
      vehiclePoll();
      vehiclePoll = null;
    }
    if (vehiclesController) {
      vehiclesController.abort();
      vehiclesController = null;
    }
    activeVehicleKey = null;
    clearSelectedVehicles();
    const note = sheetEl.querySelector('[data-vehicles-note]');
    if (note) {
      note.hidden = true;
      note.textContent = '';
    }
    for (const row of sheetEl.querySelectorAll('.service.is-active')) {
      row.classList.remove('is-active');
    }
    if (resumeFavorites) startFavoriteVehicles();
  }

  function clearFavoriteVehicles() {
    for (const entry of favoriteVehicleMarkers.values()) entry.marker.remove();
    favoriteVehicleMarkers.clear();
  }

  function stopFavoriteVehicles() {
    if (favoriteVehiclePoll) {
      favoriteVehiclePoll();
      favoriteVehiclePoll = null;
    }
    if (favoriteVehiclesController) {
      favoriteVehiclesController.abort();
      favoriteVehiclesController = null;
    }
    clearFavoriteVehicles();
  }

  function renderFavoriteVehicles(vehicles) {
    if (!map) return;
    const seen = new Set();
    for (const vehicle of vehicles.slice(0, FAVORITE_VEHICLES_MAX)) {
      const key = `${vehicle.type}:${vehicle.route}:${vehicle.id ?? `${vehicle.lat}:${vehicle.lon}`}`;
      seen.add(key);
      const existing = favoriteVehicleMarkers.get(key);
      if (existing) {
        existing.marker.setLngLat([vehicle.lon, vehicle.lat]);
        continue;
      }
      const marker = new ml.Marker({
        element: vehicleElement(vehicle.type, vehicle.route),
        anchor: 'center',
        keyboard: false
      })
        .setLngLat([vehicle.lon, vehicle.lat])
        .setPopup(vehiclePopup(vehicle, vehicle.type, vehicle.route))
        .addTo(map);
      favoriteVehicleMarkers.set(key, { marker });
    }
    for (const [key, entry] of favoriteVehicleMarkers) {
      if (!seen.has(key)) {
        entry.marker.remove();
        favoriteVehicleMarkers.delete(key);
      }
    }
  }

  async function loadFavoriteVehicles() {
    const favorites = getFavorites();
    vehiclesToggle.hidden = favorites.length === 0;
    if (!favorites.length || !favoriteVehiclesOn || !map || disposed || activeVehicleKey) return;
    if (favoriteVehiclesController) favoriteVehiclesController.abort();
    const controller = new AbortController();
    favoriteVehiclesController = controller;
    const ids = favorites.map((item) => item.id).slice(0, FAVORITE_STOPS_MAX);
    try {
      const data = await api.vehiclesByStops(ids, { signal: controller.signal });
      if (controller.signal.aborted || disposed) return;
      const allowed = new Set(getSettings().types);
      renderFavoriteVehicles((data.vehicles || []).filter((vehicle) => allowed.has(vehicle.type)));
      vehiclesToggle.classList.remove('is-error');
      vehiclesToggle.title = `Транспорт избранных остановок · ${timeLabel(data.updatedAt)}`;
    } catch (error) {
      if (isAbort(error) || disposed) return;
      vehiclesToggle.classList.add('is-error');
      vehiclesToggle.title = 'Не удалось получить транспорт избранных остановок';
    }
  }

  function startFavoriteVehicles() {
    const favorites = getFavorites();
    vehiclesToggle.hidden = favorites.length === 0;
    vehiclesToggle.classList.toggle('is-active', favoriteVehiclesOn);
    vehiclesToggle.setAttribute('aria-pressed', String(favoriteVehiclesOn));
    if (!favorites.length || !favoriteVehiclesOn) {
      stopFavoriteVehicles();
      return;
    }
    if (favoriteVehiclePoll) favoriteVehiclePoll();
    favoriteVehiclePoll = pollEvery(VEHICLE_POLL_MS, loadFavoriteVehicles);
    void loadFavoriteVehicles();
  }

  function syncSheetStar() {
    if (!sheetStop) return;
    const button = sheetEl.querySelector('[data-sheet-star]');
    if (!button) return;
    const active = isFavorite(sheetStop.id);
    button.textContent = active ? '★ В избранном' : '☆ В избранное';
    button.setAttribute('aria-pressed', String(active));
  }

  async function loadSheetBoard() {
    if (!sheetStop || !sheetController) return;
    const id = sheetStop.id;
    const boardEl = sheetEl.querySelector('[data-sheet-board]');
    const nameEl = sheetEl.querySelector('[data-sheet-name]');
    const metaEl = sheetEl.querySelector('[data-sheet-meta]');
    if (!boardEl || !nameEl || !metaEl) return;
    try {
      const data = await api.stop(id, { signal: sheetController.signal });
      if (disposed || !sheetStop || sheetStop.id !== id) return;
      const name = data.stop.name || sheetStop.name || `Остановка ${id}`;
      sheetStop.name = name;
      sheetStop.lat = data.stop.lat ?? sheetStop.lat;
      sheetStop.lon = data.stop.lon ?? sheetStop.lon;
      nameEl.textContent = name;
      const routes = visibleRoutes(data.routes, getSettings().types);
      const distance = sheetStop.distance != null ? `${distanceLabel(sheetStop.distance)} · ` : '';
      metaEl.textContent = `${distance}${routesCount(data.routes.length)}${
        data.stale ? ' · данные могли устареть' : ''
      }`;
      boardEl.innerHTML = routes.length
        ? `<div class="mini-board">${routes
            .map((route) => serviceRow(route))
            .join('')}</div><div class="sheet__meta">Нажмите на маршрут, чтобы показать его транспорт на карте.</div>`
        : `<div class="board-empty">${
            data.routes.length
              ? 'Маршруты скрыты фильтрами в настройках'
              : 'Нет данных о прибытии'
          }</div>`;
      if (
        focusSheet &&
        map &&
        Number.isFinite(data.stop.lat) &&
        Number.isFinite(data.stop.lon)
      ) {
        focusSheet = false;
        map.jumpTo({ center: [data.stop.lon, data.stop.lat], zoom: 16 });
      }
    } catch (error) {
      if (isAbort(error) || disposed) return;
      boardEl.innerHTML =
        '<div class="board-empty">Не удалось загрузить табло.<br><button class="btn btn--sm" type="button" data-sheet-retry>Повторить</button></div>';
    }
  }

  async function openSheet(stop, { focus = false } = {}) {
    if (!stop || !map) return;
    stopVehicles();
    selectedId = stop.id;
    sheetStop = { ...stop };
    focusSheet = focus;
    refreshPinStyles();
    if (sheetController) sheetController.abort();
    sheetController = new AbortController();

    sheetEl.innerHTML = `
      <div class="sheet" role="dialog" aria-label="Остановка">
        <div class="sheet__head">
          <div class="sheet__title">
            <h2 data-sheet-name>${esc(stop.name || `Остановка ${stop.id}`)}</h2>
            <div class="sheet__meta" data-sheet-meta>${
              stop.distance != null ? esc(distanceLabel(stop.distance)) : 'загрузка…'
            }</div>
          </div>
          <button class="sheet__close" type="button" data-close aria-label="Закрыть">×</button>
        </div>
        <div data-sheet-board>${skeletonBoard(3)}</div>
        <div class="sheet__actions">
          <a class="btn btn--primary btn--sm" href="#/stop/${stop.id}">Подробнее</a>
          <button class="btn btn--sm" type="button" data-sheet-star>${
            isFavorite(stop.id) ? '★ В избранном' : '☆ В избранное'
          }</button>
        </div>
        <div class="sheet__meta" data-vehicles-note hidden></div>
      </div>`;

    history.replaceState(null, '', `#/map?stop=${stop.id}`);

    if (sheetPoll) sheetPoll();
    sheetPoll = pollEvery(getSettings().refreshSec * 1000, loadSheetBoard);
    void loadSheetBoard();
  }

  function closeSheet() {
    stopVehicles();
    if (sheetController) {
      sheetController.abort();
      sheetController = null;
    }
    if (sheetPoll) {
      sheetPoll();
      sheetPoll = null;
    }
    sheetEl.innerHTML = '';
    sheetStop = null;
    selectedId = null;
    focusSheet = false;
    refreshPinStyles();
    if (location.hash.startsWith('#/map')) history.replaceState(null, '', '#/map');
  }

  async function toggleVehiclesForRoute(type, number) {
    if (!sheetStop) return;
    const key = `${type}:${number}`;
    if (activeVehicleKey === key) {
      stopVehicles();
      return;
    }
    if (!['bus', 'trolleybus', 'tram'].includes(type)) {
      ctx.toast('Для этого маршрута нет данных о транспорте');
      return;
    }
    stopVehicles({ resumeFavorites: false });
    activeVehicleKey = key;
    stopFavoriteVehicles();
    for (const row of sheetEl.querySelectorAll('.service[data-number]')) {
      row.classList.toggle('is-active', row.dataset.type === type && row.dataset.number === number);
    }
    const note = sheetEl.querySelector('[data-vehicles-note]');
    if (note) {
      note.hidden = false;
      note.textContent = `Загружаем транспорт маршрута ${number}…`;
    }
    vehiclesController = new AbortController();
    const requestController = vehiclesController;

    const load = async () => {
      try {
        const data = await api.vehicles(type, number, { signal: requestController.signal });
        if (disposed || activeVehicleKey !== key || !map) return;
        renderSelectedVehicles(data.vehicles || [], type, number);
        if (note) {
          note.textContent = `Транспорт маршрута ${number}: ${data.vehicles.length} ед. · ${timeLabel(
            data.updatedAt
          )}`;
        }
      } catch (error) {
        if (isAbort(error) || disposed) return;
        if (note) note.textContent = `Не удалось получить транспорт маршрута ${number}.`;
      }
    };

    vehiclePoll = pollEvery(15000, load);
    void load();
  }

  sheetEl.addEventListener('click', (event) => {
    if (event.target.closest('[data-close]')) {
      closeSheet();
      return;
    }
    if (event.target.closest('[data-sheet-retry]')) {
      void loadSheetBoard();
      return;
    }
    if (event.target.closest('[data-sheet-star]')) {
      if (!sheetStop) return;
      const active = toggleFavorite({
        id: sheetStop.id,
        name: sheetStop.name,
        lat: sheetStop.lat,
        lon: sheetStop.lon
      });
      syncSheetStar();
      ctx.toast(active ? 'Добавлено в избранное' : 'Удалено из избранного');
      return;
    }
    const row = event.target.closest('.service[data-number]');
    if (row) void toggleVehiclesForRoute(row.dataset.type, row.dataset.number);
  });

  vehiclesToggle.addEventListener('click', () => {
    if (!getFavorites().length) {
      ctx.toast('Добавьте остановки в избранное, чтобы видеть транспорт');
      return;
    }
    favoriteVehiclesOn = !favoriteVehiclesOn;
    startFavoriteVehicles();
    ctx.toast(favoriteVehiclesOn ? 'Транспорт избранного показан' : 'Транспорт избранного скрыт');
  });

  locateBtn.addEventListener('click', () => {
    if (!map || !navigator.geolocation) {
      ctx.toast('Геолокация недоступна в этом браузере');
      return;
    }
    locateBtn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        locateBtn.disabled = false;
        map.jumpTo({ center: [position.coords.longitude, position.coords.latitude], zoom: 15 });
      },
      () => {
        locateBtn.disabled = false;
        ctx.toast('Не удалось определить местоположение');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });

  const unsubscribe = onFavoritesChange(() => {
    refreshPinStyles();
    syncSheetStar();
    if (map && !activeVehicleKey) startFavoriteVehicles();
  });

  const onRefresh = () => {
    void loadViewport();
    if (sheetStop) void loadSheetBoard();
    if (map && !activeVehicleKey) void loadFavoriteVehicles();
  };
  window.addEventListener('app:refresh', onRefresh);

  let unwatchTheme = () => {};
  function applyMapStyle() {
    if (!map) return;
    const next = styleUrl();
    if (next === activeStyle) return;
    activeStyle = next;
    map.setStyle(next);
  }
  function watchTheme() {
    const observer = new MutationObserver(applyMapStyle);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => {
      if ((document.documentElement.dataset.theme || 'auto') === 'auto') applyMapStyle();
    };
    media?.addEventListener?.('change', onChange);
    return () => {
      observer.disconnect();
      media?.removeEventListener?.('change', onChange);
    };
  }

  void (async () => {
    try {
      ml = await waitForMapLibre();
      if (disposed) return;
      activeStyle = styleUrl();
      map = new ml.Map({
        container: mapEl,
        style: activeStyle,
        center: [MINSK.lon, MINSK.lat],
        zoom: 13,
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false
      });
      map.addControl(new ml.AttributionControl({ compact: true }), 'top-right');
      let styleFailed = false;
      map.on('error', () => {
        if (styleFailed || disposed || map.isStyleLoaded()) return;
        styleFailed = true;
        ctx.toast('Стиль карты не загрузился. Проверьте соединение.');
      });
      map.on('moveend', scheduleViewport);
      map.on('zoomend', scheduleViewport);
      requestAnimationFrame(() => map.resize());
      unwatchTheme = watchTheme();
      await loadViewport();
      startFavoriteVehicles();
      if (disposed) return;
      if (Number.isInteger(deepStopId) && deepStopId > 0) {
        void openSheet(
          { id: deepStopId, name: `Остановка ${deepStopId}`, lat: null, lon: null, routes: [] },
          { focus: true }
        );
      }
    } catch {
      if (disposed) return;
      sheetEl.innerHTML = `<div class="sheet">${errorCard({
        title: 'Карта недоступна',
        text: 'Не удалось загрузить карту OpenFreeMap. Проверьте подключение и обновите страницу.',
        action: '<button class="btn btn--primary" type="button" data-reload>Обновить</button>'
      })}</div>`;
      sheetEl.querySelector('[data-reload]')?.addEventListener('click', () => location.reload());
    }
  })();

  return () => {
    disposed = true;
    if (viewportTimer) clearTimeout(viewportTimer);
    if (nearController) nearController.abort();
    if (sheetController) sheetController.abort();
    if (sheetPoll) sheetPoll();
    if (vehiclePoll) vehiclePoll();
    if (vehiclesController) vehiclesController.abort();
    stopFavoriteVehicles();
    unwatchTheme();
    window.removeEventListener('app:refresh', onRefresh);
    unsubscribe();
    if (map) {
      map.remove();
      map = null;
    }
    stopMarkers.clear();
    selectedVehicleMarkers.clear();
    favoriteVehicleMarkers.clear();
  };
}
