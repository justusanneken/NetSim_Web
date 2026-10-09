import { describe, expect, it } from 'vitest';
import { Engine, discOf, liveNeighbors } from '../src';
import { converge, dev, l3Cfg, link, noShut, swCfg } from './labs3';

function lab() {
  const e = new Engine({ seed: 1 });
  const r1 = e.addDevice('router', { name: 'R1' });
  const s1 = e.addDevice('switch-l2', { name: 'S1' });
  const s2 = e.addDevice('switch-l2', { name: 'S2' });
  link(e, r1, 'p0', s1, 'p0');
  link(e, s1, 'p23', s2, 'p23', 'crossover');
  noShut(e, r1, 'p0');
  return { e, r1, s1, s2 };
}

describe('CDP', () => {
  it('is on by default: neighbours appear after the first advertisement', () => {
    const { e, r1, s1, s2 } = lab();
    converge(e, 10);
    const n1 = liveNeighbors(dev(e, s1), e.state.now, 'cdp');
    expect(n1.map((n) => n.deviceId).sort()).toEqual(['R1', 'S2']);
    const toR1 = n1.find((n) => n.deviceId === 'R1');
    expect(toR1?.remotePort).toBe('GigabitEthernet0/0');
    expect(toR1?.capabilities).toContain('R');
    expect(liveNeighbors(dev(e, s2), e.state.now, 'cdp').map((n) => n.deviceId)).toEqual(['S1']);
    expect(liveNeighbors(dev(e, r1), e.state.now, 'cdp')[0]?.deviceId).toBe('S1');
  });

  it('no cdp run stops advertising and ignores received frames', () => {
    const { e, s1, s2 } = lab();
    discOf(l3Cfg(e, s2)).cdpRun = false;
    e.discChanged(s2);
    converge(e, 10);
    expect(liveNeighbors(dev(e, s1), e.state.now, 'cdp').map((n) => n.deviceId)).toEqual(['R1']);
    expect(liveNeighbors(dev(e, s2), e.state.now, 'cdp')).toHaveLength(0);
  });

  it('entries expire after the holdtime when the neighbour goes silent', () => {
    const { e, s1, s2 } = lab();
    converge(e, 10);
    discOf(l3Cfg(e, s2)).cdpRun = false;
    e.discChanged(s2);
    converge(e, 200);
    expect(liveNeighbors(dev(e, s1), e.state.now, 'cdp').map((n) => n.deviceId)).toEqual(['R1']);
  });

  it('native VLAN mismatch on a trunk is logged as %CDP-4-NATIVE_VLAN_MISMATCH', () => {
    const { e, s1, s2 } = lab();
    for (const s of [s1, s2]) e.setSwitchport(s, 'p23', { mode: 'trunk' });
    e.setSwitchport(s2, 'p23', { nativeVlan: 99 });
    converge(e, 70);
    const buf = swCfg(e, s1).sys.mgmt?.logBuffer ?? [];
    expect(
      buf.some((l) =>
        l.includes(
          '%CDP-4-NATIVE_VLAN_MISMATCH: Native VLAN mismatch discovered on FastEthernet0/24 (1), with S2 FastEthernet0/24 (99).',
        ),
      ),
    ).toBe(true);
  });
});

describe('LLDP', () => {
  it('is off by default and works once enabled on both sides', () => {
    const { e, s1, s2 } = lab();
    converge(e, 40);
    expect(liveNeighbors(dev(e, s1), e.state.now, 'lldp')).toHaveLength(0);
    for (const s of [s1, s2]) {
      discOf(l3Cfg(e, s)).lldpRun = true;
      e.discChanged(s);
    }
    converge(e, 40);
    const n = liveNeighbors(dev(e, s1), e.state.now, 'lldp');
    expect(n.map((x) => x.deviceId)).toEqual(['S2']);
    expect(n[0]?.capabilities).toEqual(['B']);
  });
});
