import { SEVERITY_NAMES, mgmtOf, type MgmtCfg } from '@netsim/engine';
import { K, P, choice, opt, type ModeId, type Registry } from './parser';
import { CliError, type CliSession } from './session';
import { type7Decrypt } from './secrets';

const CF: ModeId[] = ['config'];
const U: ModeId[] = ['user', 'priv'];
const LOGGING = K('logging', 'Modify message logging facilities');
const SNMP = K('snmp-server', 'Modify SNMP engine parameters');
const NTP = K('ntp', 'Configure NTP');
const SSH = [K('ip', 'Global IP configuration subcommands'), K('ssh', 'Configure ssh options')];

const mg = (s: CliSession): MgmtCfg => mgmtOf(s.sys);

/** Schweregrad aus Zahl oder Name (auch Präfix). */
function level(txt: string): number {
  const n = /^\d$/.test(txt) ? Number(txt) : SEVERITY_NAMES.findIndex((x) => x.startsWith(txt));
  if (n < 0 || n > 7) throw new CliError('% Invalid input detected');
  return n;
}

/** Logging-Puffer/-Konsole, NTP-Authentifizierung, SNMPv3, SSH-Optionen. */
export function addMgmtExtras(r: Registry<CliSession>): void {
  // ------------------------------------------------------------ logging
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      LOGGING,
      K('buffered', 'Set buffered logging parameters'),
      opt(P('a', 'word', '<4096-2147483647>|LEVEL', 'Logging buffer size or severity level')),
      opt(P('b', 'word', 'LEVEL', 'Logging severity level')),
    ],
    run: (s, a) => {
      const sl = mg(s).syslog;
      if (s.negated) {
        sl.buffered = false;
        sl.bufSize = undefined;
        sl.bufLevel = undefined;
        return;
      }
      sl.buffered = true;
      for (const t of [a.a, a.b]) {
        if (t === undefined) continue;
        if (/^\d{4,}$/.test(t)) {
          const n = Number(t);
          if (n < 4096) throw new CliError('% Invalid input detected');
          sl.bufSize = n;
        } else sl.bufLevel = level(t);
      }
    },
  });
  for (const [kw, key, help] of [
    ['console', 'consoleLevel', 'Set console logging level'],
    ['monitor', 'monitorLevel', 'Set terminal line (monitor) logging level'],
  ] as const) {
    r.add({
      modes: CF,
      negatable: true,
      slots: [LOGGING, K(kw, help), opt(P('lvl', 'word', 'LEVEL', 'Logging severity level'))],
      run: (s, a) => {
        mg(s).syslog[key] = s.negated ? undefined : a.lvl ? level(a.lvl) : 7;
      },
    });
  }

  // ------------------------------------------------------------ NTP-Authentifizierung
  r.add({
    modes: CF,
    negatable: true,
    slots: [NTP, K('authenticate', 'Authenticate time sources')],
    run: (s) => {
      mg(s).ntp.auth = !s.negated;
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      NTP,
      K('authentication-key', 'Authentication key for trusted time sources'),
      P('id', 'int', '<1-4294967295>', 'Key number', [1, 4294967295]),
      K('md5', 'MD5 authentication'),
      P('key', 'word', 'WORD', 'MD5 key'),
      opt(P('enc', 'int', '<0-7>', 'Encryption type (7 = hidden)', [0, 7])),
    ],
    run: (s, a) => {
      const n = mg(s).ntp;
      const id = Number(a.id);
      if (s.negated) {
        if (n.keys) delete n.keys[id];
        return;
      }
      const key =
        a.enc === '7' ? (type7Decrypt(a.key as string) ?? (a.key as string)) : (a.key as string);
      (n.keys ??= {})[id] = key;
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      NTP,
      K('trusted-key', 'Key numbers for trusted time sources'),
      P('id', 'int', '<1-4294967295>', 'Key number', [1, 4294967295]),
    ],
    run: (s, a) => {
      const n = mg(s).ntp;
      const id = Number(a.id);
      n.trusted = (n.trusted ?? []).filter((x) => x !== id);
      if (!s.negated) n.trusted.push(id);
    },
  });

  // ------------------------------------------------------------ SSH
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      ...SSH,
      K('time-out', 'Specify SSH time-out interval'),
      P('sec', 'int', '<1-120>', 'SSH time-out interval (secs)', [1, 120]),
    ],
    run: (s, a) => {
      mg(s).ssh.timeout = s.negated ? undefined : Number(a.sec);
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      ...SSH,
      K('authentication-retries', 'Specify number of authentication retries'),
      P('n', 'int', '<0-5>', 'Number of authentication retries', [0, 5]),
    ],
    run: (s, a) => {
      mg(s).ssh.retries = s.negated ? undefined : Number(a.n);
    },
  });

  // ------------------------------------------------------------ SNMPv3
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      SNMP,
      K('group', 'Define a User Security Model group'),
      P('name', 'word', 'WORD', 'Name of the group'),
      K('v3', 'group using the User Security Model (SNMPv3)'),
      choice(
        'lvl',
        ['noauth', 'group using the noAuthNoPriv Security Level'],
        ['auth', 'group using the authNoPriv Security Level'],
        ['priv', 'group using SNMPv3 authPriv security level'],
      ),
    ],
    run: (s, a) => {
      const v3 = (mg(s).snmp.v3 ??= { groups: [], users: [] });
      v3.groups = v3.groups.filter((g) => g.name !== a.name);
      if (!s.negated)
        v3.groups.push({ name: a.name as string, level: a.lvl as 'noauth' | 'auth' | 'priv' });
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      SNMP,
      K('user', 'Define a user who can access the SNMP engine'),
      P('name', 'word', 'WORD', 'Name of the user'),
      P('group', 'word', 'WORD', 'Group to which the user belongs'),
      K('v3', 'user using the v3 security model'),
      opt(K('auth', 'authentication parameters for the user')),
      opt(
        choice(
          'aalg',
          ['md5', 'Use HMAC MD5 algorithm for authentication'],
          ['sha', 'Use HMAC SHA algorithm for authentication'],
        ),
      ),
      opt(P('akey', 'word', 'WORD', 'authentication password for user')),
      opt(K('priv', 'encryption parameters for the user')),
      opt(
        choice(
          'palg',
          ['aes', 'Use AES algorithm for encryption'],
          ['des', 'Use DES algorithm for encryption'],
        ),
      ),
      opt(P('pbits', 'word', '128|WORD', 'AES key size or encryption password')),
      opt(P('pkey', 'word', 'WORD', 'encryption password for user')),
    ],
    run: (s, a) => {
      const v3 = (mg(s).snmp.v3 ??= { groups: [], users: [] });
      v3.users = v3.users.filter((u) => u.name !== a.name);
      if (s.negated) return;
      if (!v3.groups.some((g) => g.name === a.group))
        throw new CliError(`% Group "${a.group as string}" does not exist`);
      const user: MgmtCfg['snmp']['v3'] extends infer T
        ? T extends { users: (infer U)[] }
          ? U
          : never
        : never = {
        name: a.name as string,
        group: a.group as string,
      };
      if (a.aalg) {
        if (!a.akey) throw new CliError('% Incomplete command.');
        user.auth = { alg: a.aalg as 'md5' | 'sha', key: a.akey };
      }
      if (a.palg) {
        const aes = a.palg === 'aes';
        const bits = aes && /^(128|192|256)$/.test(a.pbits ?? '') ? Number(a.pbits) : undefined;
        const key = aes ? (bits ? a.pkey : a.pbits) : a.pbits;
        if (!key) throw new CliError('% Incomplete command.');
        if (!user.auth) throw new CliError('% Configuration of privacy requires authentication');
        user.priv = { alg: a.palg as 'aes' | 'des', bits, key };
      }
      v3.users.push(user);
    },
  });
  r.add({
    modes: U,
    slots: [
      K('show', 'Show running system information'),
      K('snmp', 'snmp statistics'),
      K('group', 'List SNMP groups'),
    ],
    run: (s) => {
      const gs = mg(s).snmp.v3?.groups ?? [];
      const out: string[] = [];
      for (const g of gs)
        out.push(
          `groupname: ${g.name}                          security model:v3 ${g.level === 'noauth' ? 'noauth' : g.level}`,
          'contextname: <no context specified>        storage-type: nonvolatile',
          'readview : v1default                       writeview: <no writeview specified>',
          'notifyview: <no notifyview specified>',
          'row status: active',
          '',
        );
      s.outLines(out);
    },
  });
  r.add({
    modes: U,
    slots: [
      K('show', 'Show running system information'),
      K('snmp', 'snmp statistics'),
      K('user', 'Display information about configured SNMP users'),
    ],
    run: (s) => {
      const us = mg(s).snmp.v3?.users ?? [];
      const out: string[] = [];
      for (const u of us)
        out.push(
          `User name: ${u.name}`,
          `Engine ID: 800000090300${(s.device.ports[0]?.mac ?? '').replace(/:/g, '').toUpperCase()}`,
          'storage-type: nonvolatile\t active',
          `Authentication Protocol: ${u.auth ? u.auth.alg.toUpperCase() : 'None'}`,
          `Privacy Protocol: ${u.priv ? (u.priv.alg === 'aes' ? `AES${u.priv.bits ?? 128}` : 'DES') : 'None'}`,
          `Group-name: ${u.group}`,
          '',
        );
      s.outLines(out);
    },
  });
}
