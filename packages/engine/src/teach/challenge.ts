import { describeFrame, type Frame, type Ipv4Pdu } from '@netsim/protocols';
import type { LogEntry, Msg } from '../types';

/**
 * "Challenge Me": Quiz zu einem Ereignis im PDU-Inspektor. Die richtige Antwort ist nie geraten, sondern die
 * tatsaechliche Entscheidung der Engine: Sie steht im Log-Eintrag (Nachrichtenschluessel + Parameter, z. B.
 * `router.forward`, `acl.deny`, `switch.unicast`) und im empfangenen Frame. Antwortoptionen sind plausible
 * Fehlvorstellungen (Distraktoren). Reihenfolge und Auswahl sind deterministisch (Seed aus Ereignis-ID).
 */

export type DeviceClass = 'host' | 'router' | 'switch' | 'hub' | 'other';

export interface ChallengeContext {
  entry: LogEntry;
  deviceKind: DeviceClass;
  /** Anzeigenamen aller Ports/Schnittstellen des Geraets (Distraktoren fuer Port-Fragen). */
  ports: string[];
  /** Spaetere Log-Eintraege (Zeitfenster nach dem Ereignis); fuer Folgeverhalten wie ARP. */
  later: LogEntry[];
}

export interface ChallengeOption {
  id: string;
  label: Msg;
}

export interface ChallengeQuestion {
  /** Stabil: `<logId>:<kind>`. */
  id: string;
  kind: string;
  /** OSI-Schicht, auf der die Entscheidung faellt (1-7). */
  layer: number;
  prompt: Msg;
  options: ChallengeOption[];
  correct: string;
  explain: Msg;
}

const V = (value: string | number): Msg => ({ key: 'challenge.o.value', params: { value } });
const O = (id: string, params?: Msg['params']): Msg => ({ key: `challenge.o.${id}`, params });

