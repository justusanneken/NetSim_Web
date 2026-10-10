import type {
  BgpAttrs,
  BgpMsg,
  EigrpMsg,
  EigrpRoute,
  OspfAuth,
  OspfLsa,
  OspfLsaHeader,
  OspfMsg,
} from '../types';
import { prefixToMask } from '../addr';
import {
  digestBytes,
  inetChecksum,
  ip4Bytes,
  ip6Bytes,
  transportChecksum,
  type IpCtx,
  W,
} from './bytes';

// ------------------------------------------------------------------ OSPF (RFC 2328 / RFC 5340)

const OSPF_TYPE = { hello: 1, dbd: 2, lsr: 3, lsu: 4, lsack: 5 } as const;

/** Fletcher-Prüfsumme einer LSA (ISO 8473 Anhang C, RFC 2328 §12.1.7); schreibt sie an Offset 16–17. */
export function lsaChecksum(lsa: number[]): void {
  lsa[16] = 0;
  lsa[17] = 0;
  let c0 = 0;
  let c1 = 0;
  for (let i = 2; i < lsa.length; i++) {
    c0 = (c0 + (lsa[i] as number)) % 255;
    c1 = (c1 + c0) % 255;
  }
  const l = lsa.length - 2;
  const p = 15; // 1-basierte Position des Prüfsummen-Feldes innerhalb der abgedeckten Bytes (Offset 16 − 2 + 1)
  let x = ((l - p) * c0 - c1) % 255;
  if (x <= 0) x += 255;
  let y = 510 - c0 - x;
  if (y > 255) y -= 255;
  lsa[16] = x;
  lsa[17] = y;
}

const lsaTypeV2 = (t: number): number => t;
const lsaTypeV3 = (t: number): number =>
  ({ 1: 0x2001, 2: 0x2002, 3: 0x2003, 4: 0x2004, 5: 0x4005, 7: 0x2007 })[t] ?? 0x2001;

function lsaHeader(h: OspfLsaHeader, v: 2 | 3, len: number): number[] {
  const w = new W().u16(Math.min(h.age, 3600));
  if (v === 2) w.u8(0x02).u8(lsaTypeV2(h.type));
  else w.u16(lsaTypeV3(h.type));
  w.ip4(h.id)
    .ip4(h.advRouter)
    .u32((0x80000000 + h.seq) >>> 0)
    .u16(0)
    .u16(len);
  return w.b;
}

function prefixBytes6(prefix: string, plen: number): number[] {
  return ip6Bytes(prefix).slice(0, Math.ceil(plen / 32) * 4);
}

function lsaBody(l: OspfLsa, v: 2 | 3): number[] {
  const b = l.body;
  const w = new W();
  if (v === 2) {
    switch (b.type) {
      case 1:
        w.u8((b.abr ? 1 : 0) | (b.asbr ? 2 : 0))
          .u8(0)
          .u16(b.links.length);
        for (const k of b.links) {
          if (k.kind === 'stub')
            w.ip4(k.prefix ?? '0.0.0.0')
              .ip4(prefixToMask(k.plen ?? 24))
              .u8(3);
          else
            w.ip4(k.neighbor ?? '0.0.0.0')
              .ip4(k.addr ?? '0.0.0.0')
              .u8(k.kind === 'p2p' ? 1 : 2);
          w.u8(0).u16(k.cost);
        }
        break;
      case 2:
        w.ip4(prefixToMask(b.plen));
        for (const r of b.attached) w.ip4(r);
        break;
      case 3:
        w.ip4(prefixToMask(b.plen)).u8(0).u24(b.metric);
        break;
      case 4:
        w.ip4('0.0.0.0').u8(0).u24(b.metric);
        break;
      case 5:
      case 7:
        w.ip4(prefixToMask(b.plen))
          .u8(b.eType === 2 ? 0x80 : 0)
          .u24(b.metric)
          .ip4(('fwd' in b ? b.fwd : undefined) ?? '0.0.0.0')
          .u32(b.tag);
        break;
    }
    return w.b;
  }
  // OSPFv3 (vereinfachte, aber formtreue LSA-Rümpfe)
  switch (b.type) {
    case 1:
      w.u8((b.abr ? 1 : 0) | (b.asbr ? 2 : 0)).u24(0x13);
      for (const k of b.links) {
        if (k.kind === 'stub') continue;
        w.u8(k.kind === 'p2p' ? 1 : 2)
          .u8(0)
          .u16(k.cost)
          .u32(1)
          .u32(1)
          .ip4(k.neighbor ?? '0.0.0.0');
      }
      break;
    case 2:
      w.u8(0).u24(0x13);
      for (const r of b.attached) w.ip4(r);
      break;
    case 3:
      w.u8(0).u24(b.metric).u8(b.plen).u8(0).u16(0).bytes(prefixBytes6(b.prefix, b.plen));
      break;
    case 4:
      w.u8(0).u24(0x13).u8(0).u24(b.metric).ip4(b.asbr);
      break;
    case 5:
    case 7:
      w.u8(b.eType === 2 ? 0x04 : 0)
        .u24(b.metric)
        .u8(b.plen)
        .u8(0)
        .u16(0)
        .bytes(prefixBytes6(b.prefix, b.plen));
      w.u32(b.tag);
      break;
  }
  return w.b;
}

