import { dscpName, parseDscp } from '@netsim/protocols';
import { KNOWN_PROTOCOLS, qosOf, type L3Cfg, type QosCfg, type QosClass } from '@netsim/engine';
import { targets } from './commands';
import { IFM, resolveIface } from './ifnames';
import { K, P, R, choice, opt, type ModeId, type Registry } from './parser';
import { CliError, type CliSession } from './session';

const CF: ModeId[] = ['config'];
const U: ModeId[] = ['user', 'priv'];
const CMAP: ModeId[] = ['config-cmap'];
const PMAP: ModeId[] = ['config-pmap'];
const PMAPC: ModeId[] = ['config-pmap-c'];
const SHOW = K('show', 'Show running system information');

const cfgOf = (s: CliSession): L3Cfg => s.device.config as unknown as L3Cfg;

function dscpList(words: string[]): number[] {
  return words.map((w) => {
    const n = parseDscp(w);
    if (n === undefined) throw new CliError('% Invalid input detected');
    return n;
  });
}

const dscpText = (n: number): string => dscpName(n);

/** QoS: class-map, policy-map, service-policy und die zugehörigen show-Befehle. */
export function addQos(r: Registry<CliSession>): void {
  // ------------------------------------------------------------ class-map
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      K('class-map', 'Configure CMAP'),
      opt(
        choice(
          't',
          ['match-all', 'Logical-AND all matching statements under this classmap'],
          ['match-any', 'Logical-OR all matching statements under this classmap'],
        ),
      ),
      P('name', 'word', 'WORD', 'class-map name'),
    ],
    run: (s, a) => {
      const q = qosOf(cfgOf(s));
      const name = a.name as string;
      if (s.negated) {
        delete q.classes[name];
        return;
      }
      const c = (q.classes[name] ??= { name, matchAll: true, dscp: [], protocols: [], any: false });
      if (a.t) c.matchAll = a.t === 'match-all';
      s.aclName = name;
      s.mode = 'config-cmap';
    },
  });
  const cls = (s: CliSession): QosClass => {
    const c = qosOf(cfgOf(s)).classes[s.aclName];
    if (!c) throw new CliError('% Class-map does not exist');
    return c;
  };
  r.add({
    modes: CMAP,
    only: 'l3',
    negatable: true,
    slots: [
      K('match', 'classification criteria'),
      opt(K('ip', 'IP specific values')),
      K('dscp', 'Match DSCP in IP(v4)/IP(v6) packets'),
      R('vals', 'DSCP', 'Differentiated services codepoint value(s)'),
    ],
    run: (s, a) => {
      const c = cls(s);
      const vals = dscpList(String(a.vals).split(/\s+/).filter(Boolean));
      c.dscp = s.negated
        ? c.dscp.filter((d) => !vals.includes(d))
        : [...new Set([...c.dscp, ...vals])];
    },
  });
  r.add({
    modes: CMAP,
    only: 'l3',
    negatable: true,
    slots: [
      K('match', 'classification criteria'),
      K('access-group', 'Access group'),
      opt(K('name', 'Match access-group via name')),
      P('acl', 'word', 'WORD', 'ACL name or number'),
    ],
    run: (s, a) => {
      const c = cls(s);
      c.acl = s.negated ? undefined : (a.acl as string);
    },
  });
  r.add({
    modes: CMAP,
    only: 'l3',
    negatable: true,
    slots: [K('match', 'classification criteria'), K('any', 'Any packets')],
    run: (s) => {
      cls(s).any = !s.negated;
    },
  });
  r.add({
    modes: CMAP,
    only: 'l3',
    negatable: true,
    slots: [
      K('match', 'classification criteria'),
      K('protocol', 'Protocol'),
      P('p', 'word', 'WORD', 'Protocol name'),
    ],
    run: (s, a) => {
      const c = cls(s);
      const p = String(a.p).toLowerCase();
      if (!KNOWN_PROTOCOLS.includes(p)) throw new CliError('% Invalid input detected');
      c.protocols = s.negated
        ? c.protocols.filter((x) => x !== p)
        : [...new Set([...c.protocols, p])];
    },
  });

  // ------------------------------------------------------------ policy-map
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [K('policy-map', 'Configure Policy Map'), P('name', 'word', 'WORD', 'policy-map name')],
    run: (s, a) => {
      const q = qosOf(cfgOf(s));
      const name = a.name as string;
      if (s.negated) {
        delete q.policies[name];
        return;
      }
      q.policies[name] ??= { name, classes: [] };
      s.aclName = name;
      s.mode = 'config-pmap';
    },
  });
  r.add({
    modes: [...PMAP, ...PMAPC],
    only: 'l3',
    negatable: true,
    slots: [K('class', 'policy criteria'), P('name', 'word', 'WORD', 'class-map name')],
    run: (s, a) => {
      const pol = qosOf(cfgOf(s)).policies[s.aclName];
      if (!pol) throw new CliError('% Policy-map does not exist');
      const name = a.name as string;
      if (name !== 'class-default' && !qosOf(cfgOf(s)).classes[name])
        throw new CliError(`% Class-map ${name} not configured`);
      if (s.negated) {
        pol.classes = pol.classes.filter((c) => c.class !== name);
        return;
      }
      if (!pol.classes.some((c) => c.class === name))
        pol.classes.push({ class: name, actions: [] });
      s.poolName = name;
      s.mode = 'config-pmap-c';
    },
  });
  const pc = (s: CliSession) => {
    const pol = qosOf(cfgOf(s)).policies[s.aclName];
    const c = pol?.classes.find((x) => x.class === s.poolName);
    if (!c) throw new CliError('% Class does not exist');
    return c;
  };
  r.add({
    modes: PMAPC,
    only: 'l3',
    negatable: true,
    slots: [
      K('set', 'Set QoS values'),
      opt(K('ip', 'Set IP specific values')),
      K('dscp', 'Set IP DSCP (DiffServ CodePoint)'),
      P('v', 'word', 'DSCP', 'Differentiated services codepoint value'),
    ],
    run: (s, a) => {
      const [v] = dscpList([a.v as string]);
      pc(s).setDscp = s.negated ? undefined : v;
    },
  });
  for (const [kw, help] of [
    ['bandwidth', 'Bandwidth'],
    ['priority', 'Strict Scheduling Priority for this Class'],
    ['police', 'Police'],
    ['queue-limit', 'Queue Max Threshold for Tail Drop'],
    ['shape', 'Traffic Shaping'],
  ] as const) {
    r.add({
      modes: PMAPC,
      only: 'l3',
      negatable: true,
      slots: [K(kw, help), R('rest', 'VALUE', 'parameters')],
      run: (s, a) => {
        const c = pc(s);
        c.actions = c.actions.filter((x) => !x.startsWith(kw));
        if (!s.negated) c.actions.push(`${kw} ${a.rest}`);
      },
    });
  }

  // ------------------------------------------------------------ service-policy
  r.add({
    modes: IFM,
    only: 'l3',
    negatable: true,
    slots: [
      K('service-policy', 'Configure QoS Service Policy'),
      choice(
        'dir',
        ['input', 'Assign policy-map to the input of an interface'],
        ['output', 'Assign policy-map to the output of an interface'],
      ),
      P('name', 'word', 'WORD', 'policy-map name'),
    ],
    run: (s, a) => {
      const name = a.name as string;
      if (!s.negated && !qosOf(cfgOf(s)).policies[name])
        throw new CliError(`% policy map ${name} not configured`);
      for (const id of targets(s)) {
        const c = cfgOf(s).ifaces[id];
        if (!c) continue;
        if (a.dir === 'input') c.policyIn = s.negated ? undefined : name;
        else c.policyOut = s.negated ? undefined : name;
      }
    },
  });

  // ------------------------------------------------------------ show
  r.add({
    modes: U,
    only: 'l3',
    slots: [
      SHOW,
      K('class-map', 'Show Class Map'),
      opt(P('name', 'word', 'WORD', 'class-map name')),
    ],
    run: (s, a) => s.outLines(showClassMap(cfgOf(s), a.name as string | undefined)),
  });
  r.add({
    modes: U,
    only: 'l3',
    slots: [
      SHOW,
      K('policy-map', 'Show Policy Map'),
      opt(P('name', 'word', 'WORD', 'policy-map name')),
    ],
    run: (s, a) => s.outLines(showPolicyMap(cfgOf(s), a.name as string | undefined)),
  });
  r.add({
    modes: U,
    only: 'l3',
    slots: [
      SHOW,
      K('policy-map', 'Show Policy Map'),
      K('interface', 'Show Policy Map for an interface'),
      opt(P('if', 'iface', 'IFNAME', 'Interface name')),
    ],
    run: (s, a) => {
      const ref = a.if ? resolveIface(s.device, a.if as string) : undefined;
      if (a.if && !ref) throw new CliError('% Invalid interface');
      s.outLines(showPolicyInterface(s, ref?.id));
    },
  });
}

