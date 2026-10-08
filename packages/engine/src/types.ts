import type { DnsRecord, Frame, Ipv4Addr, Ipv4Pdu, Mac, ProtoTag } from '@netsim/protocols';

export type DeviceType =
  | 'pc'
  | 'laptop'
  | 'server'
  | 'tablet'
  | 'smartphone'
  | 'printer'
  | 'switch-l2'
  | 'switch-l3'
  | 'router'
  | 'hub'
  | 'ap'
  | 'wlc'
  | 'firewall'
  | 'cloud'
  | 'dsl-modem'
  | 'cable-modem'
  | 'iot-sensor'
  | 'iot-actuator'
  | 'sbc'
  | 'note';

export type PortKind =
  'fe' | 'ge' | 'tengig' | 'serial' | 'console' | 'aux' | 'usb' | 'wifi' | 'fiber-sfp';

export type CableType =
  | 'straight'
  | 'crossover'
  | 'rollover'
  | 'serial-dce'
  | 'serial-dte'
  | 'fiber'
  | 'coax'
  | 'phone'
  | 'usb'
  | 'wireless';

export interface Point {
  x: number;
  y: number;
}

export interface Counters {
  inPkts: number;
  outPkts: number;
  inBytes: number;
  outBytes: number;
  inErrors: number;
  outErrors: number;
  collisions: number;
}

export interface Port {
  /** Stabile ID innerhalb des Geräts (`p0`, `p1`, …). */
  id: string;
  /** Anzeigename, z. B. `FastEthernet0/1`. */
  name: string;
  kind: PortKind;
  mac: Mac;
  adminUp: boolean;
  operUp: boolean;
  speed: 'auto' | 10 | 100 | 1000 | 10000;
  duplex: 'auto' | 'half' | 'full';
  linkId?: string;
  vlanMode?: 'access' | 'trunk' | 'routed';
  counters: Counters;
  /** Ausgehandelte Geschwindigkeit in Mbit/s (0 wenn down). */
  operSpeed: number;
  operDuplex: 'half' | 'full';
  /** Virtuelle Zeit (µs), bis zu der der Sender belegt ist. */
  txBusyUntil: number;
  /** Maximale IP-Paketgröße in Byte. */
  mtu: number;
  /** Gesetzt, wenn der Port durch err-disable abgeschaltet wurde (z. B. `psecure-violation`). */
  errdisabled?: string;
}

export interface PortRef {
  deviceId: string;
  portId: string;
}

export interface Link {
  id: string;
  cable: CableType;
  a: PortRef;
  b: PortRef;
  operUp: boolean;
  lengthM?: number;
  /** Kabel/Port-Kombination physikalisch in Ordnung (unabhängig von admin/power). */
  cableOk: boolean;
  /** i18n-Schlüssel, falls `cableOk` false. */
  cableProblem?: string;
  /** Medium belegt im Intervall [busyFrom, busyUntil) – für Carrier Sense. */
  busyFrom: number;
  busyUntil: number;
  /** Zeit der letzten Übertragung (für Blink-Anzeige). */
  lastActivityT: number;
}

export interface ModuleSlot {
  id: string;
  name: string;
  module?: string;
}

// ---------------------------------------------------------------- Gerätezustand

export interface PingResult {
  /** Eindeutige Ping-Sitzung. */
  id: number;
  seq: number;
  dst: Ipv4Addr;
  sentAt: number;
  status: 'pending' | 'reply' | 'timeout' | 'unreachable' | 'failed';
  rttUs?: number;
  /** Absender der Antwort bzw. der ICMP-Fehlermeldung. */
  from?: Ipv4Addr;
  /** i18n-/CLI-Schlüssel der Fehlerursache (z. B. `ping.ttlExpired`). */
  note?: string;
  /** TTL der Antwort. */
  ttl?: number;
  bytes?: number;
}

export interface PingSession {
  id: number;
  dst: Ipv4Addr;
  count: number;
  sent: number;
  intervalUs: number;
  dataSize: number;
  df: boolean;
  /** Quell-IP (erweitertes Ping); sonst Adresse der Ausgangsschnittstelle. */
  source?: Ipv4Addr;
  timeoutUs: number;
}

