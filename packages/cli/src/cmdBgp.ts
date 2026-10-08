import { isValidIpv4, isValidIpv6, normalizeIpv6 } from '@netsim/protocols';
import type { BgpCfg, BgpNbrCfg } from '@netsim/engine';
import { l3c, touch } from './commandsGaps';
import { K, P, choice, opt, type ModeId, type Registry } from './parser';
import { CliError, type CliSession } from './session';
import * as show4 from './show4';

const BGPM: ModeId[] = ['config-bgp', 'config-bgp-af6'];

function bgpOf(s: CliSession): BgpCfg {
  const c = l3c(s).routing.bgp;
  if (!c) throw new CliError('% BGP is not running');
  return c;
}
function nbrOf(s: CliSession, ip: string): BgpNbrCfg {
  const n = bgpOf(s).neighbors[ip];
  if (!n) throw new CliError('%BGP: Specify remote-as or peer-group commands first');
  return n;
}

/** BGP-Policies, Route Reflector, Communities und die IPv6-Adressfamilie. */
export function addBgpGaps(r: Registry<CliSession>): void {
  const NB = [
    K('neighbor', 'Specify a neighbor router'),
    P('ip', 'ip', 'A.B.C.D', 'Neighbor address'),
  ];
  const upd = (s: CliSession, ip: string, f: (n: BgpNbrCfg) => void): void => {
    f(nbrOf(s, ip));
    touch(s);
  };
  for (const [word, help, key] of [
    ['prefix-list', 'Filter updates based on prefix list', 'prefixList'],
    ['route-map', 'Apply route map to neighbor', 'routeMap'],
  ] as const) {
    r.add({
      modes: BGPM,
      only: 'l3',
      negatable: true,
      slots: [
        ...NB,
        K(word, help),
        P(
          'name',
          'word',
          'WORD',
          word === 'route-map' ? 'Name of route map' : 'Name of a prefix list',
        ),
        choice('dir', ['in', 'Filter incoming updates'], ['out', 'Filter outgoing updates']),
      ],
      run: (s, a) =>
        upd(s, a.ip as string, (n) => {
          const field = `${key}${a.dir === 'in' ? 'In' : 'Out'}` as
            'prefixListIn' | 'prefixListOut' | 'routeMapIn' | 'routeMapOut';
          n[field] = s.negated ? undefined : (a.name as string);
        }),
    });
  }
  r.add({
    modes: BGPM,
    only: 'l3',
    negatable: true,
    slots: [
      ...NB,
      K('send-community', 'Send Community attribute to this neighbor'),
      opt(
        choice(
          'kind',
          ['both', 'Send Standard and Extended Community attributes'],
          ['standard', 'Send Standard Community attribute'],
          ['extended', 'Send Extended Community attribute'],
        ),
      ),
    ],
    run: (s, a) => upd(s, a.ip as string, (n) => (n.sendCommunity = !s.negated)),
  });
  r.add({
    modes: BGPM,
    only: 'l3',
    negatable: true,
    slots: [...NB, K('route-reflector-client', 'Configure a neighbor as Route Reflector client')],
    run: (s, a) => upd(s, a.ip as string, (n) => (n.rrClient = !s.negated)),
  });
  r.add({
    modes: BGPM,
    only: 'l3',
    negatable: true,
    slots: [
      ...NB,
      K('soft-reconfiguration', 'Per neighbor soft reconfiguration'),
      K('inbound', 'Allow inbound soft reconfiguration for this neighbor'),
    ],
    run: (s, a) => upd(s, a.ip as string, () => undefined),
  });
  r.add({
    modes: ['config-bgp'],
    only: 'l3',
    negatable: true,
    slots: [
      K('bgp', 'BGP specific commands'),
      K('cluster-id', 'Configure Route-Reflector Cluster-id'),
      P('id', 'ip', 'A.B.C.D', 'Route-Reflector Cluster-id in IP address format'),
    ],
    run: (s, a) => {
      bgpOf(s).clusterId = s.negated ? undefined : (a.id as string);
      if (!s.negated && !isValidIpv4(a.id as string)) throw new CliError('% Invalid cluster-id');
      touch(s);
    },
  });

  // ------------------------------------------------------------ address-family ipv6
  r.add({
    modes: ['config-bgp'],
    only: 'l3',
    slots: [
      K('address-family', 'Enter Address Family command mode'),
      K('ipv6', 'Address family'),
      opt(K('unicast', 'Address Family modifier')),
    ],
    run: (s) => {
      bgpOf(s);
      s.mode = 'config-bgp-af6';
    },
  });
  r.add({
    modes: ['config-bgp'],
    only: 'l3',
    slots: [
      K('address-family', 'Enter Address Family command mode'),
      K('ipv4', 'Address family'),
      opt(K('unicast', 'Address Family modifier')),
    ],
    run: () => undefined,
  });
  r.add({
    modes: ['config-bgp-af6'],
    only: 'l3',
    slots: [K('exit-address-family', 'Exit from Address Family configuration mode')],
    run: (s) => {
      s.mode = 'config-bgp';
    },
  });
  r.add({
    modes: ['config-bgp-af6'],
    only: 'l3',
    negatable: true,
    slots: [...NB, K('activate', 'Enable the Address Family for this Neighbor')],
    run: (s, a) => upd(s, a.ip as string, (n) => (n.activate6 = !s.negated)),
  });
  r.add({
    modes: ['config-bgp-af6'],
    only: 'l3',
    negatable: true,
    slots: [
      K('network', 'Specify a network to announce via BGP'),
      P('p', 'prefix6', 'X:X:X:X::X/<0-128>', 'IPv6 prefix <network>/<length>'),
    ],
    run: (s, a) => {
      const c = bgpOf(s);
      const [addr, len] = (a.p as string).split('/') as [string, string];
      if (!isValidIpv6(addr)) throw new CliError('% Invalid IPv6 prefix');
      const prefix = normalizeIpv6(addr) ?? addr;
      c.networks6 = (c.networks6 ?? []).filter(
        (x) => !(x.prefix === prefix && x.plen === Number(len)),
      );
      if (!s.negated) c.networks6.push({ prefix, plen: Number(len) });
      touch(s);
    },
  });

  // ------------------------------------------------------------ show
  const SHOW = K('show', 'Show running system information');
  const U: ModeId[] = ['user', 'priv'];
  r.add({
    modes: U,
    only: 'l3',
    slots: [
      SHOW,
      K('bgp', 'BGP information'),
      K('ipv6', 'Address family'),
      K('unicast', 'Address Family modifier'),
    ],
    run: (s) => s.outLines(show4.showBgp6(s.engine, s.device)),
  });
  r.add({
    modes: U,
    only: 'l3',
    slots: [
      SHOW,
      K('bgp', 'BGP information'),
      K('ipv6', 'Address family'),
      K('unicast', 'Address Family modifier'),
      K('summary', 'Summary of BGP neighbor status'),
    ],
    run: (s) => s.outLines(show4.showBgpSummary(s.engine, s.device)),
  });
  r.add({
    modes: U,
    only: 'l3',
    slots: [
      SHOW,
      K('ip', 'IP information'),
      K('bgp', 'BGP information'),
      P('net', 'ip', 'A.B.C.D', 'Network in the BGP routing table to display'),
    ],
    run: (s, a) => s.outLines(show4.showBgpDetail(s.device, a.net as string)),
  });
}
