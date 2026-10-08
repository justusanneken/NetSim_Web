import type { Ipv4Pdu } from '@netsim/protocols';
import { aclEval, l4Of } from '../acl';
import type { DeviceCtx } from '../ctx';
import type { Iface } from '../ifaces';
import type { Base, IpNode } from '../l3';
import { maskToPrefix } from '@netsim/protocols';
import type { FwConn, FwObject } from '../p5types';
import type { RouterConfig } from '../types';

/** Leerlaufzeiten der Verbindungstabelle in µs (ASA-Standard: TCP 1 h, UDP 2 min, ICMP verkürzt). */
const IDLE_US = { tcp: 3_600_000_000, udp: 120_000_000, icmp: 60_000_000, ip: 120_000_000 };

/** Name der von NAT-Objekten erzeugten (versteckten) ACLs. */
export const FW_NAT_ACL = (obj: string): string => `__fwnat_${obj}`;

function purge(conns: FwConn[], now: number): FwConn[] {
  return conns.filter((c) => now - c.lastAt < IDLE_US[c.proto]);
}

const sameFlow = (
  c: FwConn,
  k: ReturnType<typeof l4Of>,
  ip: Ipv4Pdu,
): 'fwd' | 'rev' | undefined => {
  if (c.proto !== k.proto) return undefined;
  const icmp = ip.payload.kind === 'icmp' ? ip.payload.type : undefined;
  if (icmp !== undefined) {
    // Echo-Request läuft in Richtung des Initiators, Echo-Reply zurück
    const reply = icmp === 'echo-reply';
    const dirOk = (d: 'fwd' | 'rev'): 'fwd' | 'rev' | undefined =>
      (d === 'fwd') === !reply ? d : undefined;
    if (c.src === ip.src && c.dst === ip.dst && c.sport === k.sport) return dirOk('fwd');
    if (c.src === ip.dst && c.dst === ip.src && c.sport === k.dport) return dirOk('rev');
    return undefined;
  }
  if (c.src === ip.src && c.dst === ip.dst && c.sport === k.sport && c.dport === k.dport)
    return 'fwd';
  if (c.src === ip.dst && c.dst === ip.src && c.sport === k.dport && c.dport === k.sport)
    return 'rev';
  return undefined;
};

/** Anzeigename einer Schnittstelle für Meldungen (`nameif` falls vorhanden). */
const nameOf = (cfg: RouterConfig, id: string): string => cfg.fw?.ifaces[id]?.nameif ?? id;

/**
 * Zustandsbehaftete Prüfung einer weitergeleiteten IPv4-Verbindung (ASA-Modell, vereinfacht):
 * bestehende Verbindungen (Hin- und Rückrichtung) → erlaubt; neue → ACL der Eingangsschnittstelle
 * (`access-group`), sonst Security-Level (hoch → niedrig erlaubt). Liefert `true` bei Erlaubnis.
 */