export function encodeLsa(l: OspfLsa, v: 2 | 3): number[] {
  const body = lsaBody(l, v);
  const lsa = [...lsaHeader(l, v, 20 + body.length), ...body];
  lsaChecksum(lsa);
  return lsa;
}

function lsaHeaderChecksummed(h: OspfLsaHeader, v: 2 | 3): number[] {
  // Eine eigenständige Header-Kopie (DBD/Ack): Länge/Prüfsumme der zugehörigen LSA sind nicht bekannt → plausible Werte.
  const hdr = lsaHeader(h, v, 20);
  hdr[16] = 0;
  hdr[17] = 0;
  return hdr;
}

function authBytes(auth: OspfAuth | undefined): { type: number; data: number[] } {
  if (!auth) return { type: 0, data: new Array<number>(8).fill(0) };
  if (auth.type === 'simple') {
    const k = [...auth.key].map((c) => c.charCodeAt(0) & 0xff).slice(0, 8);
    while (k.length < 8) k.push(0);
    return { type: 1, data: k };
  }
  return { type: 2, data: [0, 0, auth.keyId & 0xff, 16, 0, 0, 0, 1] };
}

export function encodeOspf(p: { v: 2 | 3; msg: OspfMsg }, ctx?: IpCtx): Uint8Array {
  const { v, msg: m } = p;
  const body = new W();
  switch (m.type) {
    case 'hello': {
      const opt = m.areaType === 'stub' ? 0x00 : m.areaType === 'nssa' ? 0x08 : 0x02;
      if (v === 2) {
        body
          .ip4(prefixToMask(m.plen ?? 24))
          .u16(m.helloSec)
          .u8(opt)
          .u8(m.priority)
          .u32(m.deadSec);
      } else {
        body
          .u32(1)
          .u8(m.priority)
          .u24(opt | 0x11)
          .u16(m.helloSec)
          .u16(m.deadSec);
      }
      body.ip4(m.dr || '0.0.0.0').ip4(m.bdr || '0.0.0.0');
      for (const n of m.neighbors) body.ip4(n);
      break;
    }
    case 'dbd': {
      const flags = (m.init ? 4 : 0) | (m.more ? 2 : 0) | (m.master ? 1 : 0);
      if (v === 2) body.u16(1500).u8(0x02).u8(flags).u32(m.ddSeq);
      else body.u8(0).u24(0x13).u16(1500).u8(0).u8(flags).u32(m.ddSeq);
      for (const h of m.headers) body.bytes(lsaHeaderChecksummed(h, v));
      break;
    }
    case 'lsr':
      if (v === 3) body.u16(0);
      for (const r of m.requests) {
        if (v === 2) body.u32(r.type);
        else body.u16(0).u16(lsaTypeV3(r.type));
        body.ip4(r.id).ip4(r.advRouter);
      }
      break;
    case 'lsu':
      body.u32(m.lsas.length);
      for (const l of m.lsas) body.bytes(encodeLsa(l, v));
      break;
    case 'lsack':
      for (const h of m.headers) body.bytes(lsaHeaderChecksummed(h, v));
      break;
  }
  const hdrLen = v === 2 ? 24 : 16;
  const total = hdrLen + body.length;
  const w = new W().u8(v).u8(OSPF_TYPE[m.type]).u16(total).ip4(m.routerId).ip4(m.areaId);
  if (v === 2) {
    const a = authBytes(m.auth);
    w.u16(0).u16(a.type).bytes(a.data).bytes(body.b);
    if (a.type === 2) {
      w.set16(12, 0);
      w.bytes(digestBytes(m.auth && m.auth.type === 'md5' ? m.auth.digest : '', 16));
      // Länge im Kopf zählt die Digest-Anhänge nicht mit (RFC 2328 D.3)
    } else {
      // Prüfsumme über das ganze Paket, ohne das Authentifizierungsfeld (dort stehen Nullen für die Summe)
      const tmp = w.b.slice();
      for (let i = 16; i < 24; i++) tmp[i] = 0;
      w.set16(12, inetChecksum(tmp));
    }
  } else {
    w.u16(0).u8(0).u8(0).bytes(body.b);
    if (ctx) w.set16(12, transportChecksum(ctx, 89, w.b));
  }
  return w.out();
}

// ------------------------------------------------------------------ EIGRP (Cisco, RFC 7868)

const EIGRP_OP = { update: 1, query: 3, reply: 4, hello: 5, ack: 5 } as const;

function prefixBytes(prefix: string, plen: number, v6: boolean): number[] {
  const all = v6 ? ip6Bytes(prefix) : ip4Bytes(prefix);
  return all.slice(0, Math.ceil(plen / 8));
}

