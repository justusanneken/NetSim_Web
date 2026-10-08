import { newHost, newL3, newSwitch, newSys } from './defaults';
import type { DeviceState, DeviceType, Port, PortKind } from './types';

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
  makeConfig: (name: string, ports: Port[]) => DeviceState;
}

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
    ports: [{ name: 'FastEthernet0', kind: 'fe' }],
    autoMdix: false,
    mdi: 'mdi',
    makeConfig: () => newHost(),
  },
  server: {
    model: 'Server-PT',
    type: 'server',
    namePrefix: 'Server',
    ports: [{ name: 'FastEthernet0', kind: 'fe' }],
    autoMdix: false,
    mdi: 'mdi',
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
};
