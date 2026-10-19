import { isValidIpv4, isValidIpv6, normalizeIpv6, maskToPrefix } from '@netsim/protocols';
import {
  newBgp,
  newBgpNbr,
  newEigrp,
  newHsrp,
  newOspf,
  newRip,
  type BgpCfg,
  type EigrpCfg,
  type IfaceCfg,
  type OspfCfg,
  type RedistCfg,
  type RedistSource,
  type RipCfg,
  type RouterConfig,
  type SwitchConfig,
} from '@netsim/engine';
import { runPing, targets } from './commands';
import { IFM, ifDisplay, resolveIface } from './ifnames';
import { K, P, R, choice, opt, type ModeId, type Registry } from './parser';
import { CliError, type CliSession } from './session';
import * as show4 from './show4';
import { showOspfInterfacesV4 } from './showOspfIf';

const CF: ModeId[] = ['config'];
const IF = IFM;
const U: ModeId[] = ['user', 'priv'];
const SHOW = K('show', 'Show running system information');
const IP = K('ip', 'IP information');
const IPV6 = K('ipv6', 'IPv6 information');

type L3Conf = RouterConfig | SwitchConfig;
const l3 = (s: CliSession): L3Conf => s.device.config;

/** Nach jeder Konfigurationsänderung die Routing-Prozesse nachziehen. */
const touch = (s: CliSession): void => s.engine.routingChanged(s.deviceId);

const ripCfg = (s: CliSession): RipCfg => {
  const c = l3(s).routing.rip;
  if (!c) throw new CliError('% RIP is not running');
  return c;
};
const ospfCfg = (s: CliSession, v6: boolean): OspfCfg => {
  const c = (v6 ? l3(s).routing.ospf6 : l3(s).routing.ospf)[s.procId];
  if (!c) throw new CliError('% OSPF process is not running');
  return c;
};
const eigrpCfg = (s: CliSession): EigrpCfg => {
  const c = l3(s).routing.eigrp[s.procId];
  if (!c) throw new CliError('% EIGRP process is not running');
  return c;
};
const bgpCfg = (s: CliSession): BgpCfg => {
  const c = l3(s).routing.bgp;
  if (!c) throw new CliError('% BGP is not running');
  return c;
};

const err = (r: { error: string; params?: Record<string, string | number> }): CliError => {
  const p = r.params ?? {};
  switch (r.error) {
    case 'ip6.invalidAddress':
      return new CliError('% Invalid IPv6 address');
    case 'ip6.invalidPrefix':
      return new CliError('% Invalid IPv6 prefix length');
    case 'ip6.overlap':
      return new CliError(`% ${p.net} overlaps with ${p.port}`);
    case 'ip6.linkLocalNeedsIface':
      return new CliError('% Interface has to be specified for a link-local nexthop');
    default:
      return new CliError('% Invalid input');
  }
};

const RMAP = [
  opt(K('route-map', 'Route map reference')),
  opt(P('rm', 'word', 'WORD', 'Pointer to route-map entries')),
];

/** Gemeinsame Slots für `redistribute …`. */
const REDIST_SRC = (extra: RedistSource[]): ReturnType<typeof choice> => {
  const all: [RedistSource, string][] = [
    ['connected', 'Connected'],
    ['static', 'Static routes'],
    ['rip', 'Routing Information Protocol (RIP)'],
    ['ospf', 'Open Shortest Path First (OSPF)'],
    ['eigrp', 'Enhanced Interior Gateway Routing Protocol (EIGRP)'],
    ['bgp', 'Border Gateway Protocol (BGP)'],
  ];
  return choice('src', ...all.filter(([k]) => extra.includes(k)));
};

function applyRedist(
  s: CliSession,
  list: RedistCfg[],
  self: { proto: 'rip' | 'ospf' | 'eigrp' | 'bgp'; id?: number },
  a: Record<string, string>,
): void {
  const src = a.src as RedistSource;
  const id = a.id !== undefined ? Number(a.id) : undefined;
  if (src === self.proto && (self.proto === 'rip' || id === self.id))
    throw new CliError('% Cannot redistribute a protocol into itself');
  const idx = list.findIndex((x) => x.source === src && x.id === id);
  if (s.negated) {
    if (idx >= 0) list.splice(idx, 1);
    return;
  }
  const entry: RedistCfg = {
    source: src,
    id,
    metric: a.metric !== undefined ? Number(a.metric) : undefined,
    metricType: a.mtype === '1' ? 1 : a.mtype === '2' ? 2 : undefined,
    subnets: a.subnets === 'subnets',
    tag: a.tag !== undefined ? Number(a.tag) : undefined,
    bw: a.bw !== undefined ? Number(a.bw) : undefined,
    delay: a.dly !== undefined ? Number(a.dly) : undefined,
    routeMap: a.rm,
  };
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);
}

