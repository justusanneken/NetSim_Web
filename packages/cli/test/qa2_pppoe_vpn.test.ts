import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { link, router, sec, type R } from './gapsLab';

const crypto = (r: R, peer: string, l: string, rm: string, ifc: string): string =>
  r.run(
    'configure terminal',
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
    `interface ${ifc}`,
    'crypto map VPN',
    'end',
  );

/** PC1 – CPE (Dialer1, PPPoE) ═ BRAS – R3 – PC3; Site-to-Site-VPN CPE ↔ R3 über die Einwahl. */
function lab() {
  const e = new Engine({ seed: 1 });
  const cpe = router(e, 'CPE');
  const bras = router(e, 'BRAS');
  const r3 = router(e, 'R3');
  link(e, cpe.id, 'p0', bras.id, 'p0');
  link(e, bras.id, 'p1', r3.id, 'p0');
  const pc1 = e.addDevice('pc', { name: 'PC1' });
  const pc3 = e.addDevice('pc', { name: 'PC3' });
  link(e, pc1, 'p0', cpe.id, 'p1');
  link(e, pc3, 'p0', r3.id, 'p1');
  e.setHostIp(pc1, '10.1.0.10', '255.255.255.0', '10.1.0.1');
  e.setHostIp(pc3, '10.2.0.10', '255.255.255.0', '10.2.0.1');
  bras.run(
    'enable',
    'configure terminal',
    'username kunde password geheim',
    'ip local pool KUNDEN 203.0.113.100 203.0.113.110',
    'interface loopback0',
    'ip address 203.0.113.1 255.255.255.255',
    'exit',
    'bba-group pppoe GLOBAL',
    'virtual-template 1',
    'exit',
    'interface virtual-template 1',
    'ip unnumbered loopback0',
    'peer default ip address pool KUNDEN',
    'ppp authentication chap',
    'exit',
    'interface gi0/0',
    'pppoe enable group GLOBAL',
    'no shutdown',
    'exit',
    'interface gi0/1',
    'ip address 198.51.100.1 255.255.255.0',
    'no shutdown',
    'end',
  );
  cpe.run(
    'enable',
    'configure terminal',
    'interface dialer 1',
    'encapsulation ppp',
    'ip address negotiated',
    'dialer pool 1',
    'ppp chap hostname kunde',
    'ppp chap password 0 geheim',
    'exit',
    'interface gi0/0',
    'pppoe-client dial-pool-number 1',
    'no shutdown',
    'exit',
    'interface gi0/1',
    'ip address 10.1.0.1 255.255.255.0',
    'no shutdown',
    'exit',
    'ip route 0.0.0.0 0.0.0.0 dialer 1',
    'end',
  );
  r3.run(
    'enable',
    'configure terminal',
    'interface gi0/0',
    'ip address 198.51.100.2 255.255.255.0',
    'no shutdown',
    'exit',
    'interface gi0/1',
    'ip address 10.2.0.1 255.255.255.0',
    'no shutdown',
    'exit',
    'ip route 0.0.0.0 0.0.0.0 198.51.100.1',
    'end',
  );
  crypto(cpe, '198.51.100.2', '10.1.0.0', '10.2.0.0', 'dialer 1');
  crypto(r3, '203.0.113.100', '10.2.0.0', '10.1.0.0', 'gi0/0');
  return { e, cpe, bras, r3, pc1, pc3 };
}

const ping = (e: Engine, pc: string, dst: string): boolean => {
  e.ping(pc, dst, { count: 1 });
  e.runUntil(e.state.now + 6_000_000);
  const c = e.getDevice(pc)?.config;
  return c?.kind === 'host' && c.pings.at(-1)?.status === 'reply';
};

describe('QA2: IPsec über eine PPPoE-Einwahl (Crypto Map am Dialer)', () => {
  it('VPN von der Einwahl aus: verschlüsselt, BRAS sieht nur ESP', () => {
    const { e, cpe, bras, r3, pc1 } = lab();
    sec(e, 15);
    expect(cpe.s.input('show pppoe session')).toContain('UP');
    ping(e, pc1, '10.2.0.10');
    expect(ping(e, pc1, '10.2.0.10')).toBe(true);
    expect(cpe.s.input('show crypto isakmp sa')).toContain('QM_IDLE');
    expect(cpe.s.input('show crypto ipsec sa')).toMatch(/#pkts encaps: [1-9]/);
    expect(r3.s.input('show crypto ipsec sa')).toMatch(/#pkts decaps: [1-9]/);
    // Der BRAS kennt das Ziel-LAN nicht: ohne Verschlüsselung käme nichts an
    expect(bras.s.input('show ip route')).not.toContain('10.2.0.0');
  });

  it('VPN-Aufbau von der Gegenseite zur Einwahl', () => {
    const { e, cpe, pc3 } = lab();
    sec(e, 15);
    ping(e, pc3, '10.1.0.10');
    expect(ping(e, pc3, '10.1.0.10')).toBe(true);
    expect(cpe.s.input('show crypto ipsec sa')).toMatch(/#pkts decaps: [1-9]/);
  });
});