// ---------------------------------------------------------------- Anzeigen

function matchLines(c: QosClass, indent: string): string[] {
  const L: string[] = [];
  if (c.any) L.push(`${indent}Match any `);
  if (c.dscp.length)
    L.push(`${indent}Match dscp ${c.dscp.map(dscpText).join(' ')} (${c.dscp.join(' ')})`);
  if (c.acl) L.push(`${indent}Match access-group name ${c.acl}`);
  for (const p of c.protocols) L.push(`${indent}Match protocol ${p}`);
  return L;
}

export function showClassMap(cfg: L3Cfg, name?: string): string[] {
  const L: string[] = [];
  for (const c of Object.values(cfg.qos?.classes ?? {})) {
    if (name && c.name !== name) continue;
    L.push(
      ` Class Map ${c.matchAll ? 'match-all' : 'match-any'} ${c.name} (id 1)`,
      ...matchLines(c, '   '),
      '',
    );
  }
  return L;
}

export function showPolicyMap(cfg: L3Cfg, name?: string): string[] {
  const L: string[] = [];
  for (const p of Object.values(cfg.qos?.policies ?? {})) {
    if (name && p.name !== name) continue;
    L.push(`  Policy Map ${p.name}`);
    for (const c of p.classes) {
      L.push(`    Class ${c.class}`);
      if (c.setDscp !== undefined) L.push(`      set dscp ${dscpText(c.setDscp)}`);
      for (const a of c.actions) L.push(`      ${a}`);
    }
    L.push('');
  }
  return L;
}

