import type { DeviceCtx } from '../ctx';
import { mgmtOf } from '../p5defaults';
import type { Device } from '../types';
import { deviceTimeMs, clockOf, MONTHS } from './clock';
import { ipNodeOf } from './node';
import { udpRequest } from './udputil';

export const SEVERITY_NAMES = [
  'emergencies',
  'alerts',
  'critical',
  'errors',
  'warnings',
  'notifications',
  'informational',
  'debugging',
] as const;

const p2 = (n: number): string => String(n).padStart(2, '0');

/** `*Mar  1 00:00:12.345` bzw. ohne `*` bei synchronisierter Uhr. */
export function syslogStamp(epochMs: number, synced: boolean): string {
  const d = new Date(epochMs);
  const day = String(d.getUTCDate()).padStart(2, ' ');
  return `${synced ? '' : '*'}${MONTHS[d.getUTCMonth()]} ${day} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
}

/**
 * Erzeugt eine IOS-Syslog-Meldung (`%FAC-SEV-MNEMONIC: text`): Puffer (`show logging`) und – ab
 * Schweregrad `logging trap` – UDP/514 an alle `logging host`s. Gibt die formatierte Zeile zurück.
 */
export function syslogEmit(
  ctx: DeviceCtx,
  dev: Device,
  sev: number,
  tag: string,
  text: string,
): string | undefined {
  const c = dev.config;
  if (c.kind !== 'router' && c.kind !== 'switch') return undefined;
  const m = mgmtOf(c.sys);
  const clock = clockOf(dev);
  const line = `${syslogStamp(deviceTimeMs(dev, ctx.now), clock?.syncedTo !== undefined)}: %${tag}: ${text}`;
  if (m.syslog.buffered && sev <= (m.syslog.bufLevel ?? 7)) {
    m.logBuffer.push(line);
    if (m.logBuffer.length > 100) m.logBuffer.shift();
  }
  if (sev > m.syslog.trap || m.syslog.hosts.length === 0) return line;
  const node = ipNodeOf(ctx, dev);
  if (!node) return line;
  for (const host of m.syslog.hosts) {
    udpRequest(ctx, node, {
      dst: host,
      proto: 'syslog',
      op: 'msg',
      args: { sev, host: c.sys.hostname, ts: deviceTimeMs(dev, ctx.now) },
      body: line,
      oneWay: true,
    });
  }
  return line;
}
