import type {
  EspPdu,
  GrePdu,
  Icmp6Pdu,
  IcmpPdu,
  IpPayload,
  Ip6Payload,
  Ipv4Pdu,
  Ipv6Pdu,
  TcpPdu,
  UdpPdu,
} from '../types';
import {
  encodeDhcp,
  encodeDhcp6,
  encodeDns,
  encodeHsrp,
  encodeHttp,
  encodeIke,
  encodeRip,
  encodeSvc,
} from './apps';
import {
  inetChecksum,
  ip4Bytes,
  ip6Bytes,
  pattern,
  scramble,
  transportChecksum,
  W,
  type IpCtx,
} from './bytes';
import { encodeBgp, encodeEigrp, encodeOspf } from './routing';

type Payload = IpPayload | Ip6Payload;

// ------------------------------------------------------------------ ICMPv4 (RFC 792)

function icmpOriginal(o: NonNullable<IcmpPdu['orig']>, ttl: number): number[] {
  const l4 = new W();
  if (o.protocol === 1) {
    const echo = new W().u8(8).u8(0).u16(0).u16(o.icmpId).u16(o.icmpSeq);
    echo.set16(2, inetChecksum(echo.b));
    l4.bytes(echo.b);
  } else {
    l4.u16(o.sport ?? 0)
      .u16(o.dport ?? 0)
      .u32(0);
  }
  const h = new W()
    .u8(0x45)
    .u8(0)
    .u16(20 + 8 + (o.protocol === 6 ? 12 : 0))
    .u16(o.ipId)
    .u16(0)
    .u8(ttl)
    .u8(o.protocol)
    .u16(0)
    .ip4(o.src)
    .ip4(o.dst);
  h.set16(10, inetChecksum(h.b));
  return [...h.b, ...l4.b];
}

export function encodeIcmp(p: IcmpPdu): Uint8Array {
  const w = new W();
  switch (p.type) {
    case 'echo-request':
    case 'echo-reply':
      w.u8(p.type === 'echo-request' ? 8 : 0)
        .u8(0)
        .u16(0)
        .u16(p.id)
        .u16(p.seq)
        .bytes(pattern(p.dataSize));
      break;
    case 'dest-unreachable':
    case 'time-exceeded':
      w.u8(p.type === 'dest-unreachable' ? 3 : 11)
        .u8(p.code)
        .u16(0);
      w.u16(0).u16(p.type === 'dest-unreachable' && p.code === 4 ? (p.nextHopMtu ?? 0) : 0);
      if (p.orig) w.bytes(icmpOriginal(p.orig, p.type === 'time-exceeded' ? 1 : 64));
      break;
  }
  w.set16(2, inetChecksum(w.b));
  return w.out();
}

// ------------------------------------------------------------------ ICMPv6 (RFC 4443 / 4861)

const ICMP6_TYPE = {
  'dest-unreachable': 1,
  'time-exceeded': 3,
  'echo-request': 128,
  'echo-reply': 129,
  rs: 133,
  ra: 134,
  ns: 135,
  na: 136,
} as const;

export function encodeIcmp6(p: Icmp6Pdu, ctx: IpCtx): Uint8Array {
  const w = new W().u8(ICMP6_TYPE[p.type]).u8(p.code).u16(0);
  const lladdr = (type: number): void => {
    if (p.lladdr) w.u8(type).u8(1).mac(p.lladdr);
  };
  switch (p.type) {
    case 'echo-request':
    case 'echo-reply':
      w.u16(p.id).u16(p.seq).bytes(pattern(p.dataSize));
      break;
    case 'dest-unreachable':
    case 'time-exceeded': {
      w.u32(0);
      if (p.orig) {
        const inner = new W().u8(128).u8(0).u16(0).u16(p.id).u16(p.seq);
        w.bytes(
          new W().u8(0x60).u24(0).u16(inner.length).u8(58).u8(1).ip6(p.orig.src).ip6(p.orig.dst).b,
        ).bytes(inner.b);
      }
      break;
    }
    case 'ns':
      w.u32(0).ip6(p.target ?? '::');
      lladdr(1);
      break;
    case 'na': {
      const f = p.naFlags;
      w.u8((f?.router ? 0x80 : 0) | (f?.solicited ? 0x40 : 0) | (f?.override ? 0x20 : 0))
        .u24(0)
        .ip6(p.target ?? '::');
      lladdr(2);
      break;
    }
    case 'rs':
      w.u32(0);
      lladdr(1);
      break;
    case 'ra':
      w.u8(64)
        .u8((p.raFlags?.managed ? 0x80 : 0) | (p.raFlags?.other ? 0x40 : 0))
        .u16(p.routerLifetime ?? 1800)
        .u32(0)
        .u32(0);
      lladdr(1);
      for (const px of p.prefixes ?? []) {
        w.u8(3)
          .u8(4)
          .u8(px.plen)
          .u8((px.onLink ? 0x80 : 0) | (px.autonomous ? 0x40 : 0));
        w.u32(2592000).u32(604800).u32(0).ip6(px.prefix);
      }
      break;
  }
  w.set16(2, transportChecksum(ctx, 58, w.b));
  return w.out();
}

// ------------------------------------------------------------------ UDP / TCP

function appBytes(app: UdpPdu['app'] | TcpPdu['app']): Uint8Array | undefined {
  if (!app) return undefined;
  switch (app.kind) {
    case 'dhcp':
      return encodeDhcp(app);
    case 'dhcp6':
      return encodeDhcp6(app);
    case 'dns':
      return encodeDns(app);
    case 'rip':
      return encodeRip(app);
    case 'hsrp':
      return encodeHsrp(app);
    case 'ike':
      return encodeIke(app);
    case 'http':
      return encodeHttp(app);
    case 'svc':
      return encodeSvc(app);
  }
}

