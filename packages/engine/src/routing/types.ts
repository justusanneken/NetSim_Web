import type { BgpAttrs, EigrpRoute, HsrpState, OspfLsa } from '@netsim/protocols';
import type { CommunityList, PrefixList, RouteMap } from './routemap';

/** Konfiguration und Laufzeitzustand der dynamischen Routing-Protokolle (alles JSON-serialisierbar). */

export type RedistSource = 'connected' | 'static' | 'rip' | 'ospf' | 'eigrp' | 'bgp';

export interface RedistCfg {
  source: RedistSource;
  /** Prozess-ID (OSPF) bzw. AS-Nummer (EIGRP/BGP). */
  id?: number;
  metric?: number;
  /** OSPF: externer Typ (1/2, Default 2). */
  metricType?: 1 | 2;
  /** OSPF: klassenlose Netze mit übernehmen. */
  subnets: boolean;
  tag?: number;
  /** EIGRP: Seed-Metrik (Bandbreite kbit/s, Delay in 10 µs). */
  bw?: number;
  delay?: number;
  /** `redistribute … route-map NAME`. */
  routeMap?: string;
}

/** `distribute-list ACL|prefix-list NAME in|out [Schnittstelle]`. */
export interface DistList {
  kind: 'acl' | 'prefix-list';
  name: string;
  dir: 'in' | 'out';
  ifaceId?: string;
}

// ---------------------------------------------------------------- RIP

export interface RipRoute {
  prefix: string;
  plen: number;
  metric: number;
  nextHop?: string;
  ifaceId?: string;
  /** Zeitpunkt des letzten Updates (µs); lokal erzeugte Routen: undefined. */
  updatedAt?: number;
  /** Ab diesem Zeitpunkt wird die Route mit Metrik 16 gelöscht (Garbage-Collection). */
  flushAt?: number;
  /** Änderung seit dem letzten Update (Triggered Update). */
  changed: boolean;
  origin: 'rip' | 'network' | 'redistributed' | 'default';
  tag: number;
  /** Gleichwertige Zusatzpfade (ECMP) mit derselben Metrik. */
  alts?: { nextHop: string; ifaceId: string; updatedAt: number }[];
}

export interface RipCfg {
  distributeLists?: DistList[];
  /** `maximum-paths` (ECMP). */
  maxPaths?: number;
  networks: string[];
  passive: string[];
  /** `no passive-interface X` bei `passive-interface default`. */
  unpassive: string[];
  passiveDefault: boolean;
  autoSummary: boolean;
  defaultOriginate: boolean;
  redistribute: RedistCfg[];
  /** `default-metric`; ohne Wert ist die Metrik redistribuierter Routen unendlich (IOS). */
  defaultMetric?: number;
  timers: { update: number; invalid: number; holddown: number; flush: number };
  /** Split Horizon mit Poison Reverse an? (Default: Split Horizon ohne Poison). */
  poison: boolean;
  /** Laufzeit. */
  routes: Record<string, RipRoute>;
  timersArmed?: boolean;
  /** Laufzeit: Holddown je Präfix (Ende, Metrik vor dem Ausfall). */
  held?: Record<string, { until: number; metric: number; via?: string }>;
  version: 2;
}

/** RIPng-Prozess (`ipv6 router rip NAME`). */
export interface RipngCfg {
  name: string;
  redistribute: RedistCfg[];
  defaultOriginate: boolean;
  defaultMetric?: number;
  timers: { update: number; invalid: number; holddown: number; flush: number };
  poison: boolean;
  passive?: string[];
  distributeLists?: DistList[];
  maxPaths?: number;
  /** Laufzeit. */
  routes: Record<string, RipRoute>;
  held?: Record<string, { until: number; metric: number; via?: string }>;
  timersArmed?: boolean;
}

// ---------------------------------------------------------------- OSPF

export interface OspfNetworkStmt {
  prefix: string;
  wildcard: string;
  area: string;
}

export type OspfNbrState = 'down' | 'init' | '2way' | 'exstart' | 'exchange' | 'loading' | 'full';

export interface OspfNbr {
  rid: string;
  ip: string;
  state: OspfNbrState;
  priority: number;
  dr: string;
  bdr: string;
  ddSeq: number;
  master: boolean;
  lastHeard: number;
  /** Angeforderte LSAs (Schlüssel). */
  reqList: string[];
  /** Unbestätigt gesendete LSAs (Schlüssel → Header-Seq). */
  retrans: Record<string, number>;
  /** Wurde das eigene DBD des Nachbarn schon verarbeitet? */
  dbdDone: boolean;
}