export interface TraceProbe {
  status: 'pending' | 'reply' | 'timeout';
  from?: Ipv4Addr;
  rttUs?: number;
  sentAt: number;
  /** `reached` = Ziel erreicht, `unreachable` = Zielnetz/-host meldet Unreachable. */
  outcome?: 'hop' | 'reached' | 'unreachable';
}

export interface TraceHop {
  ttl: number;
  probes: TraceProbe[];
}

export interface TraceSession {
  id: number;
  dst: Ipv4Addr;
  maxHops: number;
  ttl: number;
  hops: TraceHop[];
  done: boolean;
}

export interface ArpEntry {
  mac: Mac;
  expiresAt: number;
}

export interface ArpPending {
  attempts: number;
  ifaceId: string;
  queue: Ipv4Pdu[];
}

export interface ReasmEntry {
  firstSeen: number;
  parts: { off: number; len: number }[];
  total?: number;
  payload: Ipv4Pdu['payload'];
}

/** Gemeinsamer Zustand jedes Geräts mit IPv4-Stack (Host und Router). */
export interface IpCore {
  arpCache: Record<Ipv4Addr, ArpEntry>;
  arpPending: Record<Ipv4Addr, ArpPending>;
  reasm: Record<string, ReasmEntry>;
  pingSessions: PingSession[];
  pings: PingResult[];
  nextPingId: number;
  nextIpId: number;
  traces: TraceSession[];
  nextTraceId: number;
}

// ---------------------------------------------------------------- ACL / NAT / DHCP

export type AddrMatch = { any: true } | { ip: Ipv4Addr; wildcard: string };

export interface PortMatch {
  op: 'eq' | 'neq' | 'lt' | 'gt' | 'range';
  a: number;
  b?: number;
}

export interface AclEntry {
  seq: number;
  action: 'permit' | 'deny';
  proto: 'ip' | 'icmp' | 'tcp' | 'udp';
  src: AddrMatch;
  dst?: AddrMatch;
  srcPort?: PortMatch;
  dstPort?: PortMatch;
  /** TCP: nur Segmente mit ACK oder RST. */
  established?: boolean;
  log?: boolean;
  matches: number;
}

export interface Acl {
  name: string;
  type: 'standard' | 'extended';
  entries: AclEntry[];
}

export interface NatPool {
  name: string;
  start: Ipv4Addr;
  end: Ipv4Addr;
  mask: string;
}

export type NatRule =
  | { kind: 'static'; local: Ipv4Addr; global: Ipv4Addr; proto?: 'tcp' | 'udp'; lport?: number; gport?: number }
  | { kind: 'dynamic'; acl: string; pool: string; overload: boolean }
  | { kind: 'interface'; acl: string; ifaceId: string };

export interface NatEndpoint {
  ip: Ipv4Addr;
  port: number;
}

export interface NatEntry {
  proto: 'icmp' | 'tcp' | 'udp' | 'ip';
  insideLocal: NatEndpoint;
  insideGlobal: NatEndpoint;
  outside: NatEndpoint;
  kind: 'static' | 'dynamic';
  expiresAt: number;
}

export interface NatCfg {
  pools: Record<string, NatPool>;
  rules: NatRule[];
  table: NatEntry[];
  hits: number;
  misses: number;
  nextPort: number;
}

export interface DhcpPool {
  name: string;
  network: Ipv4Addr;
  mask: string;
  router?: Ipv4Addr;
  dns: Ipv4Addr[];
  domain?: string;
  leaseSec: number;
  tftp?: string;
  /** Optionaler Adressbereich (Server-Gerät); sonst das ganze Netz. */
  rangeStart?: Ipv4Addr;
  rangeEnd?: Ipv4Addr;
}

export interface DhcpBinding {
  mac: Mac;
  poolName: string;
  expiresAt: number;
  /** Angebot (noch nicht bestätigt) – verfällt nach 10 s. */
  offered?: boolean;
}

export interface DhcpServerCfg {
  enabled: boolean;
  pools: DhcpPool[];
  excluded: { from: Ipv4Addr; to: Ipv4Addr }[];
  bindings: Record<Ipv4Addr, DhcpBinding>;
  conflicts: Ipv4Addr[];
}

