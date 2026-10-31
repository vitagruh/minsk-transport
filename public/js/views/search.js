import { api, isAbort } from '../api.js';
import { isFavorite, toggleFavorite } from '../store.js';
import { distanceLabel, esc, routesCount } from '../format.js';
import { ICONS, emptyState, errorCard, routeChips } from '../components.js';
import { debounce } from '../util.js';

export function mount(root, ctx) {
  root.innerHTML = `
    <div class="page">
      <div class="page__head">
        <div>
          <div class="eyebrow">Справочник Минска</div>
          <h1>Поиск остановки</h1>
        </div>
      </div>
      <div class="searchbar">
        ${ICONS.search}
        <input type="search" inputmode="search" autocomplete="off" spellcheck="false" placeholder="Название остановки, например «Площадь Победы»" aria-label="Поиск остановки" data-input />
        <button class="searchbar__clear" type="button" data-clear aria-label="Очистить" title="Очистить" hidden>×</button>
      </div>
      <div class="search-actions">
        <button class="chip-btn" type="button" data-near>${ICONS.locate} Рядом со мной</button>
        <a class="chip-btn" href="#/map">${ICONS.mapPin} На карте</a>
      </div>
      <div data-results></div>
    </div>`;

  const page = root.querySelector('.page');
  const input = page.querySelector('[data-input]');
  const clearBtn = page.querySelector('[data-clear]');
  const resultsEl = page.querySelector('[data-results]');
  const nearBtn = page.querySelector('[data-near]');

  let searchController = null;
  let nearController = null;
  let buildingTimer = null;
  let results = [];

  const idle = () => {
    results = [];
    resultsEl.innerHTML = emptyState({
      icon: ICONS.search,
      title: 'Найдите остановку',
      text: 'Введите хотя бы два символа названия. Поиск идёт по справочнику остановок Минска, собранному из маршрутов Минсктранса.',
      actions: '<button class="btn btn--soft" type="button" data-near-cta>Остановки рядом</button>'
    });
  };

  const skeleton = () => {
    resultsEl.innerHTML = `<div class="results">${'<div class="skeleton skeleton-row"></div>'.repeat(4)}</div>`;
  };

  const stopMeta = (stop, showDistance) => {
    const parts = [];
    if (stop.routes?.length) parts.push(routesCount(stop.routes.length));
    if (showDistance && stop.distance != null) parts.push(distanceLabel(stop.distance));
    if (!parts.length) parts.push('остановка');
    return parts.join(' · ');
  };

  const resultMarkup = (stop, showDistance) => {
    const active = isFavorite(stop.id);
    return `<div class="result" role="button" tabindex="0" data-stop="${stop.id}" aria-label="${esc(stop.name)}">
      <div class="result__main">
        <div class="result__name"><span>${esc(stop.name)}</span></div>
        <div class="result__meta">${esc(stopMeta(stop, showDistance))}</div>
        ${routeChips(stop.routes)}
      </div>
      <button class="icon-btn icon-btn--star${active ? ' is-active' : ''}" type="button" data-star="${stop.id}" aria-pressed="${active}" aria-label="${active ? 'Убрать из избранного' : 'Добавить в избранное'}" title="${active ? 'Убрать из избранного' : 'Добавить в избранное'}">${active ? '★' : '☆'}</button>
    </div>`;
  };

  const renderResults = (list, showDistance) => {
    results = list;
    if (!list.length) {
      resultsEl.innerHTML = emptyState({
        icon: ICONS.search,
        title: 'Ничего не нашлось',
        text: 'Попробуйте другое название или уточните запрос.'
      });
      return;
    }
    resultsEl.innerHTML = `<div class="results">${list
      .map((stop) => resultMarkup(stop, showDistance))
      .join('')}</div>`;
  };

  const renderBuilding = (progress) => {
    const done = Number(progress?.done) || 0;
    const total = Number(progress?.total) || 0;
    const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 8;
    resultsEl.innerHTML = `<div class="progress-card">
      <h2>Готовим справочник остановок</h2>
      <p>Первый запуск: загружаем маршруты Минсктранса, это может занять пару минут.${
        total ? ` Готово ${done} из ${total}.` : ''
      }</p>
      <div class="progress"><div class="progress__bar" style="width:${percent}%"></div></div>
    </div>`;
  };

  const clearBuildingTimer = () => {
    if (buildingTimer) {
      clearTimeout(buildingTimer);
      buildingTimer = null;
    }
  };

  const runSearch = async (query) => {
    clearBuildingTimer();
    if (query.length < 2) {
      idle();
      return;
    }
    nearBtn.classList.remove('is-active');
    if (searchController) searchController.abort();
    searchController = new AbortController();
    skeleton();
    try {
      const data = await api.search(query, 30, { signal: searchController.signal });
      renderResults(data.results || [], false);
    } catch (error) {
      if (isAbort(error)) return;
      if (error.status === 503 && error.code === 'directory_building') {
        renderBuilding(error.payload?.progress);
        buildingTimer = setTimeout(() => {
          buildingTimer = null;
          if (input.value.trim() === query) void runSearch(query);
        }, 2500);
        return;
      }
      resultsEl.innerHTML = errorCard({
        title: 'Поиск недоступен',
        text:
          error.code === 'upstream_unavailable'
            ? 'Справочник ещё собирается или Минсктранс временно недоступен. Попробуйте через минуту.'
            : 'Не удалось выполнить запрос. Проверьте подключение к серверу приложения.',
        action: '<button class="btn btn--primary" type="button" data-search-retry>Повторить</button>'
      });
    }
  };

  const debouncedSearch = debounce((query) => {
    void runSearch(query);
  }, 250);

  const locate = () => {
    if (!navigator.geolocation) {
      ctx.toast('Геолокация недоступна в этом браузере');
      return;
    }
    nearBtn.disabled = true;
    resultsEl.innerHTML = '<div class="board-empty">Определяем местоположение…</div>';
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        nearBtn.disabled = false;
        nearBtn.classList.add('is-active');
        clearBuildingTimer();
        if (nearController) nearController.abort();
        nearController = new AbortController();
        skeleton();
        try {
          const data = await api.near(
            {
              lat: position.coords.latitude,
              lon: position.coords.longitude,
              limit: 40,
              radius: 1500
            },
            { signal: nearController.signal }
          );
          renderResults(data.results || [], true);
        } catch (error) {
          if (isAbort(error)) return;
          resultsEl.innerHTML = errorCard({
            title: 'Не удалось получить остановки рядом',
            text: 'Проверьте подключение и попробуйте ещё раз.',
            action: '<button class="btn btn--primary" type="button" data-near-cta>Повторить</button>'
          });
        }
      },
      () => {
        nearBtn.disabled = false;
        ctx.toast('Не удалось определить местоположение');
        idle();
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 120000 }
    );
  };

  input.addEventListener('input', () => {
    const query = input.value.trim();
    clearBtn.hidden = !query;
    nearBtn.classList.remove('is-active');
    clearBuildingTimer();
    if (!query) {
      debouncedSearch.cancel();
      idle();
      return;
    }
    debouncedSearch(query);
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.hidden = true;
    debouncedSearch.cancel();
    clearBuildingTimer();
    idle();
    input.focus({ preventScroll: true });
  });

  nearBtn.addEventListener('click', locate);

  resultsEl.addEventListener('click', (event) => {
    if (event.target.closest('[data-near-cta]')) {
      locate();
      return;
    }
    if (event.target.closest('[data-search-retry]')) {
      void runSearch(input.value.trim());
      return;
    }
    const star = event.target.closest('[data-star]');
    if (star) {
      event.stopPropagation();
      const stop = results.find((item) => item.id === Number(star.dataset.star));
      if (stop) {
        const active = toggleFavorite(stop);
        star.classList.toggle('is-active', active);
        star.setAttribute('aria-pressed', String(active));
        star.textContent = active ? '★' : '☆';
        star.title = active ? 'Убрать из избранного' : 'Добавить в избранное';
        ctx.toast(active ? 'Добавлено в избранное' : 'Удалено из избранного');
      }
      return;
    }
    const row = event.target.closest('.result[data-stop]');
    if (row) location.hash = `#/stop/${row.dataset.stop}`;
  });

  resultsEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (event.target.closest('button')) return;
    const row = event.target.closest('.result[data-stop]');
    if (!row) return;
    event.preventDefault();
    location.hash = `#/stop/${row.dataset.stop}`;
  });

  idle();
  setTimeout(() => input.focus({ preventScroll: true }), 60);

  return () => {
    debouncedSearch.cancel();
    if (searchController) searchController.abort();
    if (nearController) nearController.abort();
    if (buildingTimer) clearTimeout(buildingTimer);
  };
}
