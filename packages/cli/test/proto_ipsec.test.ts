import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { link, router, roundTrip, sec } from './gapsLab';

function vpn(key3 = 'geheim') {
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
  const ifs = (r: typeof r1, rows: [string, string, string][]): string[] =>
    rows.flatMap(([i, ip, mask]) => [
      `interface ${i}`,
      `ip address ${ip} ${mask}`,
      'no shutdown',
      'exit',
    ]);
  isp.run(
    'enable',
    'configure terminal',
    ...ifs(isp, [
      ['gi0/0', '203.0.113.2', '255.255.255.252'],
      ['gi0/1', '198.51.100.2', '255.255.255.252'],
    ]),
    'end',
  );
  const site = (
    r: typeof r1,
    wan: string,
    lan: [string, string],
    gw: string,
    peer: string,
    key: string,
    local: string,
    remote: string,
  ): void => {
    r.run(
      'enable',
      'configure terminal',
      ...ifs(r, [
        ['gi0/0', wan, '255.255.255.252'],
        ['gi0/1', lan[0], lan[1]],
      ]),
      `ip route 0.0.0.0 0.0.0.0 ${gw}`,
      'crypto isakmp policy 10',
      'encryption aes',
      'hash sha',
      'authentication pre-share',
      'group 2',
      'exit',
      `crypto isakmp key ${key} address ${peer}`,
      'crypto ipsec transform-set TS esp-aes esp-sha-hmac',
      'mode tunnel',
      'exit',
      `access-list 101 permit ip ${local} 0.0.0.255 ${remote} 0.0.0.255`,
      'crypto map VPN 10 ipsec-isakmp',
      `set peer ${peer}`,
      'set transform-set TS',
      'match address 101',
      'exit',
      'interface gi0/0',
      'crypto map VPN',
      'end',
    );
  };
  site(
    r1,
    '203.0.113.1',
    ['10.1.0.1', '255.255.255.0'],
    '203.0.113.2',
    '198.51.100.1',
    'geheim',
    '10.1.0.0',
    '10.2.0.0',
  );
  site(
    r3,
    '198.51.100.1',
    ['10.2.0.1', '255.255.255.0'],
    '198.51.100.2',
    '203.0.113.1',
    key3,
    '10.2.0.0',
    '10.1.0.0',
  );
  return { e, r1, isp, r3, pc1, pc3 };
}

const ping = (e: Engine, pc: string, dst: string): boolean => {
  e.ping(pc, dst, { count: 1 });
  e.runUntil(e.state.now + 6_000_000);
  const c = e.getDevice(pc)?.config;
  return c?.kind === 'host' && c.pings.at(-1)?.status === 'reply';
};

describe('IPsec (CLI)', () => {
  it('show crypto isakmp sa / ipsec sa / map / policy nach dem Aufbau', () => {
    const { e, r1, r3, pc1 } = vpn();
    sec(e, 2);
    ping(e, pc1, '10.2.0.10');
    expect(ping(e, pc1, '10.2.0.10')).toBe(true);
    expect(ping(e, pc1, '10.2.0.10')).toBe(true);
    const sa = r1.s.input('show crypto isakmp sa');
    expect(sa).toContain('198.51.100.1');
    expect(sa).toContain('QM_IDLE');
    expect(sa).toContain('ACTIVE');
    const ipsec = r1.s.input('show crypto ipsec sa');
    expect(ipsec).toContain('Crypto map tag: VPN, local addr 203.0.113.1');
    expect(ipsec).toContain('local  ident (addr/mask/prot/port): (10.1.0.0/255.255.255.0/0/0)');
    expect(ipsec).toContain('current_peer 198.51.100.1');
    expect(ipsec).toMatch(/#pkts encaps: [1-9]/);
    expect(ipsec).toMatch(/#pkts decaps: [1-9]/);
    expect(ipsec).toContain('transform: esp-aes esp-sha-hmac');
    expect(r3.s.input('show crypto isakmp sa')).toContain('QM_IDLE');
    expect(r1.s.input('show crypto map')).toContain('Peer = 198.51.100.1');
    expect(r1.s.input('show crypto map')).toContain('GigabitEthernet0/0');
    expect(r1.s.input('show crypto isakmp policy')).toContain('Pre-Shared Key');
    expect(r1.s.input('show crypto ipsec transform-set')).toContain('esp-aes esp-sha-hmac');
  });

  it('falscher Schlüssel: keine SA, clear crypto sa löscht', () => {
    const { e, r1, pc1 } = vpn('falsch');
    sec(e, 2);
    ping(e, pc1, '10.2.0.10');
    expect(ping(e, pc1, '10.2.0.10')).toBe(false);
    expect(r1.s.input('show crypto isakmp sa')).toContain('MM_NO_STATE');
    expect(r1.s.input('show crypto ipsec sa')).toContain('authentication failed');
    r1.run('clear crypto sa');
    expect(r1.s.input('show crypto ipsec sa')).toContain('No IPsec security associations');
  });

  it('running-config überlebt Speichern/Reload (Replay)', () => {
    const { e, r1 } = vpn();
    const rc = roundTrip(e, r1);
    expect(rc).toContain('crypto isakmp policy 10\n encr aes\n authentication pre-share\n group 2');
    expect(rc).toContain('crypto isakmp key geheim address 198.51.100.1');
    expect(rc).toContain('crypto ipsec transform-set TS esp-aes esp-sha-hmac');
    expect(rc).toContain(
      'crypto map VPN 10 ipsec-isakmp\n set peer 198.51.100.1\n set transform-set TS\n match address 101',
    );
    expect(rc).toContain(' crypto map VPN');
  });
});
