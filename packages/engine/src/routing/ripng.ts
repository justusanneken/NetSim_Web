import {
  ipv6Network,
  isLinkLocalIpv6,
  type Ipv6Pdu,
  type RipEntry,
  type RipPdu,
} from '@netsim/protocols';
import { sendMcast6, type Iface6 } from '../l3v6';
import {
  AD,
  SEC,
  cancelBg,
  distPermits,
  installRoutes,
  redistSource6,
  rlog,
  setBg,
  type Rt,
} from './core';
import type { RipRoute, RipngCfg } from './types';

/** RIPng (IPv6, UDP 521, ff02::9): Distanzvektor wie RIPv2 mit Split Horizon, Invalid/Flush/Holddown. */

export const RIPNG_GROUP = 'ff02::9';
const INF = 16;
const MAX_ENTRIES = 25;

export const newRipng = (name: string): RipngCfg => ({
  name,
  redistribute: [],
  defaultOriginate: false,
  timers: { update: 30, invalid: 180, holddown: 180, flush: 240 },
  poison: false,
  routes: {},
});

const key = (prefix: string, plen: number): string => `${prefix}/${plen}`;
const tname = (kind: string, name: string): string => `rt:ripng:${kind}:${name}`;

/** Schnittstellen, auf denen RIPng für den Prozess läuft (`ipv6 rip NAME enable`). */
function ifacesOf(rt: Rt, c: RipngCfg): Iface6[] {
  return (rt.node.v6?.ifaces ?? []).filter(
    (i) => i.kind !== 'loop' && i.kind !== 'tunnel' && i.cfg.v6?.ripng === c.name,
  );
}
const loopsOf = (rt: Rt, c: RipngCfg): Iface6[] =>
  (rt.node.v6?.ifaces ?? []).filter((i) => i.kind === 'loop' && i.cfg.v6?.ripng === c.name);

export function ripngSync(rt: Rt): void {
  const procs = rt.r.ripng ?? {};
  for (const c of Object.values(procs)) {
    if (!c.timersArmed) {
      c.timersArmed = true;
      setBg(rt, tname('update', c.name), rt.ctx.rand(3 * SEC) + 100_000, c.timers.update * SEC);
      setBg(rt, tname('tick', c.name), 5 * SEC, 5 * SEC);
    }
    // Schnittstellen, die verschwunden sind: darüber gelernte Routen entwerten
    const ids = new Set(ifacesOf(rt, c).map((i) => i.id));
    for (const r of Object.values(c.routes)) {
      if (r.origin === 'rip' && r.ifaceId && !ids.has(r.ifaceId) && r.metric < INF) {
        r.metric = INF;
        r.changed = true;
        r.flushAt = rt.ctx.now + (c.timers.flush - c.timers.invalid) * SEC;
      }
    }
  }
  ripngRecompute(rt);
}

export function ripngStop(rt: Rt): void {
  for (const c of Object.values(rt.r.ripng ?? {})) {
    for (const k of ['update', 'tick', 'trig']) cancelBg(rt, tname(k, c.name));
    c.timersArmed = false;
  }
}

