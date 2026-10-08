import type { RipEntry, RipPdu } from '@netsim/protocols';
import { prefixToMask } from '@netsim/protocols';
import type { Base } from '../l3';
import type { Iface } from '../ifaces';
import type { Ipv4Pdu } from '@netsim/protocols';
import {
  AD,
  SEC,
  cancelBg,
  classfulNet,
  classfulPlen,
  dbg,
  inNet,
  installRoutes,
  pfxKey,
  plenOfMask,
  redistSource,
  rlog,
  sendMcast,
  setBg,
  type Rt,
} from './core';
import { isPassive, maxPathsOf, type RipCfg, type RipRoute } from './types';

export const RIP_GROUP = '224.0.0.9';
const MAX_ENTRIES = 25;
const INF = 16;

export const newRip = (): RipCfg => ({
  networks: [],
  passive: [],
  unpassive: [],
  passiveDefault: false,
  autoSummary: true,
  defaultOriginate: false,
  redistribute: [],
  defaultMetric: 1,
  timers: { update: 30, invalid: 180, holddown: 180, flush: 240 },
  poison: false,
  routes: {},
  version: 2,
});

/** Schnittstellen, auf denen RIP läuft (`network`-Anweisung klassenbezogen). */
export function ripIfaces(rt: Rt): Iface[] {
  const c = rt.r.rip;
  if (!c) return [];
  return rt.node.ifaces.filter(
    (i) => i.kind !== 'loop' && c.networks.some((n) => classfulNet(n) === classfulNet(i.ip)),
  );
}

const loopbackIfaces = (rt: Rt): Iface[] => {
  const c = rt.r.rip;
  return c
    ? rt.node.ifaces.filter(
        (i) => i.kind === 'loop' && c.networks.some((n) => classfulNet(n) === classfulNet(i.ip)),
      )
    : [];
};

// ------------------------------------------------------------------ Start/Sync

export function ripSync(rt: Rt): void {
  const c = rt.r.rip;
  if (c) {
    for (const id of new Set(Object.values(c.routes).map((r) => r.ifaceId))) {
      if (id && !rt.node.ifaces.some((i) => i.id === id)) ripIfaceDown(rt, id);
    }
  }
  if (!c) {
    cancelBg(rt, 'rt:rip:update');
    cancelBg(rt, 'rt:rip:tick');
    return;
  }
  // Timer laufen, solange RIP konfiguriert ist
  if (!c.timersArmed) {
    c.timersArmed = true;
    setBg(rt, 'rt:rip:update', rt.ctx.rand(3 * SEC) + 100_000, c.timers.update * SEC);
    setBg(rt, 'rt:rip:tick', 5 * SEC, 5 * SEC);
    for (const i of ripIfaces(rt)) sendRequest(rt, i);
  }
  ripRecompute(rt);
}

export function ripStop(rt: Rt): void {
  cancelBg(rt, 'rt:rip:update');
  cancelBg(rt, 'rt:rip:tick');
  cancelBg(rt, 'rt:rip:trig');
}

function sendRequest(rt: Rt, iface: Iface): void {
  const req: RipPdu = {
    kind: 'rip',
    command: 'request',
    entries: [{ prefix: '0.0.0.0', mask: '0.0.0.0', nextHop: '0.0.0.0', metric: INF, tag: 0 }],
  };
  sendMcast(rt, iface, RIP_GROUP, {
    kind: 'udp',
    srcPort: 520,
    dstPort: 520,
    dataSize: 0,
    app: req,
  });
}

// ------------------------------------------------------------------ Lokale Routen

