import type { OspfLsa } from '@netsim/protocols';
import { inNet, type Rt } from './core';
import { MAXAGE, areasOf, effectiveRid, ifCost, networkOf, participants } from './ospf';
import type { OspfCfg } from './types';
import { plenOfMask } from './core';

export interface Nh {
  ifaceId: string;
  addr?: string;
}

export interface SpfRoute {
  prefix: string;
  plen: number;
  type: 'intra' | 'inter' | 'e1' | 'e2';
  cost: number;
  /** Bereich, in dem die Route gelernt wurde (für ABR-Summaries). */
  area: string;
  nh?: Nh;
  asbrCost?: number;
  /** Direkt angeschlossen: nur für Summaries, nicht für die RIB. */
  connected?: boolean;
}

export interface SpfAsbr {
  rid: string;
  cost: number;
  area: string;
  viaInter: boolean;
  nh?: Nh;
}

export interface SpfResult {
  routes: SpfRoute[];
  candidates: SpfRoute[];
  asbrs: SpfAsbr[];
}

interface Vertex {
  cost: number;
  nh?: Nh;
}

const live = (rt: Rt, c: OspfCfg, area: string, l: OspfLsa): boolean =>
  l.age + 0 < MAXAGE &&
  (c.installed[`${area}|${l.type}|${l.id}|${l.advRouter}`] ?? 0) >= 0 &&
  rt.ctx.now >= 0;

const rank = { intra: 0, inter: 1, e1: 2, e2: 3 } as const;