// ---------------------------------------------------------------- Hosts

export interface TcpConn {
  state: 'syn-sent' | 'established' | 'closed';
  lport: number;
  raddr: Ipv4Addr;
  rport: number;
  seq: number;
  ack: number;
  /** Anfrage, die nach dem Handshake gesendet wird. */
  pending?: { host: string; path: string; reqId: number };
  retries: number;
}

export interface HttpRequest {
  id: number;
  url: string;
  host: string;
  path: string;
  https: boolean;
  status: 'resolving' | 'connecting' | 'waiting' | 'done' | 'failed';
  /** HTTP-Status der Antwort (200, 404 …). */
  code?: number;
  body?: string;
  /** Fehlerschlüssel (`http.err.*`). */
  error?: string;
  addr?: Ipv4Addr;
  startedAt: number;
}

export interface DhcpClient {
  enabled: boolean;
  state: 'off' | 'init' | 'selecting' | 'requesting' | 'probing' | 'bound' | 'renewing';
  xid: number;
  server?: Ipv4Addr;
  offered?: { ip: Ipv4Addr; mask: string; router?: Ipv4Addr; dns?: Ipv4Addr[]; leaseSec: number };
  boundAt: number;
  leaseSec: number;
}

export interface HostServices {
  http: { enabled: boolean; https: boolean; pages: Record<string, string> };
  dns: { enabled: boolean; records: DnsRecord[] };
  dhcp: DhcpServerCfg;
}

export interface HostConfig extends IpCore {
  kind: 'host';
  ip?: Ipv4Addr;
  mask?: string;
  gateway?: Ipv4Addr;
  dhcpClient: DhcpClient;
  dnsServers: Ipv4Addr[];
  dnsCache: Record<string, { ip: Ipv4Addr; expiresAt: number }>;
  /** Offene DNS-Anfragen: Anfrage-ID → Name + wartende HTTP-/Ping-Aufträge. */
  dnsPending: Record<number, { name: string; reqId?: number; started: number }>;
  /** Abgeschlossene Namensauflösungen (für `nslookup`). */
  dnsResults: Record<number, { name: string; rcode: number; answers: DnsRecord[]; done: boolean; error?: string }>;
  nextDnsId: number;
  nextPort: number;
  tcp: Record<string, TcpConn>;
  nextIsn: number;
  requests: HttpRequest[];
  nextReqId: number;
  services: HostServices;
}

export interface LineConfig {
  password?: string;
  /** `login` konfiguriert (Passwortabfrage). */
  login: boolean;
}

/** Gemeinsame Systemkonfiguration von Router und Switch (CLI-Geräte). */
export interface SysConfig {
  hostname: string;
  enableSecret?: string;
  enablePassword?: string;
  servicePasswordEncryption: boolean;
  bannerMotd?: string;
  domainName?: string;
  lineCon: LineConfig;
  lineVty: LineConfig;
  /** Port-ID → Beschreibung. */
  descriptions: Record<string, string>;
  /** Gespeicherte Startup-Konfiguration (Text). */
  startupConfig?: string;
  /** Initial-Konfigurationsdialog beantwortet/übersprungen. */
  setupDone: boolean;
}

/** Konfiguration einer L3-Schnittstelle (physisch, Subinterface oder SVI). */
export interface IfaceCfg {
  kind: 'phys' | 'sub' | 'svi';
  portId?: string;
  /** Sub: Dot1Q-VLAN; SVI: VLAN-ID. */
  vlan?: number;
  ip?: Ipv4Addr;
  mask?: string;
  /** Nur Sub/SVI (physisch: Port-Admin-Status). */
  shutdown?: boolean;
  aclIn?: string;
  aclOut?: string;
  natSide?: 'inside' | 'outside';
  helpers?: Ipv4Addr[];
}
export type RouterIface = IfaceCfg;

export interface StaticRoute {
  prefix: Ipv4Addr;
  mask: string;
  nextHop?: Ipv4Addr;
  /** Alternativ zum Next-Hop: Ausgangsschnittstelle (ID wie in `ifaces`). */
  outIfaceId?: string;
  /** Administrative Distance (Default 1). */
  ad: number;
}

