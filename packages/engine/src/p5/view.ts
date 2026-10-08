import type { Engine } from '../engine';
import { CATALOG } from '../catalog';
import type {
  ApClient,
  FwCfg,
  HostMailCfg,
  IotCfg,
  MgmtCfg,
  Radio,
  Wlan,
  WifiStatus,
  WlcAp,
  WifiProfile,
  Bss,
} from '../p5types';
import type { Device } from '../types';
import { clockOf, deviceTimeMs } from './clock';
import { apBss, WIFI_RANGE } from './wifi';

/** Phase-5-Teil der Geräteansicht (strukturell klonbar). */
export interface DeviceP5View {
  clockMs?: number;
  clockSynced?: boolean;
  clockServer?: string;
  stratum?: number;
  ntpServer?: string;
  firewallOn?: boolean;
  wifi?: {
    enabled: boolean;
    status: WifiStatus;
    profiles: WifiProfile[];
    bands: string[];
    assoc?: { ap: string; ssid: string; band: string; channel: number };
  };
  ap?: {
    radios: Radio[];
    wlc?: string;
    managed: boolean;
    clients: (ApClient & { port: string })[];
    bss: Bss[];
    range: Record<string, number>;
  };
  wlc?: { wlans: Wlan[]; aps: WlcAp[] };
  mail?: HostMailCfg;
  iot?: IotCfg & { current: number };
  mgmt?: Omit<MgmtCfg, 'users'> & { users: { name: string; privilege: number }[] };
  fw?: Omit<FwCfg, 'conns'> & { connCount: number; conns: FwCfg['conns'] };
  bridge?: { groups: Record<string, number>; fixed: boolean };
  slots?: { name: string; accepts: string[]; module?: string }[];
  location?: string;
  rackPos?: number;
}

export function buildP5View(engine: Engine, d: Device): DeviceP5View {
  const v: DeviceP5View = {};
  const now = engine.state.now;
  const c = d.config;
  const clock = clockOf(d);
  if (clock) {
    v.clockMs = deviceTimeMs(d, now);
    v.clockSynced = clock.syncedTo !== undefined;
    v.clockServer = clock.syncedTo;
    v.stratum = clock.stratum;
  }
  if (c.kind === 'host') {
    v.ntpServer = c.ntpServer;
    v.firewallOn = c.firewallOn;
    if (c.wifi) {
      const a = c.wifi.assoc;
      v.wifi = {
        enabled: c.wifi.enabled,
        status: c.wifi.status,
        profiles: structuredClone(c.wifi.profiles),
        bands: [...c.wifi.bands],
        assoc: a
          ? {
              ap: engine.state.devices[a.apId]?.name ?? a.apId,
              ssid: a.ssid,
              band: a.band,
              channel: a.channel,
            }
          : undefined,
      };
    }
    if (c.ap) {
      v.ap = {
        radios: structuredClone(c.ap.radios),
        wlc: c.ap.wlc,
        managed: c.ap.managed !== undefined,
        clients: Object.entries(c.ap.clients).map(([port, x]) => ({ port, ...x })),
        bss: apBss(c),
        range: { ...WIFI_RANGE },
      };
    }
    if (c.wlc) v.wlc = { wlans: structuredClone(c.wlc.wlans), aps: Object.values(c.wlc.aps) };
    if (c.mail) v.mail = structuredClone(c.mail);
    if (c.iot) {
      v.iot = { ...structuredClone(c.iot), current: c.iot.value };
    }
  }
  if (c.kind === 'router' || c.kind === 'switch') {
    const m = c.sys.mgmt;
    if (m) {
      const { users, ...rest } = structuredClone(m);
      v.mgmt = {
        ...rest,
        users: Object.entries(users).map(([name, u]) => ({ name, privilege: u.privilege })),
      };
    }
  }
  if (c.kind === 'router' && c.fw) {
    const { conns, ...rest } = structuredClone(c.fw);
    v.fw = { ...rest, connCount: conns.length, conns: conns.slice(-50) };
  }
  if (c.kind === 'bridge') v.bridge = { groups: { ...c.groups }, fixed: c.fixed };
  const spec = CATALOG[d.type];
  if (spec?.slots) {
    v.slots = spec.slots.map((s, i) => ({
      name: s.name,
      accepts: s.accepts,
      module: d.modules[i]?.module,
    }));
  }
  v.location = d.physical.location;
  v.rackPos = d.physical.rackPos;
  return v;
}
