import {
  newEigrp,
  type EigrpCfg,
  type IfaceCfg,
  type RedistCfg,
  type RedistSource,
} from '@netsim/engine';
import { targets } from './commands';
import { l3c, touch } from './commandsGaps';
import { resolveIface } from './ifnames';
import { K, P, choice, opt, type ModeId, type Registry } from './parser';
import { CliError, type CliSession } from './session';
import * as showEigrp6 from './showEigrp6';

const CF: ModeId[] = ['config'];
const IFM: ModeId[] = ['config-if', 'config-subif', 'config-if-range'];
const U: ModeId[] = ['user', 'priv'];
const E6: ModeId[] = ['config-eigrp6'];
const IPV6 = K('ipv6', 'IPv6 information');

const cfg6 = (s: CliSession): EigrpCfg => {
  const c = l3c(s).routing.eigrp6?.[s.procId];
  if (!c) throw new CliError('% EIGRP process is not running');
  return c;
};

/** EIGRP für IPv6: `ipv6 router eigrp`, `ipv6 eigrp`, Prozess-Unterbefehle und `show ipv6 eigrp …`. */
export function addEigrp6(r: Registry<CliSession>): void {
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      IPV6,
      K('router', 'Enable an IPV6 routing process'),
      K('eigrp', 'Enhanced Interior Gateway Routing Protocol (EIGRP)'),
      P('asn', 'int', '<1-65535>', 'Autonomous system number', [1, 65535]),
    ],
    run: (s, a) => {
      const c = l3c(s);
      const asn = Number(a.asn);
      c.routing.eigrp6 ??= {};
      if (s.negated) {
        delete c.routing.eigrp6[asn];
        touch(s);
        return;
      }
      c.routing.eigrp6[asn] ??= newEigrp(asn, true);
      s.procId = asn;
      s.mode = 'config-eigrp6';
      touch(s);
    },
  });

  // ------------------------------------------------------------ Schnittstelle
  r.add({
    modes: IFM,
    only: 'l3',
    negatable: true,
    slots: [
      IPV6,
      K('eigrp', 'Enable IPv6 EIGRP on this interface'),
      P('asn', 'int', '<1-65535>', 'Autonomous system number', [1, 65535]),
    ],
    run: (s, a) => {
      for (const id of targets(s)) {
        s.engine.ensureIface(s.deviceId, id);
        const ic: IfaceCfg | undefined = l3c(s).ifaces[id];
        if (!ic) continue;
        if (s.negated) {
          if (ic.v6) ic.v6.eigrp = undefined;
          continue;
        }
        ic.v6 ??= { enabled: false, addrs: [], autoconfig: false, slaac: [] };
        ic.v6.eigrp = Number(a.asn);
      }
      touch(s);
    },
  });

  // ------------------------------------------------------------ Prozess
  r.add({
    modes: E6,
    only: 'l3',
    negatable: true,
    slots: [
      K('eigrp', 'EIGRP specific commands'),
      K('router-id', 'router-id for this EIGRP process'),
      P('id', 'ip', 'A.B.C.D', 'EIGRP router-id in IP address format'),
    ],
    run: (s, a) => {
      const c = cfg6(s);
      c.routerId = s.negated ? undefined : (a.id as string);
      c.rid = undefined;
      touch(s);
    },
  });
  r.add({
    modes: E6,
    only: 'l3',
    negatable: true,
    slots: [K('shutdown', 'Shutdown address family')],
    run: (s) => {
      cfg6(s).shutdown = !s.negated;
      touch(s);
    },
  });
  r.add({
    modes: E6,
    only: 'l3',
    negatable: true,
    slots: [
      K('variance', 'Control load balancing variance'),
      P('n', 'int', '<1-128>', 'Metric variance multiplier', [1, 128]),
    ],
    run: (s, a) => {
      cfg6(s).variance = s.negated ? 1 : Number(a.n);
      touch(s);
    },
  });
  r.add({
    modes: E6,
    only: 'l3',
    negatable: true,
    slots: [
      K('maximum-paths', 'Forward packets over multiple paths'),
      P('n', 'int', '<1-32>', 'Number of paths', [1, 32]),
    ],
    run: (s, a) => {
      const n = s.negated ? 4 : Number(a.n);
      cfg6(s).maxPaths = n === 4 ? undefined : n;
      touch(s);
    },
  });
  const passive = (s: CliSession, id: string | 'default'): void => {
    const c = cfg6(s);
    if (id === 'default') {
      c.passiveDefault = !s.negated;
      c.passive = [];
      c.unpassive = [];
      return;
    }
    const list = (c.passiveDefault ? c.unpassive : c.passive).filter((x) => x !== id);
    if (c.passiveDefault) c.unpassive = s.negated ? [...list, id] : list;
    else c.passive = s.negated ? list : [...list, id];
  };
  r.add({
    modes: E6,
    only: 'l3',
    negatable: true,
    slots: [
      K('passive-interface', 'Suppress routing updates on an interface'),
      choice('kw', ['default', 'Suppress routing updates on all interfaces']),
    ],
    run: (s) => {
      passive(s, 'default');
      touch(s);
    },
  });
  r.add({
    modes: E6,
    only: 'l3',
    negatable: true,
    slots: [
      K('passive-interface', 'Suppress routing updates on an interface'),
      P('if', 'iface', 'IFNAME', 'Interface name'),
    ],
    run: (s, a) => {
      const ref = resolveIface(s.device, a.if as string);
      if (!ref) throw new CliError('% Invalid interface');
      passive(s, ref.id);
      touch(s);
    },
  });
  const SRC: [RedistSource, string][] = [
    ['connected', 'Connected'],
    ['static', 'Static routes'],
    ['rip', 'IPv6 Routing Information Protocol (RIPng)'],
    ['ospf', 'Open Shortest Path First (OSPFv3)'],
    ['bgp', 'Border Gateway Protocol (BGP)'],
  ];
  r.add({
    modes: E6,
    only: 'l3',
    negatable: true,
    slots: [
      K('redistribute', 'Redistribute IPv6 prefixes from another routing protocol'),
      choice('src', ...SRC),
      opt(P('id', 'word', 'WORD', 'Process ID / AS number / name')),
      opt(K('metric', 'Metric for redistributed routes')),
      opt(P('bw', 'int', '<1-4294967295>', 'Bandwidth metric in Kbits per second')),
      opt(P('dly', 'int', '<0-4294967295>', 'EIGRP delay metric, in 10 microsecond units')),
      opt(P('rel', 'int', '<0-255>', 'EIGRP reliability metric where 255 is 100% reliable')),
      opt(P('load', 'int', '<1-255>', 'EIGRP Effective bandwidth metric (Loading)')),
      opt(P('mtu', 'int', '<1-65535>', 'EIGRP MTU of the path')),
      opt(K('route-map', 'Route map reference')),
      opt(P('rm', 'word', 'WORD', 'Pointer to route-map entries')),
    ],
    run: (s, a) => {
      const list = cfg6(s).redistribute;
      const src = a.src as RedistSource;
      const id = a.id !== undefined && /^\d+$/.test(a.id) ? Number(a.id) : undefined;
      const idx = list.findIndex((x) => x.source === src && x.id === id);
      if (s.negated) {
        if (idx >= 0) list.splice(idx, 1);
      } else {
        const entry: RedistCfg = {
          source: src,
          id,
          subnets: true,
          bw: a.bw !== undefined ? Number(a.bw) : undefined,
          delay: a.dly !== undefined ? Number(a.dly) : undefined,
          routeMap: a.rm,
        };
        if (idx >= 0) list[idx] = entry;
        else list.push(entry);
      }
      touch(s);
    },
  });

  // ------------------------------------------------------------ show ipv6 eigrp
  const sh = (word: string, help: string, run: (s: CliSession) => string[]): void => {
    r.add({
      modes: U,
      only: 'l3',
      slots: [
        K('show', 'Show running system information'),
        IPV6,
        K('eigrp', 'IPv6-EIGRP show commands'),
        K(word, help),
      ],
      run: (s) => s.outLines(run(s)),
    });
  };
  sh('neighbors', 'IPv6-EIGRP neighbors', (s) => showEigrp6.neighbors(s.engine, s.device));
  sh('topology', 'IPv6-EIGRP Topology Table', (s) => showEigrp6.topology(s.engine, s.device));
  sh('interfaces', 'IPv6-EIGRP interfaces', (s) => showEigrp6.interfaces(s.engine, s.device));
}
