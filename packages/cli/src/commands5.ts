import { isValidIpv4 } from '@netsim/protocols';
import type { Acl } from '@netsim/engine';
import { fwApplyNat, mgmtOf, newFw, SEVERITY_NAMES } from '@netsim/engine';
import { AclParseError, addEntry, parseAclEntry } from './aclparse';
import { aclEntryText, renderRunningConfig } from './render';
import { K, P, R, choice, opt, type ModeId, type Registry } from './parser';
import { openRemote } from './remote';
import { type7Decrypt } from './secrets';
import { CliError, type CliSession } from './session';
import * as show5 from './show5';
import { showTcpBrief } from './showTcp';
import { resolveIface } from './ifnames';
import { waitFor } from './util';

const U: ModeId[] = ['user', 'priv'];
const PR: ModeId[] = ['priv'];
const CF: ModeId[] = ['config'];
const LN: ModeId[] = ['config-line'];
const SHOW = K('show', 'Show running system information');

const mg = (s: CliSession) => mgmtOf(s.sys);
const ip4 = (name: string, help = 'IP address') => P(name, 'ip', 'A.B.C.D', help);

// ---------------------------------------------------------------- TFTP (copy)

function tftpUrl(text: string): { host?: string; file?: string } {
  const m = /^tftp:(?:\/\/([^/]+)(?:\/(.*))?)?$/i.exec(text);
  return m ? { host: m[1], file: m[2] } : {};
}
const isTftp = (t: string): boolean => /^tftp:/i.test(t);

/** Ermittelt Server und Dateiname (Parameter oder interaktive Rückfragen), dann `go(host, file)`. */
function tftpTarget(
  s: CliSession,
  url: string,
  defFile: string,
  go: (host: string, file: string) => void,
  askSrc = false,
): void {
  const u = tftpUrl(url);
  if (u.host && u.file) return go(u.host, u.file);
  s.ask('Address or name of remote host []? ', (h) => {
    const host = h.trim() || u.host || '';
    if (!isValidIpv4(host)) throw new CliError('% Bad IP address or host name');
    s.ask(`${askSrc ? 'Source' : 'Destination'} filename [${defFile}]? `, (f) =>
      go(host, f.trim() || defFile),
    );
  });
}

function tftpPut(s: CliSession, host: string, file: string, body: string): void {
  if (s.deferred()) throw new CliError('Simulation mode: TFTP is not available while stepping.');
  const r = s.engine.p5.request(s.deviceId, host, 'tftp', 'wrq', { file }, body);
  s.out(`Writing ${file} !`);
  if (!r.ok) throw new CliError(`%Error opening tftp://${host}/${file} (No route to host)`);
  waitFor(s.engine, () => s.engine.p5.reqStatus(s.deviceId, r.value)?.status !== 'pending');
  const st = s.engine.p5.reqStatus(s.deviceId, r.value);
  if (st?.status === 'done' && st.reply?.op === 'ack') {
    s.out('!!');
    s.out(`${body.length} bytes copied in 0.5 secs`);
    s.out(`[OK - ${body.length} bytes]`);
  } else if (st?.status === 'done') {
    throw new CliError(
      `%Error opening tftp://${host}/${file} (${String(st.reply?.args.text ?? 'Error')})`,
    );
  } else throw new CliError(`%Error opening tftp://${host}/${file} (Timed out)`);
}

function tftpGet(s: CliSession, host: string, file: string, apply: (text: string) => void): void {
  if (s.deferred()) throw new CliError('Simulation mode: TFTP is not available while stepping.');
  s.out(`Accessing tftp://${host}/${file}...`);
  const r = s.engine.p5.request(s.deviceId, host, 'tftp', 'rrq', { file });
  if (!r.ok) throw new CliError(`%Error opening tftp://${host}/${file} (No route to host)`);
  waitFor(s.engine, () => s.engine.p5.reqStatus(s.deviceId, r.value)?.status !== 'pending');
  const st = s.engine.p5.reqStatus(s.deviceId, r.value);
  if (st?.status === 'done' && st.reply?.op === 'data') {
    const text = st.reply.body ?? '';
    s.out(
      `Loading ${file} from ${host} (via ${s.device.ports.find((p) => p.operUp)?.name ?? 'interface'}): !`,
    );
    apply(text);
    s.out(`[OK - ${text.length} bytes]`);
  } else if (st?.status === 'done') {
    throw new CliError(
      `%Error opening tftp://${host}/${file} (${String(st.reply?.args.text ?? 'Error')})`,
    );
  } else throw new CliError(`%Error opening tftp://${host}/${file} (Timed out)`);
}

