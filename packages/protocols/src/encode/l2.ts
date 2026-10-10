import type {
  ArpPdu,
  BpduPdu,
  CdpPdu,
  EthernetPdu,
  LldpPdu,
  PppMsg,
  PppoePdu,
  VtpPdu,
} from '../types';
import { MAC_PVST } from '../types';
import { ascii, inetChecksum, macBytes, W } from './bytes';
import { encodeIpv4, encodeIpv6 } from './ip';

/** Kleinste Ethernet-Framegröße ohne FCS (64 − 4); kürzere Frames werden mit Nullen aufgefüllt. */
export const ETH_MIN_NO_FCS = 60;

export function encodeArp(p: ArpPdu): Uint8Array {
  return new W()
    .u16(1) // Hardware: Ethernet
    .u16(0x0800)
    .u8(6)
    .u8(4)
    .u16(p.op === 'request' ? 1 : 2)
    .mac(p.senderMac)
    .ip4(p.senderIp)
    .mac(p.targetMac)
    .ip4(p.targetIp)
    .out();
}

/** `32769.aa:bb:cc:dd:ee:ff` → 8 Byte Bridge-ID (Priorität inkl. Extended System ID, MAC). */
function bridgeIdBytes(id: string): number[] {
  const dot = id.indexOf('.');
  const prio = Number(id.slice(0, dot)) || 0;
  return [(prio >>> 8) & 0xff, prio & 0xff, ...macBytes(id.slice(dot + 1))];
}

/** `128.001` → 2 Byte Port-ID (Priorität, Nummer). */
function portIdBytes(id: string): number[] {
  const [p, n] = id.split('.');
  return [Number(p) & 0xff, Number(n) & 0xff];
}

/** Konfigurations-BPDU (802.1D) bzw. RST-BPDU (802.1w, Protokollversion 2). */
export function encodeBpdu(p: BpduPdu): Uint8Array {
  const w = new W()
    .u16(0)
    .u8(p.rstp ? 2 : 0)
    .u8(p.rstp ? 0x02 : 0x00);
  let flags = p.flags.topologyChange ? 0x01 : 0;
  if (p.rstp) {
    if (p.flags.proposal) flags |= 0x02;
    const role = { unknown: 0, alternate: 1, root: 2, designated: 3 }[p.flags.role];
    flags |= role << 2;
    if (p.flags.role === 'root' || p.flags.role === 'designated') flags |= 0x30; // learning + forwarding
    if (p.flags.agreement) flags |= 0x40;
  }
  w.u8(flags)
    .bytes(bridgeIdBytes(p.rootId))
    .u32(p.rootCost)
    .bytes(bridgeIdBytes(p.bridgeId))
    .bytes(portIdBytes(p.portId))
    .u16(0) // Message Age
    .u16(20 * 256) // Max Age
    .u16(2 * 256) // Hello Time
    .u16(15 * 256); // Forward Delay
  if (p.rstp) w.u8(0); // Version-1-Length
  return w.out();
}

/** LLC-Kopf: DSAP/SSAP/Control; SNAP (Cisco-OUI) für PVST+/VTP. */
const llcStp = [0x42, 0x42, 0x03];
const snap = (pid: number): number[] => [0xaa, 0xaa, 0x03, 0x00, 0x00, 0x0c, pid >>> 8, pid & 0xff];

/** VTP-Subset-Advertisement (Version 2) mit den VLANs des PDU. */
export function encodeVtp(p: VtpPdu): Uint8Array {
  const w = new W().u8(2).u8(2).u8(1).u8(p.domain.length).fixed(p.domain, 32).u32(p.revision);
  for (const v of p.vlans) {
    const nameLen = v.name.length;
    const padded = Math.ceil(nameLen / 4) * 4;
    w.u8(12 + padded)
      .u8(0) // Status: aktiv
      .u8(1) // Typ: Ethernet
      .u8(nameLen)
      .u16(v.id)
      .u16(1500)
      .u32(100000 + v.id)
      .fixed(v.name, padded);
  }
  return w.out();
}

const PPPOE_CODE: Record<PppoePdu['code'], number> = {
  PADI: 0x09,
  PADO: 0x07,
  PADR: 0x19,
  PADS: 0x65,
  PADT: 0xa7,
  SESSION: 0x00,
};

function pppBytes(m: PppMsg): { proto: number; body: number[] } {
  switch (m.proto) {
    case 'lcp': {
      const code = { 'conf-req': 1, 'conf-ack': 2, 'term-req': 5 }[m.op];
      const o = new W();
      if (m.op !== 'term-req') {
        o.u8(1).u8(4).u16(m.mru);
        if (m.auth === 'chap') o.u8(3).u8(5).u16(0xc223).u8(5);
        o.u8(5).u8(6).u32(m.magic);
      }
      return {
        proto: 0xc021,
        body: new W()
          .u8(code)
          .u8(1)
          .u16(4 + o.length)
          .bytes(o.b).b,
      };
    }
    case 'chap': {
      const code = { challenge: 1, response: 2, success: 3, failure: 4 }[m.op];
      const val = m.value ? [...new W().fixed(m.value, 16).b] : [];
      const name = m.name ?? '';
      const data = val.length ? [val.length, ...val] : [];
      const w = new W().bytes(data).str(name);
      return {
        proto: 0xc223,
        body: new W()
          .u8(code)
          .u8(m.id)
          .u16(4 + w.length)
          .bytes(w.b).b,
      };
    }
    case 'ipcp': {
      const code = { 'conf-req': 1, 'conf-nak': 3, 'conf-ack': 2 }[m.op];
      const w = new W().u8(3).u8(6).ip4(m.addr);
      return {
        proto: 0x8021,
        body: new W()
          .u8(code)
          .u8(1)
          .u16(4 + w.length)
          .bytes(w.b).b,
      };
    }
    case 'ip':
      return { proto: 0x0021, body: [...encodeIpv4(m.inner)] };
  }
}

