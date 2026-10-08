import type { DeviceCtx } from '../ctx';
import type { Wlan } from '../p5types';
import type { Device, HostConfig } from '../types';
import { ipNodeOf } from './node';
import type { SvcRx } from './services';
import { udpReply, udpRequest } from './udputil';

const hostOf = (d: Device): HostConfig | undefined =>
  d.config.kind === 'host' ? d.config : undefined;

const JOIN_RETRY_US = 3_000_000;
const REFRESH_US = 30_000_000;
const LOST_US = 3 * REFRESH_US + 5_000_000;

/**
 * Lightweight-AP: tritt dem WLC bei (CAPWAP vereinfacht: UDP 5246, `join` → `join-ok` mit den WLANs) und
 * fragt danach alle 30 s die Konfiguration erneut ab. Läuft als Hintergrund-Timer `bg:svc:capwap`.
 */
export function capwapTick(ctx: DeviceCtx, dev: Device): void {
  const h = hostOf(dev);
  const ap = h?.ap;
  if (!h || !ap?.wlc) return;
  // Lightweight-AP ohne Controller (lokaler Modus): WLANs abschalten, erneut beitreten
  if (ap.managed && ctx.now - (ap.managed.seenAt ?? ap.managed.joinedAt) > LOST_US) {
    ap.managed = undefined;
    ctx.requestWifiSync();
  }
  const node = ipNodeOf(ctx, dev);
  if (node && node.ifaces.length > 0) {
    udpRequest(ctx, node, {
      dst: ap.wlc,
      proto: 'capwap',
      op: 'join',
      args: { name: dev.name, mac: dev.ports[0]?.mac ?? '' },
    });
  }
  ctx.setTimer('bg:svc:capwap', ap.managed ? REFRESH_US : JOIN_RETRY_US);
}

/** WLC: nimmt einen AP auf und liefert die WLANs. */
export function capwapHandler(r: SvcRx): boolean {
  const wlc = hostOf(r.ctx.device)?.wlc;
  if (!wlc || r.msg.op !== 'join') return false;
  const mac = String(r.msg.args.mac ?? '');
  const name = String(r.msg.args.name ?? '');
  if (!wlc.aps[mac]) {
    r.ctx.log({
      ...r.base,
      kind: 'rx',
      proto: 'CAPWAP',
      status: 'ok',
      msg: { key: 'wlc.apJoined', params: { name, ip: r.ip.src } },
    });
  }
  wlc.aps[mac] = { mac, name, ip: r.ip.src, joinedAt: wlc.aps[mac]?.joinedAt ?? r.ctx.now };
  udpReply(r.ctx, r.node, r.iface, r.ip, r.udp, r.msg, 'join-ok', {}, JSON.stringify(wlc.wlans));
  return true;
}

/** AP: Antwort des WLC übernehmen. */
export function capwapReply(ctx: DeviceCtx, dev: Device, server: string, body: string): void {
  const ap = hostOf(dev)?.ap;
  if (!ap) return;
  let wlans: Wlan[];
  try {
    wlans = JSON.parse(body) as Wlan[];
  } catch {
    return;
  }
  const changed = !ap.managed || JSON.stringify(ap.managed.wlans) !== JSON.stringify(wlans);
  if (!ap.managed) {
    ctx.log({
      kind: 'info',
      proto: 'CAPWAP',
      status: 'ok',
      msg: { key: 'wlc.joined', params: { wlc: server, wlans: wlans.length } },
    });
  }
  ap.managed = { wlc: server, wlans, joinedAt: ap.managed?.joinedAt ?? ctx.now, seenAt: ctx.now };
  if (changed) ctx.requestWifiSync();
}