// ---------------------------------------------------------------- Firewall: ASA-ACL-Text

const toWildcard = (mask: string): string =>
  mask
    .split('.')
    .map((o) => 255 - Number(o))
    .join('.');
const toMask = (wc: string): string => toWildcard(wc);

/** ASA-Schreibweise (`any4`, `host`, Netzmaske) in die IOS-ACL-Syntax umwandeln. */
function asaToIos(text: string): string {
  const t = text.trim().split(/\s+/);
  const out: string[] = [];
  const addr = (): void => {
    const first = t.shift();
    if (first === undefined) return;
    if (first === 'any' || first === 'any4') out.push('any');
    else if (first === 'host') out.push('host', t.shift() ?? '');
    else if (isValidIpv4(first) && t[0] !== undefined && isValidIpv4(t[0]))
      out.push(first, toWildcard(t.shift() as string));
    else out.push(first);
  };
  out.push(t.shift() ?? ''); // permit|deny
  out.push(t.shift() ?? ''); // Protokoll
  const proto = out[1];
  const ports = (): void => {
    if (proto !== 'tcp' && proto !== 'udp') return;
    const op = t[0];
    if (op === 'eq' || op === 'neq' || op === 'lt' || op === 'gt')
      out.push(t.shift() as string, t.shift() ?? '');
    else if (op === 'range') out.push(t.shift() as string, t.shift() ?? '', t.shift() ?? '');
  };
  addr();
  ports();
  addr();
  ports();
  out.push(...t);
  return out.join(' ');
}

/** Rendert einen ACL-Eintrag in ASA-Schreibweise. */
export function asaEntryText(e: Parameters<typeof aclEntryText>[0]): string {
  const base = aclEntryText(e, 'extended');
  const parts = base.split(' ');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as string;
    const next = parts[i + 1];
    if (isValidIpv4(p) && next !== undefined && isValidIpv4(next)) {
      out.push(p, toMask(next));
      i++;
    } else out.push(p);
  }
  return out.join(' ');
}

function fwOf(s: CliSession) {
  const c = s.device.config;
  if (c.kind !== 'router') throw new CliError('% Invalid input');
  c.fw ??= newFw();
  return c;
}

// ---------------------------------------------------------------- Registrierung