function showPolicyInterface(s: CliSession, only?: string): string[] {
  const cfg = cfgOf(s);
  const q = cfg.qos;
  const L: string[] = [];
  for (const p of s.device.ports) {
    if (only && p.id !== only) continue;
    const ic = cfg.ifaces[p.id];
    for (const dir of ['in', 'out'] as const) {
      const pol = dir === 'in' ? ic?.policyIn : ic?.policyOut;
      const def = pol ? q?.policies[pol] : undefined;
      if (!pol || !def) continue;
      L.push(
        ` ${p.name} `,
        '',
        `  Service-policy ${dir === 'in' ? 'input' : 'output'}: ${pol}`,
        '',
      );
      for (const pc of def.classes) {
        const c = pc.class === 'class-default' ? undefined : q?.classes[pc.class];
        const ctr = q?.counters[`${p.id}|${dir}|${pc.class}`] ?? { pkts: 0, bytes: 0, marked: 0 };
        L.push(
          `    Class-map: ${pc.class} (${c ? (c.matchAll ? 'match-all' : 'match-any') : 'match-any'})`,
          `      ${ctr.pkts} packets, ${ctr.bytes} bytes`,
          '      5 minute offered rate 0000 bps, drop rate 0000 bps',
          ...(c ? matchLines(c, '      ') : ['      Match: any']),
        );
        if (pc.setDscp !== undefined)
          L.push(
            '      QoS Set',
            `        dscp ${dscpText(pc.setDscp)}`,
            `          Packets marked ${ctr.marked}`,
          );
        L.push('');
      }
    }
  }
  return L;
}

// ---------------------------------------------------------------- Rendering

export function qosGlobalLines(cfg: L3Cfg): string[] {
  const q: QosCfg | undefined = cfg.qos;
  if (!q) return [];
  const L: string[] = [];
  for (const c of Object.values(q.classes)) {
    L.push(`class-map ${c.matchAll ? 'match-all' : 'match-any'} ${c.name}`);
    if (c.any) L.push(' match any');
    if (c.dscp.length) L.push(` match dscp ${c.dscp.map(dscpText).join(' ')}`);
    if (c.acl) L.push(` match access-group name ${c.acl}`);
    for (const p of c.protocols) L.push(` match protocol ${p}`);
    L.push('!');
  }
  for (const p of Object.values(q.policies)) {
    L.push(`policy-map ${p.name}`);
    for (const c of p.classes) {
      L.push(` class ${c.class}`);
      if (c.setDscp !== undefined) L.push(`  set dscp ${dscpText(c.setDscp)}`);
      for (const a of c.actions) L.push(`  ${a}`);
    }
    L.push('!');
  }
  return L;
}

export function qosIfLines(c: { policyIn?: string; policyOut?: string } | undefined): string[] {
  const L: string[] = [];
  if (c?.policyIn) L.push(` service-policy input ${c.policyIn}`);
  if (c?.policyOut) L.push(` service-policy output ${c.policyOut}`);
  return L;
}