export function encodeUdp(p: UdpPdu, ctx: IpCtx): Uint8Array {
  const data = appBytes(p.app) ?? Uint8Array.from(pattern(p.dataSize));
  const w = new W()
    .u16(p.srcPort)
    .u16(p.dstPort)
    .u16(8 + data.length)
    .u16(0)
    .bytes(data);
  const c = transportChecksum(ctx, 17, w.b);
  w.set16(6, c === 0 ? 0xffff : c);
  return w.out();
}

export function encodeTcp(p: TcpPdu, ctx: IpCtx, appOverride?: Uint8Array): Uint8Array {
  const data = appOverride ?? appBytes(p.app) ?? Uint8Array.from(pattern(p.dataSize));
  const f = p.flags;
  const opts = f.syn ? [2, 4, 0x05, 0xb4] : []; // MSS 1460
  const hdr = 20 + opts.length;
  const flags =
    (f.fin ? 0x01 : 0) |
    (f.syn ? 0x02 : 0) |
    (f.rst ? 0x04 : 0) |
    (f.psh ? 0x08 : 0) |
    (f.ack ? 0x10 : 0);
  const w = new W()
    .u16(p.srcPort)
    .u16(p.dstPort)
    .u32(p.seq)
    .u32(p.ack)
    .u8((hdr / 4) << 4)
    .u8(flags)
    .u16(p.window)
    .u16(0)
    .u16(0)
    .bytes(opts)
    .bytes(data);
  w.set16(16, transportChecksum(ctx, 6, w.b));
  return w.out();
}

// ------------------------------------------------------------------ GRE / ESP

export function encodeGre(p: GrePdu): Uint8Array {
  const inner = p.inner.kind === 'ipv4' ? encodeIpv4(p.inner) : encodeIpv6(p.inner);
  return new W().u16(0).u16(p.protocolType).bytes(inner).out();
}

/** ESP (Tunnelmodus): SPI, Sequenz, IV, „verschlüsseltes“ Innenpaket (deterministisch maskiert), ICV. */
export function encodeEsp(p: EspPdu): Uint8Array {
  const inner = encodeIpv4(p.inner);
  const padLen = (16 - ((inner.length + 2) % 16)) % 16;
  const plain = [...inner, ...Array.from({ length: padLen }, (_, i) => i + 1), padLen, 4];
  const ks = scramble(`esp${p.spi}${p.seq}`, plain.length);
  const cipher = plain.map((b, i) => b ^ (ks[i] as number));
  return new W()
    .u32(p.spi)
    .u32(p.seq)
    .bytes(scramble(`iv${p.spi}${p.seq}`, 16))
    .bytes(cipher)
    .bytes(scramble(`icv${p.spi}${p.seq}`, 12))
    .out();
}

// ------------------------------------------------------------------ IPv4 / IPv6

function payloadBytes(p: Payload, ctx: IpCtx): Uint8Array {
  switch (p.kind) {
    case 'icmp':
      return encodeIcmp(p);
    case 'icmp6':
      return encodeIcmp6(p, ctx);
    case 'udp':
      return encodeUdp(p, ctx);
    case 'tcp':
      return encodeTcp(p, ctx);
    case 'gre':
      return encodeGre(p);
    case 'esp':
      return encodeEsp(p);
    case 'routing':
      switch (p.proto) {
        case 'ospf':
          return encodeOspf(p, ctx);
        case 'eigrp':
          return encodeEigrp(p.msg, p.v === 6);
        case 'bgp':
          // BGP läuft im Simulator ohne TCP-Zustand: als einzelnes Segment (PSH|ACK, Seq/Ack = 1) verpackt
          return encodeTcp(
            {
              kind: 'tcp',
              srcPort: p.sport,
              dstPort: p.dport,
              flags: { syn: false, ack: true, fin: false, rst: false, psh: true },
              seq: 1,
              ack: 1,
              window: 16384,
              dataSize: 0,
            },
            ctx,
            encodeBgp(p.msg),
          );
      }
  }
}

export function encodeIpv4(p: Ipv4Pdu): Uint8Array {
  const ctx: IpCtx = { v6: false, src: ip4Bytes(p.src), dst: ip4Bytes(p.dst) };
  let data = payloadBytes(p.payload, ctx);
  const fragmented = p.mf || p.fragOffset > 0;
  if (fragmented) {
    const from = p.fragOffset * 8;
    data = data.slice(from, p.dataLen !== undefined ? from + p.dataLen : undefined);
  }
  const flagsFrag = (p.df ? 0x4000 : 0) | (p.mf ? 0x2000 : 0) | (p.fragOffset & 0x1fff);
  const h = new W()
    .u8(0x45)
    .u8(((p.dscp ?? 0) & 0x3f) << 2)
    .u16(20 + data.length)
    .u16(p.id)
    .u16(flagsFrag)
    .u8(p.ttl)
    .u8(p.protocol)
    .u16(0)
    .ip4(p.src)
    .ip4(p.dst);
  h.set16(10, inetChecksum(h.b));
  return h.bytes(data).out();
}

export function encodeIpv6(p: Ipv6Pdu): Uint8Array {
  const ctx: IpCtx = { v6: true, src: ip6Bytes(p.src), dst: ip6Bytes(p.dst) };
  const data = payloadBytes(p.payload, ctx);
  return new W()
    .u32(0x60000000)
    .u16(data.length)
    .u8(p.nextHeader)
    .u8(p.hopLimit)
    .ip6(p.src)
    .ip6(p.dst)
    .bytes(data)
    .out();
}
