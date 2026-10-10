import { describe, expect, it } from 'vitest';
import { sec } from './gapsLab';
import { lab } from './wanLab';

function ospfLab() {
  const L = lab();
  for (const [r, ip, id] of [
    [L.r1, '10.0.0.1', '1.1.1.1'],
    [L.r2, '10.0.0.2', '2.2.2.2'],
  ] as const) {
    r.run(
      'enable',
      'configure terminal',
      'interface serial0/0/0',
      `ip address ${ip} 255.255.255.252`,
      'no shutdown',
      'exit',
      'router ospf 1',
      `router-id ${id}`,
      'network 10.0.0.0 0.0.0.3 area 0',
      'end',
    );
  }
  L.r1.run('configure terminal', 'interface serial0/0/0', 'clock rate 64000', 'end');
  sec(L.e, 45);
  return L;
}

describe('OSPF über Serial und show ip ospf interface', () => {
  it('Serial: Typ POINT_TO_POINT, Kosten 64, Priorität 0 in der Nachbarliste', () => {
    const { r1 } = ospfLab();
    const out = r1.run('show ip ospf interface serial0/0/0');
    expect(out).toContain('Serial0/0/0 is up, line protocol is up ');
    expect(out).toContain('  Internet Address 10.0.0.1/30, Area 0, Attached via Network Statement');
    expect(out).toContain(
      '  Process ID 1, Router ID 1.1.1.1, Network Type POINT_TO_POINT, Cost: 64',
    );
    expect(out).toContain('  Transmit Delay is 1 sec, State POINT_TO_POINT, Priority 1');
    expect(out).toContain('  Timer intervals configured, Hello 10, Dead 40, Retransmit 5');
    expect(out).toContain('  Neighbor Count is 1, Adjacent neighbor count is 1 ');
    expect(out).toContain('    Adjacent with neighbor 2.2.2.2');
    expect(out).toContain('  Suppress hello for 0 neighbor(s)');
    const nbr = r1.run('show ip ospf neighbor');
    expect(nbr).toMatch(/2\.2\.2\.2 +0 +FULL\/ {2}- +00:00:\d\d +10\.0\.0\.2 +Serial0\/0\/0/);
    expect(r1.run('show ip ospf interface brief')).toMatch(
      /Se0\/0\/0 +1 +0 +10\.0\.0\.1\/30 +64 +P2P +1\/1/,
    );
  });

  it('Hello/Dead-Mismatch verhindert die Nachbarschaft', () => {
    const { e, r1, r2 } = ospfLab();
    expect(r1.run('show ip ospf neighbor')).toContain('FULL');
    r2.run(
      'configure terminal',
      'interface serial0/0/0',
      'ip ospf hello-interval 5',
      'ip ospf dead-interval 20',
      'end',
    );
    sec(e, 120);
    expect(r1.run('show ip ospf neighbor')).not.toContain('FULL');
    expect(r1.run('show ip route ospf')).not.toMatch(/^O /m);
  });

  it('MTU-Mismatch hält die Nachbarschaft in EXSTART; mtu-ignore löst sie', () => {
    const { e, r1, r2 } = ospfLab();
    r2.run('configure terminal', 'interface serial0/0/0', 'shutdown', 'ip mtu 1400', 'end');
    r2.run('configure terminal', 'interface serial0/0/0', 'no shutdown', 'end');
    sec(e, 90);
    expect(r1.run('show ip ospf neighbor')).not.toContain('FULL');
    expect(r2.run('show ip ospf neighbor')).toContain('EXSTART');
    r2.run('configure terminal', 'interface serial0/0/0', 'ip ospf mtu-ignore', 'end');
    sec(e, 90);
    expect(r2.run('show ip ospf neighbor')).toContain('FULL');
    expect(r2.run('show running-config')).toContain(' ip ospf mtu-ignore');
  });

  it('no area N stub no-summary entfernt nur no-summary', () => {
    const { r1 } = ospfLab();
    r1.run('configure terminal', 'router ospf 1', 'area 1 stub no-summary', 'end');
    expect(r1.run('show running-config')).toContain(' area 1 stub no-summary');
    r1.run('configure terminal', 'router ospf 1', 'no area 1 stub no-summary', 'end');
    const cfg = r1.run('show running-config');
    expect(cfg).toContain(' area 1 stub\n');
    expect(cfg).not.toContain('no-summary');
  });
});