export function fwPermit(
  ctx: DeviceCtx,
  node: IpNode,
  inIface: Iface,
  outIface: Iface,
  ip: Ipv4Pdu,
  base: Base,
): boolean {
  const cfg = node.l3 as unknown as RouterConfig;
  const fw = cfg.fw;
  if (!fw) return true;
  const k = l4Of(ip);
  fw.conns = purge(fw.conns, ctx.now);
  const inCfg = fw.ifaces[inIface.id];
  const outCfg = fw.ifaces[outIface.id];
  const deny = (key: string, params: Record<string, string | number> = {}): false => {
    fw.denied++;
    ctx.log({
      ...base,
      kind: 'drop',
      proto: 'FW',
      status: 'drop',
      msg: {
        key,
        params: {
          proto: k.proto,
          src: ip.src,
          dst: ip.dst,
          in: inCfg?.nameif ?? inIface.id,
          out: outCfg?.nameif ?? outIface.id,
          ...params,
        },
      },
    });
    return false;
  };
  if (!inCfg || !outCfg) return deny('fw.noNameif');

  // ICMP-Fehlermeldungen: nur zu bestehenden Verbindungen
  const p = ip.payload;
  if (p.kind === 'icmp' && p.orig) {
    const o = p.orig;
    const rel = fw.conns.find(
      (c) => (c.src === o.src && c.dst === o.dst) || (c.src === o.dst && c.dst === o.src),
    );
    return rel ? true : deny('fw.noConn');
  }

  const existing = fw.conns.find((c) => sameFlow(c, k, ip) !== undefined);
  if (existing) {
    const dir = sameFlow(existing, k, ip);
    const ifOk =
      dir === 'fwd'
        ? existing.inIface === inIface.id
        : existing.outIface === inIface.id && existing.inIface === outIface.id;
    if (ifOk) {
      existing.lastAt = ctx.now;
      if (p.kind === 'tcp') {
        if (p.flags.rst) fw.conns = fw.conns.filter((c) => c !== existing);
        else if (p.flags.fin)
          existing.flags = existing.flags.includes('f') ? existing.flags : existing.flags + 'f';
      }
      return true;
    }
  }

  // Neue Verbindung?
  if (p.kind === 'tcp' && !(p.flags.syn && !p.flags.ack)) return deny('fw.noConn');
  if (p.kind === 'icmp' && p.type !== 'echo-request') return deny('fw.noConn');

  const acl = fw.accessGroups[inIface.id];
  let allowed: boolean;
  if (acl) allowed = aclEval(cfg.acls[acl], ip).action === 'permit';
  else allowed = inCfg.level > outCfg.level || (inCfg.level === outCfg.level && fw.sameSecurity);
  if (!allowed) return deny(acl ? 'fw.aclDeny' : 'fw.levelDeny', { acl: acl ?? '' });

  fw.built++;
  fw.conns.push({
    proto: k.proto,
    src: ip.src,
    sport: k.sport,
    dst: ip.dst,
    dport: k.dport,
    inIface: inIface.id,
    outIface: outIface.id,
    createdAt: ctx.now,
    lastAt: ctx.now,
    flags: p.kind === 'tcp' ? 'UIO' : 'Oi',
  });
  if (fw.conns.length > 500) fw.conns.shift();
  ctx.log({
    ...base,
    kind: 'rx',
    proto: 'FW',
    status: 'info',
    msg: {
      key: 'fw.build',
      params: {
        proto: k.proto,
        src: ip.src,
        dst: ip.dst,
        in: inCfg.nameif,
        out: outCfg.nameif,
      },
    },
  });
  return true;
}

// ---------------------------------------------------------------- Objekt-NAT → Router-NAT

const maskWildcard = (mask: string): string => {
  const plen = maskToPrefix(mask) ?? 32;
  const w = (~(plen === 0 ? 0 : (0xffffffff << (32 - plen)) >>> 0) >>> 0) >>> 0;
  return [w >>> 24, (w >> 16) & 255, (w >> 8) & 255, w & 255].join('.');
};

/** Leitet aus den `object network`-NAT-Definitionen die NAT-Regeln und -Seiten des Routerkerns ab. */
export function fwApplyNat(cfg: RouterConfig): void {
  const fw = cfg.fw;
  if (!fw) return;
  cfg.nat.rules = [];
  for (const name of Object.keys(cfg.acls)) if (name.startsWith('__fwnat_')) delete cfg.acls[name];
  for (const ic of Object.values(cfg.ifaces)) delete ic.natSide;
  const byName = (nameif: string): string | undefined =>
    Object.entries(fw.ifaces).find(([, v]) => v.nameif === nameif)?.[0];
  for (const o of Object.values(fw.objects)) {
    if (!o.nat || !o.net) continue;
    const from = byName(o.nat.from);
    const to = byName(o.nat.to);
    if (!from || !to) continue;
    cfg.ifaces[from] ??= { kind: 'phys', portId: from };
    cfg.ifaces[to] ??= { kind: 'phys', portId: to };
    (cfg.ifaces[from] as { natSide?: string }).natSide = 'inside';
    (cfg.ifaces[to] as { natSide?: string }).natSide = 'outside';
    if (o.nat.kind === 'dynamic-interface') {
      const acl = FW_NAT_ACL(o.name);
      cfg.acls[acl] = {
        name: acl,
        type: 'extended',
        entries: [
          {
            seq: 10,
            action: 'permit',
            proto: 'ip',
            src: { ip: o.net.ip, wildcard: maskWildcard(o.net.mask) },
            dst: { any: true },
            matches: 0,
          },
        ],
      };
      cfg.nat.rules.push({ kind: 'interface', acl, ifaceId: to });
    } else if (o.nat.mapped) {
      cfg.nat.rules.push({ kind: 'static', local: o.net.ip, global: o.nat.mapped });
    }
  }
}

export type { FwObject };

/** Uptime-String wie ASA (`0:00:05`). */
export function idleText(us: number): string {
  const s = Math.floor(us / 1_000_000);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export { nameOf };
