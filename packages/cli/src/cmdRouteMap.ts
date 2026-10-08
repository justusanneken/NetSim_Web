import { isValidIpv4, isValidIpv6 } from '@netsim/protocols';
import {
  newRouteMapClause,
  type DistList,
  type PrefixList,
  type RouteMap,
  type RouteMapClause,
  type RoutingCfg,
} from '@netsim/engine';
import { resolveIface } from './ifnames';
import { K, P, R, choice, opt, type ModeId, type Registry } from './parser';
import { CliError, type CliSession } from './session';
import { l3c, touch } from './commandsGaps';

const CF: ModeId[] = ['config'];
const RM: ModeId[] = ['config-route-map'];
const IP = K('ip', 'IP information');
const IPV6 = K('ipv6', 'IPv6 information');
const rt = (s: CliSession): RoutingCfg => l3c(s).routing;

const parsePrefix = (text: string, v6: boolean): { prefix: string; plen: number } => {
  const [a, l] = text.split('/') as [string, string | undefined];
  const plen = Number(l);
  const ok = v6
    ? isValidIpv6(a) && plen >= 0 && plen <= 128
    : isValidIpv4(a) && plen >= 0 && plen <= 32;
  if (l === undefined || !/^\d+$/.test(l) || !ok) throw new CliError('% Invalid prefix');
  return { prefix: v6 ? a.toLowerCase() : a, plen };
};

/** Aktuelle Route-Map-Klausel (Route-Map-Modus). */
export function clauseOf(s: CliSession): RouteMapClause {
  const rm = rt(s).routeMaps[s.rmName];
  const c = rm?.clauses.find((x) => x.seq === s.rmSeq);
  if (!c) throw new CliError('% Route-map clause does not exist');
  return c;
}

/** Namensliste aus einer Restzeile (`A B C`). */
const names = (text: string): string[] => text.split(/\s+/).filter(Boolean);