/** CDP v2 (Cisco, SNAP 0x2000): Device-ID, Adressen, Port-ID, Capabilities, Version, Platform, Native VLAN, Duplex. */
export function encodeCdp(p: CdpPdu): Uint8Array {
  const tlv = (w: W, type: number, body: ArrayLike<number>): void => {
    w.u16(type)
      .u16(4 + body.length)
      .bytes(body);
  };
  const t = new W();
  tlv(t, 0x0001, ascii(p.deviceId));
  if (p.addr) tlv(t, 0x0002, new W().u32(1).u8(1).u8(1).u8(0xcc).u16(4).ip4(p.addr).b);
  tlv(t, 0x0003, ascii(p.portName));
  const bits: Record<string, number> = {
    R: 0x01,
    T: 0x02,
    B: 0x04,
    S: 0x08,
    H: 0x10,
    I: 0x20,
    r: 0x40,
  };
  tlv(t, 0x0004, new W().u32(p.capabilities.reduce((a, c) => a | (bits[c] ?? 0), 0)).b);
  tlv(t, 0x0005, ascii(p.version));
  tlv(t, 0x0006, ascii(p.platform));
  if (p.nativeVlan !== undefined) tlv(t, 0x000a, new W().u16(p.nativeVlan).b);
  if (p.duplex) tlv(t, 0x000b, [p.duplex === 'full' ? 1 : 0]);
  const w = new W().u8(2).u8(Math.min(255, p.holdtime)).u16(0).bytes(t.b);
  w.set16(2, inetChecksum(w.b));
  return w.out();
}

/** LLDP (IEEE 802.1AB): Chassis-ID, Port-ID, TTL, Beschreibungen, System-Capabilities, Management-Adresse. */
export function encodeLldp(p: LldpPdu): Uint8Array {
  const w = new W();
  const tlv = (type: number, body: ArrayLike<number>): void => {
    w.u16((type << 9) | body.length).bytes(body);
  };
  const isMac = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(p.chassisId);
  tlv(1, isMac ? [4, ...macBytes(p.chassisId)] : [7, ...ascii(p.chassisId)]);
  tlv(2, [5, ...ascii(p.portId)]);
  tlv(3, new W().u16(p.ttl).b);
  tlv(4, ascii(p.portDesc));
  tlv(5, ascii(p.sysName));
  tlv(6, ascii(p.sysDesc));
  const bits: Record<string, number> = { B: 0x04, R: 0x10, W: 0x08, T: 0x20, S: 0x80 };
  const mask = (l: string[]): number => l.reduce((a, c) => a | (bits[c] ?? 0), 0);
  tlv(7, new W().u16(mask(p.capabilities)).u16(mask(p.enabledCaps)).b);
  if (p.mgmtAddr) tlv(8, new W().u8(5).u8(1).ip4(p.mgmtAddr).u8(1).u32(0).u8(0).b);
  tlv(0, []);
  return w.out();
}

export function encodePppoe(p: PppoePdu): Uint8Array {
  const body = new W();
  if (p.code === 'SESSION') {
    if (p.ppp) {
      const { proto, body: b } = pppBytes(p.ppp);
      body.u16(proto).bytes(b);
    }
  } else {
    const tag = (type: number, v: string): void => {
      body.u16(type).u16(v.length).str(v);
    };
    tag(0x0101, p.serviceName ?? '');
    if (p.acName !== undefined) tag(0x0102, p.acName);
    if (p.hostUniq !== undefined) tag(0x0103, p.hostUniq);
  }
  return new W()
    .u8(0x11)
    .u8(PPPOE_CODE[p.code])
    .u16(p.sessionId)
    .u16(body.length)
    .bytes(body.b)
    .out();
}

/** Ethernet II (optional 802.1Q) bzw. 802.3 mit LLC (STP) / SNAP (PVST+, VTP). Ohne FCS, auf 60 Byte aufgefüllt. */
export function encodeFrame(f: EthernetPdu): Uint8Array {
  const p = f.payload;
  const etherType = f.etherType;
  let body: number[] = [];
  let llc = false;
  switch (p.kind) {
    case 'arp':
      body = [...encodeArp(p)];
      break;
    case 'ipv4':
      body = [...encodeIpv4(p)];
      break;
    case 'ipv6':
      body = [...encodeIpv6(p)];
      break;
    case 'bpdu':
      llc = true;
      body =
        f.dst === MAC_PVST
          ? [...snap(0x010b), ...encodeBpdu(p), ...new W().u16(0).u16(2).u16(p.vlan).b]
          : [...llcStp, ...encodeBpdu(p)];
      break;
    case 'vtp':
      llc = true;
      body = [...snap(0x2003), ...encodeVtp(p)];
      break;
    case 'pppoe':
      body = [...encodePppoe(p)];
      break;
    case 'cdp':
      llc = true;
      body = [...snap(0x2000), ...encodeCdp(p)];
      break;
    case 'lldp':
      body = [...encodeLldp(p)];
      break;
  }
  const w = new W().mac(f.dst).mac(f.src);
  if (f.vlan) w.u16(0x8100).u16(((f.vlan.pcp & 7) << 13) | (f.vlan.vid & 0xfff));
  w.u16(llc ? body.length : etherType).bytes(body);
  if (w.length < ETH_MIN_NO_FCS) w.zeros(ETH_MIN_NO_FCS - w.length);
  return w.out();
}
