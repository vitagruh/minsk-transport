const TYPE_BY_LETTER = {
  'А': 'bus',
  'A': 'bus',
  'Т': 'trolleybus',
  'T': 'trolleybus',
  '#': 'tram',
  'М': 'metro',
  'M': 'metro'
};

const TYPE_BY_CODE = { 0: 'bus', 1: 'trolleybus', 2: 'tram' };
const TYPE_LETTER = { bus: 'А', trolleybus: 'Т', tram: '#', metro: 'М', other: '•' };
const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const SCHEDULE_HORIZON_MIN = 8 * 60;

export function cleanName(value) {
  if (value == null) return '';
  return String(value)
    .replace(/''([^']*)''/g, '«$1»')
    .replace(/''/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function typeFromLetter(letter) {
  return TYPE_BY_LETTER[String(letter || '').trim()] || 'other';
}

export function typeFromCode(code) {
  return TYPE_BY_CODE[Number(code)] || 'other';
}

export function typeLetter(type) {
  return TYPE_LETTER[type] || '•';
}

export function parseDotNetDate(value) {
  if (typeof value === 'string') {
    const match = value.match(/\/Date\((\d+)\)\//);
    if (match) return Number(match[1]);
  }
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function parseArrival(text, attrs) {
  const raw = text == null ? '' : String(text).trim();
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  return {
    text: raw,
    minutes: digits ? Number(digits) : null,
    lessThan: raw.startsWith('<'),
    visible: (attrs & 1) === 1,
    final: (attrs & 2) === 2,
    scheduled: (attrs & 4) === 4
  };
}

function arrivalRank(arrival) {
  if (!arrival) return Number.POSITIVE_INFINITY;
  if (arrival.lessThan) return 0.5;
  return arrival.minutes ?? Number.POSITIVE_INFINITY;
}

export function normalizeScoreboard(raw, fallbackStop = null) {
  const rawRoutes = Array.isArray(raw?.Routes) ? raw.Routes : [];
  const routes = rawRoutes
    .map((route) => {
      const info = Array.isArray(route.Info) ? route.Info : [];
      const attrs = Array.isArray(route.Attrs) ? route.Attrs : [];
      const arrivals = info
        .map((text, index) => parseArrival(text, Number(attrs[index] || 0)))
        .filter(Boolean)
        .sort((a, b) => arrivalRank(a) - arrivalRank(b));
      return {
        type: typeFromLetter(route.Type),
        number: String(route.Number ?? '').trim(),
        destination: cleanName(route.EndStop),
        arrivals,
        vehicles: [route.VehicleNumberFirst, route.VehicleNumberSecond].map(cleanName).filter(Boolean)
      };
    })
    .filter((route) => route.number)
    .sort((a, b) => {
      const diff = arrivalRank(a.arrivals[0]) - arrivalRank(b.arrivals[0]);
      return diff !== 0 ? diff : a.number.localeCompare(b.number, 'ru', { numeric: true });
    });

  const lat = Number(raw?.Latitude);
  const lon = Number(raw?.Longitude);
  const bearing = Number(raw?.Bearing);
  const stop = {
    id: fallbackStop?.id ?? null,
    name: cleanName(raw?.StopName) || cleanName(fallbackStop?.name),
    lat: Number.isFinite(lat) ? lat : fallbackStop?.lat ?? null,
    lon: Number.isFinite(lon) ? lon : fallbackStop?.lon ?? null,
    bearing: Number.isFinite(bearing) && bearing >= 0 ? bearing : fallbackStop?.bearing ?? null
  };

  return {
    stop,
    updatedAt: parseDotNetDate(raw?.Timestamp) || Date.now(),
    routes
  };
}

export function normalizeVehicles(raw, type) {
  const list = Array.isArray(raw?.Vehicles) ? raw.Vehicles : Array.isArray(raw) ? raw : [];
  return list
    .map((vehicle) => {
      const lat = Number(vehicle.Latitude);
      const lon = Number(vehicle.Longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const tripType = Number(vehicle.TripType) || 0;
      return {
        id: Number(vehicle.Id) || null,
        lat,
        lon,
        tripType,
        direction: tripType === 10 ? 'A' : 'B',
        endStopId: Number(vehicle.IdEndStop) || null,
        lowFloor: Number(vehicle.IsApparel) === 1,
        type
      };
    })
    .filter(Boolean);
}

function minskNow() {
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Minsk',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = formatter.formatToParts(new Date());
  const read = (type) => parts.find((part) => part.type === type)?.value || '';
  const hour = Number(read('hour'));
  const minute = Number(read('minute'));
  return {
    weekday: read('weekday').toLowerCase().replace(/\./g, ''),
    minutes: hour * 60 + minute,
    label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  };
}

function collectTimes(schedule, dayLabel, sinceMinutes) {
  const day = (schedule.AllDaysOfWeek || []).find((entry) => entry.Day === dayLabel);
  if (!day) return [];
  const times = [];
  for (const line of day.HourLines || []) {
    const hour = Number(line.Hour);
    if (!Number.isFinite(hour)) continue;
    const serviceHour = hour < 4 ? hour + 24 : hour;
    for (const part of String(line.Minutes || '').split(/\s+/)) {
      const minute = Number(part);
      if (!Number.isFinite(minute)) continue;
      const total = serviceHour * 60 + minute;
      const inMinutes = total - sinceMinutes;
      if (inMinutes < 0 || inMinutes > SCHEDULE_HORIZON_MIN) continue;
      times.push({
        total,
        inMinutes,
        label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
      });
    }
  }
  return times;
}

export function normalizeSchedule(raw) {
  const now = minskNow();
  const todayIndex = WEEKDAYS.indexOf(now.weekday);
  const yesterday = todayIndex >= 0 ? WEEKDAYS[(todayIndex + 6) % 7] : now.weekday;
  const schedules = Array.isArray(raw?.Schedules) ? raw.Schedules : [];

  const routes = schedules
    .map((schedule) => {
      const route = schedule?.Route || {};
      const next = [
        ...collectTimes(schedule, now.weekday, now.minutes),
        ...(now.minutes < 5 * 60 ? collectTimes(schedule, yesterday, now.minutes + 24 * 60) : [])
      ]
        .sort((a, b) => a.total - b.total)
        .slice(0, 3);
      return {
        type: typeFromCode(route.Type),
        number: String(route.Number ?? '').trim(),
        destination: cleanName(route.ShtName),
        next
      };
    })
    .filter((route) => route.number);

  const departures = routes
    .flatMap((route) =>
      route.next.map((time) => ({
        ...time,
        type: route.type,
        number: route.number,
        destination: route.destination
      }))
    )
    .sort((a, b) => a.total - b.total)
    .slice(0, 12);

  return {
    now: now.label,
    weekday: now.weekday,
    routes,
    departures
  };
}
