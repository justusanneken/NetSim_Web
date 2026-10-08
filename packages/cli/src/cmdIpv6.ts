import { isValidIpv6, normalizeIpv6 } from '@netsim/protocols';
import {
  newDhcp6Pool,
  newRipng,
  type Dhcp6Pool,
  type IfaceCfg,
  type RedistCfg,
  type RedistSource,
  type RipngCfg,
} from '@netsim/engine';
import { targets } from './commands';
import { l3c, touch } from './commandsGaps';
import { resolveIface } from './ifnames';
import { K, P, R, choice, opt, type ModeId, type Registry } from './parser';
import { CliError, type CliSession } from './session';
import * as showIpv6 from './showIpv6';
import { waitFor } from './util';

const IFM: ModeId[] = ['config-if', 'config-subif', 'config-if-range'];
const CF: ModeId[] = ['config'];
const U: ModeId[] = ['user', 'priv'];
const IPV6 = K('ipv6', 'IPv6 information');

function pool(s: CliSession): Dhcp6Pool {
  const p = l3c(s).dhcp6?.pools.find((x) => x.name === s.poolName);
  if (!p) throw new CliError('% DHCPv6 pool does not exist');
  return p;
}

function ripng(s: CliSession): RipngCfg {
  const c = l3c(s).routing.ripng?.[s.poolName];
  if (!c) throw new CliError('% RIPng process is not running');
  return c;
}

const v6ic = (s: CliSession, f: (v: NonNullable<IfaceCfg['v6']>) => void): void => {
  for (const id of targets(s)) {
    s.engine.ensureIface(s.deviceId, id);
    const ic = l3c(s).ifaces[id];
    if (!ic) continue;
    ic.v6 ??= { enabled: false, addrs: [], autoconfig: false, slaac: [] };
    f(ic.v6);
  }
  touch(s);
};

