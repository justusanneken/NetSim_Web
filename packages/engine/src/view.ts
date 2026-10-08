import type { Engine } from './engine';
import type { CableType, Counters, DeviceType, PingResult, PortKind, PortRef } from './types';

export interface PortView {
  id: string;
  name: string;
  kind: PortKind;
  mac: string;
  adminUp: boolean;
  operUp: boolean;
  linkId?: string;
  speed: 'auto' | 10 | 100 | 1000 | 10000;
  duplex: 'auto' | 'half' | 'full';
  operSpeed: number;
  operDuplex: 'half' | 'full';
  counters: Counters;
}

export interface DeviceView {
  id: string;
  type: DeviceType;
  model: string;
  name: string;
  pos: { x: number; y: number };
  powered: boolean;
  crashed?: string;
  ports: PortView[];
  ip?: string;
  mask?: string;
  gateway?: string;
  pings?: PingResult[];
  macTable?: { mac: string; portId: string; ageSec: number }[];
  arpTable?: { ip: string; mac: string }[];
}

export interface LinkView {
  id: string;
  cable: CableType;
  a: PortRef;
  b: PortRef;
  operUp: boolean;
  cableOk: boolean;
  problem?: string;
  lastActivityT: number;
  lengthM?: number;
}

export type SimMode = 'realtime' | 'simulation' | 'paused';

export interface ViewModel {
  now: number;
  mode: SimMode;
  speed: number;
  autoCapture: boolean;
  devices: DeviceView[];
  links: LinkView[];
  logLength: number;
  logEpoch: number;
  queueLength: number;
  canStepBack: boolean;
  domains: { hubs: string[]; endpoints: PortRef[] }[];
}

export function buildDevices(engine: Engine): DeviceView[] {
  return Object.values(engine.state.devices).map((d) => {
    const v: DeviceView = {
      id: d.id,
      type: d.type,
      model: d.model,
      name: d.name,
      pos: { ...d.pos },
      powered: d.powered,
      crashed: d.crashed?.message,
      ports: d.ports.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        mac: p.mac,
        adminUp: p.adminUp,
        operUp: p.operUp,
        linkId: p.linkId,
        speed: p.speed,
        duplex: p.duplex,
        operSpeed: p.operSpeed,
        operDuplex: p.operDuplex,
        counters: { ...p.counters },
      })),
    };
    if (d.config.kind === 'host') {
      v.ip = d.config.ip;
      v.mask = d.config.mask;
      v.gateway = d.config.gateway;
      v.pings = d.config.pings.slice(-20);
      v.arpTable = engine.arpTable(d.id);
    } else if (d.config.kind === 'switch') {
      v.macTable = engine.macTable(d.id);
    }
    return v;
  });
}

export function buildLinks(engine: Engine): LinkView[] {
  return Object.values(engine.state.links).map((l) => ({
    id: l.id,
    cable: l.cable,
    a: l.a,
    b: l.b,
    operUp: l.operUp,
    cableOk: l.cableOk,
    problem: l.cableProblem,
    lastActivityT: l.lastActivityT,
    lengthM: l.lengthM,
  }));
}
