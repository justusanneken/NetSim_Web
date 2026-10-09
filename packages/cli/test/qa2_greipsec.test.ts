import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { link, router, sec, type R } from './gapsLab';

/** PC1 – R1 ==(ISP)== R3 – PC3; GRE-Tunnel R1 ↔ R3, durch IPsec geschützt (Crypto-ACL `permit gre`). */
function lab() {
  const e = new Engine({ seed: 1 });
  const r1 = router(e, 'R1');
  const isp = router(e, 'ISP');
  const r3 = router(e, 'R3');
  link(e, r1.id, 'p0', isp.id, 'p0');
  link(e, isp.id, 'p1', r3.id, 'p0');
  const pc1 = e.addDevice('pc', { name: 'PC1' });
  const pc3 = e.addDevice('pc', { name: 'PC3' });
  link(e, pc1, 'p0', r1.id, 'p1');
  link(e, pc3, 'p0', r3.id, 'p1');
  e.setHostIp(pc1, '10.1.0.10', '255.255.255.0', '10.1.0.1');
  e.setHostIp(pc3, '10.2.0.10', '255.255.255.0', '10.2.0.1');
  isp.run(
    'enable',
    'configure terminal',
    'interface gi0/0',
    'ip address 203.0.113.2 255.255.255.252',
    'no shutdown',
    'exit',
    'interface gi0/1',
    'ip address 198.51.100.2 255.255.255.252',
    'no shutdown',
    'end',
  );
  const site = (
    r: R,
    wan: string,
    lan: string,
    gw: string,
    peer: string,
    tun: string,
    remoteLan: string,
    remoteTun: string,
  ) =>
    r.run(
      'enable',
      'configure terminal',
      'interface gi0/0',
      `ip address ${wan} 255.255.255.252`,
      'no shutdown',
      'exit',
      'interface gi0/1',
      `ip address ${lan} 255.255.255.0`,
      'no shutdown',
      'exit',
      `ip route 0.0.0.0 0.0.0.0 ${gw}`,
      'interface tunnel 0',
      `ip address ${tun} 255.255.255.252`,
      'tunnel source gi0/0',
      `tunnel destination ${peer}`,
      'exit',
      `ip route ${remoteLan} 255.255.255.0 ${remoteTun}`,
      'crypto isakmp policy 10',
      'encryption aes',
      'authentication pre-share',
      'group 14',
      'exit',
      `crypto isakmp key geheim address ${peer}`,
      'crypto ipsec transform-set TS esp-aes esp-sha-hmac',
      'exit',
      `access-list 120 permit gre host ${wan} host ${peer}`,
      'crypto map VPN 10 ipsec-isakmp',
      `set peer ${peer}`,
      'set transform-set TS',
      'match address 120',
      'exit',
      'interface gi0/0',
      'crypto map VPN',
      'end',
    );
  site(
    r1,
    '203.0.113.1',
    '10.1.0.1',
    '203.0.113.2',
    '198.51.100.1',
    '172.16.0.1',
    '10.2.0.0',
    '172.16.0.2',
  );
  site(
    r3,
    '198.51.100.1',
    '10.2.0.1',
    '198.51.100.2',
    '203.0.113.1',
    '172.16.0.2',
    '10.1.0.0',
    '172.16.0.1',
  );
  return { e, r1, r3, pc1 };
}

const ping = (e: Engine, pc: string, dst: string): boolean => {
  e.ping(pc, dst, { count: 1 });
  e.runUntil(e.state.now + 6_000_000);
  const c = e.getDevice(pc)?.config;
  return c?.kind === 'host' && c.pings.at(-1)?.status === 'reply';
};

describe('QA2: GRE über IPsec (Crypto-ACL mit permit gre)', () => {
  it('der GRE-Verkehr wird verschlüsselt, der Ping kommt durch', () => {
    const { e, r1, r3, pc1 } = lab();
    sec(e, 2);
    ping(e, pc1, '10.2.0.10');
    expect(ping(e, pc1, '10.2.0.10')).toBe(true);
    const sa1 = r1.s.input('show crypto ipsec sa');
    expect(sa1).toContain('local  ident (addr/mask/prot/port): (203.0.113.1/255.255.255.255/47/0)');
    expect(sa1).toMatch(/#pkts encaps: [1-9]/);
    expect(r3.s.input('show crypto ipsec sa')).toMatch(/#pkts decaps: [1-9]/);
  });
});
