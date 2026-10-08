import { newRouting } from './routing/types';
import type {
  DhcpServerCfg,
  HostConfig,
  IpCore,
  L3Cfg,
  NatCfg,
  Port,
  SwitchConfig,
  SwitchPortCfg,
  SysConfig,
} from './types';

export function newSys(hostname: string): SysConfig {
  return {
    hostname,
    servicePasswordEncryption: false,
    lineCon: { login: false },
    lineVty: { login: false },
    descriptions: {},
    setupDone: false,
  };
}

export function newIpCore(): IpCore {
  return {
    arpCache: {},
    arpPending: {},
    nd: {},
    ndPending: {},
    reasm: {},
    pingSessions: [],
    pings: [],
    nextPingId: 1,
    nextIpId: 1,
    traces: [],
    nextTraceId: 1,
  };
}

export const newNat = (): NatCfg => ({
  pools: {},
  rules: [],
  table: [],
  hits: 0,
  misses: 0,
  nextPort: 1024,
});

export const newDhcpServer = (): DhcpServerCfg => ({
  enabled: false,
  pools: [],
  excluded: [],
  bindings: {},
  conflicts: [],
});

export function newL3(ipRouting: boolean): L3Cfg {
  return {
    ...newIpCore(),
    ifaces: {},
    staticRoutes: [],
    acls: {},
    nat: newNat(),
    dhcp: newDhcpServer(),
    ipRouting,
    dynRoutes: [],
    routing: newRouting(),
    ipv6Routing: false,
    staticRoutes6: [],
    dynRoutes6: [],
    raIfs: [],
  };
}

export function newHost(): HostConfig {
  return {
    kind: 'host',
    ...newIpCore(),
    v6: { enabled: true, addrs: [], autoconfig: false, slaac: [], rsSent: 0 },
    dhcpClient: { enabled: false, state: 'off', xid: 0, boundAt: 0, leaseSec: 0 },
    dnsServers: [],
    dnsCache: {},
    dnsPending: {},
    dnsResults: {},
    nextDnsId: 1,
    nextPort: 49152,
    tcp: {},
    nextIsn: 1000,
    requests: [],
    nextReqId: 1,
    services: {
      http: {
        enabled: false,
        https: false,
        pages: { '/': '<h1>NetSim Web Server</h1><p>It works!</p>' },
      },
      dns: { enabled: false, records: [] },
      dhcp: newDhcpServer(),
    },
  };
}

export const newSwitchPort = (): SwitchPortCfg => ({
  mode: 'dynamic-auto',
  accessVlan: 1,
  nativeVlan: 1,
  allowed: 'all',
  routed: false,
  portfast: false,
  bpduguard: false,
  rootguard: false,
  psec: {
    enabled: false,
    max: 1,
    violation: 'shutdown',
    sticky: false,
    macs: [],
    dynMacs: [],
    violations: 0,
  },
});

export function newSwitch(name: string, ports: Port[]): SwitchConfig {
  const pc: Record<string, SwitchPortCfg> = {};
  for (const p of ports) pc[p.id] = newSwitchPort();
  return {
    kind: 'switch',
    sys: newSys(name),
    ...newL3(false),
    macTable: {},
    agingSec: 300,
    vlans: { 1: { name: 'default' } },
    vtp: { mode: 'server', domain: '', revision: 0 },
    ports: pc,
    stp: { mode: 'pvst', priority: {}, instances: {} },
    bundles: {},
    operTrunk: {},
    errdisableRecovery: { psecure: false, intervalSec: 300 },
  };
}
