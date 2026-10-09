import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { CliSession } from '../src';
import { link, router, sec, type R } from './gapsLab';

const site = (
  r: R,
  wan: string,
  lan: string,
  gw: [string, string],
  peer: string,
  l: string,
  rm: string,
) =>
  r.run(
    'enable',
    'configure terminal',
    'interface gi0/0',
    `ip address ${wan} 255.255.255.0`,
    'no shutdown',
    'exit',
    'interface gi0/1',
    `ip address ${lan} 255.255.255.0`,
    'no shutdown',
    'exit',
    `ip route 0.0.0.0 0.0.0.0 ${gw[1]}`,
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

/** PC1 – R1 – ASA (inside/outside, ohne NAT) – R3 – PC3; VPN R1 ↔ R3 durch die Firewall. */
function lab() {
  const e = new Engine({ seed: 1 });
  const r1 = router(e, 'R1');
  const r3 = router(e, 'R3');
  const fw = e.addDevice('firewall', { name: 'ASA' });
  link(e, r1.id, 'p0', fw, 'p0');
  link(e, fw, 'p1', r3.id, 'p0');
  const pc1 = e.addDevice('pc', { name: 'PC1' });
  const pc3 = e.addDevice('pc', { name: 'PC3' });
  link(e, pc1, 'p0', r1.id, 'p1');
  link(e, pc3, 'p0', r3.id, 'p1');
  e.setHostIp(pc1, '10.1.0.10', '255.255.255.0', '10.1.0.1');
  e.setHostIp(pc3, '10.2.0.10', '255.255.255.0', '10.2.0.1');
  const d = e.getDevice(fw);
  if (d?.config.kind === 'router') d.config.sys.setupDone = true;
  const s = new CliSession(e, fw);
  const asa = (...ls: string[]): string => ls.map((l) => s.input(l)).join('');
  asa(
    'enable',
    'configure terminal',
    'interface gi0/0',
    'nameif inside',
    'security-level 100',
    'ip address 172.16.0.1 255.255.255.0',
    'no shutdown',
    'exit',
    'interface gi0/1',
    'nameif outside',
    'security-level 0',
    'ip address 203.0.113.1 255.255.255.0',
    'no shutdown',
    'end',
  );
  site(
    r1,
    '172.16.0.2',
    '10.1.0.1',
    ['0.0.0.0', '172.16.0.1'],
    '203.0.113.10',
    '10.1.0.0',
    '10.2.0.0',
  );
  site(
    r3,
    '203.0.113.10',
    '10.2.0.1',
    ['0.0.0.0', '203.0.113.1'],
    '172.16.0.2',
    '10.2.0.0',
    '10.1.0.0',
  );
  return { e, r1, r3, asa, pc1, pc3 };
}

const ping = (e: Engine, pc: string, dst: string): boolean => {
  e.ping(pc, dst, { count: 1 });
  e.runUntil(e.state.now + 6_000_000);
  const c = e.getDevice(pc)?.config;
  return c?.kind === 'host' && c.pings.at(-1)?.status === 'reply';
};
const up = (e: Engine, pc: string, dst: string): boolean => {
  ping(e, pc, dst);
  return ping(e, pc, dst);
};

describe('QA2: IPsec durch eine Firewall', () => {
  it('Aufbau von innen: IKE und ESP-Rückverkehr sind zustandsbehaftet erlaubt', () => {
    const { e, asa, pc1, pc3 } = lab();
    sec(e, 2);
    expect(up(e, pc1, '10.2.0.10')).toBe(true);
    // danach auch in Gegenrichtung über die bestehende SA
    expect(up(e, pc3, '10.1.0.10')).toBe(true);
    expect(asa('show conn')).toMatch(/UDP outside 203\.0\.113\.10:500 inside 172\.16\.0\.2:500/);
  });

  it('Aufbau von außen braucht eine ACL für isakmp und esp', () => {
    const { e, asa, pc3 } = lab();
    sec(e, 2);
    expect(up(e, pc3, '10.1.0.10')).toBe(false);
    asa(
      'configure terminal',
      'access-list OUT extended permit udp host 203.0.113.10 host 172.16.0.2 eq isakmp',
      'access-list OUT extended permit esp host 203.0.113.10 host 172.16.0.2',
      'access-group OUT in interface outside',
      'end',
    );
    sec(e, 10);
    expect(up(e, pc3, '10.1.0.10')).toBe(true);
    expect(asa('show running-config')).toContain(
      'access-list OUT extended permit esp host 203.0.113.10 host 172.16.0.2',
    );
  });
});
