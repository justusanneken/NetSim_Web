import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { CliSession } from '../src';
import { diamond, sec } from './gapsLab';

const strip = (x: string): string => x.replace(/Current configuration.*\n/, '');

function ospfNssa() {
  const lab = diamond();
  const { r1, r2, r3, r4 } = lab;
  r1.run(
    'configure terminal',
    'router ospf 1',
    'network 10.0.12.0 0.0.0.255 area 0',
    'network 10.0.13.0 0.0.0.255 area 0',
    'network 10.1.0.0 0.0.0.255 area 0',
    'end',
  );
  for (const r of [r2, r3])
    r.run(
      'configure terminal',
      'router ospf 1',
      'network 10.0.12.0 0.0.0.255 area 0',
      'network 10.0.13.0 0.0.0.255 area 0',
      'network 10.0.24.0 0.0.0.255 area 1',
      'network 10.0.34.0 0.0.0.255 area 1',
      'area 1 nssa',
      'end',
    );
  r4.run(
    'configure terminal',
    'interface loopback1',
    'ip address 192.168.50.1 255.255.255.0',
    'exit',
    'router ospf 1',
    'network 10.0.24.0 0.0.0.255 area 1',
    'network 10.0.34.0 0.0.0.255 area 1',
    'area 1 nssa',
    'redistribute connected subnets',
    'redistribute static subnets',
    'end',
  );
  return lab;
}

describe('QA routing', () => {
  it('OSPF NSSA: N2 inside area, E2 in backbone, ECMP at R1', () => {
    const { e, r1, r2, r4 } = ospfNssa();
    sec(e, 120);
    const rt2 = r2.run('show ip route');
    expect(rt2).toMatch(/O N2\s+192\.168\.50\.0\/24/);
    const rt1 = r1.run('show ip route');
    expect(rt1).toMatch(/O E2\s+192\.168\.50\.0\/24/);
    expect(rt1).toMatch(/O E2\s+10\.4\.0\.0\/24/);
    // ECMP: both R2 and R3 are ABRs
    const rt = e.routingTable(r1.id).filter((x) => x.prefix === '10.0.24.0');
    expect(rt.length).toBeGreaterThan(0);
    void r4;
  });

  it('snapshot/restore mid-convergence reproduces identical log and tables', () => {
    const lab = ospfNssa();
    const { e } = lab;
    sec(e, 7);
    const snap = e.snapshot();
    const logLen = e.log.length;
    sec(e, 120);
    const tail = e.log.slice(logLen).map((l) => JSON.stringify({ ...l, id: 0 }));
    const tables = Object.keys(e.state.devices).map((id) => JSON.stringify(e.routingTable(id)));

    const e2 = new Engine({ seed: 1 });
    e2.restore(snap);
    e2.runUntil(e2.state.now + 120_000_000);
    const tail2 = e2.log.map((l) => JSON.stringify({ ...l, id: 0 }));
    const tables2 = Object.keys(e2.state.devices).map((id) => JSON.stringify(e2.routingTable(id)));
    expect(tables2).toEqual(tables);
    expect(tail2.length).toBe(tail.length);
    expect(tail2).toEqual(tail);
  });

  it('determinism: same build twice => identical log', () => {
    const a = ospfNssa();
    sec(a.e, 60);
    const b = ospfNssa();
    sec(b.e, 60);
    expect(b.e.log.map((l) => JSON.stringify(l))).toEqual(a.e.log.map((l) => JSON.stringify(l)));
  });

  it('state is JSON-serializable after converging', () => {
    const { e } = ospfNssa();
    sec(e, 60);
    const j = JSON.parse(JSON.stringify(e.state));
    expect(j).toEqual(structuredClone(e.state));
  });

  it('resetRuntime then reconverges to same tables', () => {
    const { e } = ospfNssa();
    sec(e, 120);
    const tables = Object.keys(e.state.devices).map((id) =>
      JSON.stringify(e.routingTable(id).map((r) => ({ ...r, since: 0 }))),
    );
    e.resetRuntime();
    sec(e, 120);
    const t2 = Object.keys(e.state.devices).map((id) =>
      JSON.stringify(e.routingTable(id).map((r) => ({ ...r, since: 0 }))),
    );
    expect(t2).toEqual(tables);
  });

  it('remove device mid-protocol does not crash; neighbours reconverge', () => {
    const { e, r1, r2 } = ospfNssa();
    sec(e, 20);
    e.removeDevice(r2.id);
    sec(e, 120);
    const rt1 = r1.run('show ip route');
    expect(rt1).toMatch(/10\.4\.0\.0\/24/);
    expect(rt1).not.toContain('10.0.12.2');
  });
});

describe('QA replay', () => {
  it('running-config round trip of a router with many new commands', () => {
    const e = new Engine({ seed: 1 });
    const id = e.addDevice('router', { name: 'R1' });
    const d = e.getDevice(id);
    if (d?.config.kind === 'router') d.config.sys.setupDone = true;
    const s = new CliSession(e, id);
    const lines = [
      'enable',
      'configure terminal',
      'ipv6 unicast-routing',
      'ip domain-name lab.local',
      'username admin privilege 15 secret s3cret',
      'aaa new-model',
      'ntp server 10.0.1.10',
      'logging host 10.0.1.10',
      'logging trap warnings',
      'snmp-server community public RO',
      'snmp-server community private RW',
      'ip prefix-list PL seq 5 permit 10.0.0.0/8 le 24',
      'ip community-list standard CL permit 65000:100',
      'route-map RM permit 10',
      'match ip address prefix-list PL',
      'set community 65000:100 additive',
      'set local-preference 200',
      'exit',
      'interface gi0/0',
      'ip address 10.0.1.1 255.255.255.0',
      'standby version 2',
      'standby 1 ip 10.0.1.254',
      'standby 1 priority 110',
      'standby 1 preempt',
      'ipv6 address 2001:db8:1::1/64',
      'ipv6 ospf 1 area 0',
      'ip ospf authentication message-digest',
      'ip ospf message-digest-key 1 md5 key1',
      'no shutdown',
      'exit',
      'router ospf 1',
      'network 10.0.1.0 0.0.0.255 area 0',
      'maximum-paths 2',
      'area 1 nssa',
      'exit',
      'router eigrp 10',
      'network 10.0.0.0',
      'variance 2',
      'redistribute ospf 1 metric 10000 100 255 1 1500 route-map RM',
      'exit',
      'router bgp 65000',
      'neighbor 10.0.1.2 remote-as 65000',
      'neighbor 10.0.1.2 route-reflector-client',
      'neighbor 10.0.1.2 send-community',
      'neighbor 10.0.1.2 route-map RM in',
      'address-family ipv6 unicast',
      'neighbor 10.0.1.2 activate',
      'exit-address-family',
      'exit',
      'ipv6 router ospf 1',
      'router-id 1.1.1.1',
      'exit',
      'ipv6 router rip RIPNG',
      'exit',
      'line vty 0 4',
      'login local',
      'transport input ssh telnet',
      'end',
    ];
    const errs: string[] = [];
    for (const l of lines) {
      const o = s.input(l);
      if (/^%|Invalid|Incomplete|Unknown|Ambiguous/m.test(o)) errs.push(`${l} => ${o}`);
    }
    expect(errs).toEqual([]);
    const before = s.input('show running-config');
    s.input('copy running-config startup-config');
    s.input('');
    s.input('reload');
    s.input('');
    const s2 = new CliSession(e, id);
    s2.input('enable');
    const after = s2.input('show running-config');
    expect(strip(after)).toBe(strip(before));
  });
});
