import { maskToPrefix, parseIpv4, prefixToMask } from '@netsim/protocols';
import type { Device, IfaceCfg, L3Cfg, Port } from '../types';

/** Zerlegt `GigabitEthernet0/1.10` in Buchstaben, Ziffernpfad und optionale Subinterface-Nummer. */
function splitName(text: string): { alpha: string; num: string; sub?: number } | undefined {
  const m = /^([a-z][a-z-]*)\s*(\d+(?:\/\d+)*)(?:\.(\d+))?$/i.exec(text.trim());
  if (!m) return undefined;
  return {
    alpha: (m[1] as string).toLowerCase(),
    num: m[2] as string,
    sub: m[3] ? Number(m[3]) : undefined,
  };
}

/** Port per ID (`p0`), vollem Namen oder IOS-Abkuerzung (`Gi0/1`, `fa0/1`) finden. */
export function resolvePort(dev: Device, text: string): Port | undefined {
  const t = text.trim();
  const direct = dev.ports.find((p) => p.id === t || p.name.toLowerCase() === t.toLowerCase());
  if (direct) return direct;
  const q = splitName(t);
  if (!q || q.sub !== undefined) return undefined;
  const cands = dev.ports.filter((p) => {
    const n = splitName(p.name);
    return n && n.num === q.num && n.alpha.startsWith(q.alpha) && q.alpha.length >= 2;
  });
  return cands.length === 1 ? cands[0] : undefined;
}

/** L3-Schnittstelle (physisch, Subinterface `Gi0/0.10`, SVI `Vlan10`, Loopback) in der Konfiguration finden. */
export function resolveIface(
  dev: Device,
  cfg: L3Cfg,
  text: string,
): { id: string; cfg: IfaceCfg } | undefined {
  const t = text.trim();
  const lower = t.toLowerCase();
  const svi = /^vlan\s*(\d+)$/.exec(lower);
  if (svi) {
    const c = cfg.ifaces[`vlan${svi[1]}`];
    return c ? { id: `vlan${svi[1]}`, cfg: c } : undefined;
  }
  const lo = /^(?:loopback|lo)\s*(\d+)$/.exec(lower);
  if (lo) {
    const c = cfg.ifaces[`lo${lo[1]}`];
    return c ? { id: `lo${lo[1]}`, cfg: c } : undefined;
  }
  if (cfg.ifaces[t]) return { id: t, cfg: cfg.ifaces[t] as IfaceCfg };
  const q = splitName(t);
  const base =
    q && q.sub !== undefined ? resolvePort(dev, `${q.alpha}${q.num}`) : resolvePort(dev, t);
  if (!base) return undefined;
  const id = q?.sub !== undefined ? `${base.id}.${q.sub}` : base.id;
  const c = cfg.ifaces[id];
  return c ? { id, cfg: c } : undefined;
}

/** Maske in Punktschreibweise oder `/24`. */
export function normMask(m: string | undefined): string | undefined {
  if (m === undefined) return undefined;
  const s = m.trim();
  const slash = /^\/?(\d{1,2})$/.exec(s);
  if (slash) {
    const n = Number(slash[1]);
    return n >= 0 && n <= 32 ? prefixToMask(n) : undefined;
  }
  return maskToPrefix(s) !== undefined ? s : undefined;
}

/** Praefixlaenge einer Maske in Punkt- oder Slash-Schreibweise. */
export function plenOf(m: string | number | undefined): number | undefined {
  if (typeof m === 'number') return m >= 0 && m <= 32 ? m : undefined;
  const n = normMask(m);
  return n === undefined ? undefined : maskToPrefix(n);
}

/** Netzadresse als Zahl (fuer Vergleiche von Praefixen). */
export function netNum(ip: string, plen: number): number | undefined {
  const n = parseIpv4(ip);
  if (n === undefined) return undefined;
  const mask = plen === 0 ? 0 : (0xffffffff << (32 - plen)) >>> 0;
  return (n & mask) >>> 0;
}
