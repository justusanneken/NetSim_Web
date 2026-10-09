import { describe, expect, it } from 'vitest';
import { diamond, sec } from './gapsLab';

function lab() {
  const L = diamond();
  L.r1.run(
    'configure terminal',
    'router bgp 65001',
    'neighbor 10.0.12.2 remote-as 65002',
    'exit',
    'ntp server 10.0.12.2',
    'snmp-server community public RO',
    'snmp-server host 10.1.0.10 version 2c public',
    'snmp-server host 10.1.0.11 public',
    'end',
  );
  L.r2.run(
    'configure terminal',
    'router bgp 65002',
    'neighbor 10.0.12.1 remote-as 65001',
    'exit',
    'ntp master 3',
    'end',
  );
  sec(L.e, 150);
  return L;
}

describe('QA2: IOS-Treue der Ausgaben neuer Funktionen', () => {
  it('show ip bgp summary zählt gesendete/empfangene BGP-Nachrichten', () => {
    const { r1 } = lab();
    const row = r1.s
      .input('show ip bgp summary')
      .split('\n')
      .find((l) => l.startsWith('10.0.12.2'));
    const cols = (row ?? '').trim().split(/\s+/);
    // Neighbor V AS MsgRcvd MsgSent …: OPEN + KEEPALIVEs (mindestens 3 je Richtung nach 150 s)
    expect(Number(cols[3])).toBeGreaterThanOrEqual(3);
    expect(Number(cols[4])).toBeGreaterThanOrEqual(3);
  });

  it('show ntp associations: Legende wie IOS', () => {
    const { r1 } = lab();
    expect(r1.s.input('show ntp associations')).toContain(
      ' * sys.peer, # selected, + candidate, - outlyer, x falseticker, ~ configured',
    );
  });

  it('show snmp host listet die Trap-Empfänger', () => {
    const { r1 } = lab();
    const out = r1.s.input('show snmp host');
    expect(out).toContain('Notification host: 10.1.0.10\tudp-port: 162\ttype: trap');
    expect(out).toContain('user: public\tsecurity model: v2c');
    expect(out).toContain('Notification host: 10.1.0.11\tudp-port: 162\ttype: trap');
    expect(out).toContain('user: public\tsecurity model: v1');
  });
});
