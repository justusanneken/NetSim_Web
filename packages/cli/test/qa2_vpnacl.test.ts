import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { link, router, sec, type R } from './gapsLab';

/** PC1 – R1 ==(ISP)== R3 – PC3, Site-to-Site-VPN 10.1.0.0/24 ↔ 10.2.0.0/24. */
export function vpnLab(opts: { nat?: boolean } = {}) {
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
    'exit',
    'interface loopback0',
    'ip address 8.8.8.8 255.255.255.255',
    'end',
  );
  const site = (r: R, wan: string, lan: string, gw: string, peer: string, l: string, rm: string) =>
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
      'crypto isakmp policy 10',
      'encryption aes',
      'authentication pre-share',
      'group 2',
      'exit',
      `crypto isakmp key geheim address ${peer}`,
      'crypto ipsec transform-set TS esp-aes esp-sha-hmac',
      'exit',
      `access-list 101 permit ip ${l} 0.0.0.255 ${rm} 0.0.0.255`,
      'crypto map VPN 10 ipsec-isakmp',
      `set peer ${peer}`,
      'set transform-set TS',
      'match address 101',
      'exit',
      'interface gi0/0',
      'crypto map VPN',
      'end',
    );
  site(r1, '203.0.113.1', '10.1.0.1', '203.0.113.2', '198.51.100.1', '10.1.0.0', '10.2.0.0');
  site(r3, '198.51.100.1', '10.2.0.1', '198.51.100.2', '203.0.113.1', '10.2.0.0', '10.1.0.0');
  if (opts.nat)
    r1.run(
      'configure terminal',
      // NAT-Ausnahme für den VPN-Verkehr, alles andere per PAT ins Internet
      'access-list 110 deny ip 10.1.0.0 0.0.0.255 10.2.0.0 0.0.0.255',
      'access-list 110 permit ip 10.1.0.0 0.0.0.255 any',
      'ip nat inside source list 110 interface gi0/0 overload',
      'interface gi0/1',
      'ip nat inside',
      'exit',
      'interface gi0/0',
      'ip nat outside',
      'end',
    );
  return { e, r1, isp, r3, pc1, pc3 };
}

export const ping = (e: Engine, pc: string, dst: string): boolean => {
  e.ping(pc, dst, { count: 1 });
  e.runUntil(e.state.now + 6_000_000);
  const c = e.getDevice(pc)?.config;
  return c?.kind === 'host' && c.pings.at(-1)?.status === 'reply';
};

const up = (e: Engine, pc: string, dst: string): boolean => {
  ping(e, pc, dst);
  return ping(e, pc, dst);
};

