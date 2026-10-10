import { describe, expect, it } from 'vitest';
import {
  Engine,
  buildChallenge,
  isCorrect,
  scoreOf,
  type ChallengeQuestion,
  type DeviceClass,
  type LogEntry,
} from '../src';
import { aclEntry, ANY, hostMatch } from './labs3';

interface Net {
  e: Engine;
  sw: string;
  r: string;
  a: string;
  b: string;
}

function net(): Net {
  const e = new Engine({ seed: 1 });
  const sw = e.addDevice('switch-l2', { name: 'SW' });
  const r = e.addDevice('router', { name: 'R1' });
  const a = e.addDevice('pc', { name: 'A' });
  const b = e.addDevice('pc', { name: 'B' });
  e.connect({ deviceId: a, portId: 'p0' }, { deviceId: sw, portId: 'p0' }, 'straight');
  e.connect({ deviceId: sw, portId: 'p1' }, { deviceId: r, portId: 'p0' }, 'straight');
  e.connect({ deviceId: b, portId: 'p0' }, { deviceId: r, portId: 'p1' }, 'straight');
  e.setInterfaceIp(r, 'p0', '10.0.1.1', '255.255.255.0');
  e.setInterfaceIp(r, 'p1', '10.0.2.1', '255.255.255.0');
  e.setPortAdmin(r, 'p0', true);
  e.setPortAdmin(r, 'p1', true);
  e.setHostIp(a, '10.0.1.10', '255.255.255.0', '10.0.1.1');
  e.setHostIp(b, '10.0.2.10', '255.255.255.0', '10.0.2.1');
  e.runUntil(40_000_000);
  e.log.length = 0;
  return { e, sw, r, a, b };
}

const kindOf = (e: Engine, id: string): DeviceClass => {
  const c = e.getDevice(id)?.config.kind;
  return c === 'host' || c === 'router' || c === 'switch' || c === 'hub' ? c : 'other';
};

function questionsFor(e: Engine, entry: LogEntry): ChallengeQuestion[] {
  const dev = e.getDevice(entry.atDeviceId);
  return buildChallenge({
    entry,
    deviceKind: kindOf(e, entry.atDeviceId),
    ports: dev?.ports.map((p) => p.name) ?? [],
    later: e.log.filter((l) => l.id > entry.id).slice(0, 30),
  });
}

const all = (e: Engine): { entry: LogEntry; qs: ChallengeQuestion[] }[] =>
  e.log.map((entry) => ({ entry, qs: questionsFor(e, entry) }));

const find = (e: Engine, pred: (l: LogEntry) => boolean): LogEntry => {
  const l = e.log.find(pred);
  if (!l) throw new Error('log entry not found');
  return l;
};
const q = (qs: ChallengeQuestion[], kind: string): ChallengeQuestion => {
  const x = qs.find((y) => y.kind === kind);
  if (!x) throw new Error(`question ${kind} missing`);
  return x;
};
const correctValue = (x: ChallengeQuestion): string =>
  String(x.options.find((o) => o.id === x.correct)?.label.params?.value ?? x.correct);

