import {
  type ArpPdu,
  type EthernetPdu,
  type HeaderField,
  type IcmpPdu,
  type Ipv4Pdu,
  type LayerView,
  type Pdu,
  type ProtoTag,
} from './types';

const ETH_HEADER = 14;
const ETH_FCS = 4;
const ETH_MIN_FRAME = 64;
const IPV4_HEADER = 20;
const ICMP_HEADER = 8;
const ARP_SIZE = 28;

export function pduSize(pdu: Pdu): number {
  switch (pdu.kind) {
    case 'arp':
      return ARP_SIZE;
    case 'icmp':
      return ICMP_HEADER + pdu.dataSize;
    case 'ipv4':
      return IPV4_HEADER + pduSize(pdu.payload);
    case 'ethernet':
      return Math.max(ETH_MIN_FRAME, ETH_HEADER + pduSize(pdu.payload) + ETH_FCS);
  }
}

export function clonePdu<T extends Pdu>(pdu: T): T {
  return structuredClone(pdu);
}

/** Schichten von außen (L2) nach innen. */
export function layersOf(pdu: Pdu): Pdu[] {
  switch (pdu.kind) {
    case 'ethernet':
      return [pdu, ...layersOf(pdu.payload)];
    case 'ipv4':
      return [pdu, ...layersOf(pdu.payload)];
    default:
      return [pdu];
  }
}

const hex = (n: number, w = 4): string => '0x' + n.toString(16).padStart(w, '0');

export function describePdu(pdu: Pdu): HeaderField[] {
  switch (pdu.kind) {
    case 'ethernet':
      return [
        { name: 'Destination', value: pdu.dst },
        { name: 'Source', value: pdu.src },
        { name: 'EtherType', value: hex(pdu.etherType) },
      ];
    case 'arp':
      return [
        { name: 'Operation', value: pdu.op === 'request' ? '1 (request)' : '2 (reply)' },
        { name: 'Sender MAC', value: pdu.senderMac },
        { name: 'Sender IP', value: pdu.senderIp },
        { name: 'Target MAC', value: pdu.targetMac },
        { name: 'Target IP', value: pdu.targetIp },
      ];
    case 'ipv4':
      return [
        { name: 'Version', value: '4' },
        { name: 'Total Length', value: String(pduSize(pdu)) },
        { name: 'Identification', value: String(pdu.id) },
        { name: 'DF', value: pdu.df ? '1' : '0' },
        { name: 'TTL', value: String(pdu.ttl) },
        { name: 'Protocol', value: String(pdu.protocol) },
        { name: 'Source', value: pdu.src },
        { name: 'Destination', value: pdu.dst },
      ];
    case 'icmp':
      return [
        { name: 'Type', value: pdu.type === 'echo-request' ? '8 (echo request)' : '0 (echo reply)' },
        { name: 'Code', value: String(pdu.code) },
        { name: 'Identifier', value: String(pdu.id) },
        { name: 'Sequence', value: String(pdu.seq) },
        { name: 'Data', value: `${pdu.dataSize} bytes` },
      ];
  }
}

const LAYER_META: Record<Pdu['kind'], { osi: number; name: string }> = {
  ethernet: { osi: 2, name: 'Ethernet II' },
  arp: { osi: 2, name: 'ARP' },
  ipv4: { osi: 3, name: 'IPv4' },
  icmp: { osi: 3, name: 'ICMP' },
};

export function describeFrame(frame: EthernetPdu): LayerView[] {
  return layersOf(frame).map((l) => ({ ...LAYER_META[l.kind], fields: describePdu(l) }));
}

/** Kurzbeschreibung für die Event-Liste: Protokoll-Tag (Farbe) + Info-Text. */
export function summarizeFrame(frame: EthernetPdu): { proto: ProtoTag; info: string } {
  const p = frame.payload;
  if (p.kind === 'arp') return { proto: 'ARP', info: summarizeArp(p) };
  return { proto: 'ICMP', info: summarizeIp(p) };
}

function summarizeArp(p: ArpPdu): string {
  return p.op === 'request'
    ? `Who has ${p.targetIp}? Tell ${p.senderIp}`
    : `${p.senderIp} is at ${p.senderMac}`;
}

function summarizeIp(p: Ipv4Pdu): string {
  const i: IcmpPdu = p.payload;
  return `${i.type} ${p.src} → ${p.dst} id=${i.id} seq=${i.seq} ttl=${p.ttl}`;
}