/** IPv6-Erweiterungen: DHCPv6, RIPng, OSPFv3-Redistribution, Traceroute. */
export function addIpv6Gaps(r: Registry<CliSession>): void {
  // ------------------------------------------------------------ DHCPv6
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      IPV6,
      K('dhcp', 'Configure IPv6 DHCP'),
      K('pool', 'Configure IPv6 DHCP pool'),
      P('name', 'word', 'WORD', 'IPv6 DHCP pool name'),
    ],
    run: (s, a) => {
      const cfg = l3c(s);
      const d6 = (cfg.dhcp6 ??= { pools: [], bindings: {} });
      const name = a.name as string;
      if (s.negated) {
        d6.pools = d6.pools.filter((p) => p.name !== name);
        touch(s);
        return;
      }
      if (!d6.pools.some((p) => p.name === name)) d6.pools.push(newDhcp6Pool(name));
      s.poolName = name;
      s.mode = 'config-dhcp6';
    },
  });
  const DH: ModeId[] = ['config-dhcp6'];
  r.add({
    modes: DH,
    only: 'l3',
    negatable: true,
    slots: [
      K('address', 'IPv6 address allocation'),
      K('prefix', 'IPv6 prefix'),
      P('p', 'prefix6', 'X:X:X:X::X/<0-128>', 'IPv6 prefix'),
      opt(R('rest', 'lifetime ...', 'Lifetime options')),
    ],
    run: (s, a) => {
      const p = pool(s);
      const [addr, len] = (a.p as string).split('/') as [string, string];
      p.prefix = s.negated ? undefined : { prefix: normalizeIpv6(addr) ?? addr, plen: Number(len) };
      const life = /lifetime\s+(\d+)/.exec(a.rest ?? '');
      if (life) p.leaseSec = Number(life[1]);
      touch(s);
    },
  });
  r.add({
    modes: DH,
    only: 'l3',
    negatable: true,
    slots: [
      K('dns-server', 'Configure DNS servers'),
      P('addr', 'ipv6', 'X:X:X:X::X', 'IPv6 address of DNS server'),
    ],
    run: (s, a) => {
      const p = pool(s);
      const addr = normalizeIpv6(a.addr as string) ?? (a.addr as string);
      p.dns = p.dns.filter((x) => x !== addr);
      if (!s.negated) p.dns.push(addr);
      touch(s);
    },
  });
  r.add({
    modes: DH,
    only: 'l3',
    negatable: true,
    slots: [K('domain-name', 'Configure domain name'), P('name', 'word', 'WORD', 'Domain name')],
    run: (s, a) => {
      pool(s).domain = s.negated ? undefined : (a.name as string);
      touch(s);
    },
  });
  r.add({
    modes: IFM,
    only: 'l3',
    negatable: true,
    slots: [
      IPV6,
      K('dhcp', 'IPv6 DHCP interface commands'),
      K('server', 'Enable IPv6 DHCP server on this interface'),
      P('name', 'word', 'WORD', 'IPv6 DHCP pool name'),
    ],
    run: (s, a) => v6ic(s, (v) => (v.dhcp6Server = s.negated ? undefined : (a.name as string))),
  });
  for (const [word, help, key] of [
    ['managed-config-flag', 'Hosts should use DHCP for address config', 'managed'],
    ['other-config-flag', 'Hosts should use DHCP for non-address config', 'otherConfig'],
  ] as const) {
    r.add({
      modes: IFM,
      only: 'l3',
      negatable: true,
      slots: [IPV6, K('nd', 'IPv6 interface Neighbor Discovery'), K(word, help)],
      run: (s) => v6ic(s, (v) => (v[key] = s.negated ? undefined : true)),
    });
  }
  r.add({
    modes: U,
    only: 'l3',
    slots: [
      K('show', 'Show running system information'),
      IPV6,
      K('dhcp', 'Show IPv6 DHCP information'),
      K('pool', 'DHCP pool information'),
    ],
    run: (s) => s.outLines(showIpv6.showDhcp6Pool(s.device)),
  });
  r.add({
    modes: U,
    only: 'l3',
    slots: [
      K('show', 'Show running system information'),
      IPV6,
      K('dhcp', 'Show IPv6 DHCP information'),
      K('binding', 'DHCP bindings'),
    ],
    run: (s) => s.outLines(showIpv6.showDhcp6Binding(s.engine, s.device)),
  });

  // ------------------------------------------------------------ RIPng
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      IPV6,
      K('router', 'Enable an IPV6 routing process'),
      K('rip', 'IPv6 Routing Information Protocol (RIPv6)'),
      P('name', 'word', 'WORD', 'User selected string identifying this RIP process'),
    ],
    run: (s, a) => {
      const rt = l3c(s).routing;
      const name = a.name as string;
      if (s.negated) {
        if (rt.ripng) delete rt.ripng[name];
        for (const ic of Object.values(l3c(s).ifaces))
          if (ic.v6?.ripng === name) ic.v6.ripng = undefined;
        touch(s);
        return;
      }
      (rt.ripng ??= {})[name] ??= newRipng(name);
      s.poolName = name;
      s.mode = 'config-rip6';
      touch(s);
    },
  });
  const RP: ModeId[] = ['config-rip6'];
  r.add({
    modes: IFM,
    only: 'l3',
    negatable: true,
    slots: [
      IPV6,
      K('rip', 'Configure RIP routing protocol'),
      P('name', 'word', 'WORD', 'User selected string identifying this RIP process'),
      K('enable', 'Enable/disable RIP'),
    ],
    run: (s, a) => v6ic(s, (v) => (v.ripng = s.negated ? undefined : (a.name as string))),
  });
  r.add({
    modes: RP,
    only: 'l3',
    negatable: true,
    slots: [
      K('default-information', 'Control distribution of default information'),
      K('originate', 'Distribute a default route'),
    ],
    run: (s) => {
      ripng(s).defaultOriginate = !s.negated;
      touch(s);
    },
  });
  r.add({
    modes: RP,
    only: 'l3',
    negatable: true,
    slots: [
      K('default-metric', 'Set metric of redistributed routes'),
      P('m', 'int', '<1-15>', 'Default metric', [1, 15]),
    ],
    run: (s, a) => {
      ripng(s).defaultMetric = s.negated ? undefined : Number(a.m);
      touch(s);
    },
  });
  r.add({
    modes: RP,
    only: 'l3',
    negatable: true,
    slots: [K('poison-reverse', 'Poison reverse updates')],
    run: (s) => {
      ripng(s).poison = !s.negated;
    },
  });
  r.add({
    modes: RP,
    only: 'l3',
    negatable: true,
    slots: [
      K('timers', 'Adjust routing timers'),
      P('update', 'int', '<1-4294967295>', 'Interval between updates'),
      P('invalid', 'int', '<1-4294967295>', 'Invalid'),
      P('holddown', 'int', '<0-4294967295>', 'Holddown'),
      P('flush', 'int', '<1-4294967295>', 'Flush'),
    ],
    run: (s, a) => {
      const c = ripng(s);
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
    modes: RP,
    only: 'l3',
    negatable: true,
    slots: [
      K('passive-interface', 'Suppress routing updates on an interface'),
      P('if', 'iface', 'IFNAME', 'Interface name'),
    ],
    run: (s, a) => {
      const ref = resolveIface(s.device, a.if as string);
      if (!ref) throw new CliError('% Invalid interface');
      const c = ripng(s);
      c.passive = (c.passive ?? []).filter((x) => x !== ref.id);
      if (!s.negated) c.passive.push(ref.id);
      touch(s);
    },
  });

  // ------------------------------------------------------------ redistribute (RIPng / OSPFv3)
  const SRC: [RedistSource, string][] = [
    ['connected', 'Connected'],
    ['static', 'Static routes'],
    ['rip', 'IPv6 Routing Information Protocol (RIPng)'],
    ['ospf', 'Open Shortest Path First (OSPFv3)'],
    ['bgp', 'Border Gateway Protocol (BGP)'],
  ];
  for (const mode of ['config-rip6', 'config-ospf6'] as const) {
    r.add({
      modes: [mode],
      only: 'l3',
      negatable: true,
      slots: [
        K('redistribute', 'Redistribute IPv6 prefixes from another routing protocol'),
        choice('src', ...SRC),
        opt(P('id', 'word', 'WORD', 'Process ID / AS number / name')),
        opt(K('metric', 'Metric for redistributed routes')),
        opt(P('metric', 'int', '<0-16777214>', 'Metric', [0, 16777214])),
        opt(K('metric-type', 'OSPF/IS-IS exterior metric type for redistributed routes')),
        opt(P('mtype', 'int', '<1-2>', 'Set OSPF External Type 1/2 metrics', [1, 2])),
        opt(K('route-map', 'Route map reference')),
        opt(P('rm', 'word', 'WORD', 'Pointer to route-map entries')),
      ],
      run: (s, a) => {
        const list =
          mode === 'config-rip6'
            ? ripng(s).redistribute
            : (l3c(s).routing.ospf6[s.procId]?.redistribute ??
              (() => {
                throw new CliError('% OSPF process is not running');
              })());
        const src = a.src as RedistSource;
        const num = a.id !== undefined && /^\d+$/.test(a.id) ? Number(a.id) : undefined;
        const idx = list.findIndex((x) => x.source === src && x.id === num);
        if (s.negated) {
          if (idx >= 0) list.splice(idx, 1);
        } else {
          const entry: RedistCfg = {
            source: src,
            id: num,
            metric: a.metric !== undefined ? Number(a.metric) : undefined,
            metricType: a.mtype === '1' ? 1 : a.mtype === '2' ? 2 : undefined,
            subnets: true,
            routeMap: a.rm,
          };
          if (idx >= 0) list[idx] = entry;
          else list.push(entry);
        }
        touch(s);
      },
    });
  }
  r.add({
    modes: RP,
    only: 'l3',
    negatable: true,
    slots: [
      K('maximum-paths', 'Forward packets over multiple paths'),
      P('n', 'int', '<1-32>', 'Number of paths', [1, 32]),
    ],
    run: (s, a) => {
      ripng(s).maxPaths = s.negated || Number(a.n) === 4 ? undefined : Number(a.n);
    },
  });

  // ------------------------------------------------------------ show
  r.add({
    modes: U,
    only: 'l3',
    slots: [
      K('show', 'Show running system information'),
      IPV6,
      K('rip', 'IPv6 RIP routing information'),
      opt(P('name', 'word', 'WORD', 'Process name')),
    ],
    run: (s, a) => s.outLines(showIpv6.showRipng(s.engine, s.device, a.name)),
  });

  // ------------------------------------------------------------ traceroute
  const trace6 = (s: CliSession, dst: string): void => {
    const e = s.engine;
    const d = s.device;
    const addr = normalizeIpv6(dst) ?? dst;
    const res = e.trace(d.id, addr);
    s.out('Type escape sequence to abort.');
    s.out(`Tracing the route to ${addr.toUpperCase()}`);
    s.out('');
    if (!res.ok) {
      s.out('% Invalid IPv6 address');
      return;
    }
    if (s.deferred()) {
      s.out(
        'Simulation mode: probes were queued. Step through the events in the simulation panel.',
      );
      return;
    }
    const cfg = d.config;
    const tr = () => cfg.traces.find((t) => t.id === res.value);
    waitFor(e, () => tr()?.done ?? true);
    for (const hop of tr()?.hops ?? []) {
      const parts: string[] = [];
      let last = '';
      for (const p of hop.probes) {
        if (p.status !== 'reply') parts.push('*');
        else {
          const t = `${Math.round((p.rttUs ?? 0) / 1000)} msec`;
          parts.push(p.from !== last ? `${(p.from ?? '').toUpperCase()} ${t}` : t);
          last = p.from ?? '';
        }
      }
      s.out(`${String(hop.ttl).padStart(3)} ${parts.join(' ')}`);
    }
    s.out('');
  };
  r.add({
    modes: U,
    only: 'l3',
    slots: [
      K('traceroute', 'Trace route to destination'),
      K('ipv6', 'IPv6 trace'),
      P('dst', 'ipv6', 'WORD', 'Trace route to destination address or hostname'),
    ],
    run: (s, a) => trace6(s, a.dst as string),
  });
  r.add({
    modes: U,
    only: 'l3',
    slots: [
      K('traceroute', 'Trace route to destination'),
      P('dst', 'ipv6', 'X:X:X:X::X', 'Trace route to destination address'),
    ],
    run: (s, a) => trace6(s, a.dst as string),
  });
  void isValidIpv6;
}