export function addPhase5(r: Registry<CliSession>): void {
  // --- Benutzer / SSH / Schlüssel
  const userCmd = (withPriv: boolean): void => {
    r.add({
      modes: CF,
      negatable: true,
      slots: [
        K('username', 'Establish User Name Authentication'),
        P('name', 'word', 'WORD', 'User name'),
        ...(withPriv
          ? [
              K('privilege', 'Set user privilege level'),
              P('lvl', 'int', '<0-15>', 'User privilege level', [0, 15]),
            ]
          : []),
        opt(
          choice(
            'kind',
            ['secret', 'Specify the secret for the user'],
            ['password', 'Specify the password for the user'],
          ),
        ),
        opt(P('lead', 'word', 'WORD', 'The UNENCRYPTED (cleartext) user password')),
        opt(P('pw', 'word', 'LINE', 'The password string')),
      ],
      run: (s, a) => {
        const name = a.name as string;
        if (s.negated) {
          delete mg(s).users[name];
          return;
        }
        let pw = a.lead;
        if (a.pw !== undefined) {
          // `secret 5 HASH` / `secret 0 TEXT` / `password 7 ENC`
          const enc = a.pw;
          pw = a.lead === '0' ? enc : (type7Decrypt(enc) ?? enc);
        }
        if (pw === undefined) throw new CliError('% Incomplete command.');
        mg(s).users[name] = { secret: pw, privilege: withPriv ? Number(a.lvl) : 1 };
      },
    });
  };
  userCmd(false);
  userCmd(true);

  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('ip', 'Global IP configuration subcommands'),
      K('ssh', 'Configure ssh options'),
      K('version', 'Set protocol version'),
      choice('v', ['1', 'Protocol version 1'], ['2', 'Protocol version 2']),
    ],
    run: (s, a) => {
      mg(s).ssh.version = s.negated ? 2 : (Number(a.v) as 1 | 2);
      mg(s).ssh.explicit = !s.negated;
    },
  });

  const sshVer = (x: { version: number; explicit?: boolean }): string =>
    x.version === 2 && !x.explicit ? '1.99' : String(x.version);
  const keygen = (s: CliSession, bits: number): void => {
    if (!s.sys.domainName) throw new CliError('Please define a domain-name first.');
    if (!Number.isInteger(bits) || bits < 360 || bits > 4096)
      throw new CliError('% Invalid modulus size. Choose a value between 360 and 4096.');
    mg(s).ssh.keyBits = bits;
    s.out(`The name for the keys will be: ${s.sys.hostname}.${s.sys.domainName}`);
    s.out(`% The key modulus size is ${bits} bits`);
    s.out(`% Generating ${bits} bit RSA keys, keys will be non-exportable...`);
    s.out('[OK] (elapsed time was 0 seconds)');
    s.engine.p5.syslog(s.deviceId, 5, 'SSH-5-ENABLED', `SSH ${sshVer(mg(s).ssh)} has been enabled`);
  };
  r.add({
    modes: CF,
    slots: [
      K('crypto', 'Encryption module'),
      K('key', 'Long term key operations'),
      K('generate', 'Generate new keys'),
      K('rsa', 'Generate a new RSA key pair'),
      opt(K('modulus', 'Provide number of modulus bits on the command line')),
      opt(P('bits', 'int', '<360-4096>', 'size of the key modulus', [360, 4096])),
    ],
    run: (s, a) => {
      if (a.bits !== undefined) return keygen(s, Number(a.bits));
      if (!s.sys.domainName) throw new CliError('Please define a domain-name first.');
      s.ask('How many bits in the modulus [512]: ', (b) =>
        keygen(s, b.trim() === '' ? 512 : Number(b)),
      );
    },
  });
  r.add({
    modes: CF,
    slots: [
      K('crypto', 'Encryption module'),
      K('key', 'Long term key operations'),
      K('zeroize', 'Remove keys'),
      K('rsa', 'Remove RSA keys'),
    ],
    run: (s) => {
      mg(s).ssh.keyBits = undefined;
      s.out('% All RSA keys will be removed.');
    },
  });

  // --- NTP / Uhr
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('ntp', 'Configure NTP'),
      K('server', 'Configure NTP server'),
      ip4('ip', 'IP address of peer'),
      opt(K('key', 'Configure peer authentication key')),
      opt(P('keyid', 'int', '<1-4294967295>', 'Key number', [1, 4294967295])),
    ],
    run: (s, a) => {
      const m = mg(s);
      const ip = a.ip as string;
      m.ntp.servers = m.ntp.servers.filter((x) => x !== ip);
      if (m.ntp.serverKeys) delete m.ntp.serverKeys[ip];
      if (!s.negated) {
        m.ntp.servers.push(ip);
        if (a.keyid) (m.ntp.serverKeys ??= {})[ip] = Number(a.keyid);
      }
      s.engine.p5.startTimers(s.device);
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('ntp', 'Configure NTP'),
      K('master', 'Act as NTP master clock'),
      opt(P('stratum', 'int', '<1-15>', 'Act as NTP master clock', [1, 15])),
    ],
    run: (s, a) => {
      mg(s).ntp.master = s.negated ? undefined : Number(a.stratum ?? 8);
    },
  });
  // --- Syslog / SNMP / AAA
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('logging', 'Modify message logging facilities'),
      K('host', 'Set syslog server IP address and parameters'),
      ip4('ip', 'IP address of the logging host'),
    ],
    run: (s, a) => {
      const m = mg(s);
      m.syslog.hosts = m.syslog.hosts.filter((x) => x !== a.ip);
      if (!s.negated) m.syslog.hosts.push(a.ip as string);
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('logging', 'Modify message logging facilities'),
      K('trap', 'Set syslog server logging level'),
      P('lvl', 'word', 'LEVEL', 'Logging severity level (0-7 or name)'),
    ],
    run: (s, a) => {
      const l = a.lvl as string;
      const n = /^\d$/.test(l) ? Number(l) : SEVERITY_NAMES.findIndex((x) => x.startsWith(l));
      if (n < 0 || n > 7) throw new CliError('% Invalid input detected');
      mg(s).syslog.trap = s.negated ? 6 : n;
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('snmp-server', 'Modify SNMP engine parameters'),
      K('community', 'Enable SNMP; set community string and access privileges'),
      P('name', 'word', 'WORD', 'SNMP community string'),
      opt(choice('mode', ['ro', 'Read-only access'], ['rw', 'Read-write access'])),
    ],
    run: (s, a) => {
      const m = mg(s);
      m.snmp.communities = m.snmp.communities.filter((c) => c.name !== a.name);
      if (!s.negated) m.snmp.communities.push({ name: a.name as string, rw: a.mode === 'rw' });
    },
  });
  for (const [word, key, help] of [
    ['location', 'location', 'Text for mib object sysLocation'],
    ['contact', 'contact', 'Text for mib Object sysContact'],
  ] as const) {
    r.add({
      modes: CF,
      negatable: true,
      slots: [
        K('snmp-server', 'Modify SNMP engine parameters'),
        K(word, help),
        R('text', 'LINE', help),
      ],
      run: (s, a) => {
        mg(s).snmp[key] = s.negated ? undefined : a.text;
      },
    });
  }
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('aaa', 'Authentication, Authorization and Accounting.'),
      K('new-model', 'Enable NEW access control commands and functions.(Disables OLD commands.)'),
    ],
    run: (s) => {
      mg(s).aaa.newModel = !s.negated;
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('aaa', 'Authentication, Authorization and Accounting.'),
      K('authentication', 'Authentication configuration'),
      K('login', 'Set authentication lists for logins'),
      P('list', 'word', 'WORD', 'Named authentication list (default)'),
      R('methods', 'WORD', 'group radius | group tacacs+ | local'),
    ],
    run: (s, a) => {
      const m = mg(s);
      if (s.negated) {
        m.aaa.methods = [];
        return;
      }
      const words = (a.methods as string).split(/\s+/);
      const methods: ('radius' | 'tacacs' | 'local')[] = [];
      for (let i = 0; i < words.length; i++) {
        if (words[i] === 'group' && (words[i + 1] === 'radius' || words[i + 1] === 'tacacs+')) {
          methods.push(words[i + 1] === 'radius' ? 'radius' : 'tacacs');
          i++;
        } else if (words[i] === 'local') methods.push('local');
        else throw new CliError('% Invalid input detected');
      }
      m.aaa.methods = methods;
      m.aaa.listName = a.list as string;
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('radius-server', 'Modify Radius query parameters'),
      K('host', 'Specify a RADIUS server'),
      ip4('ip', 'IP address of RADIUS server'),
      opt(K('key', 'per-server encryption key')),
      opt(P('key', 'word', 'WORD', 'The UNENCRYPTED (cleartext) server key')),
    ],
    run: (s, a) => {
      const m = mg(s);
      m.aaa.radius = m.aaa.radius.filter((x) => x.host !== a.ip);
      if (!s.negated) m.aaa.radius.push({ host: a.ip as string, key: a.key ?? '' });
    },
  });

  // --- Line-Modus
  r.add({
    modes: LN,
    negatable: true,
    slots: [
      K('transport', 'Define transport protocols for line'),
      K('input', 'Define which protocols to use when connecting to the terminal server'),
      opt(
        choice(
          'p',
          ['all', 'All protocols'],
          ['none', 'No protocols'],
          ['ssh', 'TCP/IP SSH protocol'],
          ['telnet', 'TCP/IP Telnet protocol'],
        ),
      ),
      opt(choice('q', ['ssh', 'TCP/IP SSH protocol'], ['telnet', 'TCP/IP Telnet protocol'])),
    ],
    run: (s, a) => {
      if (s.lineTarget !== 'vty') return;
      const t = mg(s).vty;
      if (s.negated || a.p === 'all') t.transport = ['ssh', 'telnet'];
      else if (a.p === 'none') t.transport = [];
      else t.transport = [...new Set([a.p, a.q].filter(Boolean) as ('ssh' | 'telnet')[])];
    },
  });
  r.add({
    modes: LN,
    negatable: true,
    slots: [K('login', 'Enable password checking'), K('local', 'Local password checking')],
    run: (s) => {
      if (s.lineTarget === 'vty') mg(s).vty.loginLocal = !s.negated;
    },
  });
  r.add({
    modes: LN,
    negatable: true,
    slots: [
      K('login', 'Enable password checking'),
      K('authentication', 'Authentication parameters'),
      P('list', 'word', 'WORD', 'Use an authentication list with this name'),
    ],
    run: (s, a) => {
      if (s.lineTarget !== 'vty') return;
      mg(s).vty.authList = s.negated ? undefined : (a.list as string);
    },
  });

  // --- Telnet / SSH (Client)
  r.add({
    modes: U,
    slots: [
      K('telnet', 'Open a telnet connection'),
      P('host', 'word', 'WORD', 'IP address or hostname of a remote system'),
    ],
    run: (s, a) => {
      s.out(
        openRemote({
          engine: s.engine,
          fromId: s.deviceId,
          nest: s.nest,
          dst: a.host as string,
          proto: 'telnet',
          deferred: s.deferred,
          style: 'ios',
        }),
      );
    },
  });
  r.add({
    modes: U,
    slots: [
      K('ssh', 'Open a secure shell client connection'),
      K('-l', 'Log in using this user name'),
      P('user', 'word', 'WORD', 'Login name'),
      P('host', 'word', 'WORD', 'IP address or hostname of a remote system'),
    ],
    run: (s, a) => {
      s.out(
        openRemote({
          engine: s.engine,
          fromId: s.deviceId,
          nest: s.nest,
          dst: a.host as string,
          proto: 'ssh',
          user: a.user,
          deferred: s.deferred,
          style: 'ios',
        }),
      );
    },
  });

  // --- copy … tftp:
  r.add({
    modes: PR,
    slots: [
      K('copy', 'Copy from one file to another'),
      choice(
        'src',
        ['running-config', 'Copy from current system configuration'],
        ['startup-config', 'Copy from startup configuration'],
      ),
      P('dst', 'word', 'tftp:', 'Copy to tftp: file system'),
    ],
    run: (s, a) => {
      const dst = a.dst as string;
      if (!isTftp(dst)) throw new CliError('% Invalid input detected');
      const running = a.src === 'running-config';
      const text = running
        ? renderRunningConfig(s.engine, s.device).join('\n')
        : (s.sys.startupConfig ?? '');
      if (!running && s.sys.startupConfig === undefined)
        throw new CliError('%Error opening nvram:/startup-config (No such file or directory)');
      tftpTarget(s, dst, `${s.sys.hostname.toLowerCase()}-confg`, (host, file) =>
        tftpPut(s, host, file, text),
      );
    },
  });
  r.add({
    modes: PR,
    slots: [
      K('copy', 'Copy from one file to another'),
      P('src', 'word', 'tftp:', 'Copy from tftp: file system'),
      choice(
        'dst',
        ['running-config', 'Copy to current system configuration'],
        ['startup-config', 'Copy to startup configuration'],
      ),
    ],
    run: (s, a) => {
      const src = a.src as string;
      if (!isTftp(src)) throw new CliError('% Invalid input detected');
      tftpTarget(
        s,
        src,
        '',
        (host, file) =>
          tftpGet(s, host, file, (text) => {
            if (a.dst === 'running-config') s.applyConfigText(text);
            else s.sys.startupConfig = text;
          }),
        true,
      );
    },
  });

  // --- show
  const sh = (
    words: [string, string][],
    run: (s: CliSession) => void,
    modes: ModeId[] = U,
    only?: 'router' | 'switch' | 'firewall',
  ): void => {
    r.add({ modes, only, slots: [SHOW, ...words.map(([w, h]) => K(w, h))], run });
  };
  sh(
    [
      ['ntp', 'Network time protocol'],
      ['status', 'NTP status'],
    ],
    (s) => s.outLines(show5.showNtpStatus(s.device)),
  );
  sh(
    [
      ['ntp', 'Network time protocol'],
      ['associations', 'NTP associations'],
    ],
    (s) => s.outLines(show5.showNtpAssociations(s.device)),
  );
  sh(
    [
      ['tcp', 'Status of TCP connections'],
      ['brief', 'Brief display of TCP connections'],
    ],
    (s) => s.outLines(showTcpBrief(s.device)),
  );
  sh([['users', 'Display information about terminal lines']], (s) =>
    s.outLines(show5.showUsers(s.engine, s.device, s.remote ? s.remote.vty : -1)),
  );
  sh([['ssh', 'Status of SSH server connections']], (s) =>
    s.outLines(show5.showSsh(s.device, s.engine)),
  );
  sh(
    [
      ['ip', 'IP information'],
      ['ssh', 'Information on SSH'],
    ],
    (s) => s.outLines(show5.showIpSsh(s.device)),
  );
  sh([['logging', 'Show the contents of logging buffers']], (s) =>
    s.outLines(show5.showLogging(s.device)),
  );
  sh([['snmp', 'snmp statistics']], (s) => s.outLines(show5.showSnmp(s.device)));
  sh([['aaa', 'Show AAA values']], (s) => s.outLines(show5.showAaa(s.device)));
  sh(
    [
      ['crypto', 'Encryption module'],
      ['key', 'Show long term public keys'],
      ['mypubkey', 'Show public keys'],
      ['rsa', 'RSA keys'],
    ],
    (s) => s.outLines(show5.showKeys(s.device)),
    PR,
  );

  // --- Firewall (ASA-Stil)
  fwCommands(r);
}