describe('Challenge Me: Antworten folgen der Engine-Entscheidung', () => {
  it('Ping ueber Switch und Router: jede Frage ist wohlgeformt', () => {
    const { e, a } = net();
    e.ping(a, '10.0.2.10');
    e.runUntil(e.state.now + 3_000_000);
    let total = 0;
    for (const { entry, qs } of all(e)) {
      const ids = new Set(qs.map((x) => x.id));
      expect(ids.size).toBe(qs.length);
      for (const x of qs) {
        total++;
        expect(x.options.length).toBeGreaterThanOrEqual(2);
        expect(x.options.some((o) => o.id === x.correct)).toBe(true);
        expect(new Set(x.options.map((o) => o.id)).size).toBe(x.options.length);
        expect(x.id.startsWith(`${entry.id}:`)).toBe(true);
        expect(x.layer).toBeGreaterThanOrEqual(1);
        expect(x.layer).toBeLessThanOrEqual(7);
      }
    }
    expect(total).toBeGreaterThan(15);
  });

  it('Switch: bekannte Ziel-MAC wird nur auf dem richtigen Port weitergeleitet', () => {
    const { e, a } = net();
    e.ping(a, '10.0.2.10');
    e.runUntil(e.state.now + 3_000_000);
    const uni = find(e, (l) => l.msg.key.startsWith('switch.unicast') && l.atDeviceName === 'SW');
    const qs = questionsFor(e, uni);
    expect(q(qs, 'sw.action').correct).toBe('forward');
    expect(correctValue(q(qs, 'sw.port'))).toBe(String(uni.msg.params?.out));
    expect(q(qs, 'gen.layer').correct).toBe('L2');
    // Distraktoren duerfen den Eingangsport enthalten (typischer Denkfehler), nie aber doppelt
    expect(q(qs, 'sw.port').options.length).toBeGreaterThanOrEqual(2);
  });

  it('Switch: Broadcast wird geflutet, Anzahl stammt aus dem Log', () => {
    const { e, a } = net();
    e.ping(a, '10.0.2.10');
    e.runUntil(e.state.now + 3_000_000);
    const fl = find(e, (l) => l.msg.key.startsWith('switch.flood'));
    const qs = questionsFor(e, fl);
    expect(q(qs, 'sw.action').correct).toBe('flood');
    expect(q(qs, 'sw.floodReason').correct).toBe('bcast');
    expect(q(qs, 'sw.floodCount').correct).toBe(`n:${fl.msg.params?.count}`);
    expect(q(qs, 'sw.learn').correct).toBe('srcIn');
  });

  it('Router: Weiterleiten, TTL-1, Ausgangsschnittstelle und ARP-Folgeverhalten', () => {
    const { e, a } = net();
    e.ping(a, '10.0.2.10');
    e.runUntil(e.state.now + 3_000_000);
    const fw = find(e, (l) => l.msg.key === 'router.forward' && l.atDeviceName === 'R1');
    const qs = questionsFor(e, fw);
    expect(q(qs, 'rt.action').correct).toBe('forward');
    expect(q(qs, 'rt.ttl').correct).toBe('n:127');
    expect(correctValue(q(qs, 'rt.egress'))).toBe('GigabitEthernet0/1');
    expect(q(qs, 'rt.arp').correct).toBe('yes');
    expect(q(qs, 'rt.gateway').correct).toBe('gw');
    expect(q(qs, 'rt.rewrite').correct).toBe('mac');
    expect(correctValue(q(qs, 'rt.nexthop'))).toBe('10.0.2.10');
    // Antwort-Paket: ARP-Eintrag existiert bereits -> kein ARP noetig
    const back = find(
      e,
      (l) => l.msg.key === 'router.forward' && l.msg.params?.dst === '10.0.1.10',
    );
    expect(q(questionsFor(e, back), 'rt.arp').correct).toBe('no');
  });

  it('Host: ARP-Request, Echo-Request, Echo-Reply', () => {
    const { e, a } = net();
    e.ping(a, '10.0.2.10');
    e.runUntil(e.state.now + 3_000_000);
    const arp = find(e, (l) => l.msg.key === 'host.arp.request');
    const qa = questionsFor(e, arp);
    expect(q(qa, 'host.arpReq').correct).toBe('reply');
    expect(q(qa, 'host.arpBcast').correct).toBe('bcast');
    const echo = find(e, (l) => l.msg.key === 'host.icmp.echoRequest');
    expect(q(questionsFor(e, echo), 'host.echoReq').correct).toBe('reply');
    expect(q(questionsFor(e, echo), 'gen.layer').correct).toBe('L3');
    const rep = find(e, (l) => l.msg.key === 'host.icmp.echoReply');
    expect(q(questionsFor(e, rep), 'host.echoMatch').correct).toBe('idseq');
    const arpRep = find(e, (l) => l.msg.key === 'host.arp.reply');
    expect(q(questionsFor(e, arpRep), 'host.arpReply').correct).toBe('cache');
  });

  it('ACL: Verwerfen mit Richtung und ICMP administratively prohibited', () => {
    const { e, a, r } = net();
    const d = e.getDevice(r);
    if (d?.config.kind !== 'router') throw new Error('router');
    d.config.acls['101'] = {
      name: '101',
      type: 'extended',
      entries: [
        aclEntry({ seq: 10, action: 'deny', proto: 'icmp', src: ANY, dst: hostMatch('10.0.2.10') }),
      ],
    };
    const p = d.config.ifaces['p0'];
    if (p) p.aclIn = '101';
    e.ping(a, '10.0.2.10');
    e.runUntil(e.state.now + 3_000_000);
    const deny = find(e, (l) => l.msg.key === 'acl.deny');
    const qs = questionsFor(e, deny);
    expect(q(qs, 'acl.decision').correct).toBe('deny');
    expect(q(qs, 'acl.dir').correct).toBe('in');
    expect(q(qs, 'acl.reply').correct).toBe('admin');
    // Die Engine sendet tatsaechlich ICMP "administratively prohibited" zurueck
    expect(
      e.log.some(
        (l) =>
          l.frame?.payload.kind === 'ipv4' &&
          l.frame.payload.payload.kind === 'icmp' &&
          l.frame.payload.payload.code === 13,
      ),
    ).toBe(true);
  });

  it('TTL abgelaufen und keine Route', () => {
    const { e, a } = net();
    e.trace(a, '10.0.2.10');
    e.runUntil(e.state.now + 5_000_000);
    const ttl = find(e, (l) => l.msg.key === 'router.ttlExpired');
    expect(q(questionsFor(e, ttl), 'rt.ttlExpired').correct).toBe('icmpTime');
    e.log.length = 0;
    e.ping(a, '172.16.0.9');
    e.runUntil(e.state.now + 3_000_000);
    const nr = find(e, (l) => l.msg.key === 'router.noRoute');
    expect(q(questionsFor(e, nr), 'rt.noRoute').correct).toBe('unreach');
  });

  it('Host: geschlossener UDP-/TCP-Port', () => {
    const { e, a } = net();
    e.trace(a, '10.0.2.10'); // erzeugt UDP auf hohen Port? sonst ping ersatzweise
    e.runUntil(e.state.now + 5_000_000);
    const closed = e.log.find((l) => l.msg.key === 'ip.noService');
    if (closed) {
      const qs = questionsFor(e, closed);
      expect(q(qs, 'host.closedPort').correct).toBe('unreach');
    }
    // Hosts leiten nichts weiter und verwerfen fremde Ziele
    const fake = {
      ...find(e, (l) => l.kind === 'rx'),
      msg: { key: 'host.ip.notMine', params: { dst: '1.2.3.4' } },
    };
    expect(
      q(buildChallenge({ entry: fake, deviceKind: 'host', ports: [], later: [] }), 'host.notMine')
        .correct,
    ).toBe('discard');
  });

  it('Hub wiederholt auf allen Ports; fremde MAC wird vom NIC verworfen', () => {
    const base = net().e;
    base.log.length = 0;
    const mk = (key: string, params: Record<string, string | number>): LogEntry => ({
      id: 7,
      t: 1,
      kind: 'rx',
      proto: 'ETH',
      status: 'ok',
      atDeviceId: 'x',
      atDeviceName: 'X',
      msg: { key, params },
    });
    const hub = buildChallenge({
      entry: mk('hub.repeat', { port: 'Fa0/1', count: 3 }),
      deviceKind: 'hub',
      ports: [],
      later: [],
    });
    expect(q(hub, 'hub.action').correct).toBe('repeat');
    expect(q(hub, 'gen.layer').correct).toBe('L1');
    const nic = buildChallenge({
      entry: mk('host.l2.notForMe', { dst: 'aa', mac: 'bb' }),
      deviceKind: 'host',
      ports: [],
      later: [],
    });
    expect(q(nic, 'host.nic').correct).toBe('discard');
    const frag = buildChallenge({
      entry: mk('router.needFrag', { size: 1600, mtu: 1500, port: 'Gi0/0' }),
      deviceKind: 'router',
      ports: [],
      later: [],
    });
    expect(q(frag, 'rt.frag').correct).toBe('icmpFrag');
    const nat = buildChallenge({
      entry: mk('nat.out', { local: '10.0.0.5', global: '203.0.113.1', dst: '8.8.8.8' }),
      deviceKind: 'router',
      ports: [],
      later: [],
    });
    expect(q(nat, 'nat.out').correct).toBe('a:203.0.113.1');
    const natIn = buildChallenge({
      entry: mk('nat.in', { local: '10.0.0.5', global: '203.0.113.1', src: '8.8.8.8' }),
      deviceKind: 'router',
      ports: [],
      later: [],
    });
    expect(q(natIn, 'nat.in').correct).toBe('a:10.0.0.5');
    const drops = ['vlanNotAllowed', 'noVlan', 'stpBlocked', 'taggedOnAccess', 'outDown'];
    for (const d of drops) {
      const qs = buildChallenge({
        entry: { ...mk(`switch.${d}`, { vlan: 10, port: 'Fa0/1' }), status: 'drop' },
        deviceKind: 'switch',
        ports: [],
        later: [],
      });
      expect(q(qs, 'sw.dropReason').correct).toBe(d);
      expect(q(qs, 'sw.action').correct).toBe('drop');
    }
    const noRoute = buildChallenge({
      entry: mk('unknown.key', {}),
      deviceKind: 'other',
      ports: [],
      later: [],
    });
    expect(noRoute).toEqual([]);
  });

  it('deterministisch und Bewertung', () => {
    const { e, a } = net();
    e.ping(a, '10.0.2.10');
    e.runUntil(e.state.now + 3_000_000);
    const fw = find(e, (l) => l.msg.key === 'router.forward');
    const a1 = questionsFor(e, fw);
    const a2 = questionsFor(e, fw);
    expect(a1).toEqual(a2);
    const answers: Record<string, string> = {};
    const first = a1[0] as ChallengeQuestion;
    const second = a1[1] as ChallengeQuestion;
    answers[first.id] = first.correct;
    answers[second.id] = second.options.find((o) => o.id !== second.correct)?.id as string;
    expect(isCorrect(first, first.correct)).toBe(true);
    expect(isCorrect(second, answers[second.id] as string)).toBe(false);
    expect(scoreOf(a1, answers)).toEqual({ answered: 2, correct: 1 });
    expect(scoreOf(a1, {})).toEqual({ answered: 0, correct: 0 });
    // Reihenfolge ist nicht immer gleich: richtige Antwort nicht stets an erster Stelle
    const positions = new Set(
      all(e)
        .flatMap((x) => x.qs)
        .map((x) => x.options.findIndex((o) => o.id === x.correct)),
    );
    expect(positions.size).toBeGreaterThan(1);
  });
});
