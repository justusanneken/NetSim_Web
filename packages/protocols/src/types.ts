/** MAC im Format `aa:bb:cc:dd:ee:ff` (klein geschrieben). */
export type Mac = string;
/** IPv4 in Punktschreibweise. */
export type Ipv4Addr = string;

export const BROADCAST_MAC: Mac = 'ff:ff:ff:ff:ff:ff';

export const ETHERTYPE = {
  ipv4: 0x0800,
  arp: 0x0806,
  dot1q: 0x8100,
  ipv6: 0x86dd,
  stp: 0x0026,
  vtp: 0x2003,
  pppoeDiscovery: 0x8863,
  pppoeSession: 0x8864,
} as const;
export const IP_PROTO = {
  icmp: 1,
  tcp: 6,
  udp: 17,
  gre: 47,
  esp: 50,
  ahp: 51,
  icmp6: 58,
  eigrp: 88,
  ospf: 89,
} as const;

/** IPv6-Adresse in komprimierter Schreibweise (`2001:db8::1`). */
export type Ipv6Addr = string;

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

export type IpPayload = IcmpPdu | UdpPdu | TcpPdu | RoutingPdu | GrePdu | EspPdu;

/**
 * IPsec ESP (IP-Protokoll 50, Tunnelmodus): `inner` ist das gekapselte Originalpaket. Es dient nur der
 * Simulation (Entschlüsselung am Endpunkt) und wird im Inspektor und in Listen NICHT angezeigt –
 * auf dem Weg ist die Nutzlast „verschlüsselt“.
 */
export interface EspPdu {
  kind: 'esp';
  spi: number;
  seq: number;
  /** Verwendete Transform-Bezeichnung (`esp-aes esp-sha-hmac`). */
  cipher: string;
  inner: Ipv4Pdu;
}

/** IKE (UDP 500), vereinfacht: ein Austausch aus Anfrage und Antwort für IKE- und IPsec-SA. */
export interface IkePdu {
  kind: 'ike';
  op: 'request' | 'accept' | 'reject';
  cookie: number;
  /** Phase-1-Parameter (ISAKMP-Policy). */
  encr: string;
  hash: string;
  group: number;
  /** Gegenseitiger Nachweis des Pre-Shared Keys (Digest, kein Klartext). */
  authHash: string;
  /** Phase 2: Transform-Set und Verkehrsauswahl (Quelle > Ziel als Präfixe). */
  transform: string;
  selector?: { src: string; dst: string };
  /** SPI, den der Absender für eingehenden Verkehr vom Peer erwartet. */
  spi: number;
  /** Ablehnungsgrund (`reject`). */
  reason?: string;
}

export type AppPdu = DhcpPdu | Dhcp6Pdu | DnsPdu | RipPdu | HsrpPdu | SvcPdu | IkePdu;

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
  app?: HttpPdu | SvcPdu;
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

/** Dienste der Phase 5 (vereinfachte Anwendungsnachrichten, strukturiert statt Bytes). */
export type SvcProto =
  | 'tftp'
  | 'ftp'
  | 'smtp'
  | 'pop3'
  | 'ntp'
  | 'syslog'
  | 'snmp'
  | 'radius'
  | 'tacacs'
  | 'telnet'
  | 'ssh'
  | 'iot'
  | 'capwap'
  | 'bgp';

/**
 * Generische Anwendungsnachricht (Phase 5): `op` benennt die Operation, `args` die Felder,
 * `body` optionale Nutzdaten (Dateiinhalt, Mailtext …). Größe = Nutzdaten + Kopf.
 */
