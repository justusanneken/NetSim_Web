import { K, P, opt, type ModeId, type Registry } from './parser';
import { CliError, type CliSession } from './session';
import type { RouterConfig, SwitchConfig } from '@netsim/engine';

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
  void opt;
}
