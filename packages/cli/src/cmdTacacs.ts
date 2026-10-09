import { isValidIpv4 } from '@netsim/protocols';
import { mgmtOf, type TacacsHost } from '@netsim/engine';
import { K, P, opt, type ModeId, type Registry } from './parser';
import { CliError, type CliSession } from './session';

const CF: ModeId[] = ['config'];
const TS: ModeId[] = ['config-tacacs'];
const U: ModeId[] = ['user', 'priv'];
const mg = (s: CliSession) => mgmtOf(s.sys);
const list = (s: CliSession): TacacsHost[] => (mg(s).aaa.tacacs ??= []);
const current = (s: CliSession): TacacsHost => {
  const h = list(s).find((x) => x.name === s.poolName);
  if (!h) throw new CliError('% TACACS+ server does not exist');
  return h;
};

/** TACACS+-Konfiguration (`tacacs-server host`, `tacacs server NAME`) und `show tacacs`. */
export function addTacacs(r: Registry<CliSession>): void {
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('tacacs-server', 'Modify TACACS query parameters'),
      K('host', 'Specify a TACACS server'),
      P('ip', 'ip', 'A.B.C.D', 'IP address of TACACS server'),
      opt(K('key', 'per-server encryption key (overrides default)')),
      opt(P('key', 'word', 'WORD', 'The UNENCRYPTED (cleartext) server key')),
    ],
    run: (s, a) => {
      const ip = a.ip as string;
      if (!isValidIpv4(ip)) throw new CliError('% Invalid IP address');
      const l = list(s).filter((x) => x.host !== ip || x.name !== undefined);
      mg(s).aaa.tacacs = l;
      if (!s.negated) l.push({ host: ip, key: a.key ?? '' });
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      K('tacacs', 'Configure TACACS+ server'),
      K('server', 'Define a TACACS+ server'),
      P('name', 'word', 'WORD', 'Name for the TACACS+ server configuration'),
    ],
    run: (s, a) => {
      const name = a.name as string;
      if (s.negated) {
        mg(s).aaa.tacacs = list(s).filter((x) => x.name !== name);
        return;
      }
      if (!list(s).some((x) => x.name === name)) list(s).push({ host: '', key: '', name });
      s.poolName = name;
      s.mode = 'config-tacacs';
    },
  });
  r.add({
    modes: TS,
    negatable: true,
    slots: [
      K('address', 'Specify the TACACS+ server address'),
      K('ipv4', 'Configure IPv4 address for TACACS+ server'),
      P('ip', 'ip', 'A.B.C.D', 'TACACS+ server IPv4 address'),
    ],
    run: (s, a) => {
      current(s).host = s.negated ? '' : (a.ip as string);
    },
  });
  r.add({
    modes: TS,
    negatable: true,
    slots: [
      K('key', 'Set TACACS+ encryption key'),
      opt(P('type', 'word', '0|7', 'Encryption type (ignored)')),
      P('key', 'word', 'WORD', 'The UNENCRYPTED (cleartext) server key'),
    ],
    run: (s, a) => {
      current(s).key = s.negated ? '' : (a.key as string);
    },
  });
  r.add({
    modes: U,
    only: 'l3',
    slots: [
      K('show', 'Show running system information'),
      K('tacacs', 'Shows tacacs server information'),
    ],
    run: (s) => {
      const hosts = (mgmtOf(s.sys).aaa.tacacs ?? []).filter((h) => h.host);
      if (hosts.length === 0) {
        s.out('No TACACS+ servers configured.');
        return;
      }
      for (const h of hosts) {
        const n = (v: number | undefined): string => String(v ?? 0).padStart(10);
        s.outLines([
          `Tacacs+ Server -  public  :`,
          `               Server name: ${h.name ?? h.host}`,
          `            Server address: ${h.host}`,
          `               Server port: 49`,
          `              Socket opens:${n(h.opens)}`,
          `             Socket closes:${n(h.opens)}`,
          `             Socket aborts:${n(0)}`,
          `             Socket errors:${n(h.errors)}`,
          `   Authentication accepted:${n(h.pass)}`,
          `   Authentication rejected:${n(h.fail)}`,
          '',
        ]);
      }
    },
  });
}