export type OspfIfStateName = 'down' | 'waiting' | 'p2p' | 'dr' | 'bdr' | 'drother' | 'loopback';

export interface OspfIfState {
  area: string;
  state: OspfIfStateName;
  dr: string;
  bdr: string;
  /** Adresse der DR-/BDR-Schnittstelle (Netzwerk-ID der Network-LSA). */
  drAddr: string;
  bdrAddr: string;
  waitUntil: number;
  /** Aktuell gesetztes Hello-Intervall (Timer-Neuanlage bei Änderung). */
  helloSec: number;
  neighbors: Record<string, OspfNbr>;
}

export interface OspfIfCfg {
  /** `ip ospf PID area A`; ohne Angabe gilt die Zuordnung über `network`-Anweisungen. */
  pid?: number;
  area?: string;
  cost?: number;
  priority?: number;
  helloSec?: number;
  deadSec?: number;
  network?: 'broadcast' | 'point-to-point';
  /** `ip ospf authentication [message-digest|null]` (überschreibt die Area-Einstellung). */
  auth?: 'simple' | 'md5' | 'null';
  /** `ip ospf authentication-key` (Klartext). */
  authKey?: string;
  /** `ip ospf message-digest-key ID md5 KEY`. */
  md5Keys?: Record<number, string>;
}

export interface OspfAreaCfg {
  id: string;
  type: 'normal' | 'stub' | 'nssa';
  /** Totally stubby / NSSA no-summary: keine Typ-3-Summaries (nur Default). */
  noSummary: boolean;
  /** Kosten der vom ABR eingespeisten Default-Route. */
  defaultCost?: number;
  /** `area N authentication [message-digest]`. */
  auth?: 'simple' | 'md5';
  /** NSSA: ABR erzeugt Typ-7-Default (`area N nssa default-information-originate`). */
  nssaDefaultOriginate?: boolean;
}

export interface OspfVlink {
  /** Transit-Area. */
  area: string;
  rid: string;
  // ---- Laufzeit
  /** Kosten des Pfads zum Peer durch die Transit-Area (aus der letzten SPF). */
  cost?: number;
}

export interface OspfAreaRange {
  area: string;
  prefix: string;
  plen: number;
  notAdvertise: boolean;
}

export interface OspfExternal {
  prefix: string;
  plen: number;
  metric: number;
  eType: 1 | 2;
  tag: number;
}

export interface OspfCfg {
  distributeLists?: DistList[];
  /** `maximum-paths` (ECMP). */
  maxPaths?: number;
  pid: number;
  routerId?: string;
  networks: OspfNetworkStmt[];
  passive: string[];
  unpassive: string[];
  passiveDefault: boolean;
  /** Referenzbandbreite in Mbit/s (Default 100). */
  refBwMbps: number;
  defaultOriginate?: { always: boolean; metric: number; metricType: 1 | 2 };
  redistribute: RedistCfg[];
  ranges: OspfAreaRange[];
  /** Bereichstypen (stub/nssa), Authentifizierung je Area. */
  areas?: Record<string, OspfAreaCfg>;
  vlinks?: OspfVlink[];
  /** Ob dies ein OSPFv3-Prozess ist (IPv6-Adressen). */
  v6: boolean;
  // ---- Laufzeit
  /** Effektive Router-ID. */
  rid?: string;
  ifs: Record<string, OspfIfState>;
  /** Area-ID (oder `as`) → LSA-Schlüssel (`typ|id|adv`) → LSA. */
  lsdb: Record<string, Record<string, OspfLsa>>;
  /** Installationszeit je LSA (`area|key`) in µs für das Altern. */
  installed: Record<string, number>;
  /** Selbst erzeugte LSA-Sequenznummern. */
  seqs: Record<string, number>;
  /** Aktuell redistribuierte externe Routen (Quelle für Typ-5-LSAs). */
  externals: Record<string, OspfExternal>;
  spfRuns: number;
  lastSpf: number;
  /** LSDB oder Topologie geändert → SPF nötig. */
  dirty: boolean;
  timersArmed?: boolean;
}

// ---------------------------------------------------------------- EIGRP

export interface EigrpQueued {
  op: 'update' | 'query' | 'reply';
  seq: number;
  routes: EigrpRoute[];
  init?: boolean;
  tries: number;
}