export function addRouteMap(r: Registry<CliSession>): void {
  // ------------------------------------------------------------ Prefix-Lists
  for (const v6 of [false, true]) {
    r.add({
      modes: CF,
      only: 'l3',
      negatable: true,
      slots: [
        v6 ? IPV6 : IP,
        K('prefix-list', 'Build a prefix list'),
        P('name', 'word', 'WORD', 'Name of a prefix list'),
        opt(K('seq', 'sequence number of an entry')),
        opt(P('seq', 'int', '<1-4294967294>', 'Sequence number', [1, 4294967294])),
        opt(
          choice(
            'act',
            ['permit', 'Specify packets to forward'],
            ['deny', 'Specify packets to reject'],
          ),
        ),
        opt(
          P(
            'pfx',
            'word',
            v6 ? 'X:X:X:X::X/<0-128>' : 'A.B.C.D/nn',
            'IP prefix <network>/<length>',
          ),
        ),
        opt(K('ge', 'Minimum prefix length to be matched')),
        opt(P('ge', 'int', '<0-128>', 'Minimum prefix length', [0, 128])),
        opt(K('le', 'Maximum prefix length to be matched')),
        opt(P('le', 'int', '<0-128>', 'Maximum prefix length', [0, 128])),
      ],
      run: (s, a) => {
        const lists = v6 ? rt(s).prefixLists6 : rt(s).prefixLists;
        const name = a.name as string;
        if (s.negated) {
          const pl = lists[name];
          if (pl && a.act && a.pfx) {
            const { prefix, plen } = parsePrefix(a.pfx, v6);
            pl.entries = pl.entries.filter(
              (e) =>
                !(
                  e.prefix === prefix &&
                  e.plen === plen &&
                  e.action === a.act &&
                  (a.seq === undefined || e.seq === Number(a.seq))
                ),
            );
            if (pl.entries.length === 0) delete lists[name];
          } else if (pl && a.seq) {
            pl.entries = pl.entries.filter((e) => e.seq !== Number(a.seq));
            if (pl.entries.length === 0) delete lists[name];
          } else delete lists[name];
          touch(s);
          return;
        }
        if (!a.act || !a.pfx) throw new CliError('% Incomplete command.');
        const { prefix, plen } = parsePrefix(a.pfx, v6);
        const pl: PrefixList = (lists[name] ??= { name, entries: [] });
        const seq = a.seq !== undefined ? Number(a.seq) : (pl.entries.at(-1)?.seq ?? 0) + 5;
        const entry = {
          seq,
          action: a.act as 'permit' | 'deny',
          prefix,
          plen,
          ge: a.ge !== undefined ? Number(a.ge) : undefined,
          le: a.le !== undefined ? Number(a.le) : undefined,
        };
        if (
          (entry.ge !== undefined && entry.ge <= plen) ||
          (entry.le !== undefined && entry.ge !== undefined && entry.le < entry.ge) ||
          (entry.le !== undefined && entry.le < plen)
        )
          throw new CliError('% Invalid prefix range for ge/le');
        pl.entries = [...pl.entries.filter((e) => e.seq !== seq), entry].sort(
          (x, y) => x.seq - y.seq,
        );
        touch(s);
      },
    });
  }

  // ------------------------------------------------------------ Community-Listen
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      IP,
      K('community-list', 'Add a community list entry'),
      opt(K('standard', 'Standard community list')),
      P('name', 'word', 'WORD', 'Community list name'),
      opt(
        choice(
          'act',
          ['permit', 'Specify community to accept'],
          ['deny', 'Specify community to reject'],
        ),
      ),
      opt(R('values', 'AA:NN', 'Community number')),
    ],
    run: (s, a) => {
      const lists = rt(s).communityLists;
      const name = a.name as string;
      if (s.negated) {
        delete lists[name];
        touch(s);
        return;
      }
      if (!a.act || !a.values) throw new CliError('% Incomplete command.');
      const values = names(a.values);
      const cl = (lists[name] ??= { name, entries: [] });
      cl.entries.push({ action: a.act as 'permit' | 'deny', values });
      touch(s);
    },
  });

  // ------------------------------------------------------------ route-map
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      K('route-map', 'Create route-map or enter route-map command mode'),
      P('name', 'word', 'WORD', 'Route map tag'),
      opt(
        choice(
          'act',
          ['permit', 'Route map denies set operations'],
          ['deny', 'Route map denies set operations'],
        ),
      ),
      opt(
        P(
          'seq',
          'int',
          '<0-65535>',
          'Sequence to insert to/delete from existing route-map entry',
          [0, 65535],
        ),
      ),
    ],
    run: (s, a) => {
      const maps = rt(s).routeMaps;
      const name = a.name as string;
      const seq = a.seq !== undefined ? Number(a.seq) : 10;
      if (s.negated) {
        const rm = maps[name];
        if (rm && (a.seq !== undefined || a.act)) {
          rm.clauses = rm.clauses.filter((c) => c.seq !== seq);
          if (rm.clauses.length === 0) delete maps[name];
        } else delete maps[name];
        touch(s);
        return;
      }
      const rm: RouteMap = (maps[name] ??= { name, clauses: [] });
      let c = rm.clauses.find((x) => x.seq === seq);
      if (!c) {
        c = newRouteMapClause(seq, (a.act as 'permit' | 'deny' | undefined) ?? 'permit');
        rm.clauses.push(c);
        rm.clauses.sort((x, y) => x.seq - y.seq);
      } else if (a.act) c.action = a.act as 'permit' | 'deny';
      s.rmName = name;
      s.rmSeq = seq;
      s.mode = 'config-route-map';
      touch(s);
    },
  });

  // match
  const upd = (s: CliSession, f: (c: RouteMapClause) => void): void => {
    f(clauseOf(s));
    touch(s);
  };
  const addNames = (list: string[], items: string[], neg: boolean): string[] =>
    neg ? list.filter((x) => !items.includes(x)) : [...new Set([...list, ...items])];
  r.add({
    modes: RM,
    only: 'l3',
    negatable: true,
    slots: [
      K('match', 'Match values from routing table'),
      IP,
      K('address', 'Match address of route or match packet'),
      K('prefix-list', 'Match entries of prefix-lists'),
      R('names', 'WORD', 'IP prefix-list name'),
    ],
    run: (s, a) =>
      upd(
        s,
        (c) => (c.matchPrefixLists = addNames(c.matchPrefixLists, names(a.names ?? ''), s.negated)),
      ),
  });
  r.add({
    modes: RM,
    only: 'l3',
    negatable: true,
    slots: [
      K('match', 'Match values from routing table'),
      IP,
      K('address', 'Match address of route or match packet'),
      R('names', '<1-199>', 'IP access-list number or name'),
    ],
    run: (s, a) =>
      upd(s, (c) => (c.matchAcls = addNames(c.matchAcls, names(a.names ?? ''), s.negated))),
  });
  r.add({
    modes: RM,
    only: 'l3',
    negatable: true,
    slots: [
      K('match', 'Match values from routing table'),
      IP,
      K('next-hop', 'Match next-hop address of route'),
      K('prefix-list', 'Match entries of prefix-lists'),
      R('names', 'WORD', 'IP prefix-list name'),
    ],
    run: (s, a) =>
      upd(
        s,
        (c) =>
          (c.matchNextHopPrefixLists = addNames(
            c.matchNextHopPrefixLists,
            names(a.names ?? ''),
            s.negated,
          )),
      ),
  });
  r.add({
    modes: RM,
    only: 'l3',
    negatable: true,
    slots: [
      K('match', 'Match values from routing table'),
      K('tag', 'Match tag of route'),
      R('n', '<0-4294967295>', 'Tag value'),
    ],
    run: (s, a) =>
      upd(s, (c) => {
        const v = names(a.n ?? '').map(Number);
        c.matchTags = s.negated
          ? c.matchTags.filter((x) => !v.includes(x))
          : [...new Set([...c.matchTags, ...v])];
      }),
  });
  r.add({
    modes: RM,
    only: 'l3',
    negatable: true,
    slots: [
      K('match', 'Match values from routing table'),
      K('metric', 'Match metric of route'),
      P('n', 'int', '<0-4294967295>', 'Metric value', [0, 4294967295]),
    ],
    run: (s, a) =>
      upd(s, (c) => {
        const v = Number(a.n);
        c.matchMetrics = s.negated
          ? c.matchMetrics.filter((x) => x !== v)
          : [...new Set([...c.matchMetrics, v])];
      }),
  });
  r.add({
    modes: RM,
    only: 'l3',
    negatable: true,
    slots: [
      K('match', 'Match values from routing table'),
      K('community', 'Match BGP community list'),
      R('names', '<1-500>', 'Community-list number (standard or expanded)'),
    ],
    run: (s, a) =>
      upd(
        s,
        (c) => (c.matchCommunities = addNames(c.matchCommunities, names(a.names ?? ''), s.negated)),
      ),
  });

  // set
  const SET = K('set', 'Set values in destination routing protocol');
  const num = (
    word: string,
    help: string,
    lo: number,
    hi: number,
    apply: (c: RouteMapClause, v: number | undefined) => void,
    pre: ReturnType<typeof K>[] = [],
  ): void => {
    r.add({
      modes: RM,
      only: 'l3',
      negatable: true,
      slots: [SET, ...pre, K(word, help), P('n', 'int', `<${lo}-${hi}>`, help, [lo, hi])],
      run: (s, a) => upd(s, (c) => apply(c, s.negated ? undefined : Number(a.n))),
    });
  };
  num(
    'local-preference',
    'BGP local preference path attribute',
    0,
    4294967295,
    (c, v) => (c.set.localPref = v),
  );
  num('weight', 'BGP weight for routing table', 0, 65535, (c, v) => (c.set.weight = v));
  num(
    'tag',
    'Tag value for destination routing protocol',
    0,
    4294967295,
    (c, v) => (c.set.tag = v),
  );
  r.add({
    modes: RM,
    only: 'l3',
    negatable: true,
    slots: [
      SET,
      K('metric', 'Metric value for destination routing protocol'),
      P('n', 'int', '<0-4294967295>', 'Metric value', [0, 4294967295]),
    ],
    run: (s, a) => upd(s, (c) => (c.set.metric = s.negated ? undefined : Number(a.n))),
  });
  r.add({
    modes: RM,
    only: 'l3',
    negatable: true,
    slots: [
      SET,
      K('metric', 'Metric value for destination routing protocol'),
      P('bw', 'int', '<1-4294967295>', 'Bandwidth metric in Kbits per second'),
      P('dly', 'int', '<0-4294967295>', 'EIGRP delay metric, in 10 microsecond units'),
      P('rel', 'int', '<0-255>', 'EIGRP reliability metric', [0, 255]),
      P('load', 'int', '<1-255>', 'EIGRP Effective bandwidth metric (Loading)', [1, 255]),
      P('mtu', 'int', '<1-65535>', 'EIGRP MTU of the path', [1, 65535]),
    ],
    run: (s, a) =>
      upd(
        s,
        (c) =>
          (c.set.eigrpMetric = s.negated ? undefined : { bw: Number(a.bw), delay: Number(a.dly) }),
      ),
  });
  r.add({
    modes: RM,
    only: 'l3',
    negatable: true,
    slots: [
      SET,
      K('metric-type', 'Type of metric for destination routing protocol'),
      choice(
        't',
        ['type-1', 'OSPF external type 1 metric'],
        ['type-2', 'OSPF external type 2 metric'],
      ),
    ],
    run: (s, a) =>
      upd(s, (c) => (c.set.metricType = s.negated ? undefined : a.t === 'type-1' ? 1 : 2)),
  });
  r.add({
    modes: RM,
    only: 'l3',
    negatable: true,
    slots: [
      SET,
      K('as-path', 'Prepend string for a BGP AS-path attribute'),
      K('prepend', 'Prepend to the as-path'),
      R('asns', '<1-65535>', 'AS number'),
    ],
    run: (s, a) =>
      upd(s, (c) => {
        const v = names(a.asns ?? '').map(Number);
        if (v.some((x) => !Number.isInteger(x) || x < 1 || x > 65535))
          throw new CliError('% Invalid AS number');
        c.set.asPathPrepend = s.negated ? undefined : v;
      }),
  });
  r.add({
    modes: RM,
    only: 'l3',
    negatable: true,
    slots: [
      SET,
      K('community', 'BGP community attribute'),
      R('values', 'AA:NN', 'Community number'),
    ],
    run: (s, a) =>
      upd(s, (c) => {
        if (s.negated) {
          c.set.community = undefined;
          return;
        }
        const toks = names(a.values ?? '');
        const additive = toks.includes('additive');
        const none = toks.includes('none');
        const values = toks.filter((x) => x !== 'additive' && x !== 'none');
        if (!none && values.length === 0) throw new CliError('% Incomplete command.');
        c.set.community = { values, additive, none: none || undefined };
      }),
  });
  r.add({
    modes: RM,
    only: 'l3',
    negatable: true,
    slots: [
      SET,
      IP,
      K('next-hop', 'Next hop address'),
      P('nh', 'ip', 'A.B.C.D', 'IP address of next hop'),
    ],
    run: (s, a) => upd(s, (c) => (c.set.nextHop = s.negated ? undefined : (a.nh as string))),
  });
  r.add({
    modes: RM,
    only: 'l3',
    negatable: true,
    slots: [
      SET,
      K('origin', 'BGP origin code'),
      choice('o', ['igp', 'local IGP'], ['egp', 'remote EGP'], ['incomplete', 'unknown heritage']),
    ],
    run: (s, a) =>
      upd(s, (c) => (c.set.origin = s.negated ? undefined : (a.o as 'igp' | 'egp' | 'incomplete'))),
  });

  // ------------------------------------------------------------ distribute-list
  const DL: ModeId[] = ['config-rip', 'config-eigrp', 'config-ospf'];
  const listsOf = (s: CliSession): { distributeLists?: DistList[] } & Record<string, unknown> => {
    const x = rt(s);
    const c =
      s.mode === 'config-rip'
        ? x.rip
        : s.mode === 'config-eigrp'
          ? x.eigrp[s.procId]
          : x.ospf[s.procId];
    if (!c) throw new CliError('% Routing process is not running');
    return c as never;
  };
  for (const kind of ['acl', 'prefix-list'] as const) {
    r.add({
      modes: DL,
      only: 'l3',
      negatable: true,
      slots: [
        K('distribute-list', 'Filter networks in routing updates'),
        ...(kind === 'prefix-list'
          ? [
              K('prefix', 'Filter prefixes in routing updates'),
              P('name', 'word', 'WORD', 'Name of an IP prefix-list'),
            ]
          : [P('name', 'word', '<1-199>', 'IP access list number or name')]),
        choice(
          'dir',
          ['in', 'Filter incoming routing updates'],
          ['out', 'Filter outgoing routing updates'],
        ),
        opt(P('if', 'iface', 'IFNAME', 'Interface')),
      ],
      run: (s, a) => {
        const c = listsOf(s);
        const dir = a.dir as 'in' | 'out';
        if (s.mode === 'config-ospf' && dir === 'out')
          throw new CliError(
            '% OSPF distribute-list out is not supported (use redistribution filters)',
          );
        const ifaceId = a.if ? resolveIface(s.device, a.if)?.id : undefined;
        if (a.if && !ifaceId) throw new CliError('% Invalid interface');
        const same = (d: DistList): boolean =>
          d.kind === kind && d.name === a.name && d.dir === dir && d.ifaceId === ifaceId;
        const cur = (c.distributeLists ?? []).filter((d) => !same(d));
        c.distributeLists = s.negated
          ? cur
          : [...cur, { kind, name: a.name as string, dir, ifaceId }];
        if ('dirty' in c) c.dirty = true;
        touch(s);
      },
    });
  }
}
