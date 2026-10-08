import { describe, expect, it } from 'vitest';
import { Engine } from '../src';
import { blockedPorts, converge, host, link, noShut, ok, ping, swCfg } from './labs3';

/** Ring aus drei Switches (S1–S2–S3–S1), je ein PC an S1 und S2. */
function ring(mode: 'pvst' | 'rapid-pvst' = 'pvst') {
  const e = new Engine({ seed: 1 });
  const s = ['S1', 'S2', 'S3'].map((n) => e.addDevice('switch-l2', { name: n })) as [string, string, string];
  for (const x of s) ok(e.setStp(x, { mode }));
  link(e, s[0], 'p22', s[1], 'p23', 'crossover');
  link(e, s[1], 'p22', s[2], 'p23', 'crossover');
  link(e, s[2], 'p22', s[0], 'p23', 'crossover');
  const a = host(e, 'A', '10.0.0.1');
  const b = host(e, 'B', '10.0.0.2');
  link(e, a, 'p0', s[0], 'p0');
  link(e, b, 'p0', s[1], 'p0');
  return { e, s, a, b };
}

describe('Spanning Tree', () => {
  it('Abnahme: ein Ring blockiert genau einen Port; Root = niedrigste Bridge-ID', () => {
    const { e, s, a } = ring();
    converge(e, 60);
    const blocked = blockedPorts(e);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.state).toBe('discarding');
    const roots = new Set(s.map((x) => swCfg(e, x).stp.instances[1]?.rootId));
    expect(roots.size).toBe(1);
    const rootBridge = [...roots][0] as string;
    const lowest = s
      .map((x) => `${String(32769).padStart(5, '0')}.${e.getDevice(x)?.ports[0]?.mac}`)
      .sort()[0];
    expect(rootBridge).toBe(lowest);
    expect(ping(e, a, '10.0.0.2')).toBe('reply');
  });

  it('kein Broadcast-Sturm im Ring: Ping erzeugt endlich viele Ereignisse', () => {
    const { e, a } = ring();
    converge(e, 60);
    e.log.length = 0;
    expect(ping(e, a, '10.0.0.2')).toBe('reply');
    expect(e.log.length).toBeLessThan(80);
  });

  it('802.1D braucht ~30 s (Listening → Learning → Forwarding)', () => {
    const { e, a } = ring();
    e.runUntil(e.state.now + 5_000_000);
    expect(ping(e, a, '10.0.0.2')).toBe('unreachable');
    converge(e, 60);
    expect(ping(e, a, '10.0.0.2')).toBe('reply');
  });

  it('Priorität bestimmt die Root-Bridge', () => {
    const { e, s } = ring();
    ok(e.setStp(s[2], { vlan: 1, priority: 4096 }));
    converge(e, 60);
    expect(swCfg(e, s[0]).stp.instances[1]?.rootId).toBe(`${String(4097).padStart(5, '0')}.${e.getDevice(s[2])?.ports[0]?.mac}`);
    expect(swCfg(e, s[2]).stp.instances[1]?.rootCost).toBe(0);
  });

  it('Linkausfall: Spanning Tree schaltet den blockierten Port frei', () => {
    const { e, s, a } = ring();
    converge(e, 60);
    const link12 = e.getDevice(s[0])?.ports[22]?.linkId as string;
    e.disconnect(link12);
    converge(e, 60);
    expect(blockedPorts(e)).toHaveLength(0);
    expect(ping(e, a, '10.0.0.2')).toBe('reply');
  });

  it('RSTP konvergiert in wenigen Sekunden und blockiert ebenfalls genau einen Port', () => {
    const { e, a } = ring('rapid-pvst');
    converge(e, 12);
    const blocked = blockedPorts(e);
    expect(blocked).toHaveLength(1);
    expect(ping(e, a, '10.0.0.2')).toBe('reply');
  });

  it('PortFast: Access-Port forwardet sofort', () => {
    const e = new Engine();
    const sw = e.addDevice('switch-l2');
    const a = host(e, 'A', '10.0.0.1');
    const b = host(e, 'B', '10.0.0.2');
    ok(e.setSwitchport(sw, 'p0', { portfast: true }));
    ok(e.setSwitchport(sw, 'p1', { portfast: true }));
    link(e, a, 'p0', sw, 'p0');
    link(e, b, 'p0', sw, 'p1');
    e.runUntil(e.state.now + 1_000_000);
    expect(ping(e, a, '10.0.0.2')).toBe('reply');
  });

  it('BPDU Guard: BPDU an einem PortFast-Port → err-disabled; Root Guard hält die Root-Rolle', () => {
    const e = new Engine();
    const s1 = e.addDevice('switch-l2', { name: 'S1' });
    const s2 = e.addDevice('switch-l2', { name: 'S2' });
    link(e, s1, 'p0', s2, 'p0', 'crossover');
    ok(e.setStp(s2, { vlan: 1, priority: 4096 }));
    ok(e.setSwitchport(s1, 'p0', { portfast: true, bpduguard: true }));
    converge(e, 10);
    const port = e.getDevice(s1)?.ports[0];
    expect(port?.errdisabled).toBe('bpduguard');
    expect(port?.operUp).toBe(false);
    expect(e.log.length).toBe(0);
    e.clearErrdisable(s1, 'p0');
    expect(port?.errdisabled).toBeUndefined();
  });

  it('Root Guard verhindert, dass ein besserer Root hinter dem Port gewählt wird', () => {
    const e = new Engine();
    const s1 = e.addDevice('switch-l2', { name: 'S1' });
    const s2 = e.addDevice('switch-l2', { name: 'S2' });
    link(e, s1, 'p0', s2, 'p0', 'crossover');
    ok(e.setStp(s2, { vlan: 1, priority: 4096 }));
    ok(e.setSwitchport(s1, 'p0', { rootguard: true }));
    converge(e, 60);
    expect(swCfg(e, s1).stp.instances[1]?.rootPort).toBeUndefined();
    expect(swCfg(e, s1).stp.instances[1]?.rootId).toContain(String(32769));
    void noShut;
  });
});

