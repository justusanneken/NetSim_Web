import {
  IP_PROTO,
  parseIpv4,
  summarizeFrame,
  type EspPdu,
  type Frame,
  type IkePdu,
  type Ipv4Addr,
  type Ipv4Pdu,
  type UdpPdu,
} from '@netsim/protocols';
import { aclEval, matchAddr } from '../acl';
import type { DeviceCtx } from '../ctx';
import type { Iface } from '../ifaces';
import { eth, ifaceFrameRx, ipSend, newIpPacket, sendUdp, type Base, type IpNode } from '../l3';
import {
  newCrypto,
  type CryptoCfg,
  type CryptoMapEntry,
  type IpsecSa,
  type IsakmpPolicy,
} from '../ipsecTypes';
import type { AclProto, AddrMatch, L3Cfg } from '../types';
import { cancelBg, setBg, type Rt } from './core';

/**
 * IPsec Site-to-Site mit Crypto Maps (vereinfacht): IKE als ein Austausch (Anfrage/Antwort, UDP 500) für IKE- und
 * IPsec-SA, ESP im Tunnelmodus (IP-Protokoll 50). Das gekapselte Paket ist im Inspektor nicht sichtbar.
 */

const SEC = 1_000_000;
const IKE_TIMEOUT = 3 * SEC;
const RETRY_AFTER = 8 * SEC;

export const cryptoOf = (cfg: L3Cfg): CryptoCfg => (cfg.crypto ??= newCrypto());

/** IP-Protokollnummer einer Crypto-ACL-Zeile (`ip` = 0, wie `prot` in `show crypto ipsec sa`). */
const aclProtoNum = (p: AclProto): number => (p === 'ip' ? 0 : IP_PROTO[p]);

const spiOf = (n: number): number => (0x2a31c000 + n * 0x1a7) >>> 0;

