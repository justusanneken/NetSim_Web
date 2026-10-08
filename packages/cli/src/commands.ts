import { maskToPrefix } from '@netsim/protocols';
import type { Port } from '@netsim/engine';
import { networkOf } from '@netsim/engine';
import { resolvePort } from './format';
import { waitFor } from './util';
import { K, P, R, Registry, choice, opt, type ModeId } from './parser';
import { renderRunningConfig } from './render';
import { secretHash, type7Decrypt } from './secrets';
import { CliError, type CliSession } from './session';
import * as show from './show';

const U: ModeId[] = ['user', 'priv'];
const PR: ModeId[] = ['priv'];
const CF: ModeId[] = ['config'];
const IF: ModeId[] = ['config-if'];
const LN: ModeId[] = ['config-line'];
const ANYCFG: ModeId[] = ['config', 'config-if', 'config-line'];

const SHOW = K('show', 'Show running system information');

const portOf = (s: CliSession, text: string): Port => {
  const p = resolvePort(s.device.ports, text);
  if (!p) throw new CliError('% Invalid interface');
  return p;
};

function saveStartup(s: CliSession): void {
  s.sys.startupConfig = renderRunningConfig(s.engine, s.device).join('\n');
}

const confirm = (a: string): boolean => a.trim() === '' || /^y/i.test(a.trim());

function logout(s: CliSession): void {
  s.out('');
  s.out('');
  s.out('');
  s.out(`${s.sys.hostname} con0 is now available`);
  s.out('');
  s.out('');
  s.out('');
  s.out('Press RETURN to get started.');
  s.out('');
  s.mode = 'user';
}

function engineError(r: { error: string; params?: Record<string, string | number> }): CliError {
  const p = r.params ?? {};
  switch (r.error) {
    case 'ip.overlap':
      return new CliError(`% ${p.net} overlaps with ${p.port}`);
    case 'ip.networkAddress':
      return new CliError('Bad mask for address');
    case 'ip.invalidMtu':
      return new CliError('% Invalid MTU');
    default:
      return new CliError('% Invalid input');
  }
}

// ---------------------------------------------------------------- Ping / Traceroute

interface PingParams {
  count: number;
  size: number;
  df: boolean;
  source?: string;
  timeoutSec: number;
}

export function runPing(s: CliSession, dst: string, o: PingParams): void {
  const e = s.engine;
  const d = s.device;
  const r = e.ping(d.id, dst, {
    count: o.count,
    dataSize: Math.max(0, o.size - 28),
    df: o.df,
    source: o.source,
    intervalUs: 100_000,
    timeoutUs: o.timeoutSec * 1_000_000,
  });
  s.out('Type escape sequence to abort.');
  s.out(
    `Sending ${o.count}, ${o.size}-byte ICMP Echos to ${dst}, timeout is ${o.timeoutSec} seconds:`,
  );
  if (!r.ok) {
    s.out('% ' + r.error);
    return;
  }
  const cfg = d.config;
  if (cfg.kind !== 'router') return;
  if (s.deferred()) {
    s.out('Simulation mode: packets were queued. Step through the events in the simulation panel.');
    return;
  }
  const mine = () => cfg.pings.filter((p) => p.id === r.value);
  waitFor(e, () => mine().length >= o.count && mine().every((p) => p.status !== 'pending'));
  const res = mine();
  const sym = (st: (typeof res)[number]): string => {
    if (st.status === 'reply') return '!';
    if (st.status === 'timeout' || st.status === 'pending') return '.';
    if (st.note === 'ping.fragNeeded') return 'M';
    if (st.note === 'ping.ttlExpired') return '&';
    return 'U';
  };
  s.out(res.map(sym).join(''));
  const ok = res.filter((p) => p.status === 'reply');
  const pct = Math.floor((ok.length * 100) / o.count);
  let line = `Success rate is ${pct} percent (${ok.length}/${o.count})`;
  if (ok.length > 0) {
    const ms = ok.map((p) => Math.max(1, Math.round((p.rttUs ?? 0) / 1000)));
    const avg = Math.round(ms.reduce((a, b) => a + b, 0) / ms.length);
    line += `, round-trip min/avg/max = ${Math.min(...ms)}/${avg}/${Math.max(...ms)} ms`;
  }
  s.out(line);
}

