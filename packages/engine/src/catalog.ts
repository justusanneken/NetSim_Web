import { newHost, newL3, newSwitch, newSys } from './defaults';
import { newAp, newBridge, newFw, newIot, newWifiClient, newWlc } from './p5defaults';
import type { WifiBand } from './p5types';
import type { DeviceState, DeviceType, HostConfig, Port, PortKind } from './types';

export { newSys };

export interface PortSpec {
  name: string;
  kind: PortKind;
}

export interface ModelSpec {
  model: string;
  type: DeviceType;
  /** Präfix für automatische Namen (PC0, Switch1 …). */
  namePrefix: string;
  ports: PortSpec[];
  /** Auto-MDIX aktiv → Straight und Crossover funktionieren. */
  autoMdix: boolean;
  /** Medium-abhängige Schnittstelle: Hosts/Router = MDI, Switch/Hub = MDI-X. */
  mdi: 'mdi' | 'mdix';
  /** Router-Schnittstellen sind (wie bei IOS) standardmäßig administrativ down. */
  portsDefaultDown?: boolean;
  /** Modul-Steckplätze (Phase 5): akzeptierte Modulnamen aus `MODULES`. */
  slots?: { name: string; accepts: string[] }[];
  makeConfig: (name: string, ports: Port[]) => DeviceState;
}

const HOST_SLOTS = [{ name: 'PCI0', accepts: ['NIC-FE', 'NIC-GE', 'NIC-WIFI'] }];

/** Host mit WLAN-Client (`wifi`). */
function wifiHost(bands: WifiBand[]): HostConfig {
  const h = newHost();
  h.wifi = newWifiClient(bands);
  return h;
}

/** Anzahl der Funk-Steckplätze (gleichzeitige Clients) eines Access Points. */
export const AP_SLOTS = 8;

const range = (n: number, make: (i: number) => PortSpec): PortSpec[] =>
  Array.from({ length: n }, (_, i) => make(i));

export const CATALOG: Partial<Record<DeviceType, ModelSpec>> = {
  pc: {
    model: 'PC-PT',
    type: 'pc',
    namePrefix: 'PC',
    ports: [{ name: 'FastEthernet0', kind: 'fe' }],
    autoMdix: false,
    mdi: 'mdi',
    slots: HOST_SLOTS,
    makeConfig: () => newHost(),
  },
  'switch-l2': {
    model: 'SW2960-24',
    type: 'switch-l2',
    namePrefix: 'Switch',
    ports: [
      ...range(24, (i) => ({ name: `FastEthernet0/${i + 1}`, kind: 'fe' as const })),
      ...range(2, (i) => ({ name: `GigabitEthernet0/${i + 1}`, kind: 'ge' as const })),
    ],
    autoMdix: true,
    mdi: 'mdix',
    makeConfig: (name, ports) => newSwitch(name, ports),
  },
  laptop: {
    model: 'Laptop-PT',
    type: 'laptop',
    namePrefix: 'Laptop',
    ports: [
      { name: 'FastEthernet0', kind: 'fe' },
      { name: 'Wlan0', kind: 'wifi' },
    ],
    autoMdix: false,
    mdi: 'mdi',
    slots: HOST_SLOTS,
    makeConfig: () => wifiHost(['2.4', '5']),
  },
  server: {
    model: 'Server-PT',
    type: 'server',
    namePrefix: 'Server',
    ports: [{ name: 'FastEthernet0', kind: 'fe' }],
    autoMdix: false,
    mdi: 'mdi',
    slots: HOST_SLOTS,
    makeConfig: () => newHost(),
  },
  router: {
    model: 'R1941',
    type: 'router',
    namePrefix: 'Router',
    ports: [0, 1, 2].map((i) => ({ name: `GigabitEthernet0/${i}`, kind: 'ge' as const })),
    autoMdix: true,
    mdi: 'mdi',
    portsDefaultDown: true,
    slots: [
      { name: 'HWIC0', accepts: ['HWIC-2T', 'HWIC-1GE'] },
      { name: 'HWIC1', accepts: ['HWIC-2T', 'HWIC-1GE'] },
    ],
    makeConfig: (name) => ({ kind: 'router', sys: newSys(name), ...newL3(true) }),
  },
  'switch-l3': {
    model: 'SW3560-24',
    type: 'switch-l3',
    namePrefix: 'MLS',
    ports: [
      ...range(24, (i) => ({ name: `FastEthernet0/${i + 1}`, kind: 'fe' as const })),
      ...range(2, (i) => ({ name: `GigabitEthernet0/${i + 1}`, kind: 'ge' as const })),
    ],
    autoMdix: true,
    mdi: 'mdix',
    makeConfig: (name, ports) => newSwitch(name, ports),
  },
  hub: {
    model: 'Hub-PT',
    type: 'hub',
    namePrefix: 'Hub',
    ports: range(8, (i) => ({ name: `Port${i + 1}`, kind: 'fe' as const })),
    autoMdix: false,
    mdi: 'mdix',
    makeConfig: () => ({ kind: 'hub', busyUntil: 0 }),
  },
  tablet: {
    model: 'Tablet-PT',
    type: 'tablet',
    namePrefix: 'Tablet',
    ports: [{ name: 'Wlan0', kind: 'wifi' }],
    autoMdix: false,
    mdi: 'mdi',
    makeConfig: () => wifiHost(['2.4', '5']),
  },
  smartphone: {
    model: 'Smartphone-PT',
    type: 'smartphone',
    namePrefix: 'Phone',
    ports: [{ name: 'Wlan0', kind: 'wifi' }],
    autoMdix: false,
    mdi: 'mdi',
    makeConfig: () => wifiHost(['2.4', '5']),
  },
  printer: {
    model: 'Printer-PT',
    type: 'printer',
    namePrefix: 'Printer',
    ports: [
      { name: 'FastEthernet0', kind: 'fe' },
      { name: 'Wlan0', kind: 'wifi' },
    ],
    autoMdix: false,
    mdi: 'mdi',
    makeConfig: () => wifiHost(['2.4']),
  },
  ap: {
    model: 'AP-PT',
    type: 'ap',
    namePrefix: 'AP',
    ports: [
      { name: 'GigabitEthernet0', kind: 'ge' },
      ...range(AP_SLOTS, (i) => ({ name: `Wlan${i}`, kind: 'wifi' as const })),
    ],
    autoMdix: true,
    mdi: 'mdix',
    makeConfig: () => {
      const h = newHost();
      h.ap = newAp();
      return h;
    },
  },
  wlc: {
    model: 'WLC-PT',
    type: 'wlc',
    namePrefix: 'WLC',
    ports: range(2, (i) => ({ name: `GigabitEthernet${i}`, kind: 'ge' as const })),
    autoMdix: true,
    mdi: 'mdi',
    makeConfig: () => {
      const h = newHost();
      h.wlc = newWlc();
      return h;
    },
  },
  firewall: {
    model: 'FW-5506',
    type: 'firewall',
    namePrefix: 'FW',
    ports: range(4, (i) => ({ name: `GigabitEthernet0/${i}`, kind: 'ge' as const })),
    autoMdix: true,
    mdi: 'mdi',
    portsDefaultDown: true,
    makeConfig: (name) => ({ kind: 'router', sys: newSys(name), ...newL3(true), fw: newFw() }),
  },
  cloud: {
    model: 'Cloud-PT',
    type: 'cloud',
    namePrefix: 'Cloud',
    ports: [
      { name: 'Ethernet0', kind: 'fe' },
      { name: 'Ethernet1', kind: 'fe' },
      { name: 'Dsl0', kind: 'dsl' },
      { name: 'Dsl1', kind: 'dsl' },
      { name: 'Coax0', kind: 'coax' },
      { name: 'Coax1', kind: 'coax' },
    ],
    autoMdix: true,
    mdi: 'mdix',
    makeConfig: () => newBridge({ p0: 1, p1: 1, p2: 1, p3: 1, p4: 1, p5: 1 }, false),
  },
  'dsl-modem': {
    model: 'DSL-Modem-PT',
    type: 'dsl-modem',
    namePrefix: 'DSLModem',
    ports: [
      { name: 'Dsl0', kind: 'dsl' },
      { name: 'Ethernet0', kind: 'fe' },
    ],
    autoMdix: true,
    mdi: 'mdi',
    makeConfig: () => newBridge({ p0: 1, p1: 1 }, true),
  },
  'cable-modem': {
    model: 'Cable-Modem-PT',
    type: 'cable-modem',
    namePrefix: 'CableModem',
    ports: [
      { name: 'Coax0', kind: 'coax' },
      { name: 'Ethernet0', kind: 'fe' },
    ],
    autoMdix: true,
    mdi: 'mdi',
    makeConfig: () => newBridge({ p0: 1, p1: 1 }, true),
  },
  'iot-sensor': iotSpec('iot-sensor', 'Sensor', 'IoT-Sensor-PT', 'sensor'),
  'iot-actuator': iotSpec('iot-actuator', 'Actuator', 'IoT-Actuator-PT', 'actuator'),
  sbc: iotSpec('sbc', 'SBC', 'SBC-PT', 'sbc'),
};