interface Opt {
  id: string;
  label: Msg;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministisches Mischen (LCG), damit die richtige Antwort nicht immer an derselben Stelle steht. */
function shuffle<T>(items: T[], seed: string): T[] {
  const a = [...items];
  let s = hashSeed(seed) || 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

function ipOf(f: Frame | undefined): Ipv4Pdu | undefined {
  return f?.payload.kind === 'ipv4' ? f.payload : undefined;
}

/** Hoechste Schicht, die im Frame vorkommt (ohne Router/Switch-Begrenzung). */
function topLayer(f: Frame | undefined): number {
  if (!f) return 2;
  return Math.max(2, ...describeFrame(f).map((l) => l.osi));
}

class Builder {
  readonly out: ChallengeQuestion[] = [];
  constructor(private readonly c: ChallengeContext) {}

  add(
    kind: string,
    layer: number,
    prompt: Msg,
    options: Opt[],
    correct: string,
    explain: Msg,
  ): void {
    const uniq: Opt[] = [];
    for (const o of options) if (!uniq.some((u) => u.id === o.id)) uniq.push(o);
    if (!uniq.some((o) => o.id === correct) || uniq.length < 2) return;
    this.out.push({
      id: `${this.c.entry.id}:${kind}`,
      kind,
      layer,
      prompt,
      options: shuffle(uniq, `${this.c.entry.id}:${kind}`),
      correct,
      explain,
    });
  }
}

const q = (id: string, params?: Msg['params']): Msg => ({ key: `challenge.q.${id}`, params });
const e = (id: string, params?: Msg['params']): Msg => ({ key: `challenge.e.${id}`, params });

/** Port-Optionen: der richtige Port plus bis zu drei andere des Geraets (nie doppelt). */
function portOptions(correct: string, ports: string[], seed: string): Opt[] {
  const others = shuffle(
    ports.filter((p) => p !== correct),
    seed,
  ).slice(0, 3);
  return [correct, ...others].map((p) => ({ id: `p:${p}`, label: V(p) }));
}

function numberOptions(correct: number, deltas: number[], min = 0): Opt[] {
  const vals = [correct, ...deltas.map((d) => correct + d).filter((v) => v >= min)];
  return [...new Set(vals)].map((v) => ({ id: `n:${v}`, label: V(v) }));
}

/** Erzeugt die Fragen zu einem Ereignis (leer, wenn das Ereignis keine Lehrfrage hergibt). */
export function buildChallenge(ctx: ChallengeContext): ChallengeQuestion[] {
  const b = new Builder(ctx);
  const { entry: en } = ctx;
  const key = en.msg.key;
  const p = (en.msg.params ?? {}) as Record<string, string | number>;
  const ip = ipOf(en.frame);
  const seed = String(en.id);
  const base = key.replace(/\.(learned|moved)$/, '');

  // ------------------------------------------------------------ Switch (Schicht 2)
  if (base.startsWith('switch.')) {
    const action =
      base === 'switch.unicast'
        ? 'forward'
        : base === 'switch.flood'
          ? 'flood'
          : base === 'switch.filter'
            ? 'filter'
            : 'drop';
    b.add(
      'sw.action',
      2,
      q('sw.action', { dst: en.frame?.dst ?? '', vlan: en.frame?.vlan?.vid ?? 1 }),
      [
        { id: 'forward', label: O('swForward') },
        { id: 'flood', label: O('swFlood') },
        { id: 'filter', label: O('swFilter') },
        { id: 'drop', label: O('swDrop') },
      ],
      action,
      e(`sw.action.${action}`, {
        dst: en.frame?.dst ?? '',
        out: String(p.out ?? ''),
        count: Number(p.count ?? 0),
        port: en.portName ?? '',
      }),
    );
    if (base === 'switch.unicast' && p.out !== undefined) {
      b.add(
        'sw.port',
        2,
        q('sw.port', { dst: String(p.dst ?? en.frame?.dst ?? '') }),
        portOptions(String(p.out), ctx.ports, seed),
        `p:${p.out}`,
        e('sw.port', { dst: String(p.dst ?? ''), out: String(p.out) }),
      );
    }
    if (key.endsWith('.learned') && en.frame) {
      b.add(
        'sw.learn',
        2,
        q('sw.learn'),
        [
          { id: 'srcIn', label: O('learnSrcIn', { src: en.frame.src, port: en.portName ?? '' }) },
          { id: 'dstIn', label: O('learnDstIn', { dst: en.frame.dst, port: en.portName ?? '' }) },
          { id: 'srcOut', label: O('learnSrcOut', { src: en.frame.src }) },
          { id: 'none', label: O('learnNone') },
        ],
        'srcIn',
        e('sw.learn', { src: en.frame.src, port: en.portName ?? '' }),
      );
    }
    if (base === 'switch.flood' && en.frame) {
      const bcast = en.frame.dst === 'ff:ff:ff:ff:ff:ff';
      const reason = bcast ? 'bcast' : en.frame.dst.startsWith('01:') ? 'mcast' : 'unknown';
      b.add(
        'sw.floodReason',
        2,
        q('sw.floodReason', { dst: en.frame.dst }),
        [
          { id: 'bcast', label: O('reasonBcast') },
          { id: 'unknown', label: O('reasonUnknown') },
          { id: 'mcast', label: O('reasonMcast') },
          { id: 'stp', label: O('reasonStp') },
        ],
        reason,
        e(`sw.floodReason.${reason}`, { dst: en.frame.dst }),
      );
      const n = Number(p.count ?? 0);
      b.add(
        'sw.floodCount',
        2,
        q('sw.floodCount', { vlan: Number(p.vlan ?? 1), port: en.portName ?? '' }),
        numberOptions(n, [1, -1, 2], 0),
        `n:${n}`,
        e('sw.floodCount', { count: n, port: en.portName ?? '' }),
      );
    }
    if (action === 'drop') {
      const reason = base.replace('switch.', '');
      b.add(
        'sw.dropReason',
        2,
        q('sw.dropReason', { port: en.portName ?? '' }),
        [
          { id: 'vlanNotAllowed', label: O('dropVlanNotAllowed') },
          { id: 'noVlan', label: O('dropNoVlan') },
          { id: 'stpBlocked', label: O('dropStp') },
          { id: 'taggedOnAccess', label: O('dropTagged') },
          { id: 'outDown', label: O('dropOutDown') },
        ],
        reason,
        e(`sw.dropReason.${reason}`, { port: en.portName ?? '', vlan: Number(p.vlan ?? 1) }),
      );
    }
    b.add(
      'gen.layer',
      2,
      q('gen.layer', { device: en.atDeviceName }),
      layerOptions([1, 2, 3, 4]),
      'L2',
      e('gen.layer.switch'),
    );
  }

  // ------------------------------------------------------------ Hub (Schicht 1)
  if (key === 'hub.repeat') {
    b.add(
      'hub.action',
      1,
      q('hub.action'),
      [
        { id: 'repeat', label: O('hubRepeat') },
        { id: 'mac', label: O('hubMac') },
        { id: 'drop', label: O('hubDrop') },
      ],
      'repeat',
      e('hub.action', { count: Number(p.count ?? 0), port: String(p.port ?? '') }),
    );
    b.add(
      'gen.layer',
      1,
      q('gen.layer', { device: en.atDeviceName }),
      layerOptions([1, 2, 3, 4]),
      'L1',
      e('gen.layer.hub'),
    );
  }

  // ------------------------------------------------------------ Host
  if (key === 'host.l2.notForMe') {
    b.add(
      'host.nic',
      2,
      q('host.nic', { dst: String(p.dst ?? ''), mac: String(p.mac ?? '') }),
      [
        { id: 'discard', label: O('nicDiscard') },
        { id: 'accept', label: O('nicAccept') },
        { id: 'reply', label: O('nicReply') },
      ],
      'discard',
      e('host.nic', { dst: String(p.dst ?? ''), mac: String(p.mac ?? '') }),
    );
  }
  if (key === 'host.arp.request') {
    b.add(
      'host.arpBcast',
      2,
      q('host.arpBcast'),
      [
        { id: 'bcast', label: O('arpBcast') },
        { id: 'ucast', label: O('arpUcast') },
        { id: 'mcast', label: O('arpMcast') },
      ],
      en.frame?.dst === 'ff:ff:ff:ff:ff:ff' ? 'bcast' : 'ucast',
      e('host.arpBcast'),
    );
    b.add(
      'host.arpReq',
      2,
      q('host.arpReq', { ip: String(p.ip ?? ''), sender: String(p.sender ?? '') }),
      [
        { id: 'reply', label: O('arpReply', { sender: String(p.sender ?? '') }) },
        { id: 'ignore', label: O('arpIgnore') },
        { id: 'flood', label: O('arpFlood') },
        { id: 'route', label: O('arpRoute') },
      ],
      'reply',
      e('host.arpReq', { ip: String(p.ip ?? ''), sender: String(p.sender ?? '') }),
    );
  }
  if (key === 'host.arp.notMine') {
    b.add(
      'host.arpReq',
      2,
      q('host.arpNotMine', { ip: String(p.ip ?? '') }),
      [
        { id: 'ignore', label: O('arpIgnore') },
        { id: 'reply', label: O('arpReplyAny') },
        { id: 'flood', label: O('arpFlood') },
      ],
      'ignore',
      e('host.arpNotMine', { ip: String(p.ip ?? '') }),
    );
  }
  if (key === 'host.arp.reply') {
    b.add(
      'host.arpReply',
      2,
      q('host.arpReply', { ip: String(p.ip ?? ''), mac: String(p.mac ?? '') }),
      [
        { id: 'cache', label: O('arpCache', { ip: String(p.ip ?? ''), mac: String(p.mac ?? '') }) },
        { id: 'forward', label: O('arpForward') },
        { id: 'drop', label: O('arpDropReply') },
      ],
      'cache',
      e('host.arpReply', { ip: String(p.ip ?? ''), mac: String(p.mac ?? '') }),
    );
  }
  if (key === 'host.icmp.echoRequest') {
    b.add(
      'host.echoReq',
      3,
      q('host.echoReq', { src: String(p.src ?? '') }),
      [
        { id: 'reply', label: O('echoReply', { src: String(p.src ?? '') }) },
        { id: 'silent', label: O('echoSilent') },
        { id: 'unreach', label: O('echoUnreach') },
        { id: 'forward', label: O('echoForward') },
      ],
      'reply',
      e('host.echoReq', { src: String(p.src ?? '') }),
    );
  }
  if (key === 'host.icmp.echoReply') {
    b.add(
      'host.echoMatch',
      3,
      q('host.echoMatch'),
      [
        { id: 'idseq', label: O('matchIdSeq') },
        { id: 'port', label: O('matchPort') },
        { id: 'mac', label: O('matchMac') },
      ],
      'idseq',
      e('host.echoMatch'),
    );
  }
  if (key === 'host.ip.notMine') {
    b.add(
      'host.notMine',
      3,
      q('host.notMine', { dst: String(p.dst ?? '') }),
      [
        { id: 'discard', label: O('hostDiscard') },
        { id: 'forward', label: O('hostForward') },
        { id: 'unreach', label: O('hostUnreach') },
      ],
      'discard',
      e('host.notMine', { dst: String(p.dst ?? '') }),
    );
  }
  if (key === 'ip.noService' && ip) {
    const tcp = ip.payload.kind === 'tcp';
    b.add(
      'host.closedPort',
      4,
      q('host.closedPort', { port: Number(p.port ?? 0), proto: tcp ? 'TCP' : 'UDP' }),
      [
        { id: 'unreach', label: O('closedUnreach') },
        { id: 'rst', label: O('closedRst') },
        { id: 'silent', label: O('closedSilent') },
        { id: 'accept', label: O('closedAccept') },
      ],
      tcp ? 'rst' : 'unreach',
      e(tcp ? 'host.closedPort.tcp' : 'host.closedPort.udp', { port: Number(p.port ?? 0) }),
    );
  }
  if (ctx.deviceKind === 'host' && en.status === 'ok' && en.frame) {
    const top = topLayer(en.frame);
    b.add(
      'gen.layer',
      top,
      q('gen.layer', { device: en.atDeviceName }),
      layerOptions([2, 3, 4, 7]),
      `L${top}`,
      e('gen.layer.host', { layer: top }),
    );
  }

  // ------------------------------------------------------------ Router (Schicht 3)
  if (key === 'router.forward' && ip) {
    const dstMac = en.frame?.dst ?? '';
    b.add(
      'rt.gateway',
      2,
      q('rt.gateway', { mac: dstMac, dst: ip.dst }),
      [
        { id: 'gw', label: O('gwNormal') },
        { id: 'err', label: O('gwError') },
        { id: 'spoof', label: O('gwSpoof') },
        { id: 'bcast', label: O('gwBcast') },
      ],
      'gw',
      e('rt.gateway', { mac: dstMac, dst: ip.dst }),
    );
    b.add(
      'rt.action',
      3,
      q('rt.action', { src: ip.src, dst: ip.dst, ttl: ip.ttl }),
      [
        { id: 'forward', label: O('rtForward') },
        { id: 'ttl', label: O('rtDropTtl') },
        { id: 'noroute', label: O('rtDropNoRoute') },
        { id: 'acl', label: O('rtDropAcl') },
      ],
      'forward',
      e('rt.action.forward', { dst: ip.dst, port: String(p.port ?? ''), via: String(p.via ?? '') }),
    );
    const outTtl = Number(p.ttl ?? ip.ttl - 1);
    b.add(
      'rt.ttl',
      3,
      q('rt.ttl', { ttl: ip.ttl }),
      numberOptions(outTtl, [-1, 1, 2], 0).concat([{ id: `n:${ip.ttl}`, label: V(ip.ttl) }]),
      `n:${outTtl}`,
      e('rt.ttl', { inTtl: ip.ttl, outTtl }),
    );
    b.add(
      'rt.egress',
      3,
      q('rt.egress', { dst: ip.dst }),
      portOptions(String(p.port ?? ''), ctx.ports, seed),
      `p:${p.port}`,
      e('rt.egress', { dst: ip.dst, port: String(p.port ?? '') }),
    );
    const via = String(p.via ?? ip.dst);
    const direct = via === ip.dst;
    b.add(
      'rt.nexthop',
      3,
      q('rt.nexthop', { dst: ip.dst }),
      [
        { id: `a:${via}`, label: V(via) },
        { id: `a:${ip.dst}`, label: V(ip.dst) },
        { id: `a:${ip.src}`, label: V(ip.src) },
      ],
      `a:${via}`,
      e(direct ? 'rt.nexthop.direct' : 'rt.nexthop.hop', { via, dst: ip.dst }),
    );
    b.add(
      'rt.rewrite',
      2,
      q('rt.rewrite'),
      [
        { id: 'mac', label: O('rewriteMac') },
        { id: 'both', label: O('rewriteBoth') },
        { id: 'ip', label: O('rewriteIp') },
        { id: 'none', label: O('rewriteNone') },
      ],
      'mac',
      e('rt.rewrite'),
    );
    // Folgeverhalten: wird fuer den naechsten Hop ARP benoetigt?
    const next = ctx.later.find((l) => l.lastDeviceId === en.atDeviceId);
    if (next?.frame) {
      const nf = next.frame.payload;
      const arp = nf.kind === 'arp' && nf.op === 'request' && nf.targetIp === via;
      const same = nf.kind === 'ipv4' && nf.src === ip.src && nf.dst === ip.dst;
      if (arp || same) {
        b.add(
          'rt.arp',
          2,
          q('rt.arp', { via }),
          [
            { id: 'yes', label: O('arpNeeded', { via }) },
            { id: 'no', label: O('arpNotNeeded') },
          ],
          arp ? 'yes' : 'no',
          e(arp ? 'rt.arp.yes' : 'rt.arp.no', { via }),
        );
      }
    }
    b.add(
      'gen.layer',
      3,
      q('gen.layer', { device: en.atDeviceName }),
      layerOptions([2, 3, 4, 7]),
      'L3',
      e('gen.layer.router'),
    );
  }
  if (key === 'router.ttlExpired') {
    b.add(
      'rt.ttlExpired',
      3,
      q('rt.ttlExpired', { dst: String(p.dst ?? ''), src: String(p.src ?? '') }),
      [
        { id: 'icmpTime', label: O('ttlIcmp', { src: String(p.src ?? '') }) },
        { id: 'silent', label: O('ttlSilent') },
        { id: 'forward', label: O('ttlForward') },
        { id: 'unreach', label: O('ttlUnreach') },
      ],
      'icmpTime',
      e('rt.ttlExpired', { src: String(p.src ?? '') }),
    );
  }
  if (key === 'router.noRoute') {
    b.add(
      'rt.noRoute',
      3,
      q('rt.noRoute', { dst: String(p.dst ?? '') }),
      [
        { id: 'unreach', label: O('noRouteUnreach') },
        { id: 'flood', label: O('noRouteFlood') },
        { id: 'queue', label: O('noRouteQueue') },
        { id: 'arp', label: O('noRouteArp') },
      ],
      'unreach',
      e('rt.noRoute', { dst: String(p.dst ?? '') }),
    );
  }
  if (key === 'router.needFrag') {
    b.add(
      'rt.frag',
      3,
      q('rt.frag', { size: Number(p.size ?? 0), mtu: Number(p.mtu ?? 0) }),
      [
        { id: 'icmpFrag', label: O('fragIcmp', { mtu: Number(p.mtu ?? 0) }) },
        { id: 'fragment', label: O('fragFragment') },
        { id: 'truncate', label: O('fragTruncate') },
      ],
      'icmpFrag',
      e('rt.frag', { size: Number(p.size ?? 0), mtu: Number(p.mtu ?? 0) }),
    );
  }
  if (key === 'acl.deny') {
    b.add(
      'acl.decision',
      3,
      q('acl.decision', {
        acl: String(p.acl ?? ''),
        dir: String(p.dir ?? 'in'),
        src: String(p.src ?? ''),
        dst: String(p.dst ?? ''),
      }),
      [
        { id: 'deny', label: O('aclDeny') },
        { id: 'permit', label: O('aclPermit') },
        { id: 'log', label: O('aclLog') },
      ],
      'deny',
      e('acl.decision', { acl: String(p.acl ?? ''), dir: String(p.dir ?? 'in') }),
    );
    b.add(
      'acl.dir',
      3,
      q('acl.dir', { acl: String(p.acl ?? '') }),
      [
        { id: 'in', label: O('aclDirIn') },
        { id: 'out', label: O('aclDirOut') },
      ],
      String(p.dir ?? 'in') === 'out' ? 'out' : 'in',
      e('acl.dir', { dir: String(p.dir ?? 'in') }),
    );
    b.add(
      'acl.reply',
      3,
      q('acl.reply'),
      [
        { id: 'admin', label: O('aclReplyAdmin') },
        { id: 'silent', label: O('aclReplySilent') },
        { id: 'rst', label: O('aclReplyRst') },
        { id: 'ttl', label: O('aclReplyTtl') },
      ],
      'admin',
      e('acl.reply'),
    );
  }
  if (key === 'nat.out') {
    b.add(
      'nat.out',
      3,
      q('nat.out', { local: String(p.local ?? ''), dst: String(p.dst ?? '') }),
      [
        { id: `a:${p.global}`, label: V(String(p.global ?? '')) },
        { id: `a:${p.local}`, label: V(String(p.local ?? '')) },
        { id: `a:${p.dst}`, label: V(String(p.dst ?? '')) },
      ],
      `a:${p.global}`,
      e('nat.out', { local: String(p.local ?? ''), global: String(p.global ?? '') }),
    );
  }
  if (key === 'nat.in') {
    b.add(
      'nat.in',
      3,
      q('nat.in', { global: String(p.global ?? '') }),
      [
        { id: `a:${p.local}`, label: V(String(p.local ?? '')) },
        { id: `a:${p.global}`, label: V(String(p.global ?? '')) },
        { id: `a:${p.src}`, label: V(String(p.src ?? '')) },
      ],
      `a:${p.local}`,
      e('nat.in', { local: String(p.local ?? ''), global: String(p.global ?? '') }),
    );
  }
  return b.out;
}

function layerOptions(layers: number[]): Opt[] {
  return layers.map((n) => ({ id: `L${n}`, label: O('layer', { n }) }));
}

/** Richtige Antwort? (Reiner Vergleich mit der aus der Engine abgeleiteten Entscheidung.) */
export function isCorrect(question: ChallengeQuestion, optionId: string): boolean {
  return question.correct === optionId;
}

export interface ChallengeScore {
  answered: number;
  correct: number;
}

export function scoreOf(
  questions: ChallengeQuestion[],
  answers: Record<string, string>,
): ChallengeScore {
  let answered = 0;
  let correct = 0;
  for (const qn of questions) {
    const a = answers[qn.id];
    if (a === undefined) continue;
    answered++;
    if (isCorrect(qn, a)) correct++;
  }
  return { answered, correct };
}
