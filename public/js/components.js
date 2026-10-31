import { esc, TYPE_META } from './format.js';

export const ICONS = {
  bus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="3.5" width="16" height="13" rx="3"/><path d="M4 10h16M8 16.5V19M16 16.5V19M8 7h8"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5" stroke-linecap="round"/></svg>',
  locate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke-linecap="round"/></svg>',
  mapPin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.5"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="6" cy="12" r="2.5"/><circle cx="17" cy="6" r="2.5"/><circle cx="17" cy="18" r="2.5"/><path d="m8.3 10.8 6.4-3.6M8.3 13.2l6.4 3.6" stroke-linecap="round"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrowLeft: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m14 6-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warning:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4 3.5 19h17z" stroke-linejoin="round"/><path d="M12 9v4M12 16.5v.1" stroke-linecap="round"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m12 3.6 2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z" stroke-linejoin="round"/></svg>'
};

const TYPE_ORDER = ['bus', 'trolleybus', 'tram', 'metro', 'other'];

export function serviceRow(route, { large = false } = {}) {
  const meta = TYPE_META[route.type] || TYPE_META.other;
  const arrivals = Array.isArray(route.arrivals) ? route.arrivals : [];
  const [first, second] = arrivals;
  let timesCell;
  if (first) {
    const isNow = first.minutes === 0;
    const unit = first.scheduled ? 'по расп.' : 'мин';
    const secondHtml = second ? `<i>${esc(second.text)}</i>` : '';
    timesCell = `<span class="service__times"><b${isNow ? ' class="is-now"' : ''}>${esc(
      first.text
    )}</b><small>${unit}</small>${secondHtml}</span>`;
  } else {
    timesCell = '<span class="service__empty">нет данных</span>';
  }
  return `<div class="service${large ? ' service--lg' : ''}" data-type="${esc(
    route.type
  )}" data-number="${esc(route.number)}">
    <span class="type-badge type--${esc(route.type)}">${meta.short}</span>
    <span class="service__no">${esc(route.number)}</span>
    <span class="service__dest">${esc(route.destination || '—')}</span>
    ${timesCell}
  </div>`;
}

export function miniBoard(routes) {
  return `<div class="mini-board">${routes.map((route) => serviceRow(route)).join('')}</div>`;
}

export function boardLabels() {
  return `<div class="board-labels" aria-hidden="true"><span>Тип</span><span>№</span><span>Направление</span><span>Прибытие</span></div>`;
}

export function routeChips(routes, limit = 6) {
  const list = Array.isArray(routes) ? routes : [];
  if (!list.length) return '';
  const sorted = [...list].sort((a, b) => {
    const order = TYPE_ORDER.indexOf(a.tt) - TYPE_ORDER.indexOf(b.tt);
    return order !== 0 ? order : a.number.localeCompare(b.number, 'ru', { numeric: true });
  });
  const shown = sorted.slice(0, limit);
  const rest = sorted.length - shown.length;
  return `<div class="route-chips">${shown
    .map((route) => `<span class="route-chip type--${esc(route.tt)}">${esc(route.number)}</span>`)
    .join('')}${rest > 0 ? `<span class="route-chip">+${rest}</span>` : ''}</div>`;
}

export function skeletonBoard(rows = 4) {
  return `<div class="skeleton skeleton-line skeleton-title"></div>${Array.from(
    { length: rows },
    () => '<div class="skeleton skeleton-row"></div>'
  ).join('')}`;
}

export function emptyState({ icon = ICONS.bus, title, text, actions = '' }) {
  return `<div class="empty">
    <div class="empty__icon">${icon}</div>
    <h2>${esc(title)}</h2>
    <p>${esc(text)}</p>
    ${actions ? `<div class="empty__actions">${actions}</div>` : ''}
  </div>`;
}

export function errorCard({ title = 'Не удалось загрузить', text = '', action = '' }) {
  return `<div class="error-card"><h2>${esc(title)}</h2><p>${esc(text)}</p>${action}</div>`;
}
