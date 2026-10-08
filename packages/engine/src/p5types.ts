/**
 * Zustandstypen der Phase 5 (WLAN, Server-Dienste, Management, Firewall, IoT, Cloud/Modem, Physical View).
 * Alles reines JSON (Snapshots). Eingebunden über optionale Felder in `types.ts`.
 */
import type { Ipv4Addr, Mac, SvcPdu, SvcProto } from '@netsim/protocols';
import type { Acl } from './types';

// ---------------------------------------------------------------- Uhr / NTP

export interface ClockCfg {
  /** Epoch-Millisekunden zum virtuellen Zeitpunkt 0. */
  baseMs: number;
  /** NTP: Server, mit dem zuletzt synchronisiert wurde. */
  syncedTo?: Ipv4Addr;
  lastSyncUs?: number;
  /** Stratum (16 = unsynchronisiert). */
  stratum: number;
}

// ---------------------------------------------------------------- WLAN

export type WifiBand = '2.4' | '5';
export type WifiSecurity = 'open' | 'wpa2-psk';

export interface Radio {
  band: WifiBand;
  channel: number;
  enabled: boolean;
  ssid: string;
  security: WifiSecurity;
  key?: string;
}

export interface Wlan {
  id: number;
  ssid: string;
  security: WifiSecurity;
  key?: string;
  band: 'both' | WifiBand;
  enabled: boolean;
}

/** Ein ausgesendetes Netz (BSS) eines Access Points. */
export interface Bss {
  ssid: string;
  security: WifiSecurity;
  key?: string;
  band: WifiBand;
  channel: number;
}

export interface ApClient {
  mac: Mac;
  ssid: string;
  band: WifiBand;
  channel: number;
  since: number;
}

export interface ApCfg {
  /** [0] = 2,4 GHz, [1] = 5 GHz. */
  radios: Radio[];
  /** Lightweight-AP: Adresse des WLC (leer = autonom). */
  wlc?: Ipv4Addr;
  /** Vom WLC gelieferte WLANs (Laufzeit, nach erfolgreichem Join). */
  managed?: { wlc: Ipv4Addr; wlans: Wlan[]; joinedAt: number };
  /** Laufzeit: gelernte MAC → Port. */
  macTable: Record<Mac, string>;
  /** Laufzeit: assoziierte Clients je Funk-Port. */
  clients: Record<string, ApClient>;
}

export interface WifiProfile {
  ssid: string;
  key?: string;
}

export interface WifiAssoc {
  apId: string;
  apPortId: string;
  clientPortId: string;
  ssid: string;
  band: WifiBand;
  channel: number;
}

export type WifiStatus = 'idle' | 'connected' | 'auth-failed' | 'no-ap' | 'off';

export interface WifiClientCfg {
  enabled: boolean;
  profiles: WifiProfile[];
  /** Unterstützte Bänder (Drucker/IoT nur 2,4 GHz). */
  bands: WifiBand[];
  assoc?: WifiAssoc;
  status: WifiStatus;
}

export interface WlcAp {
  mac: Mac;
  name: string;
  ip: Ipv4Addr;
  joinedAt: number;
}

export interface WlcCfg {
  wlans: Wlan[];
  /** Beigetretene Lightweight-APs (Laufzeit). */
  aps: Record<Mac, WlcAp>;
}

// ---------------------------------------------------------------- Server-Dienste

export interface UserCred {
  user: string;
  pass: string;
}

export interface MailMsg {
  id: number;
  from: string;
  to: string;
  subject: string;
  body: string;
  t: number;
}

export interface SyslogMsg {
  t: number;
  from: Ipv4Addr;
  host: string;
  severity: number;
  text: string;
}

export interface SnmpCommunity {
  name: string;
  rw: boolean;
}

export interface IotDevice {
  name: string;
  ip: Ipv4Addr;
  role: 'sensor' | 'actuator' | 'sbc';
  value?: number;
  unit?: string;
  state?: 'on' | 'off';
  lastSeen: number;
}

