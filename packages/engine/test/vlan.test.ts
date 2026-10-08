import { describe, expect, it } from 'vitest';
import { Engine } from '../src';
import { converge } from './helpers';
import { blockedPorts, host, link, noShut, ok, ping, swCfg } from './labs3';

/** Zwei Switches (Trunk p23), je 2 PCs in VLAN 10/20. */
function twoSwitches() {
  const e = new Engine({ seed: 1 });
  const s1 = e.addDevice('switch-l2', { name: 'S1' });
  const s2 = e.addDevice('switch-l2', { name: 'S2' });
  for (const s of [s1, s2]) {
    ok(e.addVlan(s, 10, 'Sales'));
    ok(e.addVlan(s, 20, 'Eng'));
  }
  link(e, s1, 'p23', s2, 'p23', 'crossover');
  ok(e.setSwitchport(s1, 'p23', { mode: 'trunk' }));
  ok(e.setSwitchport(s2, 'p23', { mode: 'trunk' }));
  const a = host(e, 'A', '10.0.10.1');
  const b = host(e, 'B', '10.0.20.1');
  const c = host(e, 'C', '10.0.10.2');
  const d = host(e, 'D', '10.0.20.2');
  link(e, a, 'p0', s1, 'p0');
  link(e, b, 'p0', s1, 'p1');
  link(e, c, 'p0', s2, 'p0');
  link(e, d, 'p0', s2, 'p1');
  ok(e.setSwitchport(s1, 'p0', { accessVlan: 10 }));
  ok(e.setSwitchport(s1, 'p1', { accessVlan: 20 }));
  ok(e.setSwitchport(s2, 'p0', { accessVlan: 10 }));
  ok(e.setSwitchport(s2, 'p1', { accessVlan: 20 }));
  converge(e);
  return { e, s1, s2, a, b, c, d };
}

describe('VLAN und Trunk', () => {
  it('gleiche VLANs kommunizieren über den Trunk, andere VLANs sind getrennt', () => {
    const { e, a, b, c, d } = twoSwitches();
    expect(ping(e, a, '10.0.10.2')).toBe('reply');
    expect(ping(e, b, '10.0.20.2')).toBe('reply');
    expect(ping(e, a, '10.0.20.2')).toBe('unreachable');
    expect(ping(e, c, '10.0.10.1')).toBe('reply');
    void d;
  });

  it('Broadcast bleibt im VLAN (ARP von VLAN 10 erreicht VLAN 20 nicht)', () => {
    const { e, a, b } = twoSwitches();
    e.log.length = 0;
    ping(e, a, '10.0.10.2');
    expect(e.log.some((l) => l.atDeviceName === 'B' && l.msg.key.startsWith('host.arp'))).toBe(
      false,
    );
    void b;
  });

  it('Frames auf dem Trunk sind getaggt (nicht nativ) und nativ ungetaggt', () => {
    const { e, a } = twoSwitches();
    e.log.length = 0;
    ping(e, a, '10.0.10.2');
    const rx = e.log.filter((l) => l.atDeviceName === 'S2' && l.frame?.vlan);
    expect(rx.length).toBeGreaterThan(0);
    expect(rx[0]?.frame?.vlan?.vid).toBe(10);
  });

  it('Allowed-VLAN-Liste sperrt VLAN 20 auf dem Trunk', () => {
    const { e, s1, b, d } = twoSwitches();
    ok(e.setSwitchport(s1, 'p23', { allowed: [10] }));
    converge(e);
    expect(ping(e, b, '10.0.20.2')).toBe('unreachable');
    void d;
    expect(
      e.log.some((l) => l.msg.key === 'switch.vlanNotAllowed' || l.msg.key === 'switch.noVlan'),
    ).toBe(true);
  });

  it('DTP: desirable/auto handelt Trunk aus, auto/auto nicht', () => {
    const e = new Engine();
    const s1 = e.addDevice('switch-l2');
    const s2 = e.addDevice('switch-l2');
    link(e, s1, 'p0', s2, 'p0', 'crossover');
    ok(e.setSwitchport(s1, 'p0', { mode: 'dynamic-auto' }));
    ok(e.setSwitchport(s2, 'p0', { mode: 'dynamic-auto' }));
    expect(swCfg(e, s1).operTrunk.p0).toBeUndefined();
    ok(e.setSwitchport(s2, 'p0', { mode: 'dynamic-desirable' }));
    expect(swCfg(e, s1).operTrunk.p0).toBe(true);
    expect(swCfg(e, s2).operTrunk.p0).toBe(true);
  });

  it('VTP: VLANs vom Server erreichen den Client; Revision steigt; Transparent leitet nur weiter', () => {
    const e = new Engine();
    const s1 = e.addDevice('switch-l2', { name: 'S1' });
    const s2 = e.addDevice('switch-l2', { name: 'S2' });
    const s3 = e.addDevice('switch-l2', { name: 'S3' });
    link(e, s1, 'p23', s2, 'p23', 'crossover');
    link(e, s2, 'p22', s3, 'p22', 'crossover');
    for (const [s, p] of [
      [s1, 'p23'],
      [s2, 'p23'],
      [s2, 'p22'],
      [s3, 'p22'],
    ] as const)
      ok(e.setSwitchport(s, p, { mode: 'trunk' }));
    ok(e.setVtp(s1, { mode: 'server', domain: 'lab' }));
    ok(e.setVtp(s2, { mode: 'transparent', domain: 'lab' }));
    ok(e.setVtp(s3, { mode: 'client', domain: 'lab' }));
    ok(e.addVlan(s1, 30, 'Mgmt'));
    e.runUntil(e.state.now + 2_000_000);
    expect(swCfg(e, s3).vlans[30]?.name).toBe('Mgmt');
    expect(swCfg(e, s2).vlans[30]).toBeUndefined();
    expect(swCfg(e, s3).vtp.revision).toBe(swCfg(e, s1).vtp.revision);
    expect(e.addVlan(s3, 40)).toMatchObject({ error: 'sw.vtpClient' });
    ok(e.removeVlan(s1, 30));
    e.runUntil(e.state.now + 2_000_000);
    expect(swCfg(e, s3).vlans[30]).toBeUndefined();
    expect(e.removeVlan(s1, 1).ok).toBe(false);
  });

  it('VLAN-API validiert Eingaben', () => {
    const e = new Engine();
    const s = e.addDevice('switch-l2');
    expect(e.addVlan(s, 0).ok).toBe(false);
    expect(e.addVlan(s, 5000).ok).toBe(false);
    expect(e.addVlan('nope', 5).ok).toBe(false);
    expect(e.setSwitchport(s, 'p0', { accessVlan: 5000 }).ok).toBe(false);
    expect(e.setStp(s, { vlan: 1, priority: 100 }).ok).toBe(false);
    void blockedPorts;
    void noShut;
  });
});
