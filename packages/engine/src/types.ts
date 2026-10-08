import type { Frame, Ipv4Addr, Ipv4Pdu, Mac, ProtoTag } from '@netsim/protocols';

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
}

export interface PingSession {
  id: number;
  dst: Ipv4Addr;
  count: number;
  sent: number;
  intervalUs: number;
  dataSize: number;
}

export interface ArpEntry {
  mac: Mac;
  expiresAt: number;
}

export interface ArpPending {
  attempts: number;
  queue: Ipv4Pdu[];
}

export interface HostConfig {
  kind: 'host';
  ip?: Ipv4Addr;
  mask?: string;
  gateway?: Ipv4Addr;
  arpCache: Record<Ipv4Addr, ArpEntry>;
  arpPending: Record<Ipv4Addr, ArpPending>;
  pingSessions: PingSession[];
  pings: PingResult[];
  nextPingId: number;
  nextIpId: number;
}

export interface MacEntry {
  portId: string;
  updatedAt: number;
}

export interface SwitchConfig {
  kind: 'switch';
  hostname: string;
  macTable: Record<Mac, MacEntry>;
  /** Aging in Sekunden (Default 300). */
  agingSec: number;
}

export interface HubConfig {
  kind: 'hub';
  /** Ende der laufenden Wiederholung (µs). */
  busyUntil: number;
}

export interface UnsupportedConfig {
  kind: 'none';
}

export type DeviceState = HostConfig | SwitchConfig | HubConfig | UnsupportedConfig;

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

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
