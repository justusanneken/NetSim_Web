import { isValidIpv4, parseIpv4 } from '@netsim/protocols';
import type { IfaceCfg } from '@netsim/engine';
import { targets } from './commands';
import { l3c, touch } from './commandsGaps';
import { resolveIface, IFM } from './ifnames';
import { K, P, choice, opt, type ModeId, type Registry } from './parser';
import { CliError, type CliSession } from './session';
import { showPppoeSession } from './showProto';

const CF: ModeId[] = ['config'];
const BB: ModeId[] = ['config-bba'];
const U: ModeId[] = ['user', 'priv'];
const P_EXEC: ModeId[] = ['priv'];

/** Interface-Konfiguration anlegen/ändern (ohne die Konfiguration anzulegen, wenn sie fehlt). */
function withIface(s: CliSession, f: (ic: IfaceCfg, id: string) => void): void {
  for (const id of targets(s)) {
    s.engine.ensureIface(s.deviceId, id);
    const ic = l3c(s).ifaces[id];
    if (ic) f(ic, id);
  }
  touch(s);
}

const dialer = (ic: IfaceCfg): NonNullable<IfaceCfg['dialer']> => {
  if (ic.kind !== 'dialer') throw new CliError('% This command applies to Dialer interfaces only');
  return (ic.dialer ??= { pool: 1 });
};
const vtemplate = (ic: IfaceCfg): NonNullable<IfaceCfg['vtemplate']> => {
  if (ic.kind !== 'vtemplate')
    throw new CliError('% This command applies to Virtual-Template interfaces only');
  return (ic.vtemplate ??= { chap: false });
};

