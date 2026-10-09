import type { Device, IfaceCfg, L3Cfg } from '@netsim/engine';
import { ifDisplay } from './ifnames';

/** Schnittstellen-Zeilen für PPPoE (physischer Port) – an jeder Schnittstelle erlaubt. */
export function protoIfaceLines(c: IfaceCfg, out: string[]): void {
  if (c.pppoeClientPool !== undefined)
    out.push(` pppoe-client dial-pool-number ${c.pppoeClientPool}`);
  if (c.cryptoMap !== undefined) out.push(` crypto map ${c.cryptoMap}`);
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
    L.push(`ip local pool ${p.name} ${p.start}${p.end !== p.start ? ` ${p.end}` : ''}`);
  return L;
}

/** IPsec: ISAKMP-Policies, Schlüssel, Transform-Sets und Crypto Maps (nur nicht-Default-Werte der Policy). */
export function cryptoGlobalLines(cfg: L3Cfg): string[] {
  const c = cfg.crypto;
  if (!c) return [];
  const L: string[] = [];
  for (const p of Object.values(c.policies).sort((a, b) => a.prio - b.prio)) {
    L.push(`crypto isakmp policy ${p.prio}`);
    if (p.encr !== 'des') L.push(` encr ${p.encr}`);
    if (p.hash !== 'sha') L.push(` hash ${p.hash}`);
    if (p.auth !== 'rsa-sig') L.push(` authentication ${p.auth}`);
    if (p.group !== 1) L.push(` group ${p.group}`);
    if (p.lifetime !== 86400) L.push(` lifetime ${p.lifetime}`);
    L.push('!');
  }
  for (const k of c.keys)
    L.push(
      `crypto isakmp key ${k.key} address ${k.addr}${k.mask !== '255.255.255.255' ? ' ' + k.mask : ''}`,
    );
  if (c.keys.length) L.push('!');
  for (const t of Object.values(c.transformSets)) {
    L.push(`crypto ipsec transform-set ${t.name} ${t.transforms.join(' ')}`);
    if (t.mode !== 'tunnel') L.push(` mode ${t.mode}`);
    L.push('!');
  }
  for (const m of Object.values(c.maps))
    for (const e of Object.values(m.entries).sort((a, b) => a.seq - b.seq)) {
      L.push(`crypto map ${m.name} ${e.seq} ipsec-isakmp`);
      if (e.peer) L.push(` set peer ${e.peer}`);
      if (e.lifetimeSec !== undefined)
        L.push(` set security-association lifetime seconds ${e.lifetimeSec}`);
      if (e.transformSet) L.push(` set transform-set ${e.transformSet}`);
      if (e.pfs) L.push(` set pfs ${e.pfs}`);
      if (e.acl) L.push(` match address ${e.acl}`);
      L.push('!');
    }
  return L;
}