export interface IotRule {
  id: number;
  sensor: string;
  op: '>' | '<' | '>=' | '<=' | '==';
  threshold: number;
  actuator: string;
  action: 'on' | 'off';
  /** Aktion, wenn die Bedingung nicht mehr gilt (`none` = nichts tun). */
  elseAction: 'on' | 'off' | 'none';
}

export interface ServerSvc5 {
  tftp?: { enabled: boolean; files: Record<string, string> };
  ftp?: { enabled: boolean; users: UserCred[]; files: Record<string, string> };
  mail?: {
    enabled: boolean;
    domain: string;
    accounts: UserCred[];
    boxes: Record<string, MailMsg[]>;
    nextId: number;
  };
  ntp?: { enabled: boolean };
  syslog?: { enabled: boolean; messages: SyslogMsg[] };
  snmp?: { enabled: boolean; communities: SnmpCommunity[]; location?: string; contact?: string };
  aaa?: { enabled: boolean; clients: { ip: Ipv4Addr; secret: string }[]; users: UserCred[] };
  iot?: { enabled: boolean; devices: Record<string, IotDevice>; rules: IotRule[] };
}

export interface IotCfg {
  role: 'sensor' | 'actuator' | 'sbc';
  /** Sensor-Art (`temperature`, `humidity`, `light`, `motion` …). */
  sensor: string;
  unit: string;
  /** Aktueller manueller Wert. */
  value: number;
  /** Wertverlauf: manuell oder deterministisch über die Zeit. */
  pattern: 'manual' | 'wave' | 'ramp';
  min: number;
  max: number;
  periodSec: number;
  state: 'on' | 'off';
  server?: Ipv4Addr;
  registered: boolean;
  reportSec: number;
}

export interface HostMailCfg {
  server?: Ipv4Addr;
  user: string;
  pass: string;
  inbox: MailMsg[];
  sent: MailMsg[];
  status?: { key: string; params?: Record<string, string | number> };
}

// ---------------------------------------------------------------- Transport der Dienste

export interface AppConn {
  id: number;
  role: 'c' | 's';
  proto: SvcProto;
  state: 'syn-sent' | 'open' | 'closed' | 'failed';
  lport: number;
  raddr: Ipv4Addr;
  rport: number;
  seq: number;
  ack: number;
  retries: number;
  /** Fehlerschlüssel bei `failed` (`conn.refused`, `conn.timeout`, `conn.unreachable`). */
  err?: string;
  /** Banner (aus dem SYN-ACK). */
  banner?: SvcPdu;
  /** Letzte Antwort / Zähler (Client). */
  reply?: SvcPdu;
  replySeq: number;
  waiting: boolean;
  /** Serverseitiger Sitzungszustand. */
  user?: string;
  authed?: boolean;
  fails?: number;
  /** vty-Index (Telnet/SSH-Server). */
  vty?: number;
  /** Client: erste Anfrage, die nach dem Verbindungsaufbau automatisch gesendet wird. */
  first?: { op: string; args: Record<string, string | number | boolean>; body?: string };
  /** Client: Zweck der Verbindung (`mail-send`, `mail-fetch`) für den Abschluss-Hook. */
  purpose?: string;
  /** Client: Zusatzdaten zum Zweck (Empfänger, Betreff …). */
  data?: Record<string, string | number>;
}

export interface UdpReq {
  id: number;
  proto: SvcProto;
  op: string;
  dst: Ipv4Addr;
  status: 'pending' | 'done' | 'timeout' | 'failed';
  reply?: SvcPdu;
  sentAt: number;
}

export interface AppCore {
  conns: Record<string, AppConn>;
  nextConn: number;
  nextPort: number;
  reqs: Record<number, UdpReq>;
  nextReq: number;
  /** Server-seitig wartende Logins (RADIUS): Anfrage-ID → Verbindungsschlüssel. */
  aaaWait: Record<number, { key: string; user: string; pass: string; next: number }>;
}

