/** WAN-Befehle: Serial (`clock rate`, `encapsulation hdlc`, PAP), `show controllers`, Dialer-Anzeige. */
import type { IfaceCfg, SerialCfg } from '@netsim/engine';
import { targets } from './commands';
import { l3c, touch } from './commandsGaps';
import { resolveIface, IFM } from './ifnames';
import { K, P, opt, type Registry } from './parser';
import { CliError, type CliSession } from './session';
import {
  showControllers,
  showControllerSerial,
  showDialerInterface,
  showSerialInterface,
} from './showWan';

const U = ['user', 'priv'] as const;
const CLOCK_RATES = [
  1200, 2400, 4800, 9600, 19200, 38400, 56000, 64000, 72000, 125000, 128000, 148000, 250000, 500000,
  800000, 1000000, 1300000, 2000000, 4000000,
];

/** Serial-Konfiguration der Zielschnittstellen; Fehler, wenn keine Serial-Schnittstelle gewählt ist. */
function eachSerial(s: CliSession, f: (sc: SerialCfg, ic: IfaceCfg, id: string) => void): void {
  for (const id of targets(s)) {
    const p = s.device.ports.find((x) => x.id === id);
    if (p?.kind !== 'serial') throw new CliError("% Invalid input detected at '^' marker.");
    s.engine.ensureIface(s.deviceId, id);
    const ic = l3c(s).ifaces[id];
    if (!ic) continue;
    f((ic.serial ??= { encap: 'hdlc' }), ic, id);
  }
  touch(s);
  s.engine.refreshLinks();
}