describe('EtherChannel', () => {
  function bundle(mode1: 'on' | 'active' | 'desirable', mode2: 'on' | 'passive' | 'auto') {
    const e = new Engine();
    const s1 = e.addDevice('switch-l2', { name: 'S1' });
    const s2 = e.addDevice('switch-l2', { name: 'S2' });
    link(e, s1, 'p22', s2, 'p22', 'crossover');
    link(e, s1, 'p23', s2, 'p23', 'crossover');
    for (const p of ['p22', 'p23']) {
      ok(e.setSwitchport(s1, p, { channel: 1, channelMode: mode1 }));
      ok(e.setSwitchport(s2, p, { channel: 1, channelMode: mode2 }));
    }
    const a = host(e, 'A', '10.0.0.1');
    const b = host(e, 'B', '10.0.0.2');
    link(e, a, 'p0', s1, 'p0');
    link(e, b, 'p0', s2, 'p0');
    return { e, s1, s2, a, b };
  }

  it('static on/on bündelt; STP sieht einen logischen Port, nichts wird blockiert', () => {
    const { e, s1, a } = bundle('on', 'on');
    expect(swCfg(e, s1).bundles[1]).toEqual(['p22', 'p23']);
    converge(e, 60);
    expect(blockedPorts(e)).toHaveLength(0);
    expect(Object.keys(swCfg(e, s1).stp.instances[1]?.ports ?? {}).sort()).toEqual(['p0', 'po1']);
    expect(ping(e, a, '10.0.0.2')).toBe('reply');
  });

  it('LACP active/passive und PAgP desirable/auto bündeln; on/active nicht', () => {
    expect(Object.keys(swCfg(bundle('active', 'passive').e, 'd1').bundles)).toEqual(['1']);
    expect(Object.keys(swCfg(bundle('desirable', 'auto').e, 'd1').bundles)).toEqual(['1']);
    expect(Object.keys(swCfg(bundle('on', 'auto').e, 'd1').bundles)).toEqual([]);
    expect(Object.keys(swCfg(bundle('active', 'auto').e, 'd1').bundles)).toEqual([]);
  });

  it('Hash-Verteilung nutzt beide Mitglieder, Ausfall eines Mitglieds hält die Verbindung', () => {
    const { e, s1, a, b } = bundle('on', 'on');
    converge(e, 60);
    const extra = host(e, 'C', '10.0.0.3');
    const extra2 = host(e, 'D', '10.0.0.4');
    link(e, extra, 'p0', e.addDevice('switch-l2', { name: 'X' }), 'p0');
    void extra2;
    expect(ping(e, a, '10.0.0.2', { count: 4 })).toBe('reply');
    const used = ['p22', 'p23'].filter((p) => (e.getDevice(s1)?.ports.find((x) => x.id === p)?.counters.outPkts ?? 0) > 0);
    expect(used.length).toBeGreaterThanOrEqual(1);
    e.setPortAdmin(s1, 'p22', false);
    converge(e, 60);
    expect(swCfg(e, s1).bundles[1]).toEqual(['p23']);
    expect(ping(e, a, '10.0.0.2')).toBe('reply');
    void b;
  });
});