export interface EigrpNbr {
  ip: string;
  ifaceId: string;
  routerId: string;
  holdSec: number;
  lastHeard: number;
  /** Zuletzt vergebene Sequenznummer (ausgehend). */
  seqOut: number;
  /** Zuletzt empfangene Sequenznummer des Nachbarn. */
  seqIn: number;
  /** Zuverlässige Übertragung: Kopf der Warteschlange ist unbestätigt unterwegs. */
  queue: EigrpQueued[];
  uptime: number;
}

export interface EigrpPath {
  /** Nachbar-IP oder `local` (direkt angeschlossen/redistribuiert). */
  via: string;
  ifaceId: string;
  /** Reported Distance des Nachbarn und eigene Distanz über ihn. */
  rd: number;
  dist: number;
  /** Komponenten (Delay in 10 µs, Bandbreite kbit/s) bis zum Ziel inkl. eigener Schnittstelle. */
  delay: number;
  bandwidth: number;
  hops: number;
  external?: { proto: string; router: string };
}

export interface EigrpTopo {
  prefix: string;
  plen: number;
  paths: EigrpPath[];
  /** Feasible Distance (Distanz des gewählten Successors). */
  fd: number;
  /** Gewählter Successor (`via`). */
  succ?: string;
  active: boolean;
  /** Zeitpunkt (µs), seit dem das Ziel aktiv ist (Stuck-in-Active). */
  activeSince?: number;
  /** Aktiv: Nachbarn, von denen noch eine Reply aussteht. */
  waiting: string[];
  /** Nachbar, dem nach Abschluss der aktiven Phase geantwortet werden muss. */
  origin?: string;
  /** Zuletzt an Nachbarn angekündigter Zustand. */
  advertised?: { delay: number; bandwidth: number; hops: number; unreachable: boolean };
}

export interface EigrpCfg {
  distributeLists?: DistList[];
  /** `maximum-paths` (ECMP). */
  maxPaths?: number;
  asn: number;
  routerId?: string;
  networks: { prefix: string; wildcard: string }[];
  passive: string[];
  unpassive: string[];
  passiveDefault: boolean;
  autoSummary: boolean;
  variance: number;
  redistribute: RedistCfg[];
  /** EIGRP für IPv6 (`ipv6 router eigrp ASN`): Adressen sind IPv6, Nachbarn Link-Local. */
  v6?: boolean;
  /** Nur IPv6: Prozess ist administrativ aus (`shutdown`, Default bei neuen Prozessen). */
  shutdown?: boolean;
  // ---- Laufzeit
  rid?: string;
  neighbors: Record<string, EigrpNbr>;
  topology: Record<string, EigrpTopo>;
  /** Zu verbreitende Präfixe (gebündelte Updates). */
  advQueue: string[];
  /** Laufzeit: Signatur der `distribute-list`-Konfiguration (Änderung ⇒ Neuankündigung). */
  distSig?: string;
  /** Schnittstellen, auf denen der Hello-Timer läuft. */
  helloIfs: string[];
}

// ---------------------------------------------------------------- BGP

export type BgpState = 'idle' | 'connect' | 'active' | 'opensent' | 'openconfirm' | 'established';

export interface BgpPath {
  prefix: string;
  plen: number;
  attrs: BgpAttrs;
  /** Nachbar-IP, von dem die Route kam; `local` bei eigenen Routen. */
  from: string;
  /** eBGP oder iBGP gelernt. */
  ebgp: boolean;
  /** Router-ID des Senders (Tiebreaker). */
  fromRid: string;
  weight: number;
  /** Eigener Ursprung per `network`/Redistribution. */
  local: boolean;
}

