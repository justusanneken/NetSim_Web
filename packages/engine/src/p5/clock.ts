import { HOST_EPOCH_MS, mgmtOf, newClock } from '../p5defaults';
import type { ClockCfg } from '../p5types';
import type { Device } from '../types';

/** Uhr eines Geräts (Host: eigene Uhr, Router/Switch: `mgmt.clock`). Beim ersten Zugriff angelegt. */
export function clockOf(dev: Device): ClockCfg | undefined {
  const c = dev.config;
  if (c.kind === 'host') return (c.clock ??= newClock(HOST_EPOCH_MS));
  if (c.kind === 'router' || c.kind === 'switch') return mgmtOf(c.sys).clock;
  return undefined;
}

/** Gerätezeit in Epoch-Millisekunden zur virtuellen Zeit `nowUs`. */
export function deviceTimeMs(dev: Device, nowUs: number): number {
  const c = clockOf(dev);
  return (c?.baseMs ?? HOST_EPOCH_MS) + Math.floor(nowUs / 1000);
}

/** Uhr auf `epochMs` stellen (manuell oder per NTP). */
export function setDeviceTime(dev: Device, nowUs: number, epochMs: number): void {
  const c = clockOf(dev);
  if (c) c.baseMs = epochMs - Math.floor(nowUs / 1000);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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

const p2 = (n: number): string => String(n).padStart(2, '0');

/** IOS-Format: `12:00:00.123 UTC Thu Jan 1 2026`; `*` vor der Zeit, solange die Uhr nicht synchronisiert ist. */
export function formatClock(epochMs: number, synced: boolean): string {
  const d = new Date(epochMs);
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${synced ? '' : '*'}${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${ms} UTC ${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`;
}

/**
 * Parst `clock set hh:mm:ss day month year` bzw. `month day year` (IOS erlaubt beides);
 * liefert Epoch-ms oder `undefined`.
 */
export function parseClockSet(
  time: string,
  a: string,
  b: string,
  year: string,
): number | undefined {
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!t) return undefined;
  const monthName = (x: string): number =>
    MONTHS.findIndex((m) => m.toLowerCase() === x.slice(0, 3).toLowerCase());
  let day = Number(a);
  let mon = monthName(b);
  if (!Number.isInteger(day) || mon < 0) {
    day = Number(b);
    mon = monthName(a);
  }
  const y = Number(year);
  if (!Number.isInteger(day) || mon < 0 || !Number.isInteger(y) || day < 1 || day > 31)
    return undefined;
  const h = Number(t[1]);
  const m = Number(t[2]);
  const s = Number(t[3] ?? 0);
  if (h > 23 || m > 59 || s > 59 || y < 1993 || y > 2035) return undefined;
  const ms = Date.UTC(y, mon, day, h, m, s);
  return new Date(ms).getUTCDate() === day ? ms : undefined;
}
