import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { link, router, roundTrip, sec } from './gapsLab';

/** CPE (Dialer1) ═ BRAS (Virtual-Template1), alles per CLI. */
function lab(chapPass = 'geheim') {
  const e = new Engine({ seed: 1 });
  const cpe = router(e, 'CPE');
  const bras = router(e, 'BRAS');
  const srv = e.addDevice('server', { name: 'WWW' });
  link(e, cpe.id, 'p0', bras.id, 'p0');
  link(e, srv, 'p0', bras.id, 'p1');
  e.setHostIp(srv, '198.51.100.10', '255.255.255.0', '198.51.100.1');
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
    'exit',
    'ip route 10.1.0.0 255.255.255.0 203.0.113.100',
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
    `ppp chap password 0 ${chapPass}`,
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
  return { e, cpe, bras, srv };
}

describe('PPPoE (CLI)', () => {
  it('Einwahl, show pppoe session, show ip interface brief, Routen und Ping', () => {
    const { e, cpe, bras } = lab();
    sec(e, 15);
    const ses = cpe.s.input('show pppoe session');
    expect(ses).toContain('1 client session');
    expect(ses).toContain('UP');
    expect(ses).toContain('203.0.113.100');
    expect(bras.s.input('show pppoe session')).toContain('1 session in LOCALLY_TERMINATED');
    const br = cpe.s.input('show ip interface brief');
    expect(br).toMatch(/Dialer1\s+203\.0\.113\.100/);
    expect(bras.s.input('show ip interface brief')).toMatch(/Virtual-Access1\s+203\.0\.113\.1/);
    const route = cpe.s.input('show ip route');
    expect(route).toContain('Dialer1');
    expect(cpe.run('ping 198.51.100.10')).toContain('Success rate is 100 percent');
  });

  it('running-config beider Seiten überlebt Speichern/Reload (Replay)', () => {
    const { e, cpe, bras } = lab();
    const c = roundTrip(e, cpe);
    expect(c).toContain('interface Dialer1');
    expect(c).toContain(' ip address negotiated');
    expect(c).toContain(' encapsulation ppp');
    expect(c).toContain(' dialer pool 1');
    expect(c).toContain(' ppp chap hostname kunde');
    expect(c).toContain(' ppp chap password 0 geheim');
    expect(c).toContain(' pppoe-client dial-pool-number 1');
    const b = roundTrip(e, bras);
    expect(b).toContain('bba-group pppoe GLOBAL\n virtual-template 1');
    expect(b).toContain('interface Virtual-Template1');
    expect(b).toContain(' ip unnumbered Loopback0');
    expect(b).toContain(' peer default ip address pool KUNDEN');
    expect(b).toContain(' ppp authentication chap');
    expect(b).toContain(' pppoe enable group GLOBAL');
    expect(b).toContain('ip local pool KUNDEN 203.0.113.100 203.0.113.110');
    sec(e, 20);
    expect(cpe.s.input('show pppoe session')).toContain('UP');
  });

  it('falsches CHAP-Passwort: keine Sitzung', () => {
    const { e, cpe } = lab('falsch');
    sec(e, 15);
    expect(cpe.s.input('show pppoe session')).not.toContain('UP');
    expect(cpe.s.input('show ip interface brief')).toMatch(/Dialer1\s+unassigned/);
  });

  it('clear pppoe all beendet die Sitzung, der Client wählt sich neu ein; shutdown am Dialer', () => {
    const { e, cpe } = lab();
    sec(e, 15);
    cpe.run('clear pppoe all');
    sec(e, 20);
    expect(cpe.s.input('show pppoe session')).toContain('UP');
    cpe.run('configure terminal', 'interface dialer 1', 'shutdown', 'end');
    sec(e, 3);
    expect(cpe.s.input('show pppoe session')).not.toContain('UP');
    expect(cpe.s.input('show ip interface brief')).toMatch(
      /Dialer1\s+unassigned\s+YES\s+unset\s+administratively down/,
    );
  });
});
