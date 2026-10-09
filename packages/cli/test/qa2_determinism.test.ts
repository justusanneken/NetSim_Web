import { describe, expect, it } from 'vitest';
import type { Engine } from '@netsim/engine';
import { sec } from './gapsLab';
import { ping, vpnLab } from './qa2Labs';

/** VPN + PAT + eBGP über die Crypto-Map-Schnittstelle + NTP + SNMP-Traps + Link-Flap. */
function scenario() {
  const L = vpnLab({ nat: true });
  const { e, r1, isp, pc1 } = L;
  r1.run(
    'configure terminal',
    'router bgp 65001',
    'neighbor 203.0.113.2 remote-as 65000',
    'network 10.1.0.0 mask 255.255.255.0',
    'exit',
    'ntp server 203.0.113.2',
    'snmp-server community public RO',
    'snmp-server host 10.1.0.10 version 2c public',
    'snmp-server enable traps',
    'end',
  );
  isp.run(
    'configure terminal',
    'router bgp 65000',
    'neighbor 203.0.113.1 remote-as 65001',
    'exit',
    'ntp master 3',
    'end',
  );
  sec(e, 40);
  ping(e, pc1, '10.2.0.10');
  ping(e, pc1, '8.8.8.8');
  isp.run('configure terminal', 'interface gi0/1', 'shutdown', 'end');
  sec(e, 5);
  isp.run('configure terminal', 'interface gi0/1', 'no shutdown', 'end');
  return L;
}

const fingerprint = (e: Engine): [string[], string] => [
  e.logSlice(0, 1_000_000).map((l) => `${l.id} ${l.t} ${l.atDeviceName} ${l.proto} ${l.msg.key}`),
  JSON.stringify(e.state),
];

describe('QA2: Determinismus über alle neuen Funktionen', () => {
  it('gleicher Seed ⇒ identisches Log und identischer Zustand', () => {
    const a = scenario();
    sec(a.e, 120);
    const b = scenario();
    sec(b.e, 120);
    const [la, sa] = fingerprint(a.e);
    const [lb, sb] = fingerprint(b.e);
    expect(lb).toEqual(la);
    expect(sb).toBe(sa);
    expect(a.r1.s.input('show ip bgp summary')).toMatch(/203\.0\.113\.2\s+4\s+65000/);
    expect(a.r1.s.input('show ntp status')).toContain('stratum 4');
  });

  it('Snapshot/Restore mitten im Lauf ⇒ derselbe Endzustand wie ohne Unterbrechung', () => {
    const { e } = scenario();
    const snap = e.snapshot();
    sec(e, 120);
    const [la, sa] = fingerprint(e);
    e.restore(snap);
    sec(e, 120);
    const [lb, sb] = fingerprint(e);
    expect(lb).toEqual(la);
    expect(sb).toBe(sa);
  });
});