/** Orphan-Routen eines gelöschten Prozesses entfernen und lokale/redistribuierte Einträge pflegen. */
export function ripngRecompute(rt: Rt): boolean {
  const procs = rt.r.ripng ?? {};
  let changed = false;
  if (Object.keys(procs).length === 0) {
    return installRoutes(rt, 'ripng', [], true);
  }
  for (const c of Object.values(procs)) {
    const want = new Map<string, RipRoute>();
    const add = (r: RipRoute): void => {
      const k = key(r.prefix, r.plen);
      const cur = want.get(k);
      if (!cur || r.metric < cur.metric) want.set(k, r);
    };
    for (const i of [...ifacesOf(rt, c), ...loopsOf(rt, c)]) {
      for (const a of i.addrs) {
        const prefix = ipv6Network(a.addr, a.plen);
        add({
          prefix,
          plen: a.plen,
          metric: 0,
          ifaceId: i.id,
          changed: false,
          origin: 'network',
          tag: 0,
        });
      }
    }
    for (const red of c.redistribute) {
      for (const s of redistSource6(rt, red, 'ripng')) {
        if (s.plen === 0) continue;
        const m = s.set?.metric ?? red.metric ?? c.defaultMetric;
        if (m === undefined || m >= INF) continue;
        add({
          prefix: s.prefix,
          plen: s.plen,
          metric: m,
          ifaceId: s.ifaceId,
          changed: false,
          origin: 'redistributed',
          tag: s.set?.tag ?? red.tag ?? 0,
        });
      }
    }
    if (c.defaultOriginate)
      add({ prefix: '::', plen: 0, metric: 1, changed: false, origin: 'default', tag: 0 });
    // lokale Einträge angleichen
    for (const [k, r] of Object.entries(c.routes)) {
      if (r.origin === 'rip') {
        if (!distPermits(rt, c.distributeLists, 'in', r.ifaceId, { ...r, v6: true })) {
          delete c.routes[k];
          changed = true;
        }
        continue;
      }
      if (!want.has(k)) {
        if (r.metric < INF) {
          r.metric = INF;
          r.changed = true;
          r.flushAt = rt.ctx.now + (c.timers.flush - c.timers.invalid) * SEC;
          schedTrigger(rt, c);
          changed = true;
        } else if (r.flushAt !== undefined && rt.ctx.now >= r.flushAt) {
          delete c.routes[k];
          changed = true;
        }
      }
    }
    for (const [k, r] of want) {
      const cur = c.routes[k];
      if (cur && cur.origin === 'rip' && cur.metric < INF && cur.metric <= r.metric) continue;
      if (!cur || cur.origin === 'rip' || cur.metric !== r.metric || cur.origin !== r.origin) {
        c.routes[k] = { ...r, changed: true };
        changed = true;
      }
    }
    if (changed) schedTrigger(rt, c);
  }
  if (install(rt)) changed = true;
  return changed;
}

function install(rt: Rt): boolean {
  const routes = [];
  for (const c of Object.values(rt.r.ripng ?? {})) {
    for (const r of Object.values(c.routes)) {
      if (r.origin !== 'rip' || r.metric >= INF || !r.nextHop || !r.ifaceId) continue;
      routes.push({
        proto: 'R' as const,
        prefix: r.prefix,
        plen: r.plen,
        ad: AD.rip as number,
        metric: r.metric,
        nextHop: r.nextHop,
        ifaceId: r.ifaceId,
      });
    }
  }
  return installRoutes(rt, 'ripng', routes, true);
}

function schedTrigger(rt: Rt, c: RipngCfg): void {
  setBg(rt, tname('trig', c.name), 1 * SEC + rt.ctx.rand(SEC));
}

// ------------------------------------------------------------------ Senden

function entriesFor(rt: Rt, c: RipngCfg, iface: Iface6, onlyChanged: boolean): RipEntry[] {
  const split = !c.poison;
  const out: RipEntry[] = [];
  for (const r of Object.values(c.routes)) {
    if (onlyChanged && !r.changed) continue;
    if (!distPermits(rt, c.distributeLists, 'out', iface.id, { ...r, v6: true })) continue;
    let metric = r.metric >= INF ? INF : Math.min(INF, r.metric + 1);
    if (r.origin === 'rip' && r.ifaceId === iface.id) {
      if (split) continue;
      metric = INF;
    }
    out.push({ prefix: r.prefix, mask: '', plen: r.plen, nextHop: '::', metric, tag: r.tag });
  }
  return out;
}

function sendUpdate(rt: Rt, c: RipngCfg, iface: Iface6, onlyChanged: boolean): void {
  const v6 = rt.node.v6;
  if (!v6 || (c.passive ?? []).includes(iface.id)) return;
  const all = entriesFor(rt, c, iface, onlyChanged);
  for (let i = 0; i < all.length; i += MAX_ENTRIES) {
    const pdu: RipPdu = {
      kind: 'rip',
      ng: true,
      command: 'response',
      entries: all.slice(i, i + MAX_ENTRIES),
    };
    sendMcast6(rt.ctx, { cfg: rt.node.cfg, v6, xmit: rt.node.xmit }, iface, RIPNG_GROUP, {
      kind: 'udp',
      srcPort: 521,
      dstPort: 521,
      dataSize: 0,
      app: pdu,
    });
  }
}

