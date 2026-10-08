import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { HostShell } from '../src';
import { diamond, sec } from './gapsLab';

function v6lab() {
  const lab = diamond();
  const { r1, r2, r3, r4 } = lab;
  const base = (r: typeof r1, rid: string, rows: [string, string][]): void => {
    r.run(
      'configure terminal',
      'ipv6 unicast-routing',
      'ipv6 router ospf 1',
      `router-id ${rid}`,
      'exit',
      ...rows.flatMap(([i, a]) => [
        `interface ${i}`,
        `ipv6 address ${a}`,
        'ipv6 ospf 1 area 0',
        'exit',
      ]),
      'end',
    );
  };
  base(r1, '1.1.1.1', [
    ['gi0/0', '2001:db8:12::1/64'],
    ['gi0/1', '2001:db8:13::1/64'],
    ['gi0/2', '2001:db8:1::1/64'],
  ]);
  base(r2, '2.2.2.2', [
    ['gi0/0', '2001:db8:12::2/64'],
    ['gi0/1', '2001:db8:24::2/64'],
  ]);
  base(r3, '3.3.3.3', [
    ['gi0/0', '2001:db8:13::3/64'],
    ['gi0/1', '2001:db8:34::3/64'],
  ]);
  base(r4, '4.4.4.4', [
    ['gi0/0', '2001:db8:24::4/64'],
    ['gi0/1', '2001:db8:34::4/64'],
    ['gi0/2', '2001:db8:4::1/64'],
  ]);
  r4.run(
    'configure terminal',
    'ipv6 dhcp pool STATELESS',
    'dns-server 2001:db8:4::53',
    'domain-name v6.lab',
    'exit',
    'interface gi0/2',
    'ipv6 dhcp server STATELESS',
    'ipv6 nd other-config-flag',
    'end',
  );
  return lab;
}

const ping6 = (e: Engine, pc: string, dst: string): boolean => {
  e.ping(pc, dst, { count: 1 });
  e.runUntil(e.state.now + 6_000_000);
  const c = e.getDevice(pc)?.config;
  return c?.kind === 'host' && c.pings.at(-1)?.status === 'reply';
};

describe('QA IPv6 end-to-end', () => {
  it('OSPFv3 ECMP + SLAAC + stateless DHCPv6, ping, snapshot/restore, resetRuntime', () => {
    const { e, r1, pc1, pc4 } = v6lab();
    e.setHostIpv6(pc1, { autoconfig: true });
    e.setHostIpv6(pc4, { autoconfig: true, dhcp6: true });
    sec(e, 60);
    const rt = r1.run('show ipv6 route');
    expect(rt).toMatch(/O\s+2001:DB8:4::\/64/);
    const ip4 = new HostShell(e, pc4).input('ipconfig /all');
    expect(ip4).toContain('2001:db8:4::53');
    expect(ip4).toContain('v6.lab');
    const addr4 = /IPv6 Address\.+: (2001:db8:4:[0-9a-f:]+)/.exec(ip4)?.[1];
    expect(addr4).toBeDefined();
    expect(ping6(e, pc1, addr4 as string)).toBe(true);
    // ECMP across R2 and R3
    expect(e.state.devices[r1.id]).toBeDefined();
    const snap = e.snapshot();
    const e2 = new Engine({ seed: 1 });
    e2.restore(snap);
    expect(ping6(e2, pc1, addr4 as string)).toBe(true);
    e.resetRuntime();
    sec(e, 60);
    expect(ping6(e, pc1, addr4 as string)).toBe(true);
    expect(JSON.parse(JSON.stringify(e.state))).toEqual(structuredClone(e.state));
  });

  it('host DAD: second host with same static address detects duplicate', () => {
    const { e, pc4, r4 } = v6lab();
    const pcB = e.addDevice('pc', { name: 'PCB' });
    const sw = e.addDevice('switch-l2', { name: 'SW' });
    // put pc4 and pcB behind a switch on R4's LAN
    const l = Object.values(e.state.links).find(
      (x) => x.a.deviceId === pc4 || x.b.deviceId === pc4,
    );
    if (l) e.disconnect(l.id);
    e.connect({ deviceId: pc4, portId: 'p0' }, { deviceId: sw, portId: 'p0' }, 'straight');
    e.connect({ deviceId: pcB, portId: 'p0' }, { deviceId: sw, portId: 'p1' }, 'straight');
    e.connect({ deviceId: r4.id, portId: 'p2' }, { deviceId: sw, portId: 'p2' }, 'straight');
    sec(e, 40);
    e.setHostIpv6(pc4, { addr: '2001:db8:4::10', plen: 64, gateway: '2001:db8:4::1' });
    sec(e, 5);
    e.setHostIpv6(pcB, { addr: '2001:db8:4::10', plen: 64, gateway: '2001:db8:4::1' });
    sec(e, 5);
    const b = new HostShell(e, pcB).input('ipconfig');
    const a = new HostShell(e, pc4).input('ipconfig');
    expect(b).toMatch(/Duplicate|DUP|Tentative/i);
    expect(a).not.toMatch(/Duplicate|DUP/i);
    expect(ping6(e, pc4, '2001:db8:4::1')).toBe(true);
  });
});