/** Lokale (Netzwerk-, redistribuierte, Default-)Einträge aktualisieren. Liefert `true` bei Änderungen. */
export function ripRecompute(rt: Rt): boolean {
  const c = rt.r.rip;
  if (!c) return false;
  let changed = false;
  const want = new Map<string, RipRoute>();
  const add = (r: RipRoute): void => {
    const k = pfxKey(r.prefix, r.plen);
    const cur = want.get(k);
    if (!cur || r.metric < cur.metric) want.set(k, r);
  };
  for (const i of [...ripIfaces(rt), ...loopbackIfaces(rt)]) {
    const plen = plenOfMask(i.mask);
    add({
      prefix: networkOfIp(i.ip, plen),
      plen,
      metric: 0,
      ifaceId: i.id,
      changed: false,
      origin: 'network',
      tag: 0,
    });
  }
  for (const red of c.redistribute) {
    for (const s of redistSource(rt, red, 'rip')) {
      if (s.plen === 0) continue;
      add({
        prefix: s.prefix,
        plen: s.plen,
        metric: Math.min(INF - 1, red.metric ?? c.defaultMetric),
        ifaceId: s.ifaceId,
        changed: false,
        origin: 'redistributed',
        tag: red.tag ?? 0,
      });
    }
  }
  if (c.defaultOriginate)
    add({ prefix: '0.0.0.0', plen: 0, metric: 1, changed: false, origin: 'default', tag: 0 });

  // vorhandene lokale Einträge angleichen
  for (const [k, r] of Object.entries(c.routes)) {
    if (r.origin === 'rip') continue;
    if (!want.has(k)) {
      delete c.routes[k];
      changed = true;
    }
  }
  for (const [k, r] of want) {
    const cur = c.routes[k];
    if (cur && cur.origin === 'rip' && cur.metric < INF && cur.metric <= r.metric) continue; // lokale Route schlechter als gelernte
    if (!cur || cur.origin === 'rip' || cur.metric !== r.metric || cur.origin !== r.origin) {
      c.routes[k] = { ...r, changed: true };
      changed = true;
    }
  }
  const inst = installRip(rt);
  if (changed) scheduleTrigger(rt);
  return changed || inst;
}

const networkOfIp = (ip: string, plen: number): string => {
  const m = (plen === 0 ? 0 : (0xffffffff << (32 - plen)) >>> 0) >>> 0;
  const n = ip.split('.').reduce((a, b) => a * 256 + Number(b), 0) >>> 0;
  const net = (n & m) >>> 0;
  return [net >>> 24, (net >>> 16) & 255, (net >>> 8) & 255, net & 255].join('.');
};

function installRip(rt: Rt): boolean {
  const c = rt.r.rip;
  if (!c) return installRoutes(rt, 'rip', []);
  const out = Object.values(c.routes)
    .filter((r) => r.origin === 'rip' && r.metric < INF && r.nextHop && r.ifaceId)
    .flatMap((r) =>
      [{ nextHop: r.nextHop as string, ifaceId: r.ifaceId as string }, ...(r.alts ?? [])]
        .slice(0, maxPathsOf(c))
        .map((p) => ({
          proto: 'R' as const,
          prefix: r.prefix,
          plen: r.plen,
          ad: AD.rip as number,
          metric: r.metric,
          nextHop: p.nextHop,
          ifaceId: p.ifaceId,
        })),
    );
  return installRoutes(rt, 'rip', out);
}

// ------------------------------------------------------------------ Senden

function entriesFor(rt: Rt, c: RipCfg, iface: Iface, onlyChanged: boolean): RipEntry[] {
  const ifaceMajor = classfulNet(iface.ip);
  const split = iface.cfg.ripSplitHorizon !== false;
  const agg = new Map<string, RipEntry>();
  for (const r of Object.values(c.routes)) {
    if (onlyChanged && !r.changed) continue;
    let metric = r.metric >= INF ? INF : Math.min(INF, r.metric + 1);
    if (r.origin === 'rip' && r.ifaceId === iface.id && split) {
      if (!c.poison) continue;
      metric = INF;
    }
    let prefix = r.prefix;
    let plen = r.plen;
    if (c.autoSummary && r.plen > 0 && classfulNet(r.prefix) !== ifaceMajor) {
      prefix = classfulNet(r.prefix);
      plen = classfulPlen(r.prefix);
    }
    const k = pfxKey(prefix, plen);
    const prev = agg.get(k);
    if (!prev || metric < prev.metric)
      agg.set(k, { prefix, mask: prefixToMask(plen), nextHop: '0.0.0.0', metric, tag: r.tag });
  }
  return [...agg.values()];
}