function iotSpec(
  type: 'iot-sensor' | 'iot-actuator' | 'sbc',
  namePrefix: string,
  model: string,
  role: 'sensor' | 'actuator' | 'sbc',
): ModelSpec {
  return {
    model,
    type,
    namePrefix,
    ports: [
      { name: 'FastEthernet0', kind: 'fe' },
      { name: 'Wlan0', kind: 'wifi' },
    ],
    autoMdix: false,
    mdi: 'mdi',
    makeConfig: () => {
      const h = wifiHost(['2.4']);
      h.iot = newIot(role);
      return h;
    },
  };
}

/** Steckbare Module (Physical-Tab). */
export interface ModuleSpec {
  name: string;
  ports: PortSpec[];
}
export const MODULES: Record<string, ModuleSpec> = {
  'NIC-FE': { name: 'NIC-FE', ports: [{ name: 'FastEthernet1', kind: 'fe' }] },
  'NIC-GE': { name: 'NIC-GE', ports: [{ name: 'GigabitEthernet1', kind: 'ge' }] },
  'NIC-WIFI': { name: 'NIC-WIFI', ports: [{ name: 'Wlan1', kind: 'wifi' }] },
  'HWIC-2T': {
    name: 'HWIC-2T',
    ports: [
      { name: 'Serial', kind: 'serial' },
      { name: 'Serial', kind: 'serial' },
    ],
  },
  'HWIC-1GE': { name: 'HWIC-1GE', ports: [{ name: 'GigabitEthernet', kind: 'ge' }] },
};

/** Geräte, die in Phase 1 angelegt werden können. */
export const SUPPORTED_TYPES: DeviceType[] = Object.keys(CATALOG) as DeviceType[];

/** Maximale Geschwindigkeit einer Portart in Mbit/s. */
export const PORT_MAX_SPEED: Record<PortKind, number> = {
  fe: 100,
  ge: 1000,
  tengig: 10000,
  serial: 2,
  console: 0,
  aux: 0,
  usb: 0,
  wifi: 54,
  'fiber-sfp': 1000,
  dsl: 24,
  coax: 100,
};