/** Von einem dynamischen Routing-Protokoll installierte Route (Laufzeit). */
export interface DynRoute {
  proto: 'R' | 'O' | 'D' | 'B';
  /** Unterart, z. B. `IA`, `E2`, `EX`. */
  sub?: string;
  prefix: Ipv4Addr;
  plen: number;
  ad: number;
  metric: number;
  nextHop?: Ipv4Addr;
  ifaceId: string;
  /** Installationszeit (µs virtuelle Zeit). */
  since?: number;
}

/** Gemeinsamer L3-Zustand von Router und L3-fähigen Switches. */
export interface L3Cfg extends IpCore {
  dynRoutes: DynRoute[];
  ifaces: Record<string, IfaceCfg>;
  staticRoutes: StaticRoute[];
  acls: Record<string, Acl>;
  nat: NatCfg;
  dhcp: DhcpServerCfg;
  /** `ip routing` (Router: immer an). */
  ipRouting: boolean;
  /** Switch ohne Routing: `ip default-gateway`. */
  defaultGateway?: Ipv4Addr;
}

export interface RouterConfig extends L3Cfg {
  kind: 'router';
  sys: SysConfig;
}

export interface MacEntry {
  portId: string;
  vlan: number;
  updatedAt: number;
}

export interface PortSecurity {
  enabled: boolean;
  max: number;
  violation: 'protect' | 'restrict' | 'shutdown';
  sticky: boolean;
  /** Erlaubte (statisch/sticky) MACs. */
  macs: Mac[];
  /** Dynamisch gelernte sichere MACs (nicht persistent). */
  dynMacs: Mac[];
  violations: number;
  lastMac?: Mac;
}

export type SwitchportMode = 'access' | 'trunk' | 'dynamic-auto' | 'dynamic-desirable';

export interface SwitchPortCfg {
  mode: SwitchportMode;
  accessVlan: number;
  nativeVlan: number;
  /** `'all'` oder explizite Liste. */
  allowed: 'all' | number[];
  /** `no switchport`: Routed Port (L3-Switch). */
  routed: boolean;
  portfast: boolean;
  bpduguard: boolean;
  rootguard: boolean;
  psec: PortSecurity;
  channel?: number;
  channelMode?: 'on' | 'active' | 'passive' | 'desirable' | 'auto';
}

export interface VtpCfg {
  mode: 'server' | 'client' | 'transparent';
  domain: string;
  revision: number;
}

export type StpMode = 'pvst' | 'rapid-pvst';

export interface StpPortState {
  role: 'root' | 'designated' | 'alternate' | 'disabled';
  state: 'discarding' | 'listening' | 'learning' | 'forwarding';
  /** Letzte empfangene (beste) Vektorinformation. */
  info?: { rootId: string; cost: number; bridgeId: string; portId: string; rstp: boolean };
  infoAt?: number;
  /** Zeitpunkt des nächsten Zustandsübergangs (802.1D). */
  nextAt?: number;
  proposing?: boolean;
  /** Operative Edge (PortFast oder RSTP-Edge). */
  edge: boolean;
  /** PortFast wurde durch ein empfangenes BPDU betrieblich deaktiviert. */
  edgeBroken?: boolean;
  /** Quittiert durch Agreement. */
  synced?: boolean;
}

export interface StpInstance {
  vlan: number;
  rootId: string;
  rootCost: number;
  rootPort?: string;
  ports: Record<string, StpPortState>;
  /** Topology Change aktiv bis. */
  tcUntil: number;
}

export interface StpCfg {
  mode: StpMode;
  /** Priorität je VLAN (Default 32768). */
  priority: Record<number, number>;
  instances: Record<number, StpInstance>;
}

export interface SwitchConfig extends L3Cfg {
  kind: 'switch';
  sys: SysConfig;
  /** Schlüssel `${vlan}|${mac}`. */
  macTable: Record<string, MacEntry>;
  /** Aging in Sekunden (Default 300). */
  agingSec: number;
  vlans: Record<number, { name: string }>;
  vtp: VtpCfg;
  ports: Record<string, SwitchPortCfg>;
  stp: StpCfg;
  /** Laufzeit: gebündelte Port-Channels (Nummer → Mitglieds-Port-IDs). */
  bundles: Record<number, string[]>;
  /** Laufzeit: operativer Trunk-Status je Port. */
  operTrunk: Record<string, boolean>;
  errdisableRecovery: { psecure: boolean; intervalSec: number };
}