export function addPhase4(r: Registry<CliSession>): void {
  // ------------------------------------------------------------ Router-Modi betreten
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      K('router', 'Enable a routing process'),
      K('rip', 'Routing Information Protocol (RIP)'),
    ],
    run: (s) => {
      const c = l3(s);
      if (s.negated) {
        delete c.routing.rip;
        touch(s);
        return;
      }
      c.routing.rip ??= newRip();
      s.mode = 'config-rip';
      touch(s);
    },
  });
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      K('router', 'Enable a routing process'),
      K('ospf', 'Open Shortest Path First (OSPF)'),
      P('pid', 'int', '<1-65535>', 'Process ID', [1, 65535]),
    ],
    run: (s, a) => {
      const c = l3(s);
      const pid = Number(a.pid);
      if (s.negated) {
        delete c.routing.ospf[pid];
        touch(s);
        return;
      }
      c.routing.ospf[pid] ??= newOspf(pid);
      s.procId = pid;
      s.mode = 'config-ospf';
      touch(s);
    },
  });
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      IPV6,
      K('router', 'Enable an IPV6 routing process'),
      K('ospf', 'Open Shortest Path First (OSPF)'),
      P('pid', 'int', '<1-65535>', 'Process ID', [1, 65535]),
    ],
    run: (s, a) => {
      const c = l3(s);
      const pid = Number(a.pid);
      if (s.negated) {
        delete c.routing.ospf6[pid];
        touch(s);
        return;
      }
      c.routing.ospf6[pid] ??= newOspf(pid, true);
      s.procId = pid;
      s.mode = 'config-ospf6';
      touch(s);
    },
  });
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      K('router', 'Enable a routing process'),
      K('eigrp', 'Enhanced Interior Gateway Routing Protocol (EIGRP)'),
      P('asn', 'int', '<1-65535>', 'Autonomous system number', [1, 65535]),
    ],
    run: (s, a) => {
      const c = l3(s);
      const asn = Number(a.asn);
      if (s.negated) {
        delete c.routing.eigrp[asn];
        touch(s);
        return;
      }
      c.routing.eigrp[asn] ??= newEigrp(asn);
      s.procId = asn;
      s.mode = 'config-eigrp';
      touch(s);
    },
  });
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      K('router', 'Enable a routing process'),
      K('bgp', 'Border Gateway Protocol (BGP)'),
      P('asn', 'int', '<1-65535>', 'Autonomous system number', [1, 65535]),
    ],
    run: (s, a) => {
      const c = l3(s);
      const asn = Number(a.asn);
      if (s.negated) {
        delete c.routing.bgp;
        touch(s);
        return;
      }
      if (c.routing.bgp && c.routing.bgp.asn !== asn)
        throw new CliError(`BGP is already running; AS is ${c.routing.bgp.asn}`);
      c.routing.bgp ??= newBgp(asn);
      s.procId = asn;
      s.mode = 'config-bgp';
      touch(s);
    },
  });

  // ------------------------------------------------------------ RIP
  const RIP: ModeId[] = ['config-rip'];
  r.add({
    modes: RIP,
    only: 'l3',
    slots: [
      K('version', 'Set routing protocol version'),
      P('v', 'int', '<1-2>', 'version', [1, 2]),
    ],
    run: (s, a) => {
      if (a.v === '1') throw new CliError('% RIPv1 is not supported (RIPv2 only)');
      ripCfg(s);
    },
  });
  r.add({
    modes: RIP,
    only: 'l3',
    negatable: true,
    slots: [
      K('network', 'Enable routing on an IP network'),
      P('net', 'ip', 'A.B.C.D', 'Network number'),
    ],
    run: (s, a) => {
      const c = ripCfg(s);
      const n = a.net as string;
      c.networks = c.networks.filter((x) => x !== n);
      if (!s.negated) c.networks.push(n);
      touch(s);
    },
  });
  const passive = (
    s: CliSession,
    a: Record<string, string>,
    c: { passive: string[]; unpassive: string[]; passiveDefault: boolean },
  ): void => {
    if (a.kw === 'default' || a['kw:1'] === 'default') {
      c.passiveDefault = !s.negated;
      if (!s.negated) c.passive = [];
      else c.unpassive = [];
      return;
    }
    const ref = resolveIface(s.device, a.if as string);
    if (!ref) throw new CliError('% Invalid interface');
    const list = (c.passiveDefault ? c.unpassive : c.passive).filter((x) => x !== ref.id);
    // `no passive-interface X` bei passive-interface default → X aktiv; sonst → X passiv
    if (c.passiveDefault) c.unpassive = s.negated ? [...list, ref.id] : list;
    else c.passive = s.negated ? list : [...list, ref.id];
  };
  const PASSIVE = (mode: ModeId[]) => {
    r.add({
      modes: mode,
      only: 'l3',
      negatable: true,
      slots: [
        K('passive-interface', 'Suppress routing updates on an interface'),
        choice('kw', ['default', 'Suppress routing updates on all interfaces']),
      ],
      run: (s) => {
        const c =
          s.mode === 'config-rip'
            ? ripCfg(s)
            : s.mode === 'config-eigrp'
              ? eigrpCfg(s)
              : ospfCfg(s, s.mode === 'config-ospf6');
        passive(s, { kw: 'default' }, c);
        touch(s);
      },
    });
    r.add({
      modes: mode,
      only: 'l3',
      negatable: true,
      slots: [
        K('passive-interface', 'Suppress routing updates on an interface'),
        P('if', 'iface', 'IFNAME', 'Interface name'),
      ],
      run: (s, a) => {
        const c =
          s.mode === 'config-rip'
            ? ripCfg(s)
            : s.mode === 'config-eigrp'
              ? eigrpCfg(s)
              : ospfCfg(s, s.mode === 'config-ospf6');
        passive(s, a, c);
        touch(s);
      },
    });
  };
  PASSIVE(['config-rip', 'config-ospf', 'config-ospf6', 'config-eigrp']);
  r.add({
    modes: [...RIP, 'config-eigrp'],
    only: 'l3',
    negatable: true,
    slots: [K('auto-summary', 'Enable automatic network number summarization')],
    run: (s) => {
      const c = s.mode === 'config-rip' ? ripCfg(s) : eigrpCfg(s);
      c.autoSummary = !s.negated;
      touch(s);
    },
  });
  r.add({
    modes: RIP,
    only: 'l3',
    negatable: true,
    slots: [
      K('default-information', 'Control distribution of default information'),
      K('originate', 'Distribute a default route'),
    ],
    run: (s) => {
      ripCfg(s).defaultOriginate = !s.negated;
      touch(s);
    },
  });
  r.add({
    modes: RIP,
    only: 'l3',
    negatable: true,
    slots: [
      K('default-metric', 'Set metric of redistributed routes'),
      P('m', 'int', '<1-15>', 'Default metric', [1, 15]),
    ],
    run: (s, a) => {
      ripCfg(s).defaultMetric = s.negated ? undefined : Number(a.m);
      touch(s);
    },
  });
  r.add({
    modes: RIP,
    only: 'l3',
    negatable: true,
    slots: [
      K('timers', 'Adjust routing timers'),
      K('basic', 'Basic routing protocol update timers'),
      P('update', 'int', '<1-4294967295>', 'Interval between updates'),
      P('invalid', 'int', '<1-4294967295>', 'Invalid'),
      P('holddown', 'int', '<0-4294967295>', 'Holddown'),
      P('flush', 'int', '<1-4294967295>', 'Flush'),
    ],
    run: (s, a) => {
      const c = ripCfg(s);
      c.timers = s.negated
        ? { update: 30, invalid: 180, holddown: 180, flush: 240 }
        : {
            update: Number(a.update),
            invalid: Number(a.invalid),
            holddown: Number(a.holddown),
            flush: Number(a.flush),
          };
      c.timersArmed = false;
      touch(s);
    },
  });
  r.add({
    modes: RIP,
    only: 'l3',
    negatable: true,
    slots: [
      K('redistribute', 'Redistribute information from another routing protocol'),
      REDIST_SRC(['connected', 'static', 'ospf', 'eigrp', 'bgp']),
      opt(P('id', 'int', '<1-65535>', 'Process ID / AS number', [1, 65535])),
      opt(K('metric', 'Metric for redistributed routes')),
      opt(P('metric', 'int', '<0-16>', 'Default metric', [0, 16])),
      ...RMAP,
    ],
    run: (s, a) => {
      applyRedist(s, ripCfg(s).redistribute, { proto: 'rip' }, a);
      touch(s);
    },
  });
  for (const w of ['distance']) {
    r.add({
      modes: [...RIP, 'config-ospf', 'config-eigrp'],
      only: 'l3',
      negatable: true,
      slots: [
        K(w, 'Accepted for compatibility (no effect)'),
        opt(P('n', 'int', '<1-255>', 'Value', [1, 255])),
      ],
      run: () => undefined,
    });
  }
  r.add({
    modes: ['config-rip', 'config-ospf', 'config-ospf6', 'config-eigrp', 'config-bgp'],
    only: 'l3',
    negatable: true,
    slots: [
      K('log-adjacency-changes', 'Log changes in adjacency state'),
      opt(K('detail', 'Log all state changes')),
    ],
    run: () => undefined,
  });

  // ------------------------------------------------------------ OSPF / OSPFv3
  const OSPFM: ModeId[] = ['config-ospf', 'config-ospf6'];
  r.add({
    modes: OSPFM,
    only: 'l3',
    negatable: true,
    slots: [
      K('router-id', 'router-id for this OSPF process'),
      P('id', 'ip', 'A.B.C.D', 'OSPF router-id in IP address format'),
    ],
    run: (s, a) => {
      const c = ospfCfg(s, s.mode === 'config-ospf6');
      c.routerId = s.negated ? undefined : (a.id as string);
      c.rid = undefined;
      touch(s);
    },
  });
  r.add({
    modes: ['config-ospf'],
    only: 'l3',
    negatable: true,
    slots: [
      K('network', 'Enable routing on an IP network'),
      P('net', 'ip', 'A.B.C.D', 'Network number'),
      P('wc', 'wildcard', 'A.B.C.D', 'OSPF wild card bits'),
      K('area', 'Set the OSPF area ID'),
      P('area', 'word', 'AREA', 'OSPF area ID as a decimal value or in IP address format'),
    ],
    run: (s, a) => {
      const c = ospfCfg(s, false);
      const area = String(a.area).includes('.') ? (a.area as string) : String(Number(a.area));
      c.networks = c.networks.filter(
        (n) => !(n.prefix === a.net && n.wildcard === a.wc && n.area === area),
      );
      if (!s.negated) c.networks.push({ prefix: a.net as string, wildcard: a.wc as string, area });
      touch(s);
    },
  });
  r.add({
    modes: OSPFM,
    only: 'l3',
    negatable: true,
    slots: [
      K('auto-cost', 'Calculate OSPF interface cost according to bandwidth'),
      K('reference-bandwidth', 'Use reference bandwidth method to assign OSPF cost'),
      P(
        'mbps',
        'int',
        '<1-4294967>',
        'The reference bandwidth in terms of Mbits per second',
        [1, 4294967],
      ),
    ],
    run: (s, a) => {
      ospfCfg(s, s.mode === 'config-ospf6').refBwMbps = s.negated ? 100 : Number(a.mbps);
      touch(s);
    },
  });
  r.add({
    modes: OSPFM,
    only: 'l3',
    negatable: true,
    slots: [
      K('default-information', 'Control distribution of default information'),
      K('originate', 'Distribute a default route'),
      opt(choice('always', ['always', 'Always advertise default route'])),
      opt(K('metric', 'OSPF default metric')),
      opt(P('m', 'int', '<0-16777214>', 'OSPF metric', [0, 16777214])),
      opt(K('metric-type', 'OSPF metric type for default routes')),
      opt(P('t', 'int', '<1-2>', 'OSPF metric type', [1, 2])),
    ],
    run: (s, a) => {
      const c = ospfCfg(s, s.mode === 'config-ospf6');
      c.defaultOriginate = s.negated
        ? undefined
        : {
            always: a.always === 'always',
            metric: a.m !== undefined ? Number(a.m) : 1,
            metricType: a.t === '1' ? 1 : 2,
          };
      touch(s);
    },
  });
  r.add({
    modes: ['config-ospf'],
    only: 'l3',
    negatable: true,
    slots: [
      K('redistribute', 'Redistribute information from another routing protocol'),
      REDIST_SRC(['connected', 'static', 'rip', 'ospf', 'eigrp', 'bgp']),
      opt(P('id', 'int', '<1-65535>', 'Process ID / AS number', [1, 65535])),
      opt(K('metric', 'Metric for redistributed routes')),
      opt(P('metric', 'int', '<0-16777214>', 'OSPF default metric', [0, 16777214])),
      opt(K('metric-type', 'OSPF/IS-IS exterior metric type for redistributed routes')),
      opt(P('mtype', 'int', '<1-2>', 'Set OSPF External Type 1/2 metrics', [1, 2])),
      opt(choice('subnets', ['subnets', 'Consider subnets for redistribution into OSPF'])),
      ...RMAP,
    ],
    run: (s, a) => {
      applyRedist(s, ospfCfg(s, false).redistribute, { proto: 'ospf', id: s.procId }, a);
      touch(s);
    },
  });
  r.add({
    modes: ['config-ospf'],
    only: 'l3',
    negatable: true,
    slots: [
      K('area', 'OSPF area parameters'),
      P('area', 'word', 'AREA', 'OSPF area ID'),
      K('range', 'Summarize routes matching address/mask (border routers only)'),
      P('net', 'ip', 'A.B.C.D', 'IP address to match'),
      P('mask', 'mask', 'A.B.C.D', 'IP mask'),
      opt(choice('na', ['not-advertise', 'DoNotAdvertise this range'])),
    ],
    run: (s, a) => {
      const c = ospfCfg(s, false);
      const area = String(a.area).includes('.') ? (a.area as string) : String(Number(a.area));
      const plen = maskToPrefix(a.mask as string) ?? 0;
      c.ranges = c.ranges.filter(
        (g) => !(g.area === area && g.prefix === a.net && g.plen === plen),
      );
      if (!s.negated)
        c.ranges.push({
          area,
          prefix: a.net as string,
          plen,
          notAdvertise: a.na === 'not-advertise',
        });
      touch(s);
    },
  });

  // ------------------------------------------------------------ EIGRP
  const EIG: ModeId[] = ['config-eigrp'];
  r.add({
    modes: EIG,
    only: 'l3',
    negatable: true,
    slots: [
      K('network', 'Enable routing on an IP network'),
      P('net', 'ip', 'A.B.C.D', 'Network number'),
      opt(P('wc', 'wildcard', 'A.B.C.D', 'EIGRP wild card bits')),
    ],
    run: (s, a) => {
      const c = eigrpCfg(s);
      const first = Number((a.net as string).split('.')[0]);
      const wc =
        a.wc ?? (first < 128 ? '0.255.255.255' : first < 192 ? '0.0.255.255' : '0.0.0.255');
      c.networks = c.networks.filter((n) => !(n.prefix === a.net && n.wildcard === wc));
      if (!s.negated) c.networks.push({ prefix: a.net as string, wildcard: wc });
      touch(s);
    },
  });
  r.add({
    modes: EIG,
    only: 'l3',
    negatable: true,
    slots: [
      K('eigrp', 'EIGRP specific commands'),
      K('router-id', 'router-id for this EIGRP process'),
      P('id', 'ip', 'A.B.C.D', 'EIGRP router-id in IP address format'),
    ],
    run: (s, a) => {
      const c = eigrpCfg(s);
      c.routerId = s.negated ? undefined : (a.id as string);
      c.rid = undefined;
      touch(s);
    },
  });
  r.add({
    modes: EIG,
    only: 'l3',
    negatable: true,
    slots: [
      K('variance', 'Control load balancing variance'),
      P('n', 'int', '<1-128>', 'Metric variance multiplier', [1, 128]),
    ],
    run: (s, a) => {
      eigrpCfg(s).variance = s.negated ? 1 : Number(a.n);
    },
  });
  r.add({
    modes: EIG,
    only: 'l3',
    negatable: true,
    slots: [
      K('redistribute', 'Redistribute information from another routing protocol'),
      REDIST_SRC(['connected', 'static', 'rip', 'ospf', 'bgp', 'eigrp']),
      opt(P('id', 'int', '<1-65535>', 'Process ID / AS number', [1, 65535])),
      opt(K('metric', 'Metric for redistributed routes')),
      opt(P('bw', 'int', '<1-4294967295>', 'Bandwidth metric in Kbits per second')),
      opt(P('dly', 'int', '<0-4294967295>', 'EIGRP delay metric, in 10 microsecond units')),
      opt(P('rel', 'int', '<0-255>', 'EIGRP reliability metric where 255 is 100% reliable')),
      opt(P('load', 'int', '<1-255>', 'EIGRP Effective bandwidth metric (Loading)')),
      opt(P('mtu', 'int', '<1-65535>', 'EIGRP MTU of the path')),
      ...RMAP,
    ],
    run: (s, a) => {
      applyRedist(s, eigrpCfg(s).redistribute, { proto: 'eigrp', id: s.procId }, a);
      touch(s);
    },
  });

  // ------------------------------------------------------------ BGP
  const BGP: ModeId[] = ['config-bgp'];
  r.add({
    modes: BGP,
    only: 'l3',
    negatable: true,
    slots: [
      K('bgp', 'BGP specific commands'),
      K('router-id', 'Override configured router identifier'),
      P('id', 'ip', 'A.B.C.D', 'Manually configured router identifier'),
    ],
    run: (s, a) => {
      const c = bgpCfg(s);
      c.routerId = s.negated ? undefined : (a.id as string);
      c.rid = undefined;
      touch(s);
    },
  });
  r.add({
    modes: BGP,
    only: 'l3',
    negatable: true,
    slots: [
      K('bgp', 'BGP specific commands'),
      K('default', 'Configure BGP defaults'),
      K('local-preference', 'local preference (higher=more preferred)'),
      P('n', 'int', '<0-4294967295>', 'Configure default local preference value', [0, 4294967295]),
    ],
    run: (s, a) => {
      bgpCfg(s).defaultLocalPref = s.negated ? 100 : Number(a.n);
      touch(s);
    },
  });
  const nbr = (s: CliSession, ip: string) => {
    const n = bgpCfg(s).neighbors[ip];
    if (!n) throw new CliError('%BGP: Specify remote-as or peer-group commands first');
    return n;
  };
  r.add({
    modes: BGP,
    only: 'l3',
    negatable: true,
    slots: [
      K('neighbor', 'Specify a neighbor router'),
      P('ip', 'ip', 'A.B.C.D', 'Neighbor address'),
      K('remote-as', 'Specify a BGP neighbor'),
      P('asn', 'int', '<1-65535>', 'AS of remote neighbor', [1, 65535]),
    ],
    run: (s, a) => {
      const c = bgpCfg(s);
      const ip = a.ip as string;
      if (s.negated) {
        delete c.neighbors[ip];
        touch(s);
        return;
      }
      const asn = Number(a.asn);
      const cur = c.neighbors[ip];
      if (cur) cur.asn = asn;
      else c.neighbors[ip] = newBgpNbr(ip, asn);
      touch(s);
    },
  });
  // IOS: `no neighbor A.B.C.D` entfernt den Nachbarn samt aller Einstellungen
  r.add({
    modes: BGP,
    only: 'l3',
    slots: [
      K('no', 'Negate a command or set its defaults'),
      K('neighbor', 'Specify a neighbor router'),
      P('ip', 'ip', 'A.B.C.D', 'Neighbor address'),
    ],
    run: (s, a) => {
      delete bgpCfg(s).neighbors[a.ip as string];
      touch(s);
    },
  });
  r.add({
    modes: BGP,
    only: 'l3',
    negatable: true,
    slots: [
      K('neighbor', 'Specify a neighbor router'),
      P('ip', 'ip', 'A.B.C.D', 'Neighbor address'),
      K('update-source', 'Source of routing updates'),
      P('if', 'iface', 'IFNAME', 'Interface'),
    ],
    run: (s, a) => {
      const ref = resolveIface(s.device, a.if as string);
      if (!ref) throw new CliError('% Invalid interface');
      nbr(s, a.ip as string).updateSource = s.negated ? undefined : ref.id;
      touch(s);
    },
  });
  r.add({
    modes: BGP,
    only: 'l3',
    negatable: true,
    slots: [
      K('neighbor', 'Specify a neighbor router'),
      P('ip', 'ip', 'A.B.C.D', 'Neighbor address'),
      K('ebgp-multihop', 'Allow EBGP neighbors not on directly connected networks'),
      opt(P('ttl', 'int', '<1-255>', 'maximum hop count', [1, 255])),
    ],
    run: (s, a) => {
      nbr(s, a.ip as string).ebgpMultihop = s.negated ? undefined : Number(a.ttl ?? 255);
      touch(s);
    },
  });
  r.add({
    modes: BGP,
    only: 'l3',
    negatable: true,
    slots: [
      K('neighbor', 'Specify a neighbor router'),
      P('ip', 'ip', 'A.B.C.D', 'Neighbor address'),
      K('next-hop-self', 'Disable the next hop calculation for this neighbor'),
    ],
    run: (s, a) => {
      nbr(s, a.ip as string).nextHopSelf = !s.negated;
      touch(s);
    },
  });
  r.add({
    modes: BGP,
    only: 'l3',
    negatable: true,
    slots: [
      K('neighbor', 'Specify a neighbor router'),
      P('ip', 'ip', 'A.B.C.D', 'Neighbor address'),
      K('shutdown', 'Administratively shut down this neighbor'),
    ],
    run: (s, a) => {
      nbr(s, a.ip as string).shutdown = !s.negated;
      touch(s);
    },
  });
  r.add({
    modes: BGP,
    only: 'l3',
    negatable: true,
    slots: [
      K('neighbor', 'Specify a neighbor router'),
      P('ip', 'ip', 'A.B.C.D', 'Neighbor address'),
      K('description', 'Neighbor specific description'),
      R('text', 'LINE', 'Up to 80 characters describing this neighbor'),
    ],
    run: (s, a) => {
      nbr(s, a.ip as string).description = s.negated ? undefined : (a.text as string);
    },
  });
  r.add({
    modes: BGP,
    only: 'l3',
    negatable: true,
    slots: [
      K('neighbor', 'Specify a neighbor router'),
      P('ip', 'ip', 'A.B.C.D', 'Neighbor address'),
      K('weight', 'Set default weight for routes from this neighbor'),
      P('w', 'int', '<0-65535>', 'default weight', [0, 65535]),
    ],
    run: (s, a) => {
      nbr(s, a.ip as string).weight = s.negated ? undefined : Number(a.w);
      touch(s);
    },
  });
  r.add({
    modes: BGP,
    only: 'l3',
    negatable: true,
    slots: [
      K('network', 'Specify a network to announce via BGP'),
      P('net', 'ip', 'A.B.C.D', 'Network number'),
      opt(K('mask', 'Network mask')),
      opt(P('mask', 'mask', 'A.B.C.D', 'Network mask')),
    ],
    run: (s, a) => {
      const c = bgpCfg(s);
      const first = Number((a.net as string).split('.')[0]);
      const plen = a.mask ? (maskToPrefix(a.mask) ?? 24) : first < 128 ? 8 : first < 192 ? 16 : 24;
      c.networks = c.networks.filter((n) => !(n.prefix === a.net && n.plen === plen));
      if (!s.negated) c.networks.push({ prefix: a.net as string, plen });
      touch(s);
    },
  });
  r.add({
    modes: BGP,
    only: 'l3',
    negatable: true,
    slots: [
      K('redistribute', 'Redistribute information from another routing protocol'),
      REDIST_SRC(['connected', 'static', 'rip', 'ospf', 'eigrp']),
      opt(P('id', 'int', '<1-65535>', 'Process ID / AS number', [1, 65535])),
      opt(K('metric', 'Metric for redistributed routes')),
      opt(P('metric', 'int', '<0-4294967295>', 'Default metric', [0, 4294967295])),
      ...RMAP,
    ],
    run: (s, a) => {
      applyRedist(s, bgpCfg(s).redistribute, { proto: 'bgp', id: s.procId }, a);
      touch(s);
    },
  });
  r.add({
    modes: BGP,
    only: 'l3',
    negatable: true,
    slots: [K('synchronization', 'Perform IGP synchronization')],
    run: () => undefined,
  });

  // ------------------------------------------------------------ Schnittstellen: Loopback / Tunnel / Bandbreite
  const enterVirtual = (s: CliSession, id: string): void => {
    s.engine.ensureIface(s.deviceId, id);
    s.ifaces = [id];
    s.mode = 'config-if';
  };
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      K('interface', 'Select an interface to configure'),
      K('loopback', 'Loopback interface'),
      P('n', 'int', '<0-2147483647>', 'Loopback interface number', [0, 9999]),
    ],
    run: (s, a) => {
      const id = `lo${Number(a.n)}`;
      if (s.negated) {
        delete l3(s).ifaces[id];
        touch(s);
        return;
      }
      enterVirtual(s, id);
    },
  });
  r.add({
    modes: CF,
    only: 'router',
    negatable: true,
    slots: [
      K('interface', 'Select an interface to configure'),
      K('tunnel', 'Tunnel interface'),
      P('n', 'int', '<0-2147483647>', 'Tunnel interface number', [0, 9999]),
    ],
    run: (s, a) => {
      const id = `tu${Number(a.n)}`;
      if (s.negated) {
        delete l3(s).ifaces[id];
        touch(s);
        return;
      }
      enterVirtual(s, id);
    },
  });
  r.add({
    modes: IF,
    only: 'l3',
    negatable: true,
    slots: [
      K('bandwidth', 'Set bandwidth informational parameter'),
      P('kbps', 'int', '<1-10000000>', 'Bandwidth in kilobits', [1, 10000000]),
    ],
    run: (s, a) => {
      for (const id of targets(s)) {
        const ic = l3(s).ifaces[id] ?? (s.engine.ensureIface(s.deviceId, id), l3(s).ifaces[id]);
        if (ic) ic.bandwidth = s.negated ? undefined : Number(a.kbps);
      }
      touch(s);
    },
  });
  r.add({
    modes: IF,
    only: 'l3',
    negatable: true,
    slots: [
      K('delay', 'Specify interface throughput delay'),
      P('d', 'int', '<1-16777215>', 'Throughput delay (tens of microseconds)', [1, 16777215]),
    ],
    run: (s, a) => {
      for (const id of targets(s)) {
        const ic = l3(s).ifaces[id] ?? (s.engine.ensureIface(s.deviceId, id), l3(s).ifaces[id]);
        if (ic) ic.delay = s.negated ? undefined : Number(a.d);
      }
      touch(s);
    },
  });
  const tun = (s: CliSession): IfaceCfg => {
    const ic = l3(s).ifaces[s.ifaces[0] as string];
    if (ic?.kind !== 'tunnel') throw new CliError("% Invalid input detected at '^' marker.");
    ic.tunnel ??= { mode: 'gre' };
    return ic;
  };
  r.add({
    modes: IF,
    only: 'router',
    negatable: true,
    slots: [
      K('tunnel', 'Protocol-over-protocol tunneling'),
      K('source', 'tunnel source'),
      P('src', 'word', 'IFNAME|A.B.C.D', 'Interface or IP address'),
    ],
    run: (s, a) => {
      const ic = tun(s);
      const t = a.src as string;
      const ref = resolveIface(s.device, t);
      if (ic.tunnel) ic.tunnel.source = s.negated ? undefined : ref ? ref.id : t;
      touch(s);
    },
  });
  r.add({
    modes: IF,
    only: 'router',
    negatable: true,
    slots: [
      K('tunnel', 'Protocol-over-protocol tunneling'),
      K('destination', 'destination of tunnel'),
      P('dst', 'ip', 'A.B.C.D', 'ip address'),
    ],
    run: (s, a) => {
      const ic = tun(s);
      if (ic.tunnel) ic.tunnel.destination = s.negated ? undefined : (a.dst as string);
      touch(s);
    },
  });
  r.add({
    modes: IF,
    only: 'router',
    slots: [
      K('tunnel', 'Protocol-over-protocol tunneling'),
      K('mode', 'tunnel encapsulation method'),
      K('gre', 'generic route encapsulation protocol'),
      opt(K('ip', 'over IP')),
    ],
    run: (s) => {
      tun(s);
    },
  });

  // ------------------------------------------------------------ OSPF/HSRP/RIP an Schnittstellen
  const ospfIf = (
    s: CliSession,
    v6: boolean,
    f: (o: NonNullable<IfaceCfg['ospf']>) => void,
    _pid?: number,
  ): void => {
    for (const id of targets(s)) {
      s.engine.ensureIface(s.deviceId, id);
      const ic = l3(s).ifaces[id];
      if (!ic) continue;
      if (v6) {
        ic.v6 ??= { enabled: false, addrs: [], autoconfig: false, slaac: [] };
        ic.v6.ospf ??= {};
        f(ic.v6.ospf);
      } else {
        ic.ospf ??= {};
        f(ic.ospf);
      }
    }
    touch(s);
  };
  for (const v6 of [false, true]) {
    const head = v6
      ? [IPV6, K('ospf', 'OSPF interface commands')]
      : [IP, K('ospf', 'OSPF interface commands')];
    r.add({
      modes: IF,
      only: 'l3',
      negatable: true,
      slots: [
        ...head,
        P('pid', 'int', '<1-65535>', 'Process ID', [1, 65535]),
        K('area', 'Set the OSPF area ID'),
        P('area', 'word', 'AREA', 'OSPF area ID'),
      ],
      run: (s, a) => {
        if (s.negated) {
          for (const id of targets(s)) {
            const ic = l3(s).ifaces[id];
            if (ic) {
              if (v6 && ic.v6) ic.v6.ospf = undefined;
              else ic.ospf = undefined;
            }
          }
          touch(s);
          return;
        }
        const area = String(a.area).includes('.') ? (a.area as string) : String(Number(a.area));
        ospfIf(
          s,
          v6,
          (o) => {
            o.pid = Number(a.pid);
            o.area = area;
          },
          Number(a.pid),
        );
      },
    });
    const kv = (
      word: string,
      help: string,
      name: string,
      lo: number,
      hi: number,
      set: (o: NonNullable<IfaceCfg['ospf']>, v: number | undefined) => void,
    ) => {
      r.add({
        modes: IF,
        only: 'l3',
        negatable: true,
        slots: [...head, K(word, help), P(name, 'int', `<${lo}-${hi}>`, help, [lo, hi])],
        run: (s, a) => ospfIf(s, v6, (o) => set(o, s.negated ? undefined : Number(a[name]))),
      });
    };
    kv('cost', 'Interface cost', 'n', 1, 65535, (o, v) => (o.cost = v));
    kv('priority', 'Router priority', 'n', 0, 255, (o, v) => (o.priority = v));
    kv('hello-interval', 'Time between HELLO packets', 'n', 1, 65535, (o, v) => (o.helloSec = v));
    kv(
      'dead-interval',
      'Interval after which a neighbor is declared dead',
      'n',
      1,
      65535,
      (o, v) => (o.deadSec = v),
    );
    if (!v6)
      r.add({
        modes: IF,
        only: 'l3',
        negatable: true,
        slots: [...head, K('mtu-ignore', 'Ignores the MTU in DBD packets')],
        run: (s) => ospfIf(s, v6, (o) => (o.mtuIgnore = s.negated ? undefined : true)),
      });
    r.add({
      modes: IF,
      only: 'l3',
      negatable: true,
      slots: [
        ...head,
        K('network', 'Network type'),
        choice(
          't',
          ['broadcast', 'Specify OSPF broadcast multi-access network'],
          ['point-to-point', 'Specify OSPF point-to-point network'],
        ),
      ],
      run: (s, a) =>
        ospfIf(
          s,
          v6,
          (o) => (o.network = s.negated ? undefined : (a.t as 'broadcast' | 'point-to-point')),
        ),
    });
  }
  r.add({
    modes: IF,
    only: 'l3',
    negatable: true,
    slots: [IP, K('split-horizon', 'Perform split horizon')],
    run: (s) => {
      for (const id of targets(s)) {
        const ic = l3(s).ifaces[id];
        if (ic) ic.ripSplitHorizon = s.negated ? false : undefined;
      }
    },
  });

  // HSRP
  const hs = (s: CliSession, group: number, f: (g: ReturnType<typeof newHsrp>) => void): void => {
    for (const id of targets(s)) {
      s.engine.ensureIface(s.deviceId, id);
      const ic = l3(s).ifaces[id];
      if (!ic) continue;
      if (group > 255 && (ic.hsrpVersion ?? 1) !== 2)
        throw new CliError(
          '% Group number out of range for HSRP version 1 (use standby version 2)',
        );
      // Einstellungen gelten für die IPv4- und die IPv6-Gruppe gleicher Nummer
      const v6g = ic.hsrp6?.[group];
      if (v6g) f(v6g);
      if (v6g && !ic.hsrp?.[group]) continue;
      ic.hsrp ??= {};
      const g = (ic.hsrp[group] ??= newHsrp(group));
      f(g);
    }
    touch(s);
  };
  const STBY = [
    K('standby', 'HSRP interface configuration commands'),
    P('g', 'int', '<0-4095>', 'group number', [0, 4095]),
  ];
  r.add({
    modes: IF,
    only: 'l3',
    negatable: true,
    slots: [
      ...STBY,
      K('ip', 'Enable HSRP and set the virtual IP address'),
      opt(P('vip', 'ip', 'A.B.C.D', 'Virtual IP address')),
    ],
    run: (s, a) => {
      if (s.negated) {
        for (const id of targets(s)) {
          const ic = l3(s).ifaces[id];
          if (ic?.hsrp) delete ic.hsrp[Number(a.g)];
        }
        touch(s);
        return;
      }
      if (!a.vip) throw new CliError('% Incomplete command.');
      hs(s, Number(a.g), (g) => (g.vip = a.vip));
    },
  });
  r.add({
    modes: IF,
    only: 'l3',
    negatable: true,
    slots: [
      ...STBY,
      K('priority', 'Priority level'),
      P('p', 'int', '<0-255>', 'Priority value', [0, 255]),
    ],
    run: (s, a) => hs(s, Number(a.g), (g) => (g.priority = s.negated ? 100 : Number(a.p))),
  });
  r.add({
    modes: IF,
    only: 'l3',
    negatable: true,
    slots: [...STBY, K('preempt', 'Overthrow lower priority Active routers')],
    run: (s, a) => hs(s, Number(a.g), (g) => (g.preempt = !s.negated)),
  });
  r.add({
    modes: IF,
    only: 'l3',
    negatable: true,
    slots: [
      ...STBY,
      K('timers', 'Hello and hold timers'),
      P('hello', 'int', '<1-254>', 'Hello interval in seconds', [1, 254]),
      P('hold', 'int', '<2-255>', 'Hold time in seconds', [2, 255]),
    ],
    run: (s, a) =>
      hs(s, Number(a.g), (g) => {
        g.helloSec = s.negated ? 3 : Number(a.hello);
        g.holdSec = s.negated ? 10 : Number(a.hold);
      }),
  });
  r.add({
    modes: IF,
    only: 'l3',
    negatable: true,
    slots: [
      ...STBY,
      K('track', 'Priority tracking'),
      P('if', 'iface', 'IFNAME', 'Tracked interface'),
      opt(P('dec', 'int', '<1-255>', 'Priority decrement', [1, 255])),
    ],
    run: (s, a) => {
      const ref = resolveIface(s.device, a.if as string);
      if (!ref) throw new CliError('% Invalid interface');
      hs(s, Number(a.g), (g) => {
        g.track = g.track.filter((t) => t.ifaceId !== ref.id);
        if (!s.negated) g.track.push({ ifaceId: ref.id, decrement: Number(a.dec ?? 10) });
      });
    },
  });
  r.add({
    modes: IF,
    only: 'l3',
    negatable: true,
    slots: [...STBY, K('name', 'Redundancy name'), R('text', 'WORD', 'Redundancy name string')],
    run: (s, a) => hs(s, Number(a.g), (g) => (g.name = s.negated ? undefined : (a.text as string))),
  });

  // ------------------------------------------------------------ IPv6
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [IPV6, K('unicast-routing', 'Enable unicast routing')],
    run: (s) => {
      const res = s.engine.setIpv6Routing(s.deviceId, !s.negated);
      if (!res.ok) throw err(res);
    },
  });
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      IPV6,
      K('route', 'Configure static routes'),
      P('prefix', 'prefix6', 'X:X:X:X::X/<0-128>', 'IPv6 prefix'),
      P('nh', 'word', 'X:X:X:X::X|IFNAME', 'IPv6 address of next-hop or interface'),
      opt(P('if', 'iface', 'IFNAME', 'Interface (required for link-local next hops)')),
      opt(P('ad', 'int', '<1-254>', 'Distance metric for this route', [1, 254])),
    ],
    run: (s, a) => {
      const [pfx, len] = (a.prefix as string).split('/') as [string, string];
      let nextHop: string | undefined;
      let out: string | undefined;
      if (isValidIpv6(a.nh as string)) nextHop = a.nh;
      else {
        const ref = resolveIface(s.device, a.nh as string);
        if (!ref) throw new CliError('% Invalid next hop');
        out = ref.id;
      }
      if (a.if) out = resolveIface(s.device, a.if)?.id;
      const route = {
        prefix: pfx,
        plen: Number(len),
        nextHop,
        outIfaceId: out,
        ad: a.ad ? Number(a.ad) : undefined,
      };
      const res = s.negated
        ? s.engine.removeStaticRoute6(s.deviceId, route)
        : s.engine.addStaticRoute6(s.deviceId, route);
      if (!res.ok) throw err(res);
    },
  });
  r.add({
    modes: IF,
    only: 'l3',
    negatable: true,
    slots: [
      IPV6,
      K('address', 'Configure IPv6 address on interface'),
      P('p', 'prefix6', 'X:X:X:X::X/<0-128>', 'IPv6 prefix'),
      opt(
        choice(
          'opt',
          ['eui-64', 'Use eui-64 interface identifier'],
          ['link-local', 'Use link-local address'],
        ),
      ),
    ],
    run: (s, a) => {
      if (s.negated && a.p === undefined) {
        // IOS: `no ipv6 address` entfernt alle globalen IPv6-Adressen der Schnittstelle
        for (const id of targets(s))
          for (const x of [...(l3(s).ifaces[id]?.v6?.addrs ?? [])]) {
            const res = s.engine.setInterfaceIp6(s.deviceId, id, x.addr, x.plen, {
              eui64: x.eui64,
              remove: true,
            });
            if (!res.ok) throw err(res);
          }
        return;
      }
      const [addr, len] = (a.p as string).split('/') as [string, string];
      for (const id of targets(s)) {
        const res = s.engine.setInterfaceIp6(s.deviceId, id, addr, Number(len), {
          eui64: a.opt === 'eui-64',
          remove: s.negated,
        });
        if (!res.ok) throw err(res);
      }
    },
  });
  r.add({
    modes: IF,
    only: 'l3',
    negatable: true,
    slots: [
      IPV6,
      K('address', 'Configure IPv6 address on interface'),
      K('autoconfig', 'Obtain address using autoconfiguration'),
    ],
    run: (s) => {
      for (const id of targets(s)) {
        const res = s.engine.setIpv6Autoconfig(s.deviceId, id, !s.negated);
        if (!res.ok) throw err(res);
      }
    },
  });
  r.add({
    modes: IF,
    only: 'l3',
    negatable: true,
    slots: [IPV6, K('enable', 'Enable IPv6 on interface')],
    run: (s) => {
      for (const id of targets(s)) {
        const res = s.engine.enableIpv6(s.deviceId, id, !s.negated);
        if (!res.ok) throw err(res);
      }
    },
  });
  r.add({
    modes: IF,
    only: 'l3',
    negatable: true,
    slots: [
      IPV6,
      K('nd', 'IPv6 interface Neighbor Discovery subcommands'),
      K('ra', 'Router Advertisement control'),
      K('suppress', 'Suppress IPv6 Router Advertisements'),
    ],
    run: (s) => {
      for (const id of targets(s)) {
        s.engine.enableIpv6(s.deviceId, id, true);
        const ic = l3(s).ifaces[id];
        if (ic?.v6) ic.v6.raSuppress = !s.negated;
      }
      touch(s);
    },
  });

  // ping für IPv6
  const ping6 = (s: CliSession, dst: string): void => {
    const n = normalizeIpv6(dst);
    if (!n) throw new CliError('% Invalid IPv6 address');
    runPing(s, n, { count: 5, size: 100, df: false, timeoutSec: 2 });
  };
  r.add({
    modes: U,
    only: 'l3',
    slots: [
      K('ping', 'Send echo messages'),
      K('ipv6', 'IPv6 echo'),
      P('dst', 'ipv6', 'WORD', 'Ping destination address or hostname'),
    ],
    run: (s, a) => ping6(s, a.dst as string),
  });
  r.add({
    modes: U,
    only: 'l3',
    slots: [K('ping', 'Send echo messages'), P('dst', 'ipv6', 'X:X:X:X::X', 'IPv6 address')],
    run: (s, a) => ping6(s, a.dst as string),
  });

  // ------------------------------------------------------------ show
  const sh = (
    words: [string, string][],
    run: (s: CliSession, a: Record<string, string>) => string[],
    extra: ReturnType<typeof opt>[] = [],
    only: 'l3' | 'router' = 'l3',
  ): void => {
    r.add({
      modes: U,
      only,
      slots: [SHOW, ...words.map(([w, h]) => K(w, h)), ...extra],
      run: (s, a) => s.outLines(run(s, a)),
    });
  };
  sh(
    [
      ['ip', 'IP information'],
      ['protocols', 'IP routing protocol process parameters and statistics'],
    ],
    (s) => show4.showIpProtocols(s.engine, s.device),
  );
  sh(
    [
      ['ip', 'IP information'],
      ['rip', 'IP RIP information'],
      ['database', 'IP RIP database'],
    ],
    (s) => show4.showRipDatabase(s.engine, s.device),
  );
  sh(
    [
      ['ip', 'IP information'],
      ['ospf', 'OSPF information'],
    ],
    (s, a) => show4.showOspf(s.engine, s.device, a.pid ? Number(a.pid) : undefined),
    [opt(P('pid', 'int', '<1-65535>', 'Process ID', [1, 65535]))],
  );
  sh(
    [
      ['ip', 'IP information'],
      ['ospf', 'OSPF information'],
      ['neighbor', 'Neighbor list'],
    ],
    (s) => show4.showOspfNeighbors(s.engine, s.device, false),
  );
  sh(
    [
      ['ip', 'IP information'],
      ['ospf', 'OSPF information'],
      ['interface', 'Interface information'],
    ],
    (s, a) => {
      const ref = a.if ? resolveIface(s.device, a.if) : undefined;
      if (a.if && !ref) throw new CliError('% Invalid interface');
      return showOspfInterfacesV4(s.engine, s.device, a.brief === 'brief', ref?.id);
    },
    [
      opt(choice('brief', ['brief', 'Brief summary of interface'])),
      opt(P('if', 'iface', 'IFNAME', 'Interface name')),
    ],
  );
  sh(
    [
      ['ip', 'IP information'],
      ['ospf', 'OSPF information'],
      ['database', 'Database summary'],
    ],
    (s, a) => show4.showOspfDatabase(s.engine, s.device, a.kind),
    [
      opt(
        choice(
          'kind',
          ['router', 'Router link states'],
          ['network', 'Network link states'],
          ['summary', 'Network summary link states'],
          ['asbr-summary', 'ASBR summary link states'],
          ['external', 'External link states'],
        ),
      ),
    ],
  );
  sh(
    [
      ['ipv6', 'IPv6 information'],
      ['ospf', 'OSPF information'],
      ['neighbor', 'Neighbor list'],
    ],
    (s) => show4.showOspfNeighbors(s.engine, s.device, true),
  );
  sh(
    [
      ['ipv6', 'IPv6 information'],
      ['ospf', 'OSPF information'],
      ['interface', 'Interface information'],
    ],
    (s, a) => show4.showOspfInterfaces(s.engine, s.device, true, a.brief === 'brief'),
    [opt(choice('brief', ['brief', 'Brief summary of interface']))],
  );
  sh(
    [
      ['ipv6', 'IPv6 information'],
      ['ospf', 'OSPF information'],
      ['database', 'Database summary'],
    ],
    (s) => show4.showOspfDatabase(s.engine, s.device, undefined, true),
  );
  sh(
    [
      ['ip', 'IP information'],
      ['eigrp', 'IP-EIGRP show commands'],
      ['neighbors', 'IP-EIGRP neighbors'],
    ],
    (s) => show4.showEigrpNeighbors(s.engine, s.device),
  );
  sh(
    [
      ['ip', 'IP information'],
      ['eigrp', 'IP-EIGRP show commands'],
      ['topology', 'IP-EIGRP Topology Table'],
    ],
    (s) => show4.showEigrpTopology(s.engine, s.device),
    [opt(K('all-links', 'Show all links in topology table'))],
  );
  sh(
    [
      ['ip', 'IP information'],
      ['eigrp', 'IP-EIGRP show commands'],
      ['interfaces', 'IP-EIGRP interfaces'],
    ],
    (s) => show4.showEigrpInterfaces(s.engine, s.device),
  );
  sh(
    [['standby', 'Hot Standby Router Protocol (HSRP) information']],
    (s, a) => show4.showStandby(s.engine, s.device, a.brief === 'brief'),
    [opt(choice('brief', ['brief', 'Brief output']))],
  );
  sh(
    [
      ['ip', 'IP information'],
      ['bgp', 'BGP information'],
    ],
    (s) => show4.showBgp(s.engine, s.device),
  );
  sh(
    [
      ['ip', 'IP information'],
      ['bgp', 'BGP information'],
      ['summary', 'Summary of BGP neighbor status'],
    ],
    (s) => show4.showBgpSummary(s.engine, s.device),
  );
  sh(
    [
      ['ip', 'IP information'],
      ['bgp', 'BGP information'],
      ['neighbors', 'Detailed information on TCP and BGP neighbor connections'],
    ],
    (s) => show4.showBgpNeighbors(s.engine, s.device),
  );
  sh(
    [
      ['ipv6', 'IPv6 information'],
      ['route', 'IPv6 routing table'],
    ],
    (s) => show4.showIpv6Route(s.engine, s.device),
  );
  sh(
    [
      ['ipv6', 'IPv6 information'],
      ['interface', 'IPv6 interface status and configuration'],
    ],
    (s, a) => show4.showIpv6Interface(s.engine, s.device, a.brief === 'brief'),
    [opt(choice('brief', ['brief', 'Brief summary of IPv6 status and configuration']))],
  );
  sh(
    [
      ['ipv6', 'IPv6 information'],
      ['neighbors', 'IPv6 neighbor cache entries'],
    ],
    (s) => show4.showIpv6Neighbors(s.engine, s.device),
  );
  sh(
    [
      ['ipv6', 'IPv6 information'],
      ['protocols', 'IPv6 routing protocol process parameters and statistics'],
    ],
    (s) => show4.showIpv6Protocols(s.engine, s.device),
  );
  sh([['debugging', 'State of each debugging option']], (s) => show4.showDebugging(s.device));

  // ------------------------------------------------------------ clear / debug
  r.add({
    modes: ['priv'],
    only: 'l3',
    slots: [
      K('clear', 'Reset functions'),
      IP,
      K('ospf', 'OSPF clear commands'),
      K('process', 'Reset OSPF process'),
    ],
    run: (s) => {
      for (const c of Object.values(l3(s).routing.ospf)) {
        c.ifs = {};
        c.lsdb = {};
        c.installed = {};
        c.seqs = {};
        c.externals = {};
        c.dirty = true;
      }
      touch(s);
    },
  });
  r.add({
    modes: ['priv'],
    only: 'l3',
    slots: [
      K('clear', 'Reset functions'),
      IP,
      K('bgp', 'Clear BGP sessions'),
      K('*', 'Clear all peers'),
    ],
    run: (s) => {
      for (const n of Object.values(l3(s).routing.bgp?.neighbors ?? {})) {
        n.state = 'idle';
        n.ribIn = {};
        n.advertised = {};
      }
      touch(s);
    },
  });
  r.add({
    modes: ['priv'],
    only: 'l3',
    slots: [
      K('clear', 'Reset functions'),
      IP,
      K('route', 'Delete routes from the routing table'),
      K('*', 'Delete all routes'),
    ],
    run: (s) => {
      const c = l3(s);
      for (const rr of c.routing.rip ? Object.values(c.routing.rip.routes) : [])
        if (rr.origin === 'rip') rr.metric = 16;
      touch(s);
    },
  });

  type DbgDef = { words: [string, string][]; tags: string[]; label: string };
  const DBG: DbgDef[] = [
    {
      words: [
        ['ip', 'IP information'],
        ['rip', 'RIP protocol transactions'],
      ],
      tags: ['rip'],
      label: 'RIP protocol debugging',
    },
    {
      words: [
        ['ip', 'IP information'],
        ['ospf', 'OSPF information'],
        ['events', 'OSPF events'],
      ],
      tags: ['ospf.events'],
      label: 'OSPF events',
    },
    {
      words: [
        ['ip', 'IP information'],
        ['ospf', 'OSPF information'],
        ['adj', 'OSPF adjacency events'],
      ],
      tags: ['ospf.adj'],
      label: 'OSPF adjacency events',
    },
    {
      words: [
        ['ip', 'IP information'],
        ['ospf', 'OSPF information'],
        ['hello', 'OSPF hello events'],
      ],
      tags: ['ospf.hello'],
      label: 'OSPF hello events',
    },
    {
      words: [
        ['ip', 'IP information'],
        ['ospf', 'OSPF information'],
        ['packet', 'OSPF packets'],
      ],
      tags: ['ospf.packet'],
      label: 'OSPF packet debugging',
    },
    {
      words: [
        ['ip', 'IP information'],
        ['ospf', 'OSPF information'],
        ['spf', 'OSPF spf'],
      ],
      tags: ['ospf.spf'],
      label: 'OSPF spf',
    },
    {
      words: [
        ['ip', 'IP information'],
        ['ospf', 'OSPF information'],
        ['lsa-generation', 'OSPF lsa generation'],
      ],
      tags: ['ospf.lsa'],
      label: 'OSPF lsa generation',
    },
    {
      words: [
        ['eigrp', 'EIGRP Protocol information'],
        ['packets', 'EIGRP packets'],
      ],
      tags: ['eigrp.packet'],
      label: 'EIGRP packets',
    },
    {
      words: [
        ['eigrp', 'EIGRP Protocol information'],
        ['fsm', 'EIGRP Dual Finite State Machine events/actions'],
      ],
      tags: ['eigrp.fsm'],
      label: 'EIGRP Dual Finite State Machine events/actions',
    },
    {
      words: [
        ['eigrp', 'EIGRP Protocol information'],
        ['neighbors', 'EIGRP neighbors'],
      ],
      tags: ['eigrp.neighbor'],
      label: 'EIGRP neighbors',
    },
    {
      words: [['standby', 'Hot Standby Router Protocol (HSRP) information']],
      tags: ['hsrp'],
      label: 'HSRP debugging',
    },
    {
      words: [
        ['ip', 'IP information'],
        ['bgp', 'BGP information'],
      ],
      tags: ['bgp'],
      label: 'BGP debugging',
    },
    {
      words: [
        ['ip', 'IP information'],
        ['routing', 'Routing table events'],
      ],
      tags: ['routing'],
      label: 'IP routing',
    },
    { words: [['tunnel', 'Generic Tunnel Interface']], tags: ['gre'], label: 'Tunnel debugging' },
    {
      words: [
        ['ip', 'IP information'],
        ['dhcp', 'Dynamic Host Configuration Protocol'],
        ['server', 'DHCP server activity'],
        ['events', 'Report address assignments, lease expirations, etc.'],
      ],
      tags: ['dhcp.events'],
      label: 'DHCP server event debugging',
    },
    {
      words: [
        ['ip', 'IP information'],
        ['dhcp', 'Dynamic Host Configuration Protocol'],
        ['server', 'DHCP server activity'],
        ['packet', 'Decode message receptions and transmissions'],
      ],
      tags: ['dhcp.packet'],
      label: 'DHCP server packet debugging',
    },
    {
      words: [
        ['ppp', 'PPP (Point to Point Protocol) information'],
        ['negotiation', 'Protocol parameter negotiation'],
      ],
      tags: ['ppp.negotiation'],
      label: 'PPP protocol negotiation debugging',
    },
    {
      words: [
        ['ppp', 'PPP (Point to Point Protocol) information'],
        ['authentication', 'Authentication protocol activity'],
      ],
      tags: ['ppp.authentication'],
      label: 'PPP authentication debugging',
    },
  ];
  for (const d of DBG) {
    r.add({
      modes: ['priv'],
      only: 'l3',
      negatable: true,
      slots: [
        K('debug', "Debugging functions (see also 'undebug')"),
        ...d.words.map(([w, h]) => K(w, h)),
      ],
      run: (s) => {
        const list = l3(s).routing.debug;
        for (const t of d.tags) {
          const i = list.indexOf(t);
          if (s.negated) {
            if (i >= 0) list.splice(i, 1);
          } else if (i < 0) list.push(t);
        }
        if (!s.negated) s.out(`${d.label} is on`);
        else s.out(`${d.label} is off`);
      },
    });
  }
  r.add({
    modes: ['priv'],
    only: 'l3',
    slots: [
      K('undebug', "Disable debugging functions (see also 'debug')"),
      K('all', 'Disable all debugging'),
    ],
    run: (s) => {
      l3(s).routing.debug = [];
      s.out('All possible debugging has been turned off');
    },
  });
  r.add({
    modes: ['priv'],
    only: 'l3',
    negatable: true,
    slots: [
      K('debug', "Debugging functions (see also 'undebug')"),
      K('all', 'Enable all debugging'),
    ],
    run: (s) => {
      l3(s).routing.debug = s.negated ? [] : [...new Set(DBG.flatMap((d) => d.tags))];
      s.out(
        s.negated
          ? 'All possible debugging has been turned off'
          : 'All possible debugging has been turned on',
      );
    },
  });
}

void isValidIpv4;
void ifDisplay;
