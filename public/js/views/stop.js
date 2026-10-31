import { api, isAbort } from '../api.js';
import { getSettings, isFavorite, toggleFavorite } from '../store.js';
import {
  esc,
  relativeDeparture,
  routesCount,
  timeAgo,
  timeLabel,
  visibleRoutes,
  TYPE_META
} from '../format.js';
import { ICONS, boardLabels, errorCard, serviceRow, skeletonBoard } from '../components.js';
import { pollEvery } from '../util.js';

export function mount(root, ctx) {
  const stopId = Number(ctx.route.parts[1]);
  const initialFavorite = isFavorite(stopId);

  root.innerHTML = `
    <div class="page">
      <button class="back-link" type="button" data-back>${ICONS.arrowLeft}<span>Назад</span></button>
      <div class="stop-head">
        <div class="stop-head__main">
          <div class="eyebrow">Остановка</div>
          <h1 data-title>Остановка ${stopId}</h1>
          <div class="stop-head__meta"><span data-meta>загрузка…</span></div>
        </div>
        <button class="icon-btn icon-btn--star${initialFavorite ? ' is-active' : ''}" type="button" data-star aria-pressed="${initialFavorite}" aria-label="Избранное" title="Добавить в избранное">${initialFavorite ? '★' : '☆'}</button>
      </div>
      <div data-banner></div>
      <div data-live>
        <div class="live-card">
          <div class="live-card__head">
            <strong><span class="live-dot"></span> Живое табло</strong>
            <span>подключение…</span>
          </div>
          ${skeletonBoard(4)}
        </div>
      </div>
      <details class="schedule">
        <summary><span>Ближайшие рейсы по расписанию</span><span class="muted" data-schedule-hint></span></summary>
        <div class="schedule__body" data-schedule-body><div class="board-empty">Загрузка расписания…</div></div>
      </details>
      <div class="stop-actions">
        <a class="btn btn--soft" data-map-link href="#/map?stop=${stopId}">${ICONS.mapPin} На карте</a>
        <button class="btn" type="button" data-share>${ICONS.share} Поделиться</button>
        <button class="btn btn--soft" type="button" data-refresh>${ICONS.refresh} Обновить</button>
      </div>
      <p class="stop-foot">Данные: Минсктранс (неофициальный API). Живые прогнозы могут запаздывать; если источник недоступен, показывается расписание.</p>
    </div>`;

  const page = root.querySelector('.page');
  const titleEl = page.querySelector('[data-title]');
  const metaEl = page.querySelector('[data-meta]');
  const starBtn = page.querySelector('[data-star]');
  const bannerEl = page.querySelector('[data-banner]');
  const liveEl = page.querySelector('[data-live]');
  const scheduleBody = page.querySelector('[data-schedule-body]');
  const scheduleHint = page.querySelector('[data-schedule-hint]');
  const mapLink = page.querySelector('[data-map-link]');

  const controller = new AbortController();
  let stopInfo = null;
  let hasBoard = false;
  let lastFetchAt = 0;
  let lastStale = false;

  const syncStar = () => {
    const active = isFavorite(stopId);
    starBtn.classList.toggle('is-active', active);
    starBtn.setAttribute('aria-pressed', String(active));
    starBtn.textContent = active ? '★' : '☆';
    starBtn.title = active ? 'Убрать из избранного' : 'Добавить в избранное';
  };

  const renderBoard = (data) => {
    const routes = visibleRoutes(data.routes, getSettings().types);
    const name = data.stop.name || `Остановка ${stopId}`;
    titleEl.textContent = name;
    ctx.setTitle(name);
    metaEl.textContent = `${routesCount(data.routes.length)} · обновлено ${timeLabel(data.updatedAt)}`;
    liveEl.innerHTML = `
      <div class="live-card">
        <div class="live-card__head">
          <strong><span class="live-dot"></span> Живое табло</strong>
          <span data-updated>обновлено ${timeAgo(lastFetchAt)}</span>
        </div>
        ${
          routes.length
            ? `${boardLabels()}<div class="mini-board">${routes
                .map((route) => serviceRow(route))
                .join('')}</div>`
            : `<div class="board-empty">${
                data.routes.length
                  ? 'Маршруты скрыты фильтрами в настройках'
                  : 'Нет данных о прибытии'
              }</div>`
        }
      </div>`;
  };

  const loadBoard = async () => {
    try {
      const data = await api.stop(stopId, { signal: controller.signal });
      if (controller.signal.aborted) return;
      hasBoard = true;
      lastFetchAt = Date.now();
      lastStale = Boolean(data.stale);
      stopInfo = {
        id: stopId,
        name: data.stop.name || stopInfo?.name || `Остановка ${stopId}`,
        lat: data.stop.lat,
        lon: data.stop.lon
      };
      if (Number.isFinite(data.stop.lat) && Number.isFinite(data.stop.lon)) {
        mapLink.href = `#/map?stop=${stopId}`;
      }
      renderBoard(data);
      bannerEl.innerHTML = data.stale
        ? `<div class="banner">${ICONS.warning}<span>Нет связи с Минсктрансом: показаны последние полученные данные.</span></div>`
        : '';
    } catch (error) {
      if (isAbort(error)) return;
      if (!hasBoard) {
        liveEl.innerHTML = errorCard({
          title: 'Табло недоступно',
          text: 'Не удалось получить прогноз прибытия. Проверьте подключение и повторите.',
          action: '<button class="btn btn--primary" type="button" data-retry>Повторить</button>'
        });
        metaEl.textContent = 'нет связи';
        bannerEl.innerHTML = '';
      } else {
        bannerEl.innerHTML = `<div class="banner">${ICONS.warning}<span>Не удалось обновить табло — показаны последние данные.</span></div>`;
      }
    }
  };

  const renderSchedule = (data) => {
    scheduleHint.textContent = data.now ? `данные на ${data.now}` : '';
    const departures = Array.isArray(data.departures) ? data.departures : [];
    if (!departures.length) {
      scheduleBody.innerHTML =
        '<div class="board-empty">На ближайшие часы рейсов по расписанию нет.</div>';
      return;
    }
    scheduleBody.innerHTML = departures
      .map((departure) => {
        const meta = TYPE_META[departure.type] || TYPE_META.other;
        return `<div class="departure">
          <time>${esc(departure.label)}</time>
          <span class="type-badge type--${esc(departure.type)}">${meta.short}</span>
          <span class="service__no">${esc(departure.number)}</span>
          <span class="departure__dest">${esc(departure.destination || '—')}</span>
          <span class="departure__in" data-total="${Number(departure.total) || 0}">${relativeDeparture(
            departure.total
          )}</span>
        </div>`;
      })
      .join('');
  };

  const loadSchedule = async () => {
    try {
      const data = await api.schedule(stopId, { signal: controller.signal });
      if (!controller.signal.aborted) renderSchedule(data);
    } catch (error) {
      if (isAbort(error)) return;
      scheduleHint.textContent = '';
      scheduleBody.innerHTML = '<div class="board-empty">Расписание сейчас недоступно.</div>';
    }
  };

  const share = async () => {
    const name = stopInfo?.name || `Остановка ${stopId}`;
    const url = location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: name, text: `Остановка «${name}» — транспорт Минска`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      ctx.toast('Ссылка скопирована');
    } catch (error) {
      if (error?.name === 'AbortError') return;
      ctx.toast('Не удалось поделиться ссылкой');
    }
  };

  page.addEventListener('click', (event) => {
    if (event.target.closest('[data-back]')) {
      ctx.back();
      return;
    }
    if (event.target.closest('[data-retry]')) {
      void loadBoard();
      return;
    }
    if (event.target.closest('[data-refresh]')) {
      void loadBoard();
      void loadSchedule();
      ctx.toast('Обновляем табло');
      return;
    }
    if (event.target.closest('[data-share]')) {
      void share();
      return;
    }
    if (event.target.closest('[data-star]')) {
      const name = stopInfo?.name || `Остановка ${stopId}`;
      const active = toggleFavorite({
        id: stopId,
        name,
        lat: stopInfo?.lat ?? null,
        lon: stopInfo?.lon ?? null
      });
      syncStar();
      ctx.toast(active ? 'Добавлено в избранное' : 'Удалено из избранного');
    }
  });

  const stopPoll = pollEvery(getSettings().refreshSec * 1000, loadBoard);
  const schedulePoll = pollEvery(60000, loadSchedule);
  const ticker = setInterval(() => {
    if (hasBoard && !lastStale) {
      const label = liveEl.querySelector('[data-updated]');
      if (label) label.textContent = `обновлено ${timeAgo(lastFetchAt)}`;
    }
    for (const el of scheduleBody.querySelectorAll('[data-total]')) {
      el.textContent = relativeDeparture(Number(el.dataset.total));
    }
  }, 10000);

  const onRefresh = () => {
    void loadBoard();
    void loadSchedule();
  };
  window.addEventListener('app:refresh', onRefresh);

  void loadBoard();
  void loadSchedule();

  return () => {
    controller.abort();
    stopPoll();
    schedulePoll();
    clearInterval(ticker);
    window.removeEventListener('app:refresh', onRefresh);
  };
}
