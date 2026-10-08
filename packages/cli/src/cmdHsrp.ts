import { isValidIpv6, normalizeIpv6 } from '@netsim/protocols';
import { newHsrp } from '@netsim/engine';
import { targets } from './commands';
import { l3c, touch } from './commandsGaps';
import { K, P, opt, type Registry } from './parser';
import { CliError, type CliSession } from './session';

const IFM = ['config-if', 'config-subif', 'config-if-range'] as const;
const STBY = K('standby', 'HSRP interface configuration commands');

/** HSRP-Erweiterungen: Version 2, Authentifizierung und IPv6-Gruppen. */
export function addHsrpGaps(r: Registry<CliSession>): void {
  r.add({
    modes: [...IFM],
    only: 'l3',
    negatable: true,
    slots: [STBY, K('version', 'HSRP version'), P('v', 'int', '<1-2>', 'Version number', [1, 2])],
    run: (s, a) => {
      for (const id of targets(s)) {
        s.engine.ensureIface(s.deviceId, id);
        const ic = l3c(s).ifaces[id];
        if (!ic) continue;
        const v = s.negated ? 1 : (Number(a.v) as 1 | 2);
        if (v === 1) {
          const big = Object.keys(ic.hsrp ?? {}).some((g) => Number(g) > 255);
          if (big || Object.keys(ic.hsrp6 ?? {}).length > 0)
            throw new CliError('% Remove groups above 255 and IPv6 groups before using version 1');
        }
        ic.hsrpVersion = v === 2 ? 2 : undefined;
      }
      touch(s);
    },
  });
  r.add({
    modes: [...IFM],
    only: 'l3',
    negatable: true,
    slots: [
      STBY,
      P('g', 'int', '<0-4095>', 'group number', [0, 4095]),
      K('authentication', 'Authentication'),
      opt(K('text', 'Plain text authentication')),
      opt(P('key', 'word', 'WORD', 'Plain text authentication string (8 chars max)')),
    ],
    run: (s, a) => {
      const group = Number(a.g);
      for (const id of targets(s)) {
        s.engine.ensureIface(s.deviceId, id);
        const ic = l3c(s).ifaces[id];
        if (!ic) continue;
        if (!s.negated && !a.key) throw new CliError('% Incomplete command.');
        const gs = [ic.hsrp?.[group], ic.hsrp6?.[group]].filter((x) => !!x);
        if (gs.length === 0) {
          if (s.negated) continue;
          ic.hsrp ??= {};
          gs.push((ic.hsrp[group] = newHsrp(group)));
        }
        for (const g of gs) if (g) g.authKey = s.negated ? undefined : (a.key as string);
      }
      touch(s);
    },
  });
  r.add({
    modes: [...IFM],
    only: 'l3',
    negatable: true,
    slots: [
      STBY,
      P('g', 'int', '<0-4095>', 'group number', [0, 4095]),
      K('ipv6', 'Enable HSRP IPv6'),
      opt(P('addr', 'word', 'X:X:X:X::X | autoconfig', 'IPv6 address or "autoconfig"')),
    ],
    run: (s, a) => {
      const group = Number(a.g);
      for (const id of targets(s)) {
        s.engine.ensureIface(s.deviceId, id);
        const ic = l3c(s).ifaces[id];
        if (!ic) continue;
        if (s.negated) {
          if (ic.hsrp6) delete ic.hsrp6[group];
          if (ic.hsrp6 && Object.keys(ic.hsrp6).length === 0) ic.hsrp6 = undefined;
          continue;
        }
        if ((ic.hsrpVersion ?? 1) !== 2)
          throw new CliError('% HSRP for IPv6 requires HSRP version 2 (standby version 2)');
        const addr = a.addr as string | undefined;
        if (!addr) throw new CliError('% Incomplete command.');
        const auto = 'autoconfig'.startsWith(addr.toLowerCase()) && addr.length > 1;
        if (!auto && !isValidIpv6(addr)) throw new CliError('% Invalid IPv6 address');
        const src = ic.hsrp?.[group];
        ic.hsrp6 ??= {};
        const g = (ic.hsrp6[group] ??= {
          ...newHsrp(group),
          ...(src
            ? {
                priority: src.priority,
                preempt: src.preempt,
                helloSec: src.helloSec,
                holdSec: src.holdSec,
                track: src.track.map((t) => ({ ...t })),
                name: src.name,
                authKey: src.authKey,
              }
            : {}),
        });
        g.v6 = true;
        g.autoconfig = auto || undefined;
        g.vip = auto ? undefined : (normalizeIpv6(addr) ?? addr);
      }
      touch(s);
    },
  });
}
