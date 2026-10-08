import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { ifcfg, link, router, sec } from './gapsLab';

const pingOk = (e: Engine, pc: string, dst: string): boolean => {
  e.ping(pc, dst, { count: 1 });
  e.runUntil(e.state.now + 6_000_000);
  const cfg = e.getDevice(pc)?.config;
  return cfg?.kind === 'host' && cfg.pings.at(-1)?.status === 'reply';
};

/** PC – SW – (R1 | R2) – R3 – Server; HSRP v2 VIP 10.1.0.254 auf dem LAN. */
function lab() {
  const e = new Engine({ seed: 3 });
  const sw = e.addDevice('switch-l2', { name: 'SW' });
  const pc = e.addDevice('pc', { name: 'PC' });
  const srv = e.addDevice('server', { name: 'SRV' });
  const r1 = router(e, 'R1');
  const r2 = router(e, 'R2');
  const r3 = router(e, 'R3');
  e.connect({ deviceId: pc, portId: 'p0' }, { deviceId: sw, portId: 'p0' }, 'straight');
  e.connect({ deviceId: r1.id, portId: 'p0' }, { deviceId: sw, portId: 'p1' }, 'straight');
  e.connect({ deviceId: r2.id, portId: 'p0' }, { deviceId: sw, portId: 'p2' }, 'straight');
  link(e, r1.id, 'p1', r3.id, 'p0');
  link(e, r2.id, 'p1', r3.id, 'p1');
  e.connect({ deviceId: srv, portId: 'p0' }, { deviceId: r3.id, portId: 'p2' }, 'straight');
  e.setHostIp(pc, '10.1.0.10', '255.255.255.0', '10.1.0.254');
  e.setHostIp(srv, '10.9.0.10', '255.255.255.0', '10.9.0.1');
  ifcfg(r1, [
    ['gi0/0', '10.1.0.1'],
    ['gi0/1', '10.0.13.1'],
  ]);
  ifcfg(r2, [
    ['gi0/0', '10.1.0.2'],
    ['gi0/1', '10.0.23.2'],
  ]);
  ifcfg(r3, [
    ['gi0/0', '10.0.13.3'],
    ['gi0/1', '10.0.23.3'],
    ['gi0/2', '10.9.0.1'],
  ]);
  for (const [r, prio] of [
    [r1, 150],
    [r2, 100],
  ] as const) {
    r.run(
      'configure terminal',
      'interface gi0/0',
      'standby version 2',
      'standby 10 ip 10.1.0.254',
      `standby 10 priority ${prio}`,
      'standby 10 preempt',
      'exit',
      'router ospf 1',
      'network 10.0.0.0 0.255.255.255 area 0',
      'end',
    );
  }
  r3.run('configure terminal', 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'end');
  return { e, pc, srv, r1, r2, r3 };
}

describe('QA HSRP v2 failover', () => {
  it('fails over on power loss and preempts back', () => {
    const { e, pc, r1, r2 } = lab();
    sec(e, 90);
    expect(r1.run('show standby brief')).toMatch(/Active/);
    expect(pingOk(e, pc, '10.9.0.10')).toBe(true);
    e.setPower(r1.id, false);
    sec(e, 12);
    expect(r2.run('show standby brief')).toMatch(/Gi0\/0\s+10\s+100\s+P\s+Active/);
    expect(pingOk(e, pc, '10.9.0.10')).toBe(true);
    e.setPower(r1.id, true);
    // R1 kommt ohne startup-config hoch: kein HSRP mehr → R2 bleibt aktiv
    sec(e, 60);
    expect(r2.run('show standby brief')).toMatch(/Active/);
    expect(pingOk(e, pc, '10.9.0.10')).toBe(true);
  });

  it('interface shutdown on active: standby takes over; no shutdown: preempt back', () => {
    const { e, pc, r1, r2 } = lab();
    sec(e, 90);
    r1.run('configure terminal', 'interface gi0/0', 'shutdown', 'end');
    sec(e, 2);
    expect(r2.run('show standby brief')).toMatch(/Active/);
    sec(e, 10);
    expect(pingOk(e, pc, '10.9.0.10')).toBe(true);
    r1.run('configure terminal', 'interface gi0/0', 'no shutdown', 'end');
    sec(e, 40);
    expect(r1.run('show standby brief')).toMatch(/Gi0\/0\s+10\s+150\s+P\s+Active/);
    expect(r2.run('show standby brief')).toMatch(/Standby/);
    expect(pingOk(e, pc, '10.9.0.10')).toBe(true);
  });

  it('track: decrement on uplink loss hands over to R2', () => {
    const { e, pc, r1, r2 } = lab();
    const o = r1.run('configure terminal', 'interface gi0/0', 'standby 10 track gi0/1 60', 'end');
    expect(o).not.toContain('%');
    sec(e, 90);
    r1.run('configure terminal', 'interface gi0/1', 'shutdown', 'end');
    sec(e, 10);
    expect(r2.run('show standby brief')).toMatch(/Active/);
    expect(pingOk(e, pc, '10.9.0.10')).toBe(true);
  });

  it('no standby <group> on the active router removes the group; standby takes over', () => {
    const { e, pc, r1, r2 } = lab();
    sec(e, 90);
    const o = r1.run('configure terminal', 'interface gi0/0', 'no standby 10', 'end');
    expect(o).not.toContain('%');
    expect(r1.run('show running-config')).not.toContain('standby 10');
    expect(r1.run('show standby brief')).not.toMatch(/Gi0\/0\s+10/);
    sec(e, 15);
    expect(r2.run('show standby brief')).toMatch(/Gi0\/0\s+10\s+100\s+P\s+Active/);
    sec(e, 10);
    expect(pingOk(e, pc, '10.9.0.10')).toBe(true);
  });

  it('no interface loopbackN withdraws its route', () => {
    const { e, r1, r3 } = lab();
    r1.run(
      'configure terminal',
      'interface loopback7',
      'ip address 7.7.7.7 255.255.255.255',
      'exit',
      'router ospf 1',
      'network 7.7.7.7 0.0.0.0 area 0',
      'end',
    );
    sec(e, 90);
    expect(r3.run('show ip route')).toContain('7.7.7.7');
    const o = r1.run('configure terminal', 'no interface Loopback7', 'end');
    expect(o).not.toContain('%');
    sec(e, 15);
    expect(r1.run('show running-config')).not.toContain('Loopback7');
    expect(r3.run('show ip route')).not.toContain('7.7.7.7');
    expect(r1.run('configure terminal', 'no interface gi0/0', 'end')).toContain(
      '% Invalid interface',
    );
  });
});