/** Digest über den Pre-Shared Key (kein Klartext auf der Leitung; deterministischer Pseudo-Hash). */
export function keyDigest(key: string, cookie: number): string {
  let h1 = 2166136261;
  let h2 = 5381;
  for (const ch of `${key}|${cookie}`) {
    h1 = Math.imul(h1 ^ ch.charCodeAt(0), 16777619) >>> 0;
    h2 = (Math.imul(h2, 33) + ch.charCodeAt(0)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

const am = (m: AddrMatch | undefined): string =>
  !m || 'any' in m ? 'any' : m.wildcard === '0.0.0.0' ? `host ${m.ip}` : `${m.ip}/${m.wildcard}`;
const parseAm = (s: string): AddrMatch | undefined => {
  if (s === 'any') return { any: true };
  if (s.startsWith('host ')) return { ip: s.slice(5), wildcard: '0.0.0.0' };
  const [ip, wildcard] = s.split('/');
  return ip && wildcard ? { ip, wildcard } : undefined;
};
const matches = (s: string, ip: Ipv4Addr): boolean => {
  const m = parseAm(s);
  return !m || matchAddr(m, ip);
};

const maskMatch = (key: { addr: string; mask: string }, ip: Ipv4Addr): boolean => {
  const a = parseIpv4(ip);
  const b = parseIpv4(key.addr);
  const m = parseIpv4(key.mask);
  return a !== undefined && b !== undefined && m !== undefined && ((a ^ b) & m) >>> 0 === 0;
};

function log(
  rt: Rt,
  key: string,
  params: Record<string, string | number>,
  status: 'ok' | 'info' | 'error' = 'info',
): void {
  rt.ctx.log({ kind: 'info', proto: 'IKE', status, msg: { key, params } });
}

// ------------------------------------------------------------------ Hilfen

const bestPolicy = (c: CryptoCfg): IsakmpPolicy | undefined =>
  Object.values(c.policies).sort((a, b) => a.prio - b.prio)[0];

const entriesOf = (cfg: L3Cfg, mapName: string): CryptoMapEntry[] =>
  Object.values(cfg.crypto?.maps[mapName]?.entries ?? {}).sort((a, b) => a.seq - b.seq);

/** Eintrag einer Crypto Map (auf irgendeiner Schnittstelle), der zum Peer gehört. */
function entryForPeer(
  cfg: L3Cfg,
  peer: Ipv4Addr,
): { entry: CryptoMapEntry; mapName: string; ifaceId: string } | undefined {
  for (const [ifaceId, ic] of Object.entries(cfg.ifaces)) {
    if (!ic.cryptoMap) continue;
    const e = entriesOf(cfg, ic.cryptoMap).find((x) => x.peer === peer);
    if (e) return { entry: e, mapName: ic.cryptoMap, ifaceId };
  }
  return undefined;
}

// ------------------------------------------------------------------ Senden (Crypto-Map-Schnittstelle)

/**
 * Ausgehender Frame an einer Schnittstelle mit `crypto map`: passt das Paket auf eine Crypto-ACL, wird es
 * ESP-gekapselt (SA steht), verworfen (SA im Aufbau, IKE wird angestoßen) oder unverschlüsselt gesendet.
 * `true` = Frame wurde verbraucht.
 */
export function cryptoXmit(
  c: DeviceCtx,
  node: IpNode,
  iface: Pick<Iface, 'id' | 'ip' | 'cfg'>,
  frame: Frame,
): boolean {
  const cfg = node.l3;
  const mapName = iface.cfg.cryptoMap;
  const inner = frame.payload;
  if (!cfg || !mapName || !cfg.crypto || inner.kind !== 'ipv4') return false;
  const p = inner.payload;
  if (p.kind === 'esp' || (p.kind === 'udp' && p.dstPort === 500 && p.srcPort === 500))
    return false;
  const rt = { ctx: c, node, dev: node.dev, cfg, r: cfg.routing } as unknown as Rt;
  for (const entry of entriesOf(cfg, mapName)) {
    const acl = entry.acl ? cfg.acls[entry.acl] : undefined;
    if (!acl || !entry.peer) continue;
    const r = aclEval(acl, inner);
    if (r.action !== 'permit' || !r.entry) continue;
    const proto = aclProtoNum(r.entry.proto);
    const sel = { src: am(r.entry.src), dst: am(r.entry.dst), ...(proto ? { proto } : {}) };
    const key = `${entry.peer}|${sel.src}>${sel.dst}${proto ? `/${proto}` : ''}`;
    const sa = cfg.crypto.sas[key];
    if (sa?.state === 'up') {
      sa.encaps++;
      const esp: EspPdu = {
        kind: 'esp',
        spi: sa.outSpi,
        seq: sa.encaps,
        cipher: sa.transform,
        inner,
      };
      const outer = newIpPacket(node, iface.ip, entry.peer, esp, { ttl: 255 });
      c.log({
        kind: 'info',
        proto: 'ESP',
        status: 'ok',
        msg: { key: 'ipsec.encap', params: { peer: entry.peer, spi: sa.outSpi.toString(16) } },
      });
      if (!ipSend(c, node, outer).ok) sa.dropped++;
      return true;
    }
    if (sa?.state === 'connecting') {
      sa.dropped++;
      return true;
    }
    if (!sa || (sa.retryAt ?? 0) <= c.now) startIke(rt, iface, entry, mapName, sel, key);
    else sa.dropped++;
    c.log({
      kind: 'drop',
      proto: 'ESP',
      status: 'drop',
      msg: { key: 'ipsec.noSa', params: { peer: entry.peer } },
    });
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ IKE

function setFailed(rt: Rt, sa: IpsecSa, reason: string): void {
  sa.state = 'failed';
  sa.reason = reason;
  sa.retryAt = rt.ctx.now + RETRY_AFTER;
  cancelBg(rt, `rt:ipsec:to:${sa.key}`);
  log(rt, 'ipsec.ikeFailed', { peer: sa.peer, reason }, 'error');
}

function startIke(
  rt: Rt,
  iface: Pick<Iface, 'id' | 'ip'>,
  entry: CryptoMapEntry,
  mapName: string,
  sel: { src: string; dst: string },
  key: string,
): void {
  const c = cryptoOf(rt.cfg);
  const peer = entry.peer as Ipv4Addr;
  const ts = entry.transformSet ? c.transformSets[entry.transformSet] : undefined;
  const policy = bestPolicy(c);
  const sa: IpsecSa = {
    key,
    peer,
    local: iface.ip,
    ifaceId: iface.id,
    mapName,
    seq: entry.seq,
    sel,
    role: 'initiator',
    state: 'connecting',
    inSpi: spiOf(c.nextSpi++),
    outSpi: 0,
    transform: ts?.transforms.join(' ') ?? '',
    encr: policy?.encr ?? '',
    hash: policy?.hash ?? '',
    connId: c.nextConn++,
    cookie: 0x4000 + c.nextConn * 977,
    since: rt.ctx.now,
    encaps: 0,
    decaps: 0,
    dropped: 1,
  };
  c.sas[key] = sa;
  const psk = c.keys.find((k) => maskMatch(k, peer));
  if (!policy) return setFailed(rt, sa, 'no ISAKMP policy configured');
  if (policy.auth !== 'pre-share')
    return setFailed(rt, sa, 'policy authentication is not pre-share');
  if (!psk) return setFailed(rt, sa, 'no pre-shared key for peer');
  if (!ts) return setFailed(rt, sa, 'transform set missing');
  const msg: IkePdu = {
    kind: 'ike',
    op: 'request',
    cookie: sa.cookie,
    encr: policy.encr,
    hash: policy.hash,
    group: policy.group,
    authHash: keyDigest(psk.key, sa.cookie),
    transform: sa.transform,
    selector: sel,
    spi: sa.inSpi,
  };
  log(rt, 'ipsec.ikeStart', { peer }, 'info');
  sendUdp(rt.ctx, rt.node, { src: iface.ip, dst: peer, sport: 500, dport: 500, app: msg });
  setBg(rt, `rt:ipsec:to:${key}`, IKE_TIMEOUT);
}

/** IKE-Nachricht (UDP 500). */
export function ikeRx(rt: Rt, iface: Iface, base: Base, ip: Ipv4Pdu, udp: UdpPdu, m: IkePdu): void {
  const c = cryptoOf(rt.cfg);
  if (m.op === 'request') return ikeRequest(rt, iface, ip, udp, m, c);
  const sa = Object.values(c.sas).find((x) => x.cookie === m.cookie && x.peer === ip.src);
  if (!sa || sa.state !== 'connecting') return;
  cancelBg(rt, `rt:ipsec:to:${sa.key}`);
  if (m.op === 'reject') return setFailed(rt, sa, m.reason ?? 'rejected by peer');
  sa.outSpi = m.spi;
  sa.state = 'up';
  sa.since = rt.ctx.now;
  log(rt, 'ipsec.saUp', { peer: sa.peer, spi: sa.inSpi.toString(16) }, 'ok');
  void base;
}

function ikeRequest(rt: Rt, iface: Iface, ip: Ipv4Pdu, udp: UdpPdu, m: IkePdu, c: CryptoCfg): void {
  const reply = (op: 'accept' | 'reject', spi: number, reason?: string): void => {
    const msg: IkePdu = { ...m, op, spi, reason, authHash: '', selector: m.selector };
    sendUdp(rt.ctx, rt.node, {
      src: iface.ip,
      dst: ip.src,
      sport: 500,
      dport: udp.srcPort,
      app: msg,
    });
  };
  const found = entryForPeer(rt.cfg, ip.src);
  const fail = (reason: string): void => {
    log(rt, 'ipsec.ikeRejected', { peer: ip.src, reason }, 'error');
    reply('reject', 0, reason);
  };
  if (!found) return fail('no crypto map entry for peer');
  const { entry, mapName } = found;
  const policy = Object.values(c.policies)
    .sort((a, b) => a.prio - b.prio)
    .find(
      (p) =>
        p.auth === 'pre-share' && p.encr === m.encr && p.hash === m.hash && p.group === m.group,
    );
  if (!policy) return fail('no matching ISAKMP policy');
  const psk = c.keys.find((k) => maskMatch(k, ip.src));
  if (!psk || keyDigest(psk.key, m.cookie) !== m.authHash) return fail('authentication failed');
  const ts = entry.transformSet ? c.transformSets[entry.transformSet] : undefined;
  if (!ts || ts.transforms.join(' ') !== m.transform) return fail('transform set mismatch');
  const acl = entry.acl ? rt.cfg.acls[entry.acl] : undefined;
  const sel = m.selector;
  // Spiegel: die eigene Crypto-ACL muss Quelle/Ziel des Peers umgekehrt erlauben
  const mirror = acl?.entries.find(
    (e) =>
      e.action === 'permit' &&
      sel &&
      am(e.src) === sel.dst &&
      am(e.dst) === sel.src &&
      aclProtoNum(e.proto) === (sel.proto ?? 0),
  );
  if (!sel || !mirror) return fail('proxy identities not supported');
  const key = `${ip.src}|${sel.dst}>${sel.src}${sel.proto ? `/${sel.proto}` : ''}`;
  const sa: IpsecSa = {
    key,
    peer: ip.src,
    local: ip.dst,
    ifaceId: found.ifaceId,
    mapName,
    seq: entry.seq,
    sel: { src: sel.dst, dst: sel.src, ...(sel.proto ? { proto: sel.proto } : {}) },
    role: 'responder',
    state: 'up',
    inSpi: spiOf(c.nextSpi++),
    outSpi: m.spi,
    transform: ts.transforms.join(' '),
    encr: policy.encr,
    hash: policy.hash,
    connId: c.nextConn++,
    cookie: m.cookie,
    since: rt.ctx.now,
    encaps: 0,
    decaps: 0,
    dropped: 0,
  };
  c.sas[key] = sa;
  log(rt, 'ipsec.saUp', { peer: ip.src, spi: sa.inSpi.toString(16) }, 'ok');
  reply('accept', sa.inSpi);
}

// ------------------------------------------------------------------ ESP-Empfang

export function ipsecRx(rt: Rt, iface: Iface, base: Base, ip: Ipv4Pdu, esp: EspPdu): void {
  const c = cryptoOf(rt.cfg);
  const sa = Object.values(c.sas).find(
    (x) => x.state === 'up' && x.inSpi === esp.spi && x.peer === ip.src,
  );
  if (!sa) {
    rt.ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'ipsec.badSpi', params: { spi: esp.spi.toString(16), src: ip.src } },
    });
    return;
  }
  // Auswahl prüfen: Quelle gehört zur Gegenseite, Ziel zu uns
  if (!matches(sa.sel.dst, esp.inner.src) || !matches(sa.sel.src, esp.inner.dst)) {
    sa.dropped++;
    rt.ctx.log({
      ...base,
      kind: 'drop',
      status: 'drop',
      msg: { key: 'ipsec.badSelector', params: { src: esp.inner.src, dst: esp.inner.dst } },
    });
    return;
  }
  sa.decaps++;
  const { proto, info } = summarizeFrame(eth(iface.mac, iface.mac, esp.inner));
  rt.ctx.log({
    ...base,
    kind: 'rx',
    proto: 'ESP',
    status: 'ok',
    summary: `decrypted ${info}`,
    msg: { key: 'ipsec.decap', params: { peer: ip.src, spi: esp.spi.toString(16) } },
  });
  void proto;
  ifaceFrameRx(rt.ctx, rt.node, iface, eth(iface.mac, iface.mac, esp.inner), base.from);
}

// ------------------------------------------------------------------ Timer / Zustand

export function ipsecTimer(rt: Rt, name: string): boolean {
  if (!name.startsWith('rt:ipsec:to:')) return false;
  const sa = rt.cfg.crypto?.sas[name.slice('rt:ipsec:to:'.length)];
  if (sa?.state === 'connecting') setFailed(rt, sa, 'no response from peer (timeout)');
  return true;
}

export function ipsecReset(cfg: L3Cfg): void {
  if (cfg.crypto) cfg.crypto.sas = {};
}

/** `clear crypto sa` / `clear crypto isakmp`. */
export function ipsecClear(rt: Rt): void {
  if (rt.cfg.crypto) rt.cfg.crypto.sas = {};
}
