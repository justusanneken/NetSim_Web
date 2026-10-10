import { isValidIpv6, normalizeIpv6 } from '@netsim/protocols';
import type { Acl6, Acl6Entry, Acl6Match, L3Cfg, PortMatch } from '@netsim/engine';
import { targets } from './commands';
import { IFM } from './ifnames';
import { K, P, R, choice, opt, type ModeId, type Registry } from './parser';
import { CliError, type CliSession } from './session';

const CF: ModeId[] = ['config'];
const U: ModeId[] = ['user', 'priv'];
const V6 = K('ipv6', 'Global IPv6 configuration commands');
const IPV6ACL: ModeId[] = ['config-ipv6-acl'];

const PORT_NAMES: Record<string, number> = {
  ftp: 21,
  'ftp-data': 20,
  ssh: 22,
  telnet: 23,
  smtp: 25,
  domain: 53,
  www: 80,
  pop3: 110,
  ntp: 123,
  https: 443,
  bgp: 179,
  syslog: 514,
};
const NAME_OF = Object.fromEntries(Object.entries(PORT_NAMES).map(([k, v]) => [v, k]));

const cfgOf = (s: CliSession): L3Cfg => s.device.config as unknown as L3Cfg;

function addr6(t: string[]): Acl6Match {
  const w = t.shift();
  if (w === 'any') return { any: true };
  if (w === 'host') {
    const a = t.shift();
    if (!a || !isValidIpv6(a)) throw new CliError('% Invalid input detected');
    return { prefix: normalizeIpv6(a) ?? a, plen: 128 };
  }
  const m = /^(.+)\/(\d{1,3})$/.exec(w ?? '');
  if (!m || !isValidIpv6(m[1] as string) || Number(m[2]) > 128)
    throw new CliError('% Invalid input detected');
  return { prefix: normalizeIpv6(m[1] as string) ?? (m[1] as string), plen: Number(m[2]) };
}

function port(t: string[]): PortMatch | undefined {
  const op = t[0];
  const num = (x: string | undefined): number => {
    const n = x === undefined ? NaN : /^\d+$/.test(x) ? Number(x) : (PORT_NAMES[x] ?? NaN);
    if (Number.isNaN(n) || n > 65535) throw new CliError('% Invalid input detected');
    return n;
  };
  if (op === 'eq' || op === 'neq' || op === 'lt' || op === 'gt') {
    t.shift();
    return { op, a: num(t.shift()) };
  }
  if (op === 'range') {
    t.shift();
    const a = num(t.shift());
    return { op: 'range', a, b: num(t.shift()) };
  }
  return undefined;
}

/** `permit|deny PROTO SRC [PORT] DST [PORT] [established] [log] [sequence N]`. */
export function parseAcl6Entry(text: string): Omit<Acl6Entry, 'seq'> & { seq?: number } {
  const t = text.trim().split(/\s+/);
  const action = t.shift();
  if (action !== 'permit' && action !== 'deny') throw new CliError('% Invalid input detected');
  const proto = t.shift();
  if (proto !== 'ipv6' && proto !== 'icmp' && proto !== 'tcp' && proto !== 'udp')
    throw new CliError('% Invalid input detected');
  const src = addr6(t);
  const srcPort = proto === 'tcp' || proto === 'udp' ? port(t) : undefined;
  const dst = addr6(t);
  const dstPort = proto === 'tcp' || proto === 'udp' ? port(t) : undefined;
  let established: boolean | undefined;
  let seq: number | undefined;
  while (t.length) {
    const w = t.shift();
    if (w === 'established' && proto === 'tcp') established = true;
    else if (w === 'log' || w === 'log-input' || w === 'icmp-type') continue;
    else if (w === 'sequence') {
      seq = Number(t.shift());
      if (!Number.isInteger(seq) || seq < 1) throw new CliError('% Invalid input detected');
    } else if (proto === 'icmp') continue;
    else throw new CliError('% Invalid input detected');
  }
  return { action, proto, src, dst, srcPort, dstPort, established, seq, matches: 0 };
}

const m6 = (m: Acl6Match): string =>
  'any' in m
    ? 'any'
    : m.plen === 128
      ? `host ${m.prefix.toUpperCase()}`
      : `${m.prefix.toUpperCase()}/${m.plen}`;
const p6 = (p: PortMatch | undefined): string =>
  !p
    ? ''
    : p.op === 'range'
      ? ` range ${NAME_OF[p.a] ?? p.a} ${NAME_OF[p.b ?? p.a] ?? p.b}`
      : ` ${p.op} ${NAME_OF[p.a] ?? p.a}`;

const text6 = (e: Acl6Entry): string =>
  `${e.action} ${e.proto} ${m6(e.src)}${p6(e.srcPort)} ${m6(e.dst)}${p6(e.dstPort)}${e.established ? ' established' : ''}`;

/** running-config: `ipv6 access-list`-Blöcke (Sequenznummer nur, wenn abweichend von 10, 20, …). */
export function acl6Lines(cfg: L3Cfg): string[] {
  const L: string[] = [];
  for (const acl of Object.values(cfg.acls6 ?? {}).sort((a, b) => a.name.localeCompare(b.name))) {
    L.push(`ipv6 access-list ${acl.name}`);
    acl.entries.forEach((e, i) => {
      if (e.remark) L.push(` remark ${e.remark}`);
      L.push(` ${text6(e)}${e.seq !== (i + 1) * 10 ? ` sequence ${e.seq}` : ''}`);
    });
    if (acl.pendingRemark) L.push(` remark ${acl.pendingRemark}`);
    L.push('!');
  }
  return L;
}

