import { K, P, opt, type ModeId, type Registry } from './parser';
import { CliError, type CliSession } from './session';
import type { RouterConfig, SwitchConfig } from '@netsim/engine';
import { addRouteMap } from './cmdRouteMap';
import { addOspfAreas } from './cmdOspf';
import { addHsrpGaps } from './cmdHsrp';
import { addBgpGaps } from './cmdBgp';
import * as showGaps from './showGaps';

/**
 * Befehle, die die bekannten Lücken der Phasen 1–4 schließen (ECMP, OSPF-Bereichstypen,
 * Route-Maps/Prefix-Lists, HSRPv2/IPv6, BGP-Policies, DAD/DHCPv6/RIPng, `clock set` …).
 */

type L3Conf = RouterConfig | SwitchConfig;
export const l3c = (s: CliSession): L3Conf => s.device.config;
export const touch = (s: CliSession): void => s.engine.routingChanged(s.deviceId);

export function addGaps(r: Registry<CliSession>): void {
  // ------------------------------------------------------------ ECMP: maximum-paths
  const MP: [ModeId, number][] = [
    ['config-rip', 4],
    ['config-ospf', 4],
    ['config-ospf6', 4],
    ['config-eigrp', 4],
    ['config-bgp', 1],
  ];
  for (const [mode, def] of MP) {
    r.add({
      modes: [mode],
      only: 'l3',
      negatable: true,
      slots: [
        K('maximum-paths', 'Forward packets over multiple paths'),
        P('n', 'int', '<1-32>', 'Number of paths', [1, 32]),
      ],
      run: (s, a) => {
        const rt = l3c(s).routing;
        const c =
          mode === 'config-rip'
            ? rt.rip
            : mode === 'config-ospf'
              ? rt.ospf[s.procId]
              : mode === 'config-ospf6'
                ? rt.ospf6[s.procId]
                : mode === 'config-eigrp'
                  ? rt.eigrp[s.procId]
                  : rt.bgp;
        if (!c) throw new CliError('% Routing process is not running');
        const n = s.negated ? def : Number(a.n);
        c.maxPaths = n === def ? undefined : n;
        if ('dirty' in c) c.dirty = true;
        touch(s);
      },
    });
  }
  addRouteMap(r);
  addOspfAreas(r);
  addHsrpGaps(r);
  addBgpGaps(r);
  // ------------------------------------------------------------ show (Policies)
  const SHOW = K('show', 'Show running system information');
  const U: ModeId[] = ['user', 'priv'];
  for (const v6 of [false, true]) {
    r.add({
      modes: U,
      only: 'l3',
      slots: [
        SHOW,
        K(v6 ? 'ipv6' : 'ip', 'IP information'),
        K('prefix-list', 'List IP prefix lists'),
        opt(P('name', 'word', 'WORD', 'Name of a prefix list')),
      ],
      run: (s, a) =>
        s.outLines(
          showGaps.showPrefixLists(
            v6 ? l3c(s).routing.prefixLists6 : l3c(s).routing.prefixLists,
            a.name,
            v6,
          ),
        ),
    });
  }
  r.add({
    modes: U,
    only: 'l3',
    slots: [
      SHOW,
      K('route-map', 'route-map information'),
      opt(P('name', 'word', 'WORD', 'route-map name')),
    ],
    run: (s, a) => s.outLines(showGaps.showRouteMaps(l3c(s).routing.routeMaps, a.name)),
  });
  r.add({
    modes: U,
    only: 'l3',
    slots: [
      SHOW,
      K('ip', 'IP information'),
      K('community-list', 'List community-list'),
      opt(P('name', 'word', 'WORD', 'Community-list name')),
    ],
    run: (s, a) => s.outLines(showGaps.showCommunityLists(l3c(s).routing, a.name)),
  });
}