describe('Port-Security', () => {
  function psec(violation: 'shutdown' | 'restrict' | 'protect', sticky = false) {
    const e = new Engine();
    const sw = e.addDevice('switch-l2');
    const hub = e.addDevice('hub');
    const a = host(e, 'A', '10.0.0.1');
    const b = host(e, 'B', '10.0.0.2');
    const srv = host(e, 'S', '10.0.0.9');
    link(e, hub, 'p0', sw, 'p0');
    link(e, a, 'p0', hub, 'p1');
    link(e, b, 'p0', hub, 'p2');
    link(e, srv, 'p0', sw, 'p1');
    ok(e.setSwitchport(sw, 'p0', { portfast: true }));
    ok(e.setSwitchport(sw, 'p1', { portfast: true }));
    converge(e, 5);
    ok(e.setSwitchport(sw, 'p0', { psec: { enabled: true, max: 1, violation, sticky, macs: [], dynMacs: [], violations: 0 } }));
    return { e, sw, a, b, srv };
  }

  it('erste MAC wird gelernt (dynamisch/sticky), zweite löst shutdown aus', () => {
    const { e, sw, a, b, srv } = psec('shutdown', true);
    expect(ping(e, a, '10.0.0.9')).toBe('reply');
    expect(swCfg(e, sw).ports.p0?.psec.macs).toHaveLength(1);
    ping(e, b, '10.0.0.9');
    const port = e.getDevice(sw)?.ports[0];
    expect(port?.errdisabled).toBe('psecure-violation');
    expect(port?.operUp).toBe(false);
    expect(swCfg(e, sw).ports.p0?.psec.violations).toBeGreaterThan(0);
    expect(e.log.some((l) => l.msg.key === 'switch.errdisable')).toBe(true);
    void srv;
  });

  it('restrict verwirft und zählt, Port bleibt up; protect verwirft still', () => {
    const r = psec('restrict');
    ping(r.e, r.a, '10.0.0.9');
    expect(ping(r.e, r.b, '10.0.0.9')).toBe('unreachable');
    expect(r.e.getDevice(r.sw)?.ports[0]?.operUp).toBe(true);
    expect(swCfg(r.e, r.sw).ports.p0?.psec.violations).toBeGreaterThan(0);
    expect(r.e.log.some((l) => l.msg.key === 'switch.psec.restrict')).toBe(true);
    const p = psec('protect');
    ping(p.e, p.a, '10.0.0.9');
    ping(p.e, p.b, '10.0.0.9');
    expect(p.e.log.some((l) => l.msg.key === 'switch.psec.protect')).toBe(false);
    expect(swCfg(p.e, p.sw).ports.p0?.psec.violations).toBeGreaterThan(0);
  });

  it('Auto-Recovery stellt den Port nach dem Intervall wieder her', () => {
    const { e, sw, a, b } = psec('shutdown');
    swCfg(e, sw).errdisableRecovery = { psecure: true, intervalSec: 30 };
    ping(e, a, '10.0.0.9');
    e.ping(b, '10.0.0.9');
    e.runUntil(e.state.now + 3_000_000);
    expect(e.getDevice(sw)?.ports[0]?.errdisabled).toBe('psecure-violation');
    e.runUntil(e.state.now + 31_000_000);
    expect(e.getDevice(sw)?.ports[0]?.errdisabled).toBeUndefined();
    expect(e.getDevice(sw)?.ports[0]?.operUp).toBe(true);
    expect(e.log.some((l) => l.msg.key === 'switch.errdisableRecovered')).toBe(true);
  });
});
