import type { Engine } from './engine';
import { ifaceName } from './ifaces';
import { listIfaces6 } from './l3v6';
import { linkLocalFromMac } from '@netsim/protocols';
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
  Device,
  PortRef,
  RouterConfig,
  StaticRoute,
  SwitchConfig,
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

/** Zusammenfassung der dynamischen Routing-Protokolle (nur lesend, für das Panel). */
export interface RoutingInfo {
  rip: boolean;
  ospf: {
    pid: number;
    v6: boolean;
    rid?: string;
    neighbors: { rid: string; ip: string; iface: string; state: string }[];
  }[];
  eigrp: { asn: number; neighbors: { ip: string; iface: string }[] }[];
  bgp?: {
    asn: number;
    neighbors: { ip: string; asn: number; state: string; prefixes: number }[];
  };
  hsrp: { iface: string; group: number; state: string; vip?: string; priority: number }[];
}

export interface HostV6View {
  enabled: boolean;
  linkLocal: string;
  addrs: { addr: string; plen: number }[];
  slaac: { addr: string; plen: number }[];
  gateway?: string;
  raGateway?: string;
  autoconfig: boolean;
  dhcp6: boolean;
  dhcpAddrs: { addr: string; plen: number }[];
  dns6: string[];
  domain6?: string;
  /** Adressen in der Duplicate Address Detection bzw. als Duplikat erkannt. */
  tentative: string[];
  duplicate: string[];
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
    /** IPv6-Adressen (global/ULA, inkl. SLAAC). */
    v6?: string[];
  }[];
  /** Router/L3-Switch: IPv6-Routing aktiv, IPv6-Routen. */
  ipv6Routing?: boolean;
  routes6?: RibEntry[];
  routingInfo?: RoutingInfo;
  hostV6?: HostV6View;
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

type L3Conf = RouterConfig | SwitchConfig;

function ifaceListOf(d: Device, cfg: L3Conf): NonNullable<DeviceView['ifaceList']> {
  const v6 = new Map(
    listIfaces6(d, cfg).map((i) => [i.id, i.addrs.map((a) => `${a.addr}/${a.plen}`)]),
  );
  return Object.entries(cfg.ifaces).map(([id, c]) => ({
    id,
    name: ifaceName(d, id, c),
    kind: c.kind,
    ip: c.ip,
    mask: c.mask,
    v6: v6.get(id),
  }));
}

function addRoutingView(engine: Engine, d: Device, cfg: L3Conf, v: DeviceView): void {
  v.ipv6Routing = cfg.ipv6Routing;
  v.routes6 = engine.routingTable6(d.id);
  const r = cfg.routing;
  const name = (id: string): string => ifaceName(d, id);
  const info: RoutingInfo = { rip: !!r.rip, ospf: [], eigrp: [], hsrp: [] };
  for (const [v6, map] of [
    [false, r.ospf],
    [true, r.ospf6],
  ] as const) {
    for (const c of Object.values(map)) {
      info.ospf.push({
        pid: c.pid,
        v6,
        rid: c.rid ?? c.routerId,
        neighbors: Object.entries(c.ifs).flatMap(([id, ifs]) =>
          Object.values(ifs.neighbors).map((n) => ({
            rid: n.rid,
            ip: n.ip,
            iface: name(id),
            state: n.state,
          })),
        ),
      });
    }
  }
  for (const c of Object.values(r.eigrp))
    info.eigrp.push({
      asn: c.asn,
      neighbors: Object.values(c.neighbors).map((n) => ({ ip: n.ip, iface: name(n.ifaceId) })),
    });
  if (r.bgp)
    info.bgp = {
      asn: r.bgp.asn,
      neighbors: Object.values(r.bgp.neighbors).map((n) => ({
        ip: n.ip,
        asn: n.asn,
        state: n.state,
        prefixes: n.prefixesRx,
      })),
    };
  for (const [id, ic] of Object.entries(cfg.ifaces))
    for (const g of Object.values(ic.hsrp ?? {}))
      info.hsrp.push({
        iface: name(id),
        group: g.group,
        state: g.state,
        vip: g.vip,
        priority: g.priority,
      });
  v.routingInfo = info;
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
      const port = d.ports[0];
      v.hostV6 = {
        enabled: d.config.v6.enabled,
        linkLocal: port ? linkLocalFromMac(port.mac) : '',
        addrs: d.config.v6.addrs.map((a) => ({ addr: a.addr, plen: a.plen })),
        slaac: d.config.v6.slaac.map((a) => ({ addr: a.addr, plen: a.plen })),
        gateway: d.config.v6.gateway,
        raGateway: d.config.v6.raGateway?.addr,
        autoconfig: d.config.v6.autoconfig,
        dhcp6: !!d.config.v6.dhcp6,
        dhcpAddrs: (d.config.v6.dhcpAddrs ?? []).map((a) => ({ addr: a.addr, plen: a.plen })),
        dns6: [...(d.config.v6.dns6 ?? [])],
        domain6: d.config.v6.domain6,
        tentative: Object.entries(d.config.dad ?? {})
          .filter(([, x]) => x.state === 'tentative')
          .map(([a]) => a),
        duplicate: Object.entries(d.config.dad ?? {})
          .filter(([, x]) => x.state === 'dup')
          .map(([a]) => a),
      };
    } else if (d.config.kind === 'router') {
      v.hostname = d.config.sys.hostname;
      v.ifaces = structuredClone(d.config.ifaces);
      v.ifaceList = ifaceListOf(d, d.config);
      v.staticRoutes = structuredClone(d.config.staticRoutes);
      v.routes = engine.routingTable(d.id);
      v.pings = d.config.pings.slice(-20);
      v.traces = d.config.traces.slice(-3);
      v.arpTable = engine.arpTable(d.id);
      addRoutingView(engine, d, d.config, v);
    } else if (d.config.kind === 'switch') {
      v.hostname = d.config.sys.hostname;
      v.macTable = engine.macTable(d.id);
      v.ifaces = structuredClone(d.config.ifaces);
      v.ifaceList = ifaceListOf(d, d.config);
      v.staticRoutes = structuredClone(d.config.staticRoutes);
      v.routes = d.type === 'switch-l3' ? engine.routingTable(d.id) : undefined;
      if (d.type === 'switch-l3') addRoutingView(engine, d, d.config, v);
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