/** PPPoE: Dialer (Client), `bba-group pppoe` / Virtual-Template (Server), `show pppoe session`. */
export function addPppoe(r: Registry<CliSession>): void {
  // ------------------------------------------------------------ Server: Gruppen und Pools
  r.add({
    modes: CF,
    only: 'router',
    negatable: true,
    slots: [
      K('bba-group', 'Configure BBA group'),
      K('pppoe', 'PPP over Ethernet'),
      P('name', 'word', 'WORD', 'BBA group name'),
    ],
    run: (s, a) => {
      const c = l3c(s);
      const name = a.name as string;
      if (s.negated) {
        if (c.bba) delete c.bba[name];
        touch(s);
        return;
      }
      (c.bba ??= {})[name] ??= { name };
      s.poolName = name;
      s.mode = 'config-bba';
    },
  });
  r.add({
    modes: BB,
    only: 'router',
    negatable: true,
    slots: [
      K('virtual-template', 'Virtual template for PPPoE sessions'),
      P('n', 'int', '<1-200>', 'Virtual-Template number', [1, 200]),
    ],
    run: (s, a) => {
      const g = l3c(s).bba?.[s.poolName];
      if (!g) throw new CliError('% BBA group does not exist');
      g.template = s.negated ? undefined : Number(a.n);
      touch(s);
    },
  });
  r.add({
    modes: CF,
    only: 'router',
    negatable: true,
    slots: [
      K('ip', 'Global IP configuration subcommands'),
      K('local', 'Specify local options'),
      K('pool', 'IP Local address pool lists'),
      P('name', 'word', 'WORD', 'Name of the pool'),
      opt(P('start', 'ip', 'A.B.C.D', 'Low IP address')),
      opt(P('end', 'ip', 'A.B.C.D', 'High IP address')),
    ],
    run: (s, a) => {
      const c = l3c(s);
      const name = a.name as string;
      if (s.negated) {
        if (c.ipPools) delete c.ipPools[name];
        touch(s);
        return;
      }
      if (!a.start || !isValidIpv4(a.start)) throw new CliError('% Incomplete command.');
      if (a.end && (parseIpv4(a.end) ?? 0) < (parseIpv4(a.start) ?? 0))
        throw new CliError('%End address less than starting address');
      (c.ipPools ??= {})[name] = { name, start: a.start, end: a.end ?? a.start };
      touch(s);
    },
  });

  // ------------------------------------------------------------ Schnittstellen
  for (const [word, prefix, help] of [
    ['dialer', 'di', 'Dialer interface'],
    ['virtual-template', 'vt', 'Virtual Template interface'],
  ] as const) {
    r.add({
      modes: CF,
      only: 'router',
      negatable: true,
      slots: [
        K('interface', 'Select an interface to configure'),
        K(word, help),
        P('n', 'int', '<0-255>', `${help} number`, [0, 255]),
      ],
      run: (s, a) => {
        const id = `${prefix}${Number(a.n)}`;
        if (s.negated) {
          delete l3c(s).ifaces[id];
          touch(s);
          return;
        }
        s.engine.ensureIface(s.deviceId, id);
        s.ifaces = [id];
        s.mode = 'config-if';
      },
    });
  }
  r.add({
    // Nicht im Subinterface-Modus: dort gehört `encapsulation` zu `encapsulation dot1Q <vlan>` (Router-on-a-Stick)
    modes: ['config-if', 'config-if-range'],
    only: 'router',
    negatable: true,
    slots: [
      K('encapsulation', 'Set encapsulation type for an interface'),
      K('ppp', 'Point-to-Point protocol'),
    ],
    run: (s) => {
      withIface(s, (ic) => {
        if (ic.kind === 'dialer') dialer(ic);
      });
    },
  });
  r.add({
    modes: IFM,
    only: 'router',
    negatable: true,
    slots: [
      K('ip', 'Interface Internet Protocol config commands'),
      K('address', 'Set the IP address of an interface'),
      K('negotiated', 'IP Address negotiated over PPP'),
    ],
    run: (s) => {
      withIface(s, (ic) => {
        dialer(ic).negotiated = !s.negated;
      });
    },
  });
  r.add({
    modes: IFM,
    only: 'router',
    negatable: true,
    slots: [
      K('dialer', 'Dial-on-demand routing (DDR) commands'),
      K('pool', 'Dialer pool'),
      P('n', 'int', '<1-255>', 'Dialer pool number', [1, 255]),
    ],
    run: (s, a) => {
      withIface(s, (ic) => {
        dialer(ic).pool = s.negated ? 1 : Number(a.n);
      });
    },
  });
  r.add({
    modes: IFM,
    only: 'router',
    negatable: true,
    slots: [
      K('ppp', 'Point-to-Point Protocol'),
      K('chap', 'CHAP authentication'),
      K('hostname', 'Set CHAP hostname'),
      P('name', 'word', 'WORD', 'Hostname for CHAP'),
    ],
    run: (s, a) => {
      withIface(s, (ic) => {
        dialer(ic).chapUser = s.negated ? undefined : (a.name as string);
      });
    },
  });
  r.add({
    modes: IFM,
    only: 'router',
    negatable: true,
    slots: [
      K('ppp', 'Point-to-Point Protocol'),
      K('chap', 'CHAP authentication'),
      K('password', 'Set CHAP password'),
      opt(P('lead', 'word', '0|7', 'Encryption type / password')),
      opt(P('pw', 'word', 'LINE', 'Password')),
    ],
    run: (s, a) => {
      withIface(s, (ic) => {
        const pw = a.pw ?? a.lead;
        if (!s.negated && pw === undefined) throw new CliError('% Incomplete command.');
        dialer(ic).chapPass = s.negated ? undefined : pw;
      });
    },
  });
  r.add({
    modes: IFM,
    only: 'router',
    negatable: true,
    slots: [
      K('ppp', 'Point-to-Point Protocol'),
      K('ipcp', 'Set IPCP negotiation options'),
      K('route', 'Install a route'),
      K('default', 'Default route'),
    ],
    run: (s) => {
      withIface(s, (ic) => {
        dialer(ic).ipcpRoute = !s.negated;
      });
    },
  });
  r.add({
    modes: IFM,
    only: 'router',
    negatable: true,
    slots: [
      K('ppp', 'Point-to-Point Protocol'),
      K('authentication', 'Set authentication method'),
      choice('m', ['chap', 'Challenge Handshake Authentication Protocol (CHAP)']),
      opt(K('callin', 'Authentication on incoming call only')),
    ],
    run: (s) => {
      withIface(s, (ic) => {
        vtemplate(ic).chap = !s.negated;
      });
    },
  });
  r.add({
    modes: IFM,
    only: 'router',
    negatable: true,
    slots: [
      K('peer', 'Peer parameters for point-to-point interfaces'),
      K('default', 'Default parameters for peer'),
      K('ip', 'Default IP address'),
      K('address', 'Specify default IP address'),
      K('pool', 'Use pool of addresses'),
      P('pool', 'word', 'WORD', 'Pool name'),
    ],
    run: (s, a) => {
      withIface(s, (ic) => {
        vtemplate(ic).pool = s.negated ? undefined : (a.pool as string);
      });
    },
  });
  r.add({
    modes: IFM,
    only: 'router',
    negatable: true,
    slots: [
      K('ip', 'Interface Internet Protocol config commands'),
      K('unnumbered', 'Enable IP processing without an explicit address'),
      P('if', 'iface', 'IFNAME', 'Interface name'),
    ],
    run: (s, a) => {
      // `no ip unnumbered` (ohne Schnittstelle) ist wie bei IOS gültig
      const ref = s.negated ? undefined : resolveIface(s.device, a.if as string);
      if (!s.negated && !ref) throw new CliError('% Invalid interface');
      withIface(s, (ic) => {
        vtemplate(ic).unnumbered = ref?.id;
      });
    },
  });
  r.add({
    modes: IFM,
    only: 'router',
    negatable: true,
    slots: [
      K('pppoe-client', 'PPPoE client'),
      K('dial-pool-number', 'Dialer pool number'),
      P('n', 'int', '<1-255>', 'Dialer pool number', [1, 255]),
    ],
    run: (s, a) => {
      withIface(s, (ic) => {
        ic.pppoeClientPool = s.negated ? undefined : Number(a.n);
      });
    },
  });
  r.add({
    modes: IFM,
    only: 'router',
    negatable: true,
    slots: [
      K('pppoe', 'PPP over Ethernet'),
      K('enable', 'Enable PPPoE on this interface'),
      opt(K('group', 'Use a BBA group')),
      opt(P('group', 'word', 'WORD', 'BBA group name')),
    ],
    run: (s, a) => {
      withIface(s, (ic) => {
        ic.pppoeGroup = s.negated ? undefined : (a.group ?? 'global');
      });
    },
  });

  // `ip route 0.0.0.0 0.0.0.0 dialer 1` (Schnittstellenname in zwei Wörtern)
  r.add({
    modes: CF,
    only: 'router',
    negatable: true,
    slots: [
      K('ip', 'Global IP configuration subcommands'),
      K('route', 'Establish static routes'),
      P('prefix', 'ip', 'A.B.C.D', 'Destination prefix'),
      P('mask', 'mask', 'A.B.C.D', 'Destination prefix mask'),
      K('dialer', 'Dialer interface'),
      P('n', 'int', '<0-255>', 'Dialer interface number', [0, 255]),
      opt(P('ad', 'int', '<1-255>', 'Distance metric for this route', [1, 255])),
    ],
    run: (s, a) => {
      const route = {
        prefix: a.prefix as string,
        mask: a.mask as string,
        outIfaceId: `di${Number(a.n)}`,
        ad: a.ad ? Number(a.ad) : 1,
      };
      const res = s.negated
        ? s.engine.removeStaticRoute(s.deviceId, route)
        : s.engine.addStaticRoute(s.deviceId, route);
      if (!res.ok) throw new CliError('% Invalid route');
    },
  });

  // ------------------------------------------------------------ show / clear
  r.add({
    modes: U,
    only: 'router',
    slots: [
      K('show', 'Show running system information'),
      K('pppoe', 'PPPoE information'),
      K('session', 'PPPoE session information'),
      opt(choice('all', ['all', 'Show all sessions'])),
    ],
    run: (s) => s.outLines(showPppoeSession(s.device)),
  });
  r.add({
    modes: P_EXEC,
    only: 'router',
    slots: [
      K('clear', 'Reset functions'),
      K('pppoe', 'PPPoE information'),
      choice('what', ['all', 'Clear all PPPoE sessions']),
    ],
    run: (s) => s.engine.clearPppoe(s.deviceId),
  });
}
