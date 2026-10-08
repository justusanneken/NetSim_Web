import type { Engine } from './engine';
import { ifaceName } from './ifaces';
import type { RibEntry } from './rib';
import type {
  CableType,
  DhcpClient,
  HostServices,
  HttpRequest,
  SwitchPortCfg,
  VtpCfg,
  Counters,
  DeviceType,
  PingResult,
  PortKind,
  PortRef,
  StaticRoute,
  TraceSession,
} from './types';

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
  mtu: number;
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
  traces?: TraceSession[];
  hostname?: string;
  /** Router: konfigurierte Schnittstellenadressen. */
  ifaces?: Record<string, { ip?: string; mask?: string }>;
  staticRoutes?: StaticRoute[];
  routes?: RibEntry[];
  macTable?: { mac: string; portId: string; ageSec: number }[];
  arpTable?: { ip: string; mac: string }[];
  /** Router/L3-Switch: alle Schnittstellen inkl. Subinterfaces und SVIs. */
  ifaceList?: {
    id: string;
    name: string;
    kind: 'phys' | 'sub' | 'svi' | 'loop' | 'tunnel';
    ip?: string;
    mask?: string;
  }[];
  /** Hosts: DHCP-Client, DNS, Dienste, HTTP-Abrufe. */
  dhcp?: DhcpClient['state'];
  dnsServers?: string[];
  services?: HostServices;
  requests?: HttpRequest[];
  /** Switches: VLANs, VTP, Switchport-Konfiguration und STP-Zustand je Port (VLAN 1 bzw. erstes VLAN). */
  vlans?: { id: number; name: string }[];
  vtp?: VtpCfg;
  stpMode?: 'pvst' | 'rapid-pvst';
  switchports?: Record<
    string,
    SwitchPortCfg & {
      operTrunk: boolean;
      errdisabled?: string;
      stp?: { role: string; state: string };
    }
  >;
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
  /** Mindestens ein Ende wird von Spanning Tree blockiert (Link-Licht orange). */
  stpBlocked?: boolean;
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
        mtu: p.mtu,
        counters: { ...p.counters },
      })),
    };
    if (d.config.kind === 'host') {
      v.ip = d.config.ip;
      v.mask = d.config.mask;
      v.gateway = d.config.gateway;
      v.pings = d.config.pings.slice(-20);
      v.arpTable = engine.arpTable(d.id);
      v.traces = d.config.traces.slice(-3);
      v.dhcp = d.config.dhcpClient.state;
      v.dnsServers = [...d.config.dnsServers];
      v.services = structuredClone(d.config.services);
      v.requests = d.config.requests.slice(-5);
    } else if (d.config.kind === 'router') {
      v.hostname = d.config.sys.hostname;
      v.ifaces = structuredClone(d.config.ifaces);
      v.ifaceList = Object.entries(d.config.ifaces).map(([id, c]) => ({
        id,
        name: ifaceName(d, id, c),
        kind: c.kind,
        ip: c.ip,
        mask: c.mask,
      }));
      v.staticRoutes = structuredClone(d.config.staticRoutes);
      v.routes = engine.routingTable(d.id);
      v.pings = d.config.pings.slice(-20);
      v.traces = d.config.traces.slice(-3);
      v.arpTable = engine.arpTable(d.id);
    } else if (d.config.kind === 'switch') {
      v.hostname = d.config.sys.hostname;
      v.macTable = engine.macTable(d.id);
      v.ifaces = structuredClone(d.config.ifaces);
      v.ifaceList = Object.entries(d.config.ifaces).map(([id, c]) => ({
        id,
        name: ifaceName(d, id, c),
        kind: c.kind,
        ip: c.ip,
        mask: c.mask,
      }));
      v.staticRoutes = structuredClone(d.config.staticRoutes);
      v.routes = d.type === 'switch-l3' ? engine.routingTable(d.id) : undefined;
      v.vlans = Object.entries(d.config.vlans).map(([id, x]) => ({ id: Number(id), name: x.name }));
      v.vtp = { ...d.config.vtp };
      v.stpMode = d.config.stp.mode;
      const inst = d.config.stp.instances[1] ?? Object.values(d.config.stp.instances)[0];
      v.switchports = {};
      for (const p of d.ports) {
        const pc = d.config.ports[p.id];
        if (!pc) continue;
        const st = inst?.ports[p.id];
        v.switchports[p.id] = {
          ...structuredClone(pc),
          operTrunk: d.config.operTrunk[p.id] === true,
          errdisabled: p.errdisabled,
          stp: st ? { role: st.role, state: st.state } : undefined,
        };
      }
    }
    return v;
  });
}

function stpBlocks(engine: Engine, ref: PortRef): boolean {
  const d = engine.state.devices[ref.deviceId];
  if (d?.config.kind !== 'switch') return false;
  return Object.values(d.config.stp.instances).some((i) => {
    const s = i.ports[ref.portId];
    return s !== undefined && s.role !== 'disabled' && s.state !== 'forwarding';
  });
}

export function buildLinks(engine: Engine): LinkView[] {
  return Object.values(engine.state.links).map((l) => ({
    stpBlocked: l.operUp && (stpBlocks(engine, l.a) || stpBlocks(engine, l.b)),
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