function eigrpRoute(r: EigrpRoute, v6: boolean): number[] {
  const w = new W();
  const nh = v6 ? ip6Bytes('::') : ip4Bytes('0.0.0.0');
  const metric = (): void => {
    w.u32(r.unreachable ? 0xffffffff : r.delay)
      .u32(r.bandwidth)
      .u24(1500)
      .u8(r.hops)
      .u8(255)
      .u8(1)
      .u16(0);
  };
  if (r.external) {
    w.bytes(nh).bytes(ip4Bytes(r.external.router)).u32(0).u32(0).u32(0).u16(0).u8(0).u8(0);
    metric();
    w.u8(r.plen).bytes(prefixBytes(r.prefix, r.plen, v6));
    return [
      ...new W()
        .u16(v6 ? 0x0403 : 0x0103)
        .u16(4 + w.length)
        .bytes(w.b).b,
    ];
  }
  w.bytes(nh);
  metric();
  w.u8(r.plen).bytes(prefixBytes(r.prefix, r.plen, v6));
  return [
    ...new W()
      .u16(v6 ? 0x0402 : 0x0102)
      .u16(4 + w.length)
      .bytes(w.b).b,
  ];
}

export function encodeEigrp(m: EigrpMsg, v6: boolean): Uint8Array {
  const tlv = new W();
  if (m.op === 'hello' && m.ack === 0) {
    tlv.u16(0x0001).u16(12).bytes([1, 0, 1, 0, 0, 0]).u16(m.holdSec);
    tlv.u16(0x0004).u16(8).bytes([12, 4, 2, 0]);
  }
  for (const r of m.routes ?? []) tlv.bytes(eigrpRoute(r, v6));
  const op = m.op === 'ack' ? 5 : EIGRP_OP[m.op];
  const asn = m.asn & 0xffff;
  const w = new W()
    .u8(2)
    .u8(op)
    .u16(0)
    .u32(m.init ? 1 : 0)
    .u32(m.seq)
    .u32(m.ack)
    .u16(0)
    .u16(asn)
    .bytes(tlv.b);
  w.set16(2, inetChecksum(w.b));
  return w.out();
}

// ------------------------------------------------------------------ BGP-4 (RFC 4271)

function nlri(w: W, list: { prefix: string; plen: number }[]): void {
  for (const n of list) w.u8(n.plen).bytes(prefixBytes(n.prefix, n.plen, false));
}

const COMM: Record<string, number> = {
  'no-export': 0xffffff01,
  'no-advertise': 0xffffff02,
  'local-AS': 0xffffff03,
};

function attrs(a: BgpAttrs): number[] {
  const w = new W();
  const attr = (flags: number, type: number, body: number[]): void => {
    w.u8(flags | (body.length > 255 ? 0x10 : 0)).u8(type);
    if (body.length > 255) w.u16(body.length);
    else w.u8(body.length);
    w.bytes(body);
  };
  attr(0x40, 1, [{ igp: 0, egp: 1, incomplete: 2 }[a.origin]]);
  attr(
    0x40,
    2,
    a.asPath.length
      ? [2, a.asPath.length, ...a.asPath.flatMap((n) => [(n >>> 8) & 0xff, n & 0xff])]
      : [],
  );
  attr(0x40, 3, ip4Bytes(a.nextHop));
  if (a.med !== undefined) attr(0x80, 4, new W().u32(a.med).b);
  if (a.localPref !== undefined) attr(0x40, 5, new W().u32(a.localPref).b);
  if (a.originatorId) attr(0x80, 9, ip4Bytes(a.originatorId));
  if (a.clusterList?.length)
    attr(
      0x80,
      10,
      a.clusterList.flatMap((c) => ip4Bytes(c)),
    );
  if (a.communities?.length) {
    attr(
      0xc0,
      8,
      a.communities.flatMap((c) => {
        const known = COMM[c];
        if (known !== undefined) return new W().u32(known).b;
        const [h, l] = c.split(':').map(Number);
        return new W().u16(h ?? 0).u16(l ?? 0).b;
      }),
    );
  }
  return w.b;
}

/**
 * BGP-Nachricht. MP-BGP-IPv6-Felder (`nlri6`, `withdrawn6`) des Simulators werden nicht kodiert (siehe
 * docs/simplifications.md).
 */
export function encodeBgp(m: BgpMsg): Uint8Array {
  const body = new W();
  let type: number;
  switch (m.type) {
    case 'open': {
      type = 1;
      const as2 = m.asn > 65535 ? 23456 : m.asn;
      body.u8(4).u16(as2).u16(m.holdSec).ip4(m.routerId).u8(0);
      break;
    }
    case 'update': {
      type = 2;
      const wd = new W();
      nlri(wd, m.withdrawn);
      body.u16(wd.length).bytes(wd.b);
      const pa = m.attrs && m.nlri.length ? attrs(m.attrs) : [];
      body.u16(pa.length).bytes(pa);
      nlri(body, m.nlri);
      break;
    }
    case 'notification':
      type = 3;
      body.u8(m.code).u8(0).str(m.text);
      break;
    case 'keepalive':
      type = 4;
      break;
  }
  return new W()
    .bytes(new Array<number>(16).fill(0xff))
    .u16(19 + body.length)
    .u8(type)
    .bytes(body.b)
    .out();
}
