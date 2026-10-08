import type { SysConfig } from '@netsim/engine';

/** Systemuhr: ohne `clock set` startet sie wie ein IOS-Gerät am 1. März 1993 (nicht autoritativ, `*`). */
export const BASE_DATE = Date.UTC(1993, 2, 1);
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const FULL = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const p2 = (n: number): string => String(n).padStart(2, '0');

/** Aktuelle Uhrzeit des Geräts in ms seit der Unix-Epoche (aus virtueller Zeit + gesetzter Uhr). */
export const wallMs = (sys: Pick<SysConfig, 'clock'>, nowUs: number): number =>
  sys.clock ? sys.clock.baseMs + (nowUs - sys.clock.atUs) / 1000 : BASE_DATE + nowUs / 1000;

/** `10:30:05.123 UTC Sat Mar 15 2025` (mit `*` solange die Uhr nicht gesetzt wurde). */
export function formatClock(sys: Pick<SysConfig, 'clock'>, nowUs: number): string {
  const t = new Date(wallMs(sys, nowUs));
  return `${sys.clock ? '' : '*'}${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}:${p2(t.getUTCSeconds())}.${String(t.getUTCMilliseconds()).padStart(3, '0')} UTC ${DAYS[t.getUTCDay()]} ${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()} ${t.getUTCFullYear()}`;
}

/** Zeitstempel für `debug`-Ausgaben: `*Mar  1 00:00:12.345` bzw. `Mar 15 10:30:05.123`. */
export function debugStamp(sys: Pick<SysConfig, 'clock'>, nowUs: number): string {
  const t = new Date(wallMs(sys, nowUs));
  return `${sys.clock ? '' : '*'}${MONTHS[t.getUTCMonth()]} ${String(t.getUTCDate()).padStart(2, ' ')} ${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}:${p2(t.getUTCSeconds())}.${String(t.getUTCMilliseconds()).padStart(3, '0')}`;
}

const monthIndex = (s: string): number => {
  const low = s.toLowerCase();
  if (low.length < 3) return -1;
  return FULL.findIndex((m) => m.startsWith(low));
};

/** `HH:MM:SS DAY MONTH YEAR` bzw. `HH:MM:SS MONTH DAY YEAR` → ms seit Epoche oder Fehlertext. */
export function parseClockSet(
  time: string,
  a: string,
  b: string,
  year: string,
): { ms: number } | { error: string } {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!m) return { error: '% Invalid input detected at the time field' };
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const ss = Number(m[3] ?? 0);
  if (hh > 23 || mm > 59 || ss > 59) return { error: '% Invalid time' };
  const numFirst = /^\d+$/.test(a);
  const day = Number(numFirst ? a : b);
  const mon = monthIndex(numFirst ? b : a);
  const y = Number(year);
  if (mon < 0 || !Number.isInteger(day) || day < 1) return { error: '% Invalid date' };
  if (!/^\d{4}$/.test(year) || y < 1993 || y > 2035) return { error: '% Invalid year' };
  const dim = new Date(Date.UTC(y, mon + 1, 0)).getUTCDate();
  if (day > dim) return { error: '% Invalid day of month' };
  return { ms: Date.UTC(y, mon, day, hh, mm, ss) };
}
