import { describe, expect, it } from 'vitest';
import type { Engine } from '@netsim/engine';
import { sec } from './gapsLab';
import { ping, vpnLab } from './qa2Labs';

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