export interface BgpNbrCfg {
  ip: string;
  asn: number;
  updateSource?: string;
  ebgpMultihop?: number;
  nextHopSelf: boolean;
  shutdown: boolean;
  description?: string;
  weight?: number;
  /** `neighbor X prefix-list NAME in|out`, `neighbor X route-map NAME in|out`. */
  prefixListIn?: string;
  prefixListOut?: string;
  routeMapIn?: string;
  routeMapOut?: string;
  /** `neighbor X send-community`. */
  sendCommunity?: boolean;
  /** `neighbor X route-reflector-client`. */
  rrClient?: boolean;
  /** `address-family ipv6` → `neighbor X activate`. */
  activate6?: boolean;
  // ---- Laufzeit
  state: BgpState;
  /** Schlüssel der TCP-Verbindung (Port 179) in `appc.conns`, solange eine besteht. */
  connKey?: string;
  routerId?: string;
  holdSec: number;
  lastRx: number;
  lastTx: number;
  established?: number;
  /** Anzahl empfangener Präfixe. */
  prefixesRx: number;
  /** Zähler gesendeter/empfangener BGP-Nachrichten (`show ip bgp summary`). */
  msgTx?: number;
  msgRx?: number;
  /** Zuletzt an den Nachbarn gesendete Präfixe (Präfix → Attribut-Schlüssel) für Withdraws/Änderungen. */
  advertised: Record<string, string>;
  /** Adj-RIB-In: Präfix → Pfad. */
  ribIn: Record<string, BgpPath>;
  /** IPv6-Adressfamilie (MP-BGP, vereinfacht im selben Update). */
  advertised6?: Record<string, string>;
  ribIn6?: Record<string, BgpPath>;
}

export interface BgpCfg {
  /** `maximum-paths` (ECMP). */
  maxPaths?: number;
  asn: number;
  routerId?: string;
  neighbors: Record<string, BgpNbrCfg>;
  networks: { prefix: string; plen: number }[];
  /** IPv6-Adressfamilie: `network X::/L`. */
  networks6?: { prefix: string; plen: number }[];
  redistribute: RedistCfg[];
  /** Route-Reflector-Cluster-ID (`bgp cluster-id`); Default: Router-ID. */
  clusterId?: string;
  /** Laufzeit: Loc-RIB (Präfix-Schlüssel → bester Pfad). */
  locRib: Record<string, BgpPath>;
  locRib6?: Record<string, BgpPath>;
  rid?: string;
  defaultLocalPref: number;
  timersArmed?: boolean;
}

// ---------------------------------------------------------------- HSRP

export interface HsrpCfg {
  group: number;
  vip?: string;
  priority: number;
  preempt: boolean;
  helloSec: number;
  holdSec: number;
  track: { ifaceId: string; decrement: number }[];
  name?: string;
  /** `standby G authentication KEY` (Klartext, Default `cisco`). */
  authKey?: string;
  /** IPv6-Gruppe (`standby G ipv6 …`): `vip` ist die IPv6-Adresse. */
  v6?: boolean;
  /** `standby G ipv6 autoconfig`: virtuelle Link-Local aus der virtuellen MAC. */
  autoconfig?: boolean;
  // ---- Laufzeit
  state: HsrpState;
  activeIp?: string;
  standbyIp?: string;
  activePriority: number;
  standbyPriority: number;
  lastActiveHello: number;
  lastStandbyHello: number;
  stateSince: number;
}

// ---------------------------------------------------------------- GRE

export interface TunnelCfg {
  /** Quell-Schnittstelle (ID) oder -Adresse. */
  source?: string;
  destination?: string;
  mode: 'gre';
}

// ---------------------------------------------------------------- Gesamt

export interface RoutingCfg {
  rip?: RipCfg;
  /** RIPng-Prozesse nach Name. */
  ripng?: Record<string, RipngCfg>;
  ospf: Record<number, OspfCfg>;
  /** OSPFv3 (IPv6). */
  ospf6: Record<number, OspfCfg>;
  eigrp: Record<number, EigrpCfg>;
  /** EIGRP für IPv6 (`ipv6 router eigrp`). */
  eigrp6?: Record<number, EigrpCfg>;
  bgp?: BgpCfg;
  /** Aktive `debug`-Schalter (z. B. `ospf.adj`). */
  debug: string[];
  prefixLists: Record<string, PrefixList>;
  prefixLists6: Record<string, PrefixList>;
  routeMaps: Record<string, RouteMap>;
  communityLists: Record<string, CommunityList>;
}

export const newRouting = (): RoutingCfg => ({
  ospf: {},
  ospf6: {},
  eigrp: {},
  debug: [],
  prefixLists: {},
  prefixLists6: {},
  routeMaps: {},
  communityLists: {},
});

/** `maximum-paths`: IGPs Default 4, BGP Default 1. */
export const maxPathsOf = (c: { maxPaths?: number }, def = 4): number => c.maxPaths ?? def;

export const isPassive = (
  c: { passive: string[]; unpassive: string[]; passiveDefault: boolean },
  id: string,
): boolean => (c.passiveDefault ? !c.unpassive.includes(id) : c.passive.includes(id));