export function ripngTimer(rt: Rt, name: string): boolean {
  if (!name.startsWith('rt:ripng:')) return false;
  const [, , kind, procName] = name.split(':');
  const c = rt.r.ripng?.[procName as string];
  if (!c) return true;
  if (kind === 'update' || kind === 'trig') {
    for (const i of ifacesOf(rt, c)) sendUpdate(rt, c, i, kind === 'trig');
    for (const r of Object.values(c.routes)) r.changed = false;
  } else if (kind === 'tick') age(rt, c);
  return true;
}

function age(rt: Rt, c: RipngCfg): void {
  const now = rt.ctx.now;
  let changed = false;
  for (const [k, r] of Object.entries(c.routes)) {
    if (r.origin !== 'rip') {
      if (r.metric >= INF && r.flushAt !== undefined && now >= r.flushAt) {
        delete c.routes[k];
        changed = true;
      }
      continue;
    }
    if (r.metric < INF && r.updatedAt !== undefined && now - r.updatedAt > c.timers.invalid * SEC) {
      if (c.timers.holddown > 0)
        (c.held ??= {})[k] = {
          until: now + c.timers.holddown * SEC,
          metric: r.metric,
          via: r.nextHop,
        };
      r.metric = INF;
      r.changed = true;
      r.flushAt = now + (c.timers.flush - c.timers.invalid) * SEC;
      changed = true;
      rlog(rt, 'RIP', { key: 'rip.expired', params: { prefix: k } });
    } else if (r.flushAt !== undefined && now >= r.flushAt) {
      delete c.routes[k];
      changed = true;
    }
  }
  if (changed) {
    install(rt);
    schedTrigger(rt, c);
  }
}

// ------------------------------------------------------------------ Empfang

export function ripngRx(rt: Rt, iface: Iface6, pkt: Ipv6Pdu, pdu: RipPdu): void {
  if (!pdu.ng || !isLinkLocalIpv6(pkt.src) || pkt.src === iface.ll) return;
  const c = Object.values(rt.r.ripng ?? {}).find((x) => iface.cfg.v6?.ripng === x.name);
  if (!c || (c.passive ?? []).includes(iface.id)) return;
  if (pdu.command === 'request') {
    sendUpdate(rt, c, iface, false);
    return;
  }
  rlog(
    rt,
    'RIP',
    { key: 'rip.update.rx', params: { src: pkt.src, count: pdu.entries.length } },
    { kind: 'rx', status: 'ok' },
  );
  const now = rt.ctx.now;
  let changed = false;
  for (const e of pdu.entries) {
    const plen = e.plen ?? 64;
    const k = key(e.prefix, plen);
    const metric = Math.min(INF, e.metric);
    if (!distPermits(rt, c.distributeLists, 'in', iface.id, { prefix: e.prefix, plen, v6: true }))
      continue;
    const cur = c.routes[k];
    if (cur && cur.origin !== 'rip') continue;
    const hold = c.held?.[k];
    if (hold) {
      const recovered = pkt.src === hold.via && metric <= hold.metric;
      if (now >= hold.until || metric < hold.metric || recovered) delete c.held?.[k];
      else continue;
    }
    if (!cur) {
      if (metric >= INF) continue;
      c.routes[k] = {
        prefix: e.prefix,
        plen,
        metric,
        nextHop: pkt.src,
        ifaceId: iface.id,
        updatedAt: now,
        changed: true,
        origin: 'rip',
        tag: e.tag,
      };
      changed = true;
    } else if (cur.nextHop === pkt.src && cur.ifaceId === iface.id) {
      if (metric !== cur.metric) {
        if (metric >= INF && cur.metric < INF && c.timers.holddown > 0)
          (c.held ??= {})[k] = {
            until: now + c.timers.holddown * SEC,
            metric: cur.metric,
            via: cur.nextHop,
          };
        cur.metric = metric;
        cur.changed = true;
        cur.flushAt = metric >= INF ? now + (c.timers.flush - c.timers.invalid) * SEC : undefined;
        changed = true;
      }
      if (metric < INF) {
        cur.updatedAt = now;
        cur.flushAt = undefined;
      }
    } else if (metric < cur.metric) {
      cur.metric = metric;
      cur.nextHop = pkt.src;
      cur.ifaceId = iface.id;
      cur.updatedAt = now;
      cur.flushAt = undefined;
      cur.changed = true;
      changed = true;
    }
  }
  if (changed) {
    install(rt);
    schedTrigger(rt, c);
    rt.ctx.requestRefresh();
  }
}