function runTrace(s: CliSession, dst: string): void {
  const e = s.engine;
  const d = s.device;
  const r = e.trace(d.id, dst);
  s.out('Type escape sequence to abort.');
  s.out(`Tracing the route to ${dst}`);
  s.out('VRF info: (vrf in name/id, vrf out name/id)');
  if (!r.ok || d.config.kind !== 'router') return;
  if (s.deferred()) {
    s.out('Simulation mode: probes were queued. Step through the events in the simulation panel.');
    return;
  }
  const cfg = d.config;
  const tr = () => cfg.traces.find((t) => t.id === r.value);
  waitFor(e, () => tr()?.done ?? true);
  for (const hop of tr()?.hops ?? []) {
    const parts: string[] = [];
    let last = '';
    for (const p of hop.probes) {
      if (p.status !== 'reply') parts.push('*');
      else {
        const t = `${Math.round((p.rttUs ?? 0) / 1000)} msec`;
        parts.push(p.from !== last ? `${p.from} ${t}` : t);
        last = p.from ?? '';
      }
    }
    s.out(`${String(hop.ttl).padStart(3)} ${parts.join(' ')}`);
  }
  s.out('');
}

function pingDialog(s: CliSession): void {
  const p: PingParams = { count: 5, size: 100, df: false, timeoutSec: 2 };
  let target = '';
  const num = (a: string, def: number): number => (a.trim() === '' ? def : Number(a.trim()));
  s.ask('Protocol [ip]: ', () =>
    s.ask('Target IP address: ', (a) => {
      target = a.trim();
      s.ask('Repeat count [5]: ', (c) => {
        p.count = Math.min(100, Math.max(1, num(c, 5)));
        s.ask('Datagram size [100]: ', (z) => {
          p.size = Math.min(18024, Math.max(36, num(z, 100)));
          s.ask('Timeout in seconds [2]: ', (t) => {
            p.timeoutSec = Math.max(1, num(t, 2));
            s.ask('Extended commands [n]: ', (x) => {
              const run = () => {
                if (!/^\d+\.\d+\.\d+\.\d+$/.test(target)) {
                  s.out('% Bad IP address or host name');
                  return;
                }
                runPing(s, target, p);
              };
              if (!/^y/i.test(x.trim())) return run();
              s.ask('Source address or interface: ', (src) => {
                if (src.trim()) {
                  const port = resolvePort(s.device.ports, src.trim());
                  const cfg = s.device.config;
                  const ip = port && cfg.kind === 'router' ? cfg.ifaces[port.id]?.ip : undefined;
                  p.source = ip ?? src.trim();
                }
                s.ask('Set DF bit in IP header? (yes/no) [no]: ', (df) => {
                  p.df = /^y/i.test(df.trim());
                  run();
                });
              });
            });
          });
        });
      });
    }),
  );
}

// ---------------------------------------------------------------- Reload

const BOOT = [
  'System Bootstrap, Version 15.0(1r)M15 (simulated), RELEASE SOFTWARE (fc1)',
  'Technical Support: none (simulator)',
  '',
  'Self decompressing the image : ################################ [OK]',
  '',
  'NetSim Software (SIM-UNIVERSALK9-M), Version 15.1(4)M (simulated)',
  '',
];

function doReload(s: CliSession): void {
  const e = s.engine;
  const id = s.deviceId;
  const startup = s.sys.startupConfig;
  for (const l of BOOT) s.out(l);
  e.setPower(id, false);
  e.factoryReset(id);
  e.setPower(id, true);
  if (startup !== undefined) {
    s.applyConfigText(startup);
    s.sys.setupDone = true;
  }
  s.mode = 'user';
  s.ifaces = [];
  s.begin();
}

function reload(s: CliSession): void {
  const proceed = (): void =>
    s.ask('Proceed with reload? [confirm]', (a) => {
      if (confirm(a)) doReload(s);
    });
  const running = renderRunningConfig(s.engine, s.device).join('\n');
  if (running !== s.sys.startupConfig) {
    s.ask('System configuration has been modified. Save? [yes/no]: ', (a) => {
      if (/^y/i.test(a.trim())) {
        saveStartup(s);
        s.out('Building configuration...');
        s.out('[OK]');
      }
      proceed();
    });
  } else proceed();
}