export function addWan(r: Registry<CliSession>): void {
  r.add({
    modes: IFM,
    only: 'router',
    negatable: true,
    slots: [
      K('clock', 'Configure serial interface clock'),
      K('rate', 'Configure serial interface clock speed'),
      P('rate', 'int', '<1200-4000000>', 'Choose clockrate from list above', [1200, 4000000]),
    ],
    run: (s, a) => {
      eachSerial(s, (sc, _ic, id) => {
        if (s.engine.serialRole(s.deviceId, id) === 'dte')
          throw new CliError('%Error: This command applies only to DCE interfaces');
        if (!s.negated && !CLOCK_RATES.includes(Number(a.rate)))
          throw new CliError(
            `Speed (bits per second) of ${a.rate} is not valid. Valid values are: ${CLOCK_RATES.join(' ')}`,
          );
        sc.clockRate = s.negated ? undefined : Number(a.rate);
      });
    },
  });
  r.add({
    modes: IFM,
    only: 'router',
    negatable: true,
    slots: [
      K('encapsulation', 'Set encapsulation type for an interface'),
      K('hdlc', 'Serial HDLC synchronous'),
    ],
    run: (s) => {
      for (const id of targets(s)) {
        const p = s.device.ports.find((x) => x.id === id);
        if (p?.kind !== 'serial')
          throw new CliError('% Encapsulation HDLC is not supported on this interface');
      }
      eachSerial(s, (sc) => {
        sc.encap = 'hdlc';
      });
    },
  });
  r.add({
    modes: IFM,
    only: 'router',
    negatable: true,
    slots: [
      K('keepalive', 'Enable keepalive'),
      opt(P('sec', 'int', '<0-32767>', 'Keepalive period (default 10 seconds)', [0, 32767])),
    ],
    run: (s, a) => {
      for (const id of targets(s)) {
        const p = s.device.ports.find((x) => x.id === id);
        if (p?.kind !== 'serial') continue;
        s.engine.ensureIface(s.deviceId, id);
        const ic = l3c(s).ifaces[id];
        if (!ic) continue;
        const sc = (ic.serial ??= { encap: 'hdlc' });
        sc.keepalive = s.negated ? 0 : a.sec === undefined ? undefined : Number(a.sec);
        if (sc.keepalive === 10) sc.keepalive = undefined;
      }
      touch(s);
    },
  });
  r.add({
    modes: IFM,
    only: 'router',
    negatable: true,
    slots: [
      K('ppp', 'Point-to-Point Protocol'),
      K('pap', 'PAP authentication'),
      K('sent-username', 'Set PAP username and password to send'),
      P('user', 'word', 'WORD', 'Username'),
      // optional (benannt), damit `no ppp pap sent-username` wie bei IOS gilt
      opt({ ...K('password', 'Set PAP password'), name: 'pwkw' }),
      opt(P('lead', 'word', '0|7', 'Encryption type / password')),
      opt(P('pw', 'word', 'LINE', 'Password')),
    ],
    run: (s, a) => {
      eachSerial(s, (sc) => {
        if (s.negated) {
          sc.papUser = undefined;
          sc.papPass = undefined;
          return;
        }
        const pw = a.pw ?? a.lead;
        if (pw === undefined || a.pwkw === undefined) throw new CliError('% Incomplete command.');
        sc.papUser = a.user as string;
        sc.papPass = pw;
      });
    },
  });

  // ------------------------------------------------------------ EIGRP-Timer je Schnittstelle
  for (const [word, help, key] of [
    ['hello-interval', 'Configures EIGRP-IPv4 hello interval', 'hello'],
    ['hold-time', 'Configures EIGRP-IPv4 hold time', 'hold'],
  ] as const) {
    r.add({
      modes: IFM,
      only: 'router',
      negatable: true,
      slots: [
        K('ip', 'Interface Internet Protocol config commands'),
        K(word, help),
        K('eigrp', 'EIGRP-IPv4 interface subcommands'),
        P('asn', 'int', '<1-65535>', 'Autonomous system number', [1, 65535]),
        P('sec', 'int', '<1-65535>', 'Seconds', [1, 65535]),
      ],
      run: (s, a) => {
        for (const id of targets(s)) {
          s.engine.ensureIface(s.deviceId, id);
          const ic = l3c(s).ifaces[id];
          if (!ic) continue;
          const t = ((ic.eigrpTimers ??= {})[Number(a.asn)] ??= {});
          t[key] = s.negated ? undefined : Number(a.sec);
          if (t.hello === undefined && t.hold === undefined) delete ic.eigrpTimers?.[Number(a.asn)];
        }
        // Hello-Timer neu aufbauen
        for (const p of Object.values(l3c(s).routing.eigrp)) p.helloIfs = [];
        touch(s);
      },
    });
  }

  // ------------------------------------------------------------ show
  const SHOW = K('show', 'Show running system information');
  r.add({
    modes: [...U],
    only: 'router',
    slots: [
      SHOW,
      K('controllers', 'Interface controller status'),
      opt(K('serial', 'Serial interface')),
      opt(P('n', 'word', 'slot/subslot/port', 'Serial interface number')),
    ],
    run: (s, a) => {
      if (a.n === undefined) {
        s.outLines(showControllers(s.engine, s.device));
        return;
      }
      const ref = resolveIface(s.device, `serial${a.n ?? ''}`);
      const p = ref ? s.device.ports.find((x) => x.id === ref.id) : undefined;
      if (!p || p.kind !== 'serial') throw new CliError('% Invalid interface');
      s.outLines(showControllerSerial(s.engine, s.device, p));
    },
  });
  r.add({
    modes: [...U],
    only: 'router',
    slots: [
      SHOW,
      K('interfaces', 'Interface status and configuration'),
      K('serial', 'Serial interface'),
      P('n', 'word', 'slot/subslot/port', 'Serial interface number'),
    ],
    run: (s, a) => {
      const ref = resolveIface(s.device, `serial${a.n}`);
      const p = ref ? s.device.ports.find((x) => x.id === ref.id) : undefined;
      if (!p || p.kind !== 'serial') throw new CliError('% Invalid interface');
      s.outLines(showSerialInterface(s.device, p));
    },
  });
  r.add({
    modes: [...U],
    only: 'router',
    slots: [
      SHOW,
      K('interfaces', 'Interface status and configuration'),
      K('dialer', 'Dialer interface'),
      P('n', 'int', '<0-255>', 'Dialer interface number', [0, 255]),
    ],
    run: (s, a) => {
      const lines = showDialerInterface(s.device, `di${a.n}`);
      if (!lines.length) throw new CliError('% Invalid interface');
      s.outLines(lines);
    },
  });
}