export function acl6IfLines(c: { v6?: { aclIn?: string; aclOut?: string } }): string[] {
  const L: string[] = [];
  if (c.v6?.aclIn) L.push(` ipv6 traffic-filter ${c.v6.aclIn} in`);
  if (c.v6?.aclOut) L.push(` ipv6 traffic-filter ${c.v6.aclOut} out`);
  return L;
}

export function showAcl6(cfg: L3Cfg, name?: string): string[] {
  const L: string[] = [];
  for (const acl of Object.values(cfg.acls6 ?? {})) {
    if (name && acl.name !== name) continue;
    L.push(`IPv6 access list ${acl.name}`);
    for (const e of acl.entries)
      L.push(
        `    ${text6(e)}${e.matches ? ` (${e.matches} match${e.matches === 1 ? '' : 'es'})` : ''} sequence ${e.seq}`,
      );
  }
  return L;
}

/** IPv6-ACLs, ACL-Resequencing. */
export function addAclExtras(r: Registry<CliSession>): void {
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      V6,
      K('access-list', 'Configure IPv6 access lists'),
      P('name', 'word', 'WORD', 'User selected string identifying this access list'),
    ],
    run: (s, a) => {
      const c = cfgOf(s);
      const name = a.name as string;
      if (s.negated) {
        if (c.acls6) delete c.acls6[name];
        return;
      }
      (c.acls6 ??= {})[name] ??= { name, entries: [] };
      s.aclName = name;
      s.mode = 'config-ipv6-acl';
    },
  });
  for (const action of ['permit', 'deny'] as const) {
    r.add({
      modes: IPV6ACL,
      only: 'l3',
      negatable: true,
      slots: [
        K(action, action === 'permit' ? 'Specify packets to forward' : 'Specify packets to reject'),
        R('rest', 'LINE', 'access-list entry'),
      ],
      run: (s, a) => {
        const acl = cfgOf(s).acls6?.[s.aclName] as Acl6;
        const e = parseAcl6Entry(`${action} ${a.rest}`);
        if (s.negated) {
          const i = acl.entries.findIndex((x) =>
            e.seq !== undefined ? x.seq === e.seq : text6(x) === text6({ ...e, seq: 0 }),
          );
          if (i >= 0) acl.entries.splice(i, 1);
          return;
        }
        const seq =
          e.seq ??
          (acl.entries.length ? (acl.entries[acl.entries.length - 1] as Acl6Entry).seq + 10 : 10);
        if (acl.entries.some((x) => x.seq === seq))
          throw new CliError('% Duplicate sequence number');
        const entry: Acl6Entry = { ...e, seq };
        if (acl.pendingRemark) {
          entry.remark = acl.pendingRemark;
          acl.pendingRemark = undefined;
        }
        acl.entries.push(entry);
        acl.entries.sort((x, y) => x.seq - y.seq);
      },
    });
  }
  r.add({
    modes: IPV6ACL,
    only: 'l3',
    slots: [K('remark', 'Access list entry comment'), R('t', 'LINE', 'comment')],
    run: (s, a) => {
      const acl = cfgOf(s).acls6?.[s.aclName];
      if (acl) acl.pendingRemark = a.t as string;
    },
  });
  r.add({
    modes: IFM,
    only: 'l3',
    negatable: true,
    slots: [
      V6,
      K('traffic-filter', 'Filter IPv6 traffic'),
      P('acl', 'word', 'WORD', 'Access-list name'),
      choice('dir', ['in', 'inbound packets'], ['out', 'outbound packets']),
    ],
    run: (s, a) => {
      for (const id of targets(s)) {
        const c = cfgOf(s).ifaces[id];
        if (!c) continue;
        const v6 = (c.v6 ??= { enabled: false, addrs: [], autoconfig: false, slaac: [] });
        if (a.dir === 'in') v6.aclIn = s.negated ? undefined : (a.acl as string);
        else v6.aclOut = s.negated ? undefined : (a.acl as string);
      }
    },
  });
  r.add({
    modes: U,
    only: 'l3',
    slots: [
      K('show', 'Show running system information'),
      V6,
      K('access-list', 'Summary of access lists'),
      opt(P('name', 'word', 'WORD', 'Access list name')),
    ],
    run: (s, a) => s.outLines(showAcl6(cfgOf(s), a.name as string | undefined)),
  });

  // ---------------------------------------------------------- resequence
  r.add({
    modes: CF,
    only: 'l3',
    slots: [
      K('ip', 'Global IP configuration subcommands'),
      K('access-list', 'Named access list'),
      K('resequence', 'Resequence Access List'),
      P('name', 'word', 'WORD', 'Access-list name'),
      P('start', 'int', '<1-2147483647>', 'Starting Sequence Number', [1, 2147483647]),
      P('inc', 'int', '<1-2147483647>', 'Step to increment the sequence number', [1, 2147483647]),
    ],
    run: (s, a) => {
      const acl = cfgOf(s).acls[a.name as string];
      if (!acl) throw new CliError('% Access-list not found');
      let n = Number(a.start);
      for (const e of acl.entries) {
        e.seq = n;
        n += Number(a.inc);
      }
    },
  });
}