export function sendUpdate(rt: Rt, iface: Iface, onlyChanged = false): void {
  const c = rt.r.rip;
  if (!c || isPassive(c, iface.id)) return;
  const all = entriesFor(rt, c, iface, onlyChanged);
  for (let i = 0; i < all.length; i += MAX_ENTRIES) {
    const chunk = all.slice(i, i + MAX_ENTRIES);
    sendMcast(rt, iface, RIP_GROUP, {
      kind: 'udp',
      srcPort: 520,
      dstPort: 520,
      dataSize: 0,
      app: { kind: 'rip', command: 'response', entries: chunk },
    });
    dbg(
      rt,
      'RIP',
      'rip',
      () =>
        `RIP: sending v2 update to ${RIP_GROUP} via ${rt.ctx.deviceIfaceName(iface.id)} (${iface.ip})\n` +
        chunk
          .map(
            (e) =>
              `RIP: build update entries\n\t${e.prefix}/${plenOfMask(e.mask)} via 0.0.0.0, metric ${e.metric}, tag ${e.tag}`,
          )
          .join('\n'),
    );
  }
}

function scheduleTrigger(rt: Rt): void {
  setBg(rt, 'rt:rip:trig', 1 * SEC + rt.ctx.rand(SEC));
}

export function ripTimer(rt: Rt, name: string): boolean {
  const c = rt.r.rip;
  if (!name.startsWith('rt:rip:')) return false;
  if (!c) return true;
  if (name === 'rt:rip:update') {
    for (const i of ripIfaces(rt)) sendUpdate(rt, i);
    for (const r of Object.values(c.routes)) r.changed = false;
  } else if (name === 'rt:rip:trig') {
    for (const i of ripIfaces(rt)) sendUpdate(rt, i, true);
    for (const r of Object.values(c.routes)) r.changed = false;
  } else if (name === 'rt:rip:tick') {
    ripAge(rt, c);
  }
  return true;
}