function fwCommands(r: Registry<CliSession>): void {
  const IFMODE: ModeId[] = ['config-if'];
  r.add({
    modes: IFMODE,
    only: 'firewall',
    negatable: true,
    slots: [K('nameif', 'Assign name to interface'), P('name', 'word', 'WORD', 'Interface name')],
    run: (s, a) => {
      const c = fwOf(s);
      const fw = c.fw!;
      for (const id of s.ifaces) {
        if (s.negated) delete fw.ifaces[id];
        else {
          const level = fw.ifaces[id]?.level ?? (a.name === 'inside' ? 100 : 0);
          fw.ifaces[id] = { nameif: a.name as string, level };
        }
      }
      fwApplyNat(c);
    },
  });
  r.add({
    modes: IFMODE,
    only: 'firewall',
    negatable: true,
    slots: [
      K('security-level', 'Set security level'),
      P('n', 'int', '<0-100>', 'Security level', [0, 100]),
    ],
    run: (s, a) => {
      const fw = fwOf(s).fw!;
      for (const id of s.ifaces) {
        const f = fw.ifaces[id];
        if (!f) throw new CliError('ERROR: Interface has no name; configure nameif first');
        f.level = s.negated ? 0 : Number(a.n);
      }
    },
  });
  r.add({
    modes: CF,
    only: 'firewall',
    negatable: true,
    slots: [
      K('access-list', 'Configure an access control element'),
      P('name', 'word', 'WORD', 'access list identifier'),
      K('extended', 'Use extended access list syntax'),
      R('rest', 'LINE', 'permit|deny …'),
    ],
    run: (s, a) => {
      const c = fwOf(s);
      const name = a.name as string;
      const acl: Acl = (c.acls[name] ??= { name, type: 'extended', entries: [] });
      try {
        const e = parseAclEntry('extended', asaToIos(a.rest as string));
        if (s.negated) {
          const txt = aclEntryText({ ...e, seq: 0 }, 'extended');
          acl.entries = acl.entries.filter((x) => aclEntryText(x, 'extended') !== txt);
          return;
        }
        addEntry(acl.entries, e);
      } catch (err) {
        if (err instanceof AclParseError) throw new CliError(err.message);
        throw err;
      }
    },
  });
  r.add({
    modes: CF,
    only: 'firewall',
    negatable: true,
    slots: [
      K('access-group', 'Bind an access list to an interface'),
      P('name', 'word', 'WORD', 'access list identifier'),
      K('in', 'Apply to input traffic'),
      K('interface', 'Specify the interface'),
      P('nameif', 'word', 'WORD', 'Interface name'),
    ],
    run: (s, a) => {
      const c = fwOf(s);
      const fw = c.fw!;
      const id = Object.entries(fw.ifaces).find(([, v]) => v.nameif === a.nameif)?.[0];
      if (!id) throw new CliError(`ERROR: interface ${a.nameif} not found`);
      if (s.negated) delete fw.accessGroups[id];
      else fw.accessGroups[id] = a.name as string;
    },
  });
  r.add({
    modes: CF,
    only: 'firewall',
    negatable: true,
    slots: [
      K('same-security-traffic', 'Permit traffic between same-security interfaces'),
      K('permit', 'Permit'),
      K('inter-interface', 'Between interfaces'),
    ],
    run: (s) => {
      fwOf(s).fw!.sameSecurity = !s.negated;
    },
  });
  r.add({
    modes: CF,
    only: 'firewall',
    negatable: true,
    slots: [
      K('object', 'Configure an object'),
      K('network', 'Specify a network object'),
      P('name', 'word', 'WORD', 'Object name'),
    ],
    run: (s, a) => {
      const fw = fwOf(s).fw!;
      const name = a.name as string;
      if (s.negated) {
        delete fw.objects[name];
        fwApplyNat(fwOf(s));
        return;
      }
      fw.objects[name] ??= { name };
      s.aclName = name;
      s.mode = 'config-obj-net';
    },
  });
  r.add({
    modes: ['config-obj-net'],
    only: 'firewall',
    slots: [
      K('subnet', 'Enter this subnet'),
      ip4('ip', 'Network address'),
      P('mask', 'mask', 'A.B.C.D', 'Netmask'),
    ],
    run: (s, a) => {
      const o = fwOf(s).fw!.objects[s.aclName];
      if (o) o.net = { ip: a.ip as string, mask: a.mask as string };
      fwApplyNat(fwOf(s));
    },
  });
  r.add({
    modes: ['config-obj-net'],
    only: 'firewall',
    slots: [K('host', 'Enter this host'), ip4('ip', 'Host address')],
    run: (s, a) => {
      const o = fwOf(s).fw!.objects[s.aclName];
      if (o) o.net = { ip: a.ip as string, mask: '255.255.255.255' };
      fwApplyNat(fwOf(s));
    },
  });
  r.add({
    modes: ['config-obj-net'],
    only: 'firewall',
    negatable: true,
    slots: [
      K('nat', 'Enable NAT on a interface'),
      P('pair', 'word', '(inside,outside)', 'Source and destination interface names'),
      choice('kind', ['dynamic', 'Dynamic NAT'], ['static', 'Static NAT']),
      R('arg', 'WORD', 'interface | mapped address'),
    ],
    run: (s, a) => {
      const c = fwOf(s);
      const o = c.fw!.objects[s.aclName];
      if (!o) return;
      if (s.negated) {
        o.nat = undefined;
        fwApplyNat(c);
        return;
      }
      const m = /^\(([^,]+),([^)]+)\)$/.exec(a.pair as string);
      if (!m) throw new CliError('% Invalid input detected');
      const arg = (a.arg as string).trim();
      if (a.kind === 'dynamic') {
        if (arg !== 'interface') throw new CliError('% Only "dynamic interface" is supported');
        o.nat = { from: m[1] as string, to: m[2] as string, kind: 'dynamic-interface' };
      } else {
        if (!isValidIpv4(arg)) throw new CliError('% Invalid mapped address');
        o.nat = { from: m[1] as string, to: m[2] as string, kind: 'static', mapped: arg };
      }
      fwApplyNat(c);
    },
  });
  r.add({
    modes: U,
    only: 'firewall',
    slots: [SHOW, K('conn', 'Show connections')],
    run: (s) => s.outLines(show5.showConn(s.engine, s.device)),
  });
  r.add({
    modes: U,
    only: 'firewall',
    slots: [SHOW, K('xlate', 'Show NAT translations')],
    run: (s) => s.outLines(show5.showXlate(s.engine, s.device)),
  });
  r.add({
    modes: U,
    only: 'firewall',
    slots: [SHOW, K('nameif', 'Show interface names')],
    run: (s) => s.outLines(show5.showNameif(s.device)),
  });
  void resolveIface;
}