// ---------------------------------------------------------------- Management (Router/Switch/Firewall)

export interface VtySession {
  /** vty-Index (-1 = Console). */
  line: number;
  user: string;
  from: string;
  since: number;
  protocol: 'telnet' | 'ssh' | 'console';
}

export interface MgmtCfg {
  /** `username X [privilege N] secret Y` (Klartext, wie die übrigen Passwörter). */
  users: Record<string, { secret: string; privilege: number }>;
  ssh: { version: 1 | 2; keyBits?: number };
  vty: {
    /** Anzahl der vty-Leitungen (`line vty 0 4` = 5, `0 15` = 16). */
    lines: number;
    transport: ('ssh' | 'telnet')[];
    loginLocal: boolean;
    /** `login authentication LIST` (AAA). */
    authList?: string;
  };
  ntp: { servers: Ipv4Addr[]; master?: number };
  clock: ClockCfg;
  syslog: { hosts: Ipv4Addr[]; trap: number; buffered: boolean };
  snmp: { communities: SnmpCommunity[]; location?: string; contact?: string };
  aaa: {
    newModel: boolean;
    radius: { host: Ipv4Addr; key: string }[];
    /** `aaa authentication login default group radius local`. */
    methods: ('radius' | 'local')[];
    listName: string;
  };
  /** Laufzeit: offene Sitzungen (Console nicht enthalten). */
  sessions: VtySession[];
  /** Laufzeit: Log-Puffer (`show logging`). */
  logBuffer: string[];
}

// ---------------------------------------------------------------- Firewall

export interface FwIface {
  nameif: string;
  level: number;
}

export interface FwConn {
  proto: 'icmp' | 'tcp' | 'udp' | 'ip';
  /** Richtung der ersten Pakete: Quelle (Initiator) → Ziel. */
  src: Ipv4Addr;
  sport: number;
  dst: Ipv4Addr;
  dport: number;
  inIface: string;
  outIface: string;
  createdAt: number;
  lastAt: number;
  flags: string;
}

export interface FwObject {
  name: string;
  /** `subnet N M` oder `host H`. */
  net?: { ip: Ipv4Addr; mask: string };
  nat?: {
    from: string;
    to: string;
    kind: 'dynamic-interface' | 'static';
    mapped?: Ipv4Addr;
  };
}

export interface FwCfg {
  /** Schnittstellen-ID → nameif/security-level. */
  ifaces: Record<string, FwIface>;
  /** Interface-ID → ACL-Name (`access-group NAME in interface X`). */
  accessGroups: Record<string, string>;
  objects: Record<string, FwObject>;
  /** Laufzeit: Verbindungstabelle. */
  conns: FwConn[];
  /** `same-security-traffic permit inter-interface`. */
  sameSecurity: boolean;
  /** Zähler. */
  built: number;
  denied: number;
}

export type { Acl };

// ---------------------------------------------------------------- Cloud / Modem

export interface BridgeCfg {
  kind: 'bridge';
  /** Port-ID → Gruppe; Ports derselben Gruppe sind überbrückt (0 = aus). */
  groups: Record<string, number>;
  /** Laufzeit: MAC → Port. */
  macTable: Record<Mac, string>;
  /** Modem: Gruppen sind fest. */
  fixed: boolean;
}

// ---------------------------------------------------------------- Physical View

export interface PhysicalRoom {
  name: string;
  racks: string[];
}
export interface PhysicalBuilding {
  name: string;
  rooms: PhysicalRoom[];
}
export interface PhysicalCity {
  name: string;
  buildings: PhysicalBuilding[];
}
export interface PhysicalTree {
  cities: PhysicalCity[];
}

/** Gerätestandort als Pfad `Stadt/Gebäude/Raum[/Rack]`. */
export interface PhysicalLoc {
  rackPos?: number;
  location?: string;
}
