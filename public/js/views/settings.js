import { api } from '../api.js';
import {
  clearFavorites,
  getFavorites,
  getSettings,
  onFavoritesChange,
  updateSettings
} from '../store.js';
import { esc, formatDate, plural } from '../format.js';
import { pollEvery } from '../util.js';

const THEMES = [
  ['auto', 'Авто'],
  ['light', 'Светлая'],
  ['dark', 'Тёмная']
];

const TYPES = [
  ['bus', 'Автобусы'],
  ['trolleybus', 'Троллейбусы'],
  ['tram', 'Трамваи'],
  ['metro', 'Метро']
];

export function mount(root, ctx) {
  const settings = getSettings();

  root.innerHTML = `
    <div class="page">
      <div class="page__head">
        <div>
          <div class="eyebrow">Настройки</div>
          <h1>Приложение</h1>
        </div>
      </div>

      <div class="group">
        <div class="group__title">Оформление</div>
        <div class="row">
          <div class="row__label">Тема<div class="row__hint">Как в системе, светлая или тёмная</div></div>
          <div class="segmented" data-theme>
            ${THEMES.map(
              ([value, label]) => `<button type="button" data-value="${value}">${label}</button>`
            ).join('')}
          </div>
        </div>
      </div>

      <div class="group">
        <div class="group__title">Обновление табло</div>
        <div class="row">
          <div class="row__label">Интервал<div class="row__hint">Как часто обновлять прогноз прибытия</div></div>
          <div class="segmented" data-refresh>
            ${[10, 20, 30, 60]
              .map((sec) => `<button type="button" data-value="${sec}">${sec} с</button>`)
              .join('')}
          </div>
        </div>
      </div>

      <div class="group">
        <div class="group__title">Виды транспорта</div>
        <div class="toggle-chips" data-types>
          ${TYPES.map(
            ([value, label]) => `<label class="toggle-chip type--${value}">
              <input type="checkbox" value="${value}" data-type ${
                settings.types.includes(value) ? 'checked' : ''
              }>
              <span>${label}</span>
            </label>`
          ).join('')}
        </div>
      </div>

      <div class="group">
        <div class="group__title">Справочник остановок</div>
        <div class="dir-status" data-dir>Загрузка…</div>
        <div class="row">
          <div class="row__label">Пересобрать справочник<div class="row__hint">Около 250 запросов к Минсктрансу, занимает пару минут</div></div>
          <button class="btn btn--sm" type="button" data-rebuild>Собрать</button>
        </div>
      </div>

      <div class="group">
        <div class="group__title">Данные</div>
        <div class="row">
          <div class="row__label">Избранные остановки<div class="row__hint" data-fav-count>…</div></div>
          <button class="btn btn--sm btn--danger" type="button" data-clear>Очистить</button>
        </div>
      </div>

      <div class="about">
        <p>Живые прогнозы приходят с сайта <a href="https://www.minsktrans.by" target="_blank" rel="noopener">Минсктранса</a> через его неофициальный JSON-интерфейс. Это независимый проект: данные могут задерживаться и не гарантированы.</p>
        <p>Карта — <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> на основе данных <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>. Ключи API, аккаунты и реклама не используются.</p>
      </div>
    </div>`;

  const page = root.querySelector('.page');
  const themeGroup = page.querySelector('[data-theme]');
  const refreshGroup = page.querySelector('[data-refresh]');
  const typesGroup = page.querySelector('[data-types]');
  const dirEl = page.querySelector('[data-dir]');
  const rebuildBtn = page.querySelector('[data-rebuild]');
  const clearBtn = page.querySelector('[data-clear]');
  const favCountEl = page.querySelector('[data-fav-count]');

  const syncSegments = (group, value) => {
    for (const button of group.querySelectorAll('button[data-value]')) {
      button.classList.toggle('is-active', button.dataset.value === String(value));
    }
  };

  syncSegments(themeGroup, settings.theme);
  syncSegments(refreshGroup, settings.refreshSec);

  themeGroup.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;
    updateSettings({ theme: button.dataset.value });
    syncSegments(themeGroup, button.dataset.value);
  });

  refreshGroup.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;
    updateSettings({ refreshSec: Number(button.dataset.value) });
    syncSegments(refreshGroup, button.dataset.value);
  });

  typesGroup.addEventListener('change', (event) => {
    const input = event.target.closest('input[data-type]');
    if (!input) return;
    const checked = [...typesGroup.querySelectorAll('input[data-type]:checked')].map(
      (element) => element.value
    );
    if (!checked.length) {
      input.checked = true;
      ctx.toast('Оставьте хотя бы один вид транспорта');
      return;
    }
    updateSettings({ types: checked });
  });

  const updateFavCount = () => {
    const count = getFavorites().length;
    favCountEl.textContent = count
      ? plural(count, 'остановка', 'остановки', 'остановок')
      : 'Список пуст';
  };

  const renderDirectory = (directory) => {
    if (!directory) {
      dirEl.textContent = 'Справочник недоступен.';
      return;
    }
    const rows = [
      `<div>Остановок: <b>${Number(directory.stops) || 0}</b> · маршрутов: <b>${
        Number(directory.routes) || 0
      }</b></div>`,
      `<div>Обновлён: <b>${esc(formatDate(directory.builtAt))}</b></div>`
    ];
    if (directory.building) {
      const done = Number(directory.progress?.done) || 0;
      const total = Number(directory.progress?.total) || 0;
      const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 8;
      rows.push(`<div>Идёт сборка: <b>${done}${total ? ` / ${total}` : ''}</b></div>`);
      rows.push(
        `<div class="progress"><div class="progress__bar" style="width:${percent}%"></div></div>`
      );
    }
    if (directory.lastError) {
      rows.push(`<div>Последняя ошибка: ${esc(directory.lastError)}</div>`);
    }
    dirEl.innerHTML = rows.join('');
    rebuildBtn.disabled = Boolean(directory.building);
  };

  const updateHealth = async () => {
    try {
      const data = await api.health();
      renderDirectory(data.directory);
    } catch {
      dirEl.textContent = 'Сервер приложения недоступен.';
      rebuildBtn.disabled = false;
    }
  };

  rebuildBtn.addEventListener('click', async () => {
    rebuildBtn.disabled = true;
    try {
      await api.rebuild();
      ctx.toast('Сборка справочника запущена');
    } catch (error) {
      ctx.toast(
        error.status === 429
          ? 'Сборка уже запускалась — повторите через минуту'
          : 'Не удалось запустить сборку'
      );
      rebuildBtn.disabled = false;
    }
    void updateHealth();
  });

  clearBtn.addEventListener('click', () => {
    if (!getFavorites().length) {
      ctx.toast('Избранное уже пусто');
      return;
    }
    if (!confirm('Удалить все избранные остановки?')) return;
    clearFavorites();
    ctx.toast('Избранное очищено');
  });

  updateFavCount();
  const unsubscribe = onFavoritesChange(updateFavCount);
  const stopPoll = pollEvery(5000, updateHealth);
  void updateHealth();

  return () => {
    stopPoll();
    unsubscribe();
  };
}