export function spfRun(rt: Rt, c: OspfCfg): SpfResult {
  const myRid = effectiveRid(rt, c);
  const parts = participants(rt, c);
  const areas = areasOf(parts);
  const isAbr = areas.length > 1;
  const all: SpfRoute[] = [];
  const asbrs: SpfAsbr[] = [];
  const connected = new Set(
    rt.node.ifaces.map((i) => `${networkOf(i.ip, plenOfMask(i.mask))}/${plenOfMask(i.mask)}`),
  );

  for (const area of areas) {
    const db = c.lsdb[area] ?? {};
    const routers = new Map<string, Extract<OspfLsa['body'], { type: 1 }>>();
    const networks = new Map<string, Extract<OspfLsa['body'], { type: 2 }>>();
    for (const l of Object.values(db)) {
      if (!live(rt, c, area, l)) continue;
      if (l.body.type === 1) routers.set(l.advRouter, l.body);
      else if (l.body.type === 2) networks.set(l.id, l.body);
    }
    const dist = new Map<string, Vertex>();
    const done = new Set<string>();
    const root = `r:${myRid}`;
    if (!routers.has(myRid)) continue;
    dist.set(root, { cost: 0 });

    const linkAddr = (rid: string, netId: string): string | undefined =>
      routers.get(rid)?.links.find((l) => l.kind === 'transit' && l.neighbor === netId)?.addr;

    const relax = (key: string, cost: number, nh: Nh | undefined): void => {
      const cur = dist.get(key);
      if (!cur || cost < cur.cost) dist.set(key, { cost, nh });
    };

    for (;;) {
      let bestKey: string | undefined;
      let best: Vertex | undefined;
      for (const [k, v] of dist) {
        if (done.has(k)) continue;
        if (!best || v.cost < best.cost) {
          best = v;
          bestKey = k;
        }
      }
      if (!bestKey || !best) break;
      done.add(bestKey);
      const isRoot = bestKey === root;
      if (bestKey.startsWith('r:')) {
        const rid = bestKey.slice(2);
        const body = routers.get(rid);
        if (!body) continue;
        for (const link of body.links) {
          if (link.kind === 'p2p' && link.neighbor) {
            const nb = routers.get(link.neighbor);
            if (!nb?.links.some((l) => l.kind === 'p2p' && l.neighbor === rid)) continue;
            let nh = best.nh;
            if (isRoot) {
              for (const [ifaceId, ifs] of Object.entries(c.ifs)) {
                const n = ifs.neighbors[link.neighbor];
                if (n && ifs.state === 'p2p') nh = { ifaceId, addr: n.ip };
              }
            }
            relax(`r:${link.neighbor}`, best.cost + link.cost, nh);
          } else if (link.kind === 'transit' && link.neighbor) {
            if (!networks.has(link.neighbor)) continue;
            let nh = best.nh;
            if (isRoot) {
              const ifaceId = Object.entries(c.ifs).find(
                ([, ifs]) => ifs.area === area && ifs.drAddr === link.neighbor,
              )?.[0];
              nh = ifaceId ? { ifaceId } : undefined;
            }
            relax(`n:${link.neighbor}`, best.cost + link.cost, nh);
          }
        }
      } else {
        const netId = bestKey.slice(2);
        const net = networks.get(netId);
        if (!net) continue;
        for (const rid of net.attached) {
          if (rid === myRid) continue;
          if (!routers.get(rid)?.links.some((l) => l.kind === 'transit' && l.neighbor === netId))
            continue;
          let nh = best.nh;
          if (nh && nh.addr === undefined) nh = { ifaceId: nh.ifaceId, addr: linkAddr(rid, netId) };
          relax(`r:${rid}`, best.cost, nh);
        }
      }
    }

    // Routen aus den erreichten Knoten
    for (const [k, v] of dist) {
      if (k.startsWith('r:')) {
        const rid = k.slice(2);
        if (rid === myRid) continue;
        const body = routers.get(rid);
        if (!body) continue;
        if (body.asbr) asbrs.push({ rid, cost: v.cost, area, viaInter: false, nh: v.nh });
        for (const l of body.links) {
          if (l.kind !== 'stub' || l.prefix === undefined || l.plen === undefined) continue;
          if (connected.has(`${l.prefix}/${l.plen}`)) continue;
          all.push({
            prefix: l.prefix,
            plen: l.plen,
            type: 'intra',
            cost: v.cost + l.cost,
            area,
            nh: v.nh,
          });
        }
      } else {
        const net = networks.get(k.slice(2));
        if (!net || v.nh?.addr === undefined) continue;
        if (connected.has(`${net.prefix}/${net.plen}`)) continue;
        all.push({
          prefix: net.prefix,
          plen: net.plen,
          type: 'intra',
          cost: v.cost,
          area,
          nh: v.nh,
        });
      }
    }

    // Inter-Area: ein ABR wertet nur den Backbone aus
    if (isAbr && area !== '0') continue;
    for (const l of Object.values(db)) {
      if (!live(rt, c, area, l) || l.advRouter === myRid) continue;
      const abr = dist.get(`r:${l.advRouter}`);
      if (!abr) continue;
      if (l.body.type === 3) {
        if (connected.has(`${l.body.prefix}/${l.body.plen}`)) continue;
        all.push({
          prefix: l.body.prefix,
          plen: l.body.plen,
          type: 'inter',
          cost: abr.cost + l.body.metric,
          area,
          nh: abr.nh,
        });
      } else if (l.body.type === 4) {
        asbrs.push({
          rid: l.body.asbr,
          cost: abr.cost + l.body.metric,
          area,
          viaInter: true,
          nh: abr.nh,
        });
      }
    }
  }

  // Direkt angeschlossene Netze (für ABR-Summaries)
  for (const { iface, area } of parts) {
    const plen = iface.kind === 'loop' ? 32 : plenOfMask(iface.mask);
    all.push({
      prefix: iface.kind === 'loop' ? iface.ip : networkOf(iface.ip, plen),
      plen,
      type: 'intra',
      cost: ifCost(rt, iface, c),
      area,
      connected: true,
    });
  }

  // Externe Routen (Typ 5)
  for (const l of Object.values(c.lsdb['as'] ?? {})) {
    if (l.advRouter === myRid || l.body.type !== 5 || l.age >= MAXAGE) continue;
    const cands = asbrs.filter((a) => a.rid === l.advRouter);
    const via = cands.sort((a, b) => Number(a.viaInter) - Number(b.viaInter) || a.cost - b.cost)[0];
    if (!via) continue;
    if (connected.has(`${l.body.prefix}/${l.body.plen}`)) continue;
    all.push({
      prefix: l.body.prefix,
      plen: l.body.plen,
      type: l.body.eType === 1 ? 'e1' : 'e2',
      cost: l.body.eType === 1 ? via.cost + l.body.metric : l.body.metric,
      area: via.area,
      nh: via.nh,
      asbrCost: via.cost,
    });
  }

  // beste Route je Präfix
  const best = new Map<string, SpfRoute>();
  for (const r of all) {
    const k = `${r.prefix}/${r.plen}`;
    const cur = best.get(k);
    if (
      !cur ||
      rank[r.type] < rank[cur.type] ||
      (rank[r.type] === rank[cur.type] &&
        (r.cost < cur.cost || (r.cost === cur.cost && (r.asbrCost ?? 0) < (cur.asbrCost ?? 0))))
    )
      best.set(k, r);
  }
  const candidates = [...best.values()];
  const routes = candidates.filter((r) => !r.connected && r.nh?.addr !== undefined);
  void inNet;
  return { routes, candidates, asbrs };
}
