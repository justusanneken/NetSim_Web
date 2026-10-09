import { Engine } from '@netsim/engine';
import { link, router, type R } from './gapsLab';

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