function ripAge(rt: Rt, c: RipCfg): void {
  const now = rt.ctx.now;
  let changed = false;
  for (const [k, r] of Object.entries(c.routes)) {
    if (r.origin !== 'rip') continue;
    if (r.alts?.some((a) => now - a.updatedAt > c.timers.invalid * SEC)) {
      r.alts = r.alts.filter((a) => now - a.updatedAt <= c.timers.invalid * SEC);
      changed = true;
    }
    if (
      r.metric < INF &&
      r.updatedAt !== undefined &&
      now - r.updatedAt > c.timers.invalid * SEC &&
      r.alts?.length
    ) {
      const a = r.alts[0] as NonNullable<RipRoute['alts']>[number];
      r.nextHop = a.nextHop;
      r.ifaceId = a.ifaceId;
      r.updatedAt = a.updatedAt;
      r.alts = r.alts.slice(1);
      changed = true;
    } else if (
      r.metric < INF &&
      r.updatedAt !== undefined &&
      now - r.updatedAt > c.timers.invalid * SEC
    ) {
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
    installRip(rt);
    scheduleTrigger(rt);
  }
}

/** Schnittstelle ausgefallen: alle darüber gelernten Routen sofort entwerten. */
function ripIfaceDown(rt: Rt, ifaceId: string): void {
  const c = rt.r.rip;
  if (!c) return;
  let changed = false;
  for (const r of Object.values(c.routes)) {
    if (r.alts?.some((a) => a.ifaceId === ifaceId)) {
      r.alts = r.alts.filter((a) => a.ifaceId !== ifaceId);
      changed = true;
    }
    if (r.origin === 'rip' && r.ifaceId === ifaceId && r.metric < INF && r.alts?.length) {
      // gleichwertiger Zusatzpfad übernimmt
      const a = r.alts[0] as NonNullable<RipRoute['alts']>[number];
      r.nextHop = a.nextHop;
      r.ifaceId = a.ifaceId;
      r.updatedAt = a.updatedAt;
      r.alts = r.alts.slice(1);
      changed = true;
    } else if (r.origin === 'rip' && r.ifaceId === ifaceId && r.metric < INF) {
      r.metric = INF;
      r.changed = true;
      r.flushAt = rt.ctx.now + (c.timers.flush - c.timers.invalid) * SEC;
      changed = true;
    }
  }
  if (changed) {
    installRip(rt);
    scheduleTrigger(rt);
  }
}

// ------------------------------------------------------------------ Empfangen

export function ripRx(rt: Rt, iface: Iface, base: Base, ip: Ipv4Pdu, pdu: RipPdu): void {
  const c = rt.r.rip;
  if (!c) return;
  if (!ripIfaces(rt).some((i) => i.id === iface.id)) return;
  if (ip.src === iface.ip) return; // eigene Pakete (Loopback-Multicast)
  if (!inNet(ip.src, networkOfIp(iface.ip, plenOfMask(iface.mask)), plenOfMask(iface.mask))) return;
  if (pdu.command === 'request') {
    // Antwort mit der vollständigen Tabelle (unicast vereinfacht als Multicast-Update)
    sendUpdate(rt, iface);
    return;
  }
  rlog(
    rt,
    'RIP',
    { key: 'rip.update.rx', params: { src: ip.src, count: pdu.entries.length } },
    { kind: 'rx', status: 'ok' },
  );
  dbg(
    rt,
    'RIP',
    'rip',
    () =>
      `RIP: received v2 update from ${ip.src} on ${rt.ctx.deviceIfaceName(iface.id)}\n` +
      pdu.entries
        .map((e) => `     ${e.prefix}/${plenOfMask(e.mask)} via 0.0.0.0 in ${e.metric} hops`)
        .join('\n'),
  );
  void base;
  let changed = false;
  const now = rt.ctx.now;
  for (const e of pdu.entries) {
    const plen = plenOfMask(e.mask);
    const key = pfxKey(e.prefix, plen);
    const metric = Math.min(INF, e.metric);
    const nh = e.nextHop === '0.0.0.0' ? ip.src : e.nextHop;
    const cur = c.routes[key];
    if (cur && cur.origin !== 'rip') continue; // lokale Route hat Vorrang
    if (!cur) {
      if (metric >= INF) continue;
      c.routes[key] = {
        prefix: e.prefix,
        plen,
        metric,
        nextHop: nh,
        ifaceId: iface.id,
        updatedAt: now,
        changed: true,
        origin: 'rip',
        tag: e.tag,
      };
      changed = true;
      continue;
    }
    if (cur.nextHop === nh && cur.ifaceId === iface.id) {
      if (metric !== cur.metric) {
        cur.metric = metric;
        cur.alts = undefined;
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
      cur.nextHop = nh;
      cur.ifaceId = iface.id;
      cur.updatedAt = now;
      cur.flushAt = undefined;
      cur.alts = undefined;
      cur.changed = true;
      changed = true;
    } else {
      // gleichwertiger bzw. schlechterer Zusatzpfad (ECMP)
      const alt = cur.alts?.find((a) => a.nextHop === nh && a.ifaceId === iface.id);
      if (metric === cur.metric && metric < INF) {
        if (alt) alt.updatedAt = now;
        else if ((cur.alts?.length ?? 0) + 1 < maxPathsOf(c)) {
          cur.alts = [...(cur.alts ?? []), { nextHop: nh, ifaceId: iface.id, updatedAt: now }];
          changed = true;
        }
      } else if (alt) {
        cur.alts = cur.alts?.filter((a) => a !== alt);
        changed = true;
      }
    }
  }
  if (changed) {
    installRip(rt);
    scheduleTrigger(rt);
    rt.ctx.requestRefresh();
  }
}