export interface SvcPdu {
  kind: 'svc';
  proto: SvcProto;
  op: string;
  args: Record<string, string | number | boolean>;
  body?: string;
  /** BGP-Nachricht (Port 179), wenn `proto === 'bgp'`. */
  bgp?: BgpMsg;
  /** Nutzdaten sind verschlüsselt (SSH): der Inspektor zeigt keinen Klartext. */
  encrypted?: boolean;
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

/** DHCPv6 (UDP 546/547, Multicast ff02::1:2): Solicit/Advertise/Request/Reply bzw. Information-Request/Reply. */
export interface Dhcp6Pdu {
  kind: 'dhcp6';
  op: 'solicit' | 'advertise' | 'request' | 'reply' | 'information-request';
  xid: number;
  /** DUID des Clients (vereinfacht: MAC). */
  clientId: Mac;
  serverId?: Mac;
  /** Zugewiesene Adresse (IA_NA) und Präfixlänge. */
  addr?: Ipv6Addr;
  plen?: number;
  leaseSec?: number;
  dns?: Ipv6Addr[];
  domain?: string;
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

// ---------------------------------------------------------------- Routing-Protokolle (Phase 4)

export interface RipEntry {
  /** IPv4-Präfix (RIPv2) bzw. IPv6-Präfix (RIPng). */
  prefix: string;
  /** Subnetzmaske (RIPv2); bei RIPng leer, die Länge steht in `plen`. */
  mask: string;
  plen?: number;
  nextHop: Ipv4Addr;
  /** 1–15, 16 = unerreichbar. */
  metric: number;
  tag: number;
}

/** RIPv2 (UDP 520, Multicast 224.0.0.9). */
export interface RipPdu {
  kind: 'rip';
  /** RIPng (UDP 521, ff02::9) statt RIPv2. */
  ng?: boolean;
  command: 'request' | 'response';
  entries: RipEntry[];
}

export type HsrpState = 'init' | 'learn' | 'listen' | 'speak' | 'standby' | 'active';

/** HSRPv1 (UDP 1985, Multicast 224.0.0.2). */
export interface HsrpPdu {
  kind: 'hsrp';
  group: number;
  op: 'hello' | 'coup' | 'resign';
  state: HsrpState;
  helloSec: number;
  holdSec: number;
  priority: number;
  vip: string;
  /** 1 (Default) oder 2 (`standby version 2`, Multicast 224.0.0.102 bzw. ff02::66). */
  version?: 1 | 2;
  /** Klartext-Authentifizierung (Default `cisco`). */
  auth?: string;
}

export interface OspfLsaHeader {
  /** 1 Router, 2 Network, 3 Summary, 4 ASBR-Summary, 5 AS-External, 7 NSSA-External. */
  type: 1 | 2 | 3 | 4 | 5 | 7;
  id: string;
  advRouter: string;
  seq: number;
  age: number;
}

export interface OspfRouterLink {
  kind: 'p2p' | 'transit' | 'stub';
  /** p2p: Router-ID des Nachbarn; transit: Netzwerk-ID (DR-Schnittstelle); stub: –. */
  neighbor?: string;
  /** Eigene Adresse an dieser Verbindung (Next-Hop-Berechnung der anderen). */
  addr?: string;
  prefix?: string;
  plen?: number;
  cost: number;
}

export type OspfLsaBody =
  | { type: 1; abr: boolean; asbr: boolean; links: OspfRouterLink[] }
  | { type: 2; prefix: string; plen: number; attached: string[] }
  | { type: 3; prefix: string; plen: number; metric: number }
  | { type: 4; asbr: string; metric: number }
  | {
      type: 5;
      prefix: string;
      plen: number;
      metric: number;
      eType: 1 | 2;
      fwd?: string;
      tag: number;
    }
  | {
      /** NSSA-External (Typ 7); `p`: Übersetzung in Typ 5 am ABR erlaubt. */
      type: 7;
      prefix: string;
      plen: number;
      metric: number;
      eType: 1 | 2;
      tag: number;
      p: boolean;
    };

/** OSPF-Authentifizierung: Klartext oder (vereinfachter) MD5-Digest über den gemeinsamen Schlüssel. */
export type OspfAuth =
  { type: 'simple'; key: string } | { type: 'md5'; keyId: number; digest: string };

export type OspfLsa = OspfLsaHeader & { body: OspfLsaBody };

export type OspfMsg =
  | {
      type: 'hello';
      routerId: string;
      areaId: string;
      auth?: OspfAuth;
      helloSec: number;
      deadSec: number;
      priority: number;
      dr: string;
      bdr: string;
      neighbors: string[];
      /** Subnetzmaske (v2) bzw. Prefixlänge – nur zur Anzeige/Prüfung. */
      plen?: number;
      /** Options-Bits: E-Bit (normal) / ohne E-Bit (stub) / N-Bit (NSSA). */
      areaType?: 'normal' | 'stub' | 'nssa';
    }
  | {
      type: 'dbd';
      routerId: string;
      areaId: string;
      auth?: OspfAuth;
      init: boolean;
      more: boolean;
      master: boolean;
      ddSeq: number;
      headers: OspfLsaHeader[];
    }
  | {
      type: 'lsr';
      routerId: string;
      areaId: string;
      auth?: OspfAuth;
      requests: { type: number; id: string; advRouter: string }[];
    }
  | { type: 'lsu'; routerId: string; areaId: string; auth?: OspfAuth; lsas: OspfLsa[] }
  | {
      type: 'lsack';
      routerId: string;
      areaId: string;
      auth?: OspfAuth;
      headers: OspfLsaHeader[];
    };

export interface EigrpRoute {
  prefix: string;
  plen: number;
  /** Zusammengesetzte Metrik-Komponenten (klassisch). */
  delay: number;
  bandwidth: number;
  hops: number;
  /** Externe Route (Redistribution). */
  external?: { proto: string; router: string };
  unreachable?: boolean;
}

export interface EigrpMsg {
  op: 'hello' | 'update' | 'query' | 'reply' | 'ack';
  asn: number;
  routerId: string;
  holdSec: number;
  seq: number;
  ack: number;
  init?: boolean;
  routes?: EigrpRoute[];
}

export interface BgpAttrs {
  origin: 'igp' | 'egp' | 'incomplete';
  asPath: number[];
  nextHop: string;
  med?: number;
  localPref?: number;
  /** Communities (`65001:100`, `no-export`, `no-advertise`, `local-AS`). */
  communities?: string[];
  /** Route Reflection (RFC 4456). */
  originatorId?: string;
  clusterList?: string[];
  /** MP-BGP IPv6: Next Hop der `nlri6`-Präfixe. */
  nextHop6?: string;
}

export type BgpMsg =
  | { type: 'open'; asn: number; holdSec: number; routerId: string }
  | { type: 'keepalive' }
  | {
      type: 'update';
      withdrawn: { prefix: string; plen: number }[];
      attrs?: BgpAttrs;
      nlri: { prefix: string; plen: number }[];
      /** MP-BGP IPv6 (vereinfacht im selben Update). */
      withdrawn6?: { prefix: string; plen: number }[];
      nlri6?: { prefix: string; plen: number }[];
    }
  | { type: 'notification'; code: number; text: string };

/** OSPF (IP-Protokoll 89), EIGRP (88) und – vereinfacht ohne TCP – BGP (Port 179). */
export type RoutingPdu =
  | { kind: 'routing'; proto: 'ospf'; v: 2 | 3; msg: OspfMsg }
  | { kind: 'routing'; proto: 'eigrp'; /** 6 = EIGRP für IPv6. */ v?: 6; msg: EigrpMsg }
  | { kind: 'routing'; proto: 'bgp'; sport: number; dport: number; msg: BgpMsg };

/** GRE (IP-Protokoll 47): kapselt ein IPv4-/IPv6-Paket. */
export interface GrePdu {
  kind: 'gre';
  protocolType: number;
  inner: Ipv4Pdu | Ipv6Pdu;
}

// ---------------------------------------------------------------- IPv6

export type Icmp6Type =
  'echo-request' | 'echo-reply' | 'dest-unreachable' | 'time-exceeded' | 'ns' | 'na' | 'rs' | 'ra';

export interface Icmp6Pdu {
  kind: 'icmp6';
  type: Icmp6Type;
  code: number;
  id: number;
  seq: number;
  dataSize: number;
  /** NS/NA: Zieladresse. */
  target?: Ipv6Addr;
  /** NS/RS/RA: Source-Link-Layer-Adresse; NA: Target-Link-Layer-Adresse. */
  lladdr?: Mac;
  /** NA-Flags. */
  naFlags?: { router: boolean; solicited: boolean; override: boolean };
  /** RA: M-Flag (Managed: DHCPv6 für Adressen) und O-Flag (Other: DHCPv6 für übrige Informationen). */
  raFlags?: { managed: boolean; other: boolean };
  /** RA: Präfixe (SLAAC) und Router-Lebensdauer. */
  prefixes?: { prefix: Ipv6Addr; plen: number; onLink: boolean; autonomous: boolean }[];
  routerLifetime?: number;
  /** Fehlermeldungen: Absender/Ziel des auslösenden Pakets. */
  orig?: { src: Ipv6Addr; dst: Ipv6Addr };
}

export type Ip6Payload = Icmp6Pdu | UdpPdu | TcpPdu | RoutingPdu | GrePdu;

// ---------------------------------------------------------------- PPPoE / PPP

export type PppMsg =
  | {
      proto: 'lcp';
      op: 'conf-req' | 'conf-ack' | 'term-req';
      mru: number;
      auth?: 'chap';
      magic: number;
    }
  | {
      proto: 'chap';
      op: 'challenge' | 'response' | 'success' | 'failure';
      id: number;
      /** Challenge-Wert bzw. Antwort-Digest (kein Klartextpasswort). */
      value?: string;
      name?: string;
    }
  | { proto: 'ipcp'; op: 'conf-req' | 'conf-nak' | 'conf-ack'; addr: Ipv4Addr; peer?: Ipv4Addr }
  | { proto: 'ip'; inner: Ipv4Pdu };

/** PPP over Ethernet: Discovery (EtherType 0x8863) und Session (0x8864) in einem PDU-Typ. */
export interface PppoePdu {
  kind: 'pppoe';
  code: 'PADI' | 'PADO' | 'PADR' | 'PADS' | 'PADT' | 'SESSION';
  sessionId: number;
  serviceName?: string;
  /** Access Concentrator (BRAS) – nur PADO/PADS. */
  acName?: string;
  hostUniq?: string;
  /** Nur `SESSION`. */
  ppp?: PppMsg;
}

export interface Ipv6Pdu {
  kind: 'ipv6';
  src: Ipv6Addr;
  dst: Ipv6Addr;
  hopLimit: number;
  nextHeader: number;
  payload: Ip6Payload;
}

export interface EthernetPdu {
  kind: 'ethernet';
  dst: Mac;
  src: Mac;
  etherType: number;
  /** 802.1Q-Tag (fehlt bei untagged Frames). */
  vlan?: { vid: number; pcp: number };
  payload: ArpPdu | Ipv4Pdu | Ipv6Pdu | BpduPdu | VtpPdu | PppoePdu;
}

export type Pdu =
  | EthernetPdu
  | ArpPdu
  | Ipv4Pdu
  | IcmpPdu
  | UdpPdu
  | TcpPdu
  | DhcpPdu
  | Dhcp6Pdu
  | DnsPdu
  | HttpPdu
  | SvcPdu
  | BpduPdu
  | VtpPdu
  | Ipv6Pdu
  | Icmp6Pdu
  | RipPdu
  | HsrpPdu
  | RoutingPdu
  | GrePdu
  | EspPdu
  | IkePdu
  | PppoePdu;
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
  | 'RIP'
  | 'OSPF'
  | 'EIGRP'
  | 'BGP'
  | 'HSRP'
  | 'GRE'
  | 'ICMP6'
  | 'ND'
  | 'LINK'
  | 'TFTP'
  | 'FTP'
  | 'SMTP'
  | 'POP3'
  | 'NTP'
  | 'SYSLOG'
  | 'SNMP'
  | 'RADIUS'
  | 'TELNET'
  | 'SSH'
  | 'IOT'
  | 'WIFI'
  | 'FW'
  | 'CAPWAP'
  | 'TACACS'
  | 'PPPOE'
  | 'PPP'
  | 'IKE'
  | 'ESP'
  | 'CSMA'
  | 'SYS';
