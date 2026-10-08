/** MAC im Format `aa:bb:cc:dd:ee:ff` (klein geschrieben). */
export type Mac = string;
/** IPv4 in Punktschreibweise. */
export type Ipv4Addr = string;

export const BROADCAST_MAC: Mac = 'ff:ff:ff:ff:ff:ff';

export const ETHERTYPE = {
  ipv4: 0x0800,
  arp: 0x0806,
  dot1q: 0x8100,
  stp: 0x0026,
  vtp: 0x2003,
} as const;
export const IP_PROTO = { icmp: 1, tcp: 6, udp: 17 } as const;

/** Ziel-MAC-Adressen der Layer-2-Steuerprotokolle (werden vom Switch nicht weitergeleitet). */
export const MAC_STP = '01:80:c2:00:00:00';
export const MAC_PVST = '01:00:0c:cc:cc:cd';
export const MAC_VTP = '01:00:0c:cc:cc:cc';

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
export const ICMP_UNREACH = {
  net: 0,
  host: 1,
  protocol: 2,
  port: 3,
  fragNeeded: 4,
  admin: 13,
} as const;

/** Auszug des auslösenden Pakets in ICMP-Fehlermeldungen (RFC 792: IP-Header + 8 Byte). */
export interface IcmpOriginal {
  src: Ipv4Addr;
  dst: Ipv4Addr;
  ipId: number;
  protocol: number;
  /** ID/Seq des ursprünglichen ICMP-Echos (für die Zuordnung beim Absender). */
  icmpId: number;
  icmpSeq: number;
  /** Bei TCP/UDP: Ports des auslösenden Segments. */
  sport?: number;
  dport?: number;
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
  payload: IpPayload;
}

export type IpPayload = IcmpPdu | UdpPdu | TcpPdu;

export type AppPdu = DhcpPdu | DnsPdu;

export interface UdpPdu {
  kind: 'udp';
  srcPort: number;
  dstPort: number;
  /** Zusätzliche Nutzdaten in Byte (wenn keine strukturierte Anwendung folgt). */
  dataSize: number;
  app?: AppPdu;
}

export interface TcpFlags {
  syn: boolean;
  ack: boolean;
  fin: boolean;
  rst: boolean;
  psh: boolean;
}

export interface TcpPdu {
  kind: 'tcp';
  srcPort: number;
  dstPort: number;
  flags: TcpFlags;
  seq: number;
  ack: number;
  window: number;
  dataSize: number;
  app?: HttpPdu;
}

export interface HttpPdu {
  kind: 'http';
  /** Anfrage: Methode + Pfad + Host; Antwort: Status + Body. */
  method?: 'GET';
  path?: string;
  host?: string;
  status?: number;
  body?: string;
}

export type DhcpOp = 'discover' | 'offer' | 'request' | 'ack' | 'nak' | 'decline' | 'release';

export interface DhcpPdu {
  kind: 'dhcp';
  op: DhcpOp;
  xid: number;
  chaddr: Mac;
  ciaddr: Ipv4Addr;
  yiaddr: Ipv4Addr;
  siaddr: Ipv4Addr;
  giaddr: Ipv4Addr;
  /** Optionen 1 (Maske), 3 (Router), 6 (DNS), 15 (Domain), 51 (Lease), 54 (Server-ID), 50 (angefragte IP), 66/150 (TFTP). */
  options: {
    mask?: string;
    router?: Ipv4Addr;
    dns?: Ipv4Addr[];
    domain?: string;
    leaseSec?: number;
    serverId?: Ipv4Addr;
    requestedIp?: Ipv4Addr;
    tftp?: string;
  };
}

export type DnsType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'PTR';

export interface DnsRecord {
  name: string;
  type: DnsType;
  data: string;
  ttl: number;
}

export interface DnsPdu {
  kind: 'dns';
  id: number;
  response: boolean;
  /** 0 = NOERROR, 3 = NXDOMAIN. */
  rcode: 0 | 3;
  question: { name: string; type: DnsType };
  answers: DnsRecord[];
}

/** STP/RSTP-BPDU (PVST+: `vlan` benennt die Instanz). */
export interface BpduPdu {
  kind: 'bpdu';
  rstp: boolean;
  vlan: number;
  /** `prio.mac` mit Extended System ID. */
  rootId: string;
  rootCost: number;
  bridgeId: string;
  portId: string;
  flags: {
    proposal: boolean;
    agreement: boolean;
    topologyChange: boolean;
    role: 'root' | 'designated' | 'alternate' | 'unknown';
  };
}

export interface VtpPdu {
  kind: 'vtp';
  domain: string;
  revision: number;
  vlans: { id: number; name: string }[];
}

export interface EthernetPdu {
  kind: 'ethernet';
  dst: Mac;
  src: Mac;
  etherType: number;
  /** 802.1Q-Tag (fehlt bei untagged Frames). */
  vlan?: { vid: number; pcp: number };
  payload: ArpPdu | Ipv4Pdu | BpduPdu | VtpPdu;
}

export type Pdu =
  | EthernetPdu
  | ArpPdu
  | Ipv4Pdu
  | IcmpPdu
  | UdpPdu
  | TcpPdu
  | DhcpPdu
  | DnsPdu
  | HttpPdu
  | BpduPdu
  | VtpPdu;
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

export type ProtoTag =
  | 'ETH'
  | 'ARP'
  | 'ICMP'
  | 'UDP'
  | 'TCP'
  | 'DHCP'
  | 'DNS'
  | 'HTTP'
  | 'STP'
  | 'VTP'
  | 'NAT'
  | 'ACL'
  | 'LINK'
  | 'CSMA'
  | 'SYS';
