/** MAC im Format `aa:bb:cc:dd:ee:ff` (klein geschrieben). */
export type Mac = string;
/** IPv4 in Punktschreibweise. */
export type Ipv4Addr = string;

export const BROADCAST_MAC: Mac = 'ff:ff:ff:ff:ff:ff';

export const ETHERTYPE = { ipv4: 0x0800, arp: 0x0806, dot1q: 0x8100 } as const;
export const IP_PROTO = { icmp: 1, tcp: 6, udp: 17 } as const;

export interface ArpPdu {
  kind: 'arp';
  op: 'request' | 'reply';
  senderMac: Mac;
  senderIp: Ipv4Addr;
  targetMac: Mac;
  targetIp: Ipv4Addr;
}

export type IcmpType = 'echo-request' | 'echo-reply' | 'dest-unreachable' | 'time-exceeded';

/** ICMP-Codes für `dest-unreachable`. */
export const ICMP_UNREACH = { net: 0, host: 1, protocol: 2, port: 3, fragNeeded: 4 } as const;

/** Auszug des auslösenden Pakets in ICMP-Fehlermeldungen (RFC 792: IP-Header + 8 Byte). */
export interface IcmpOriginal {
  src: Ipv4Addr;
  dst: Ipv4Addr;
  ipId: number;
  protocol: number;
  /** ID/Seq des ursprünglichen ICMP-Echos (für die Zuordnung beim Absender). */
  icmpId: number;
  icmpSeq: number;
}

export interface IcmpPdu {
  kind: 'icmp';
  type: IcmpType;
  code: number;
  id: number;
  seq: number;
  /** Nutzdatengröße in Byte (Inhalt wird nicht simuliert). */
  dataSize: number;
  /** Nur bei Fehlermeldungen. */
  orig?: IcmpOriginal;
  /** Nur bei `dest-unreachable`/`fragNeeded`: MTU des nächsten Hops. */
  nextHopMtu?: number;
}

export interface Ipv4Pdu {
  kind: 'ipv4';
  src: Ipv4Addr;
  dst: Ipv4Addr;
  ttl: number;
  protocol: number;
  id: number;
  df: boolean;
  /** More Fragments. */
  mf: boolean;
  /** Fragment-Offset in Einheiten à 8 Byte. */
  fragOffset: number;
  /** Länge der IP-Nutzdaten dieses (Fragments); fehlt bei unfragmentierten Paketen. */
  dataLen?: number;
  /** Bei Fragmenten trägt jedes Fragment (vereinfachend) die Nutzlast-Referenz mit. */
  payload: IcmpPdu;
}

export interface EthernetPdu {
  kind: 'ethernet';
  dst: Mac;
  src: Mac;
  etherType: number;
  payload: ArpPdu | Ipv4Pdu;
}

export type Pdu = EthernetPdu | ArpPdu | Ipv4Pdu | IcmpPdu;
/** Ein Frame auf dem Kabel ist immer ein Ethernet-PDU. */
export type Frame = EthernetPdu;

export interface HeaderField {
  name: string;
  value: string;
}

export interface LayerView {
  /** OSI-Schicht (2 = Ethernet/ARP, 3 = IPv4/ICMP). */
  osi: number;
  /** Protokollname, z. B. `Ethernet II`. */
  name: string;
  fields: HeaderField[];
}

export type ProtoTag = 'ETH' | 'ARP' | 'ICMP' | 'LINK' | 'CSMA' | 'SYS';
