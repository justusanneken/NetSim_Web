import type {
  ApCfg,
  AppCore,
  BridgeCfg,
  ClockCfg,
  FwCfg,
  IotCfg,
  MgmtCfg,
  Radio,
  WifiBand,
  WifiClientCfg,
  WlcCfg,
} from './p5types';
import type { SysConfig } from './types';

/** 1.3.1993 00:00:00 UTC – IOS-Geräte starten ohne NTP mit dieser Zeit. */
export const IOS_EPOCH_MS = Date.UTC(1993, 2, 1, 0, 0, 0);
/** 1.1.2026 12:00:00 UTC – Standarduhr der Hosts (Server-Zeit für NTP). */
export const HOST_EPOCH_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

export const newClock = (baseMs: number): ClockCfg => ({ baseMs, stratum: 16 });

export const newAppCore = (): AppCore => ({
  conns: {},
  nextConn: 1,
  nextPort: 50000,
  reqs: {},
  nextReq: 1,
  aaaWait: {},
});

export const newMgmt = (): MgmtCfg => ({
  users: {},
  ssh: { version: 2 },
  vty: { lines: 5, transport: ['ssh', 'telnet'], loginLocal: false },
  ntp: { servers: [] },
  clock: newClock(IOS_EPOCH_MS),
  syslog: { hosts: [], trap: 6, buffered: true },
  snmp: { communities: [] },
  aaa: { newModel: false, radius: [], methods: [], listName: 'default' },
  sessions: [],
  logBuffer: [],
});

/** Management-Konfiguration eines CLI-Geräts (lazy angelegt). */
export function mgmtOf(sys: SysConfig): MgmtCfg {
  sys.mgmt ??= newMgmt();
  return sys.mgmt;
}

export const newFw = (): FwCfg => ({
  ifaces: {},
  accessGroups: {},
  objects: {},
  conns: [],
  sameSecurity: false,
  built: 0,
  denied: 0,
});

const CHANNEL_DEFAULT: Record<WifiBand, number> = { '2.4': 6, '5': 36 };
export const CHANNELS: Record<WifiBand, number[]> = {
  '2.4': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  '5': [36, 40, 44, 48, 52, 56, 60, 64, 100, 149, 153, 157, 161],
};

export const newRadio = (band: WifiBand): Radio => ({
  band,
  channel: CHANNEL_DEFAULT[band],
  enabled: true,
  ssid: '',
  security: 'open',
});

export const newAp = (): ApCfg => ({
  radios: [newRadio('2.4'), newRadio('5')],
  macTable: {},
  clients: {},
});

export const newWlc = (): WlcCfg => ({ wlans: [], aps: {} });

export const newWifiClient = (bands: WifiBand[]): WifiClientCfg => ({
  enabled: true,
  profiles: [],
  bands,
  status: 'idle',
});

export const newIot = (role: IotCfg['role']): IotCfg => ({
  role,
  sensor: role === 'actuator' ? '' : 'temperature',
  unit: role === 'actuator' ? '' : '°C',
  value: 20,
  pattern: 'manual',
  min: 10,
  max: 30,
  periodSec: 60,
  state: 'off',
  registered: false,
  reportSec: 10,
});

export const newBridge = (groups: Record<string, number>, fixed: boolean): BridgeCfg => ({
  kind: 'bridge',
  groups,
  macTable: {},
  fixed,
});
