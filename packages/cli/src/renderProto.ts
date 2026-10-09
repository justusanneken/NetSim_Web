import type { Device, IfaceCfg, L3Cfg } from '@netsim/engine';
import { ifDisplay } from './ifnames';

/** Schnittstellen-Zeilen für PPPoE (physischer Port) – an jeder Schnittstelle erlaubt. */
export function protoIfaceLines(c: IfaceCfg, out: string[]): void {
  if (c.pppoeClientPool !== undefined)
    out.push(` pppoe-client dial-pool-number ${c.pppoeClientPool}`);
  if (c.pppoeGroup !== undefined)
    out.push(c.pppoeGroup === 'global' ? ' pppoe enable' : ` pppoe enable group ${c.pppoeGroup}`);
}

/** `interface Dialer N` (PPPoE-Client). */
export function dialerLines(c: IfaceCfg): string[] {
  const d = c.dialer;
  const out: string[] = [];
  if (d?.negotiated) out.push(' ip address negotiated');
  else out.push(' no ip address');
  out.push(' encapsulation ppp');
  if (d) out.push(` dialer pool ${d.pool}`);
  if (d?.chapUser !== undefined) out.push(` ppp chap hostname ${d.chapUser}`);
  if (d?.chapPass !== undefined) out.push(` ppp chap password 0 ${d.chapPass}`);
  if (d?.ipcpRoute) out.push(' ppp ipcp route default');
  return out;
}

/** `interface Virtual-Template N` (PPPoE-Server). */
export function vtemplateLines(d: Device, c: IfaceCfg): string[] {
  const t = c.vtemplate;
  const out: string[] = [];
  if (t?.unnumbered) out.push(` ip unnumbered ${ifDisplay(d, t.unnumbered)}`);
  else if (c.ip && c.mask) out.push(` ip address ${c.ip} ${c.mask}`);
  if (t?.pool) out.push(` peer default ip address pool ${t.pool}`);
  if (t?.chap) out.push(' ppp authentication chap');
  return out;
}

/** Globale PPPoE-Zeilen: `bba-group pppoe`, `ip local pool`. */
export function protoGlobalLines(cfg: L3Cfg): string[] {
  const L: string[] = [];
  for (const g of Object.values(cfg.bba ?? {})) {
    L.push(`bba-group pppoe ${g.name}`);
    if (g.template !== undefined) L.push(` virtual-template ${g.template}`);
    L.push('!');
  }
  for (const p of Object.values(cfg.ipPools ?? {}))
    L.push(`ip local pool ${p.name} ${p.start} ${p.end}`);
  return L;
}
