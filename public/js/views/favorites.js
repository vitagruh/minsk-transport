import { api, isAbort } from '../api.js';
import { getFavorites, getSettings, onFavoritesChange, toggleFavorite } from '../store.js';
import { esc, routesCount, timeAgo, visibleRoutes } from '../format.js';
import { ICONS, emptyState, miniBoard, skeletonBoard } from '../components.js';
import { mapLimit, pollEvery } from '../util.js';

const TOP_ROUTES = 3;

export function mount(root, ctx) {
  root.innerHTML = `
    <div class="page">
      <div class="page__head">
        <div>
          <div class="eyebrow">Минск · живое табло</div>
          <h1>Избранное</h1>
        </div>
        <a class="btn btn--soft btn--sm" href="#/search">Добавить</a>
      </div>
      <div data-body></div>
    </div>`;

  const body = root.querySelector('[data-body]');
  const controller = new AbortController();
  let stopPoll = null;
  let ticker = null;
  let loading = false;

  const cards = () => [...body.querySelectorAll('.stop-card')];

  const loadCard = async (card) => {
    const id = Number(card.dataset.stop);
    const boardEl = card.querySelector('[data-board]');
    const updatedEl = card.querySelector('[data-updated]');
    const countEl = card.querySelector('[data-count]');
    try {
      const data = await api.stop(id, { signal: controller.signal });
      const routes = visibleRoutes(data.routes, getSettings().types);
      boardEl.innerHTML = routes.length
        ? miniBoard(routes.slice(0, TOP_ROUTES))
        : `<div class="board-empty">${
            data.routes.length
              ? 'Маршруты скрыты фильтрами в настройках'
              : 'Нет данных о прибытии'
          }</div>`;
      if (countEl) countEl.textContent = `${routesCount(data.routes.length)} · сейчас`;
      card.dataset.updated = String(Date.now());
      card.dataset.stale = data.stale ? '1' : '';
      updatedEl.textContent = data.stale
        ? 'данные могли устареть'
        : `обновлено ${timeAgo(Date.now())}`;
    } catch (error) {
      if (isAbort(error)) return;
      if (!card.dataset.loaded) {
        boardEl.innerHTML = `<div class="board-empty">Не удалось загрузить табло. <button class="btn btn--sm" type="button" data-retry="${id}">Повторить</button></div>`;
      }
      updatedEl.textContent = 'нет связи';
    } finally {
      card.dataset.loaded = '1';
    }
  };

  const loadAll = async () => {
    if (loading) return;
    if (document.visibilityState !== 'visible') return;
    const list = cards();
    if (!list.length) return;
    loading = true;
    try {
      await mapLimit(list, 3, loadCard);
    } finally {
      loading = false;
    }
  };

  const renderBody = () => {
    if (stopPoll) {
      stopPoll();
      stopPoll = null;
    }
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    loading = false;
    const favorites = getFavorites();
    if (!favorites.length) {
      body.innerHTML = emptyState({
        icon: ICONS.bus,
        title: 'Пока пусто',
        text: 'Добавьте остановки — и здесь появится живое табло с ближайшими автобусами, троллейбусами и трамваями.',
        actions:
          '<a class="btn btn--primary" href="#/search">Найти остановку</a><a class="btn" href="#/map">Открыть карту</a>'
      });
      return;
    }
    body.innerHTML = `<div class="fav-list">${favorites.map(cardMarkup).join('')}</div>`;
    void loadAll();
    stopPoll = pollEvery(getSettings().refreshSec * 1000, loadAll);
    ticker = setInterval(() => {
      for (const card of cards()) {
        const at = Number(card.dataset.updated);
        if (!at || card.dataset.stale) continue;
        const label = card.querySelector('[data-updated]');
        if (label) label.textContent = `обновлено ${timeAgo(at)}`;
      }
    }, 10000);
  };

  body.addEventListener('click', (event) => {
    const retry = event.target.closest('[data-retry]');
    if (retry) {
      event.stopPropagation();
      const card = retry.closest('.stop-card');
      if (card) void loadCard(card);
      return;
    }
    const star = event.target.closest('[data-star]');
    if (star) {
      event.stopPropagation();
      const favorite = getFavorites().find((item) => item.id === Number(star.dataset.star));
      if (favorite) toggleFavorite(favorite);
      return;
    }
    if (event.target.closest('a')) return;
    const card = event.target.closest('.stop-card');
    if (card) location.hash = `#/stop/${card.dataset.stop}`;
  });

  const onRefresh = () => {
    void loadAll();
  };
  window.addEventListener('app:refresh', onRefresh);
  const unsubscribe = onFavoritesChange(renderBody);

  renderBody();

  return () => {
    controller.abort();
    if (stopPoll) stopPoll();
    if (ticker) clearInterval(ticker);
    window.removeEventListener('app:refresh', onRefresh);
    unsubscribe();
  };
}

function cardMarkup(favorite) {
  return `
    <article class="stop-card" data-stop="${favorite.id}">
      <div class="stop-card__head">
        <div class="stop-card__title">
          <h2>${esc(favorite.name)}</h2>
          <div class="muted" data-count>остановка</div>
        </div>
        <button class="icon-btn icon-btn--star is-active" type="button" data-star="${favorite.id}" aria-label="Убрать из избранного" aria-pressed="true" title="Убрать из избранного">★</button>
      </div>
      <div data-board>${skeletonBoard(3)}</div>
      <div class="stop-card__foot">
        <span data-updated>обновление…</span>
        <span aria-hidden="true">·</span>
        <a href="#/map?stop=${favorite.id}">на карте</a>
      </div>
    </article>`;
}