describe('QA2: IPsec mit NAT und Schnittstellen-ACLs', () => {
  it('NAT-Overload und Crypto Map an derselben WAN-Schnittstelle (mit NAT-Ausnahme)', () => {
    const { e, r1, pc1 } = vpnLab({ nat: true });
    sec(e, 2);
    expect(up(e, pc1, '10.2.0.10')).toBe(true);
    expect(r1.s.input('show crypto ipsec sa')).toMatch(/#pkts encaps: [1-9]/);
    expect(up(e, pc1, '8.8.8.8')).toBe(true);
    const tr = r1.s.input('show ip nat translations');
    expect(tr).toContain('203.0.113.1');
    expect(tr).toContain('8.8.8.8');
    expect(tr).not.toContain('10.2.0.10');
  });

  it('ACL-Schlüsselwörter esp/ahp/gre/ospf/eigrp und Portnamen bgp/tacacs/isakmp/snmptrap', () => {
    const { r1 } = vpnLab();
    const out = r1.run(
      'configure terminal',
      'access-list 120 permit esp host 198.51.100.1 host 203.0.113.1',
      'access-list 120 permit ahp any any',
      'access-list 120 permit gre any any',
      'access-list 120 permit ospf any any',
      'access-list 120 permit eigrp any any',
      'access-list 120 permit udp host 198.51.100.1 host 203.0.113.1 eq isakmp',
      'access-list 120 permit udp any any eq non500-isakmp',
      'access-list 120 permit tcp any any eq bgp',
      'access-list 120 permit tcp any eq tacacs any',
      'access-list 120 permit udp any any eq snmptrap',
      'end',
    );
    expect(out).not.toContain('%');
    const rc = r1.s.input('show running-config');
    expect(rc).toContain('access-list 120 permit esp host 198.51.100.1 host 203.0.113.1');
    expect(rc).toContain('access-list 120 permit ahp any any');
    expect(rc).toContain('access-list 120 permit gre any any');
    expect(rc).toContain('access-list 120 permit ospf any any');
    expect(rc).toContain('access-list 120 permit eigrp any any');
    expect(rc).toContain('access-list 120 permit udp host 198.51.100.1 host 203.0.113.1 eq isakmp');
    expect(rc).toContain('access-list 120 permit udp any any eq non500-isakmp');
    expect(rc).toContain('access-list 120 permit tcp any any eq bgp');
    expect(rc).toContain('access-list 120 permit tcp any eq tacacs any');
    expect(rc).toContain('access-list 120 permit udp any any eq snmptrap');
  });

  it('eingehende WAN-ACL: IKE und ESP zum Router werden gefiltert', () => {
    const { e, r1, pc1 } = vpnLab();
    r1.run(
      'configure terminal',
      'access-list 120 deny esp any any',
      'access-list 120 permit ip any any',
      'interface gi0/0',
      'ip access-group 120 in',
      'end',
    );
    sec(e, 2);
    expect(up(e, pc1, '10.2.0.10')).toBe(false);
    // IKE ebenso: ohne UDP 500 kommt keine SA zustande
    r1.run(
      'configure terminal',
      'no access-list 120',
      'access-list 120 deny udp any any eq isakmp',
      'access-list 120 permit ip any any',
      'end',
      'clear crypto sa',
    );
    sec(e, 10);
    expect(up(e, pc1, '10.2.0.10')).toBe(false);
    expect(r1.s.input('show crypto isakmp sa')).not.toContain('QM_IDLE');
  });

  it('eingehende WAN-ACL mit permit für IKE, ESP und den inneren Verkehr: VPN steht', () => {
    const { e, r1, pc1 } = vpnLab();
    r1.run(
      'configure terminal',
      'access-list 120 permit udp host 198.51.100.1 host 203.0.113.1 eq isakmp',
      'access-list 120 permit esp host 198.51.100.1 host 203.0.113.1',
      'access-list 120 permit ip 10.2.0.0 0.0.0.255 10.1.0.0 0.0.0.255',
      'interface gi0/0',
      'ip access-group 120 in',
      'end',
    );
    sec(e, 2);
    expect(up(e, pc1, '10.2.0.10')).toBe(true);
    expect(r1.s.input('show access-lists 120')).toMatch(/permit esp .*\(\d+ match/);
  });

  it('eingehende ACL sperrt auch Ping an die Router-Schnittstelle (IOS)', () => {
    const { e, r1, isp } = vpnLab();
    r1.run(
      'configure terminal',
      'access-list 130 deny icmp any any',
      'access-list 130 permit ip any any',
      'interface gi0/0',
      'ip access-group 130 in',
      'end',
    );
    const out = isp.run('ping 203.0.113.1');
    sec(e, 1);
    expect(out).toMatch(/Success rate is 0 percent/);
  });
});

describe('QA2: IPsec nach Neustart der Gegenstelle', () => {
  it('alte SA bleibt (kein DPD); IKE von der neu gestarteten Seite stellt das VPN wieder her', () => {
    const { e, r3, pc1, pc3 } = vpnLab();
    sec(e, 2);
    expect(up(e, pc1, '10.2.0.10')).toBe(true);
    e.setPower(r3.id, false);
    sec(e, 2);
    e.setPower(r3.id, true);
    sec(e, 5);
    expect(up(e, pc1, '10.2.0.10')).toBe(false);
    expect(up(e, pc3, '10.1.0.10')).toBe(true);
    expect(up(e, pc1, '10.2.0.10')).toBe(true);
  });
});