export interface HubConfig {
  kind: 'hub';
  /** Ende der laufenden Wiederholung (µs). */
  busyUntil: number;
}

export interface UnsupportedConfig {
  kind: 'none';
}

export type DeviceState = HostConfig | RouterConfig | SwitchConfig | HubConfig | UnsupportedConfig;

export interface Device {
  id: string;
  type: DeviceType;
  model: string;
  name: string;
  pos: Point;
  ports: Port[];
  modules: ModuleSlot[];
  powered: boolean;
  config: DeviceState;
  physical: { rackPos?: number; location?: string };
  /** Gesetzt, wenn ein Handler eine Exception geworfen hat. */
  crashed?: { message: string; t: number };
}

// ---------------------------------------------------------------- Ereignisse

export interface RxPayload {
  portId: string;
  txId: number;
  frame: Frame;
}
export interface TimerPayload {
  name: string;
  repeatUs?: number;
}
export interface TxPayload {
  portId: string;
  frame: Frame;
  attempts: number;
  /** Übertragung, aus der ein Hub diese Wiederholung erzeugt hat. */
  origin?: number;
}
export interface CollisionPayload {
  portId: string;
  txId: number;
}

export type SimEvent = { t: number; seq: number; deviceId: string } & (
  | { kind: 'rx'; payload: RxPayload }
  | { kind: 'timer'; payload: TimerPayload }
  | { kind: 'tx'; payload: TxPayload }
  | { kind: 'collision'; payload: CollisionPayload }
);

/** Übertragung auf einem Link (für Kollisionserkennung und Animation). */
export interface Transmission {
  id: number;
  linkId: string;
  from: PortRef;
  to: PortRef;
  sendStart: number;
  /** Ankunft des ersten/letzten Bits beim Empfänger. */
  arrStart: number;
  arrEnd: number;
  frame: Frame;
  attempts: number;
  collided: boolean;
  /** Gesetzt, wenn ein Hub die Übertragung `origin` wiederholt (kein eigener Retry). */
  origin?: number;
}

// ---------------------------------------------------------------- Log

/** i18n-Nachricht: Schlüssel + Parameter; die UI übersetzt. */
export interface Msg {
  key: string;
  params?: Record<string, string | number>;
}

export type LogKind = 'rx' | 'drop' | 'collision' | 'link' | 'ping' | 'info' | 'error';

export interface LogEntry {
  id: number;
  t: number;
  kind: LogKind;
  proto: ProtoTag;
  status: 'ok' | 'drop' | 'info' | 'error';
  lastDeviceId?: string;
  lastDeviceName?: string;
  atDeviceId: string;
  atDeviceName: string;
  portName?: string;
  msg: Msg;
  /** Kurzinfo des Frames (z. B. „Who has 10.0.0.2?“). */
  summary?: string;
  frame?: Frame;
}

// ---------------------------------------------------------------- Engine-Zustand

export interface EngineConfig {
  /** Propagationsverzögerung je Link in µs. */
  propagationUs: number;
  /** Gerätebearbeitung in µs. */
  processingUs: number;
  /** Kupferkabel länger als dieses Maß → Link down. 0 = Prüfung aus. */
  maxCopperLengthM: number;
}

export interface EngineState {
  version: 1;
  seed: number;
  rng: number;
  now: number;
  seq: number;
  nextTxId: number;
  nextId: number;
  macCounter: number;
  nameCounters: Record<string, number>;
  config: EngineConfig;
  devices: Record<string, Device>;
  links: Record<string, Link>;
  /** Min-Heap, geordnet nach (t, seq). */
  queue: SimEvent[];
  transmissions: Transmission[];
}

export interface EngineSnapshot {
  state: EngineState;
  logLength: number;
}

export type Result<T> =
  { ok: true; value: T } | { ok: false; error: string; params?: Record<string, string | number> };