// ---------------------------------------------------------------- Registry

function banner(s: CliSession, rest: string): void {
  if (s.negated) {
    s.sys.bannerMotd = undefined;
    return;
  }
  const delim = rest.startsWith('^C') ? '^C' : (rest[0] ?? '#');
  const body = rest.slice(delim.length);
  const end = body.indexOf(delim);
  if (end >= 0) {
    s.sys.bannerMotd = body.slice(0, end);
    return;
  }
  s.out(`Enter TEXT message.  End with the character '${delim}'.`);
  const lines: string[] = body === '' ? [] : [body];
  const next = (): void =>
    s.ask('', (a) => {
      const i = a.indexOf(delim);
      if (i >= 0) {
        lines.push(a.slice(0, i));
        s.sys.bannerMotd = lines.join('\n');
      } else {
        lines.push(a);
        next();
      }
    });
  next();
}

export function buildRegistry(): Registry<CliSession> {
  const r = new Registry<CliSession>();

  // --- Modus-Wechsel
  r.add({
    modes: ['user'],
    slots: [K('enable', 'Turn on privileged commands')],
    run: (s) => {
      const { enableSecret, enablePassword } = s.sys;
      if (!enableSecret && enablePassword === undefined) {
        s.mode = 'priv';
        return;
      }
      let tries = 0;
      const attempt = (): void =>
        s.ask(
          'Password: ',
          (a) => {
            const ok = enableSecret ? secretHash(a) === enableSecret : a === enablePassword;
            if (ok) {
              s.mode = 'priv';
              return;
            }
            s.out('% Bad secrets');
            if (++tries < 3) attempt();
          },
          true,
        );
      attempt();
    },
  });
  r.add({
    modes: PR,
    slots: [K('disable', 'Turn off privileged commands')],
    run: (s) => {
      s.mode = 'user';
    },
  });
  r.add({
    modes: PR,
    slots: [
      K('configure', 'Enter configuration mode'),
      opt(K('terminal', 'Configure from the terminal')),
    ],
    run: (s, a) => {
      const enter = (): void => {
        s.out('Enter configuration commands, one per line.  End with CNTL/Z.');
        s.mode = 'config';
      };
      if (a['kw:1']) enter();
      else s.ask('Configuring from terminal, memory, or network [terminal]? ', () => enter());
    },
  });
  r.add({
    modes: ['user', 'priv', ...ANYCFG],
    slots: [K('exit', 'Exit from the EXEC / current mode')],
    run: (s) => {
      if (s.mode === 'config-if' || s.mode === 'config-line') s.mode = 'config';
      else if (s.mode === 'config') s.mode = 'priv';
      else logout(s);
    },
  });
  r.add({
    modes: ['user', 'priv'],
    slots: [K('logout', 'Exit from the EXEC')],
    run: (s) => logout(s),
  });
  r.add({
    modes: ANYCFG,
    slots: [K('end', 'Exit from configure mode')],
    run: (s) => {
      s.mode = 'priv';
    },
  });
  r.add({
    modes: ANYCFG,
    slots: [K('do', 'To run exec commands in config mode'), R('cmd', 'LINE', 'Exec command')],
    run: (s, a) => s.runIn('priv', a.cmd as string),
  });

  // --- terminal / history
  r.add({
    modes: U,
    slots: [
      K('terminal', 'Set terminal line parameters'),
      K('length', 'Set number of lines on a screen'),
      P('n', 'int', '<0-512>', 'Number of lines on screen (0 for no pausing)', [0, 512]),
    ],
    run: (s, a) => {
      s.terminalLength = Number(a.n);
    },
  });
  r.add({
    modes: U,
    slots: [
      K('terminal', 'Set terminal line parameters'),
      K('history', 'Enable and control the command history function'),
      K('size', 'Set history buffer size'),
      P('n', 'int', '<0-256>', 'Size of history buffer', [0, 256]),
    ],
    run: (s, a) => {
      s.historySize = Number(a.n);
    },
  });
  r.add({
    modes: U,
    slots: [
      K('terminal', 'Set terminal line parameters'),
      K('monitor', 'Copy debug output to the current terminal line'),
    ],
    run: () => undefined,
  });

  // --- show
  const sh = (
    words: [string, string][],
    run: (s: CliSession, a: Record<string, string>) => void,
    modes: ModeId[] = U,
    extra: ReturnType<typeof opt>[] = [],
    only?: 'router' | 'switch',
  ) => r.add({ modes, only, slots: [SHOW, ...words.map(([w, h]) => K(w, h)), ...extra], run });
  sh([['version', 'System hardware and software status']], (s) =>
    s.outLines(show.showVersion(s.engine, s.device)),
  );
  sh(
    [['running-config', 'Current operating configuration']],
    (s) => s.outLines(show.showRunning(s.engine, s.device)),
    PR,
  );
  sh(
    [['startup-config', 'Contents of startup configuration']],
    (s) => s.outLines(show.showStartup(s.device)),
    PR,
  );
  sh(
    [
      ['ip', 'IP information'],
      ['interface', 'IP interface status and configuration'],
      ['brief', 'Brief summary of IP status and configuration'],
    ],
    (s) => s.outLines(show.showIpInterfaceBrief(s.engine, s.device)),
  );
  r.add({
    modes: U,
    only: 'router',
    slots: [
      SHOW,
      K('ip', 'IP information'),
      K('route', 'IP routing table'),
      opt(P('net', 'ip', 'A.B.C.D', 'Network to display information about')),
    ],
    run: (s, a) => s.outLines(show.showIpRoute(s.engine, s.device, a.net)),
  });
  sh(
    [
      ['ip', 'IP information'],
      ['arp', 'IP ARP table'],
    ],
    (s) => s.outLines(show.showIpArp(s.engine, s.device)),
    U,
    [],
    'router',
  );
  r.add({
    modes: U,
    slots: [
      SHOW,
      K('interfaces', 'Interface status and configuration'),
      opt(P('if', 'iface', 'IFNAME', 'Interface name')),
    ],
    run: (s, a) => {
      const ports = a.if ? [portOf(s, a.if)] : s.device.ports;
      for (const p of ports) s.outLines(show.showInterface(s.device, p));
    },
  });
  sh(
    [
      ['interfaces', 'Interface status and configuration'],
      ['status', 'Show interface line status'],
    ],
    (s) => s.outLines(show.showInterfacesStatus(s.engine, s.device)),
  );
  sh(
    [
      ['mac', 'MAC configuration'],
      ['address-table', 'MAC forwarding table'],
    ],
    (s) => s.outLines(show.showMacTable(s.engine, s.device)),
    U,
    [],
    'switch',
  );
  sh([['history', 'Display the session command history']], (s) => s.outLines([...s.history]));
  sh([['clock', 'Display the system clock']], (s) => s.outLines(show.showClock(s.engine)));

  // --- Diagnose
  r.add({
    modes: U,
    slots: [
      K('ping', 'Send echo messages'),
      opt(P('dst', 'ip', 'A.B.C.D', 'Ping destination address')),
      opt(K('repeat', 'Specify repeat count')),
      opt(P('n', 'int', '<1-100000>', 'Repeat count', [1, 100000])),
      opt(K('size', 'Specify datagram size')),
      opt(P('sz', 'int', '<36-18024>', 'Datagram size', [36, 18024])),
      opt(K('df-bit', 'Enable do not fragment bit in IP header')),
    ],
    run: (s, a) => {
      if (!a.dst) return pingDialog(s);
      runPing(s, a.dst, {
        count: Number(a.n ?? 5),
        size: Number(a.sz ?? 100),
        df: a['kw:6'] !== undefined,
        timeoutSec: 2,
      });
    },
  });
  r.add({
    modes: U,
    slots: [
      K('traceroute', 'Trace route to destination'),
      P('dst', 'ip', 'A.B.C.D', 'Trace route to destination address'),
    ],
    run: (s, a) => runTrace(s, a.dst as string),
  });

  // --- Dateien
  r.add({
    modes: PR,
    slots: [
      K('copy', 'Copy from one file to another'),
      K('running-config', 'Copy from current system configuration'),
      K('startup-config', 'Copy to startup configuration'),
    ],
    run: (s) =>
      s.ask('Destination filename [startup-config]? ', () => {
        s.out('Building configuration...');
        saveStartup(s);
        s.out('[OK]');
      }),
  });
  r.add({
    modes: PR,
    slots: [
      K('copy', 'Copy from one file to another'),
      K('startup-config', 'Copy from startup configuration'),
      K('running-config', 'Copy to current system configuration'),
    ],
    run: (s) =>
      s.ask('Destination filename [running-config]? ', () => {
        const t = s.sys.startupConfig;
        if (t === undefined)
          throw new CliError('%Error opening nvram:/startup-config (No such file or directory)');
        s.applyConfigText(t);
        s.out(`${t.length} bytes copied`);
      }),
  });
  r.add({
    modes: PR,
    slots: [
      K('write', 'Write running configuration to memory'),
      opt(K('memory', 'Write to NV memory')),
    ],
    run: (s) => {
      s.out('Building configuration...');
      saveStartup(s);
      s.out('[OK]');
    },
  });
  r.add({
    modes: PR,
    slots: [
      K('erase', 'Erase a filesystem'),
      K('startup-config', 'Erase contents of configuration memory'),
    ],
    run: (s) =>
      s.ask(
        'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]',
        (a) => {
          if (!confirm(a)) return;
          s.sys.startupConfig = undefined;
          s.out('[OK]');
          s.out('Erase of nvram: complete');
        },
      ),
  });
  r.add({
    modes: PR,
    slots: [K('reload', 'Halt and perform a cold restart')],
    run: (s) => reload(s),
  });
  r.add({
    modes: PR,
    only: 'switch',
    slots: [
      K('clear', 'Reset functions'),
      K('mac', 'MAC forwarding table'),
      K('address-table', 'MAC forwarding table'),
      opt(K('dynamic', 'Remove dynamic entries')),
    ],
    run: (s) => {
      const c = s.device.config;
      if (c.kind === 'switch') c.macTable = {};
    },
  });

  // --- Globale Konfiguration
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('hostname', "Set system's network name"),
      P('name', 'word', 'WORD', "This system's network name"),
    ],
    run: (s, a) => {
      s.sys.hostname = s.negated
        ? s.device.config.kind === 'router'
          ? 'Router'
          : 'Switch'
        : (a.name as string);
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('enable', 'Modify enable password parameters'),
      K('secret', 'Assign the privileged level secret'),
      P('pw', 'word', 'LINE', "The UNENCRYPTED (cleartext) 'enable' secret"),
    ],
    run: (s, a) => {
      s.sys.enableSecret = s.negated ? undefined : secretHash(a.pw as string);
    },
  });
  r.add({
    modes: CF,
    slots: [
      K('enable', 'Modify enable password parameters'),
      K('secret', 'Assign the privileged level secret'),
      K('5', 'Specifies an ENCRYPTED secret will follow'),
      P('hash', 'word', 'LINE', 'The ENCRYPTED enable secret string'),
    ],
    run: (s, a) => {
      s.sys.enableSecret = a.hash as string;
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('enable', 'Modify enable password parameters'),
      K('password', 'Assign the privileged level password (MAX of 25 characters)'),
      P('pw', 'word', 'LINE', "The UNENCRYPTED (cleartext) 'enable' password"),
    ],
    run: (s, a) => {
      s.sys.enablePassword = s.negated ? undefined : (a.pw as string);
    },
  });
  r.add({
    modes: CF,
    slots: [
      K('enable', 'Modify enable password parameters'),
      K('password', 'Assign the privileged level password (MAX of 25 characters)'),
      K('7', 'Specifies a HIDDEN password will follow'),
      P('enc', 'word', 'LINE', "The HIDDEN 'enable' password string"),
    ],
    run: (s, a) => {
      s.sys.enablePassword = type7Decrypt(a.enc as string) ?? '';
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('service', 'Modify use of network based services'),
      K('password-encryption', 'Encrypt system passwords'),
    ],
    run: (s) => {
      s.sys.servicePasswordEncryption = !s.negated;
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('service', 'Modify use of network based services'),
      K('timestamps', 'Timestamp debug/log messages'),
      R('rest', 'WORD', 'Options'),
    ],
    run: () => undefined,
  });
  r.add({
    modes: CF,
    slots: [K('version', 'Specify IOS version'), P('v', 'word', 'WORD', 'Version')],
    run: () => undefined,
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('banner', 'Define a login banner'),
      K('motd', 'Set Message of the Day banner'),
      opt(R('text', 'LINE', "c banner-text c, where 'c' is a delimiting character")),
    ],
    run: (s, a) => banner(s, a.text ?? ''),
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('ip', 'Global IP configuration subcommands'),
      K('domain-name', 'Define the default domain name'),
      P('name', 'word', 'WORD', 'Default domain name'),
    ],
    run: (s, a) => {
      s.sys.domainName = s.negated ? undefined : (a.name as string);
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('ip', 'Global IP configuration subcommands'),
      K('domain-lookup', 'Enable IP Domain Name System hostname translation'),
    ],
    run: () => undefined,
  });

  const routeBase = [
    K('ip', 'Global IP configuration subcommands'),
    K('route', 'Establish static routes'),
    P('prefix', 'ip', 'A.B.C.D', 'Destination prefix'),
    P('mask', 'mask', 'A.B.C.D', 'Destination prefix mask'),
  ];
  const routeRun = (s: CliSession, a: Record<string, string>): void => {
    const route = {
      prefix: a.prefix as string,
      mask: a.mask as string,
      nextHop: a.nh,
      outPortId: a.out ? portOf(s, a.out).id : undefined,
      ad: a.ad ? Number(a.ad) : 1,
    };
    const res = s.negated
      ? s.engine.removeStaticRoute(s.deviceId, route)
      : s.engine.addStaticRoute(s.deviceId, route);
    if (!res.ok) throw engineError(res);
  };
  r.add({
    modes: CF,
    only: 'router',
    negatable: true,
    slots: [
      ...routeBase,
      P('nh', 'ip', 'A.B.C.D', "Forwarding router's address"),
      opt(P('ad', 'int', '<1-255>', 'Distance metric for this route', [1, 255])),
    ],
    run: routeRun,
  });
  r.add({
    modes: CF,
    only: 'router',
    negatable: true,
    slots: [
      ...routeBase,
      P('out', 'iface', 'IFNAME', 'Interface name'),
      opt(P('ad', 'int', '<1-255>', 'Distance metric for this route', [1, 255])),
    ],
    run: routeRun,
  });

  r.add({
    modes: CF,
    slots: [
      K('interface', 'Select an interface to configure'),
      P('if', 'iface', 'IFNAME', 'Interface name'),
    ],
    run: (s, a) => {
      s.ifaces = [portOf(s, a.if as string).id];
      s.mode = 'config-if';
      if (s.replay) s.engine.setPortAdmin(s.deviceId, s.ifaces[0] as string, true);
    },
  });
  r.add({
    modes: CF,
    slots: [
      K('line', 'Configure a terminal line'),
      choice('target', ['console', 'Primary terminal line'], ['vty', 'Virtual terminal']),
      P('first', 'int', '<0-15>', 'First Line number', [0, 15]),
      opt(P('last', 'int', '<0-15>', 'Last Line number', [0, 15])),
    ],
    run: (s, a) => {
      s.lineTarget = a.target === 'console' ? 'con' : 'vty';
      s.mode = 'config-line';
    },
  });

  // --- Interface-Modus
  r.add({
    modes: IF,
    only: 'router',
    negatable: true,
    slots: [
      K('ip', 'Interface Internet Protocol config commands'),
      K('address', 'Set the IP address of an interface'),
      opt(P('ip', 'ip', 'A.B.C.D', 'IP address')),
      opt(P('mask', 'mask', 'A.B.C.D', 'IP subnet mask')),
    ],
    run: (s, a) => {
      for (const id of s.ifaces) {
        const res = s.negated
          ? s.engine.setInterfaceIp(s.deviceId, id, '', '')
          : s.engine.setInterfaceIp(s.deviceId, id, a.ip ?? '', a.mask ?? '');
        if (!res.ok) {
          if (res.error === 'ip.networkAddress')
            throw new CliError(`Bad mask /${maskToPrefix(a.mask ?? '')} for address ${a.ip}`);
          throw engineError(res);
        }
      }
      void networkOf;
    },
  });
  const mtu = (s: CliSession, a: Record<string, string>): void => {
    for (const id of s.ifaces) {
      const res = s.engine.setPortMtu(s.deviceId, id, s.negated ? 1500 : Number(a.n));
      if (!res.ok) throw engineError(res);
    }
  };
  r.add({
    modes: IF,
    only: 'router',
    negatable: true,
    slots: [
      K('ip', 'Interface Internet Protocol config commands'),
      K('mtu', 'Set IP Maximum Transmission Unit'),
      P('n', 'int', '<68-9216>', 'MTU (bytes)', [68, 9216]),
    ],
    run: mtu,
  });
  r.add({
    modes: IF,
    negatable: true,
    slots: [
      K('mtu', 'Set the interface Maximum Transmission Unit (MTU)'),
      P('n', 'int', '<64-9216>', 'MTU size in bytes', [64, 9216]),
    ],
    run: mtu,
  });
  r.add({
    modes: IF,
    negatable: true,
    slots: [K('shutdown', 'Shutdown the selected interface')],
    run: (s) => {
      for (const id of s.ifaces) s.setAdmin(id, s.negated);
    },
  });
  r.add({
    modes: IF,
    negatable: true,
    slots: [
      K('description', 'Interface specific description'),
      opt(R('text', 'LINE', 'Up to 240 characters describing this interface')),
    ],
    run: (s, a) => {
      for (const id of s.ifaces) {
        if (s.negated || !a.text) delete s.sys.descriptions[id];
        else s.sys.descriptions[id] = a.text;
      }
    },
  });
  r.add({
    modes: IF,
    negatable: true,
    slots: [
      K('speed', 'Configure speed operation.'),
      choice(
        'v',
        ['auto', 'Enable AUTO speed configuration'],
        ['10', '10 Mbps'],
        ['100', '100 Mbps'],
        ['1000', '1000 Mbps'],
      ),
    ],
    run: (s, a) => {
      for (const id of s.ifaces)
        s.engine.setPortSettings(s.deviceId, id, {
          speed: s.negated || a.v === 'auto' ? 'auto' : (Number(a.v) as 10 | 100 | 1000),
        });
    },
  });
  r.add({
    modes: IF,
    negatable: true,
    slots: [
      K('duplex', 'Configure duplex operation.'),
      choice(
        'v',
        ['auto', 'Enable AUTO duplex configuration'],
        ['full', 'Force full duplex operation'],
        ['half', 'Force half-duplex operation'],
      ),
    ],
    run: (s, a) => {
      for (const id of s.ifaces)
        s.engine.setPortSettings(s.deviceId, id, {
          duplex: s.negated ? 'auto' : (a.v as 'auto' | 'full' | 'half'),
        });
    },
  });

  // --- Line-Modus
  const line = (s: CliSession) => (s.lineTarget === 'con' ? s.sys.lineCon : s.sys.lineVty);
  r.add({
    modes: LN,
    negatable: true,
    slots: [
      K('password', 'Set a password'),
      P('pw', 'word', 'LINE', 'The UNENCRYPTED (cleartext) line password'),
    ],
    run: (s, a) => {
      line(s).password = s.negated ? undefined : (a.pw as string);
    },
  });
  r.add({
    modes: LN,
    slots: [
      K('password', 'Set a password'),
      K('7', 'Specifies a HIDDEN password will follow'),
      P('enc', 'word', 'LINE', 'The HIDDEN line password string'),
    ],
    run: (s, a) => {
      line(s).password = type7Decrypt(a.enc as string) ?? '';
    },
  });
  r.add({
    modes: LN,
    negatable: true,
    slots: [K('login', 'Enable password checking')],
    run: (s) => {
      line(s).login = !s.negated;
    },
  });
  r.add({
    modes: LN,
    negatable: true,
    slots: [
      K('exec-timeout', 'Set the EXEC timeout'),
      P('min', 'int', '<0-35791>', 'Timeout in minutes', [0, 35791]),
      opt(P('sec', 'int', '<0-2147483>', 'Timeout in seconds', [0, 2147483])),
    ],
    run: () => undefined,
  });
  r.add({
    modes: LN,
    negatable: true,
    slots: [
      K('logging', 'Modify message logging facilities'),
      K('synchronous', 'Synchronized message output'),
    ],
    run: () => undefined,
  });

  return r;
}
