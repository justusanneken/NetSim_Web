import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { link, router, sec } from './gapsLab';

/** CPE (Dialer1) ═ BRAS (Virtual-Template1) – Server. */
function lab(opts: { brasLater?: boolean } = {}) {
  const e = new Engine({ seed: 1 });
  const cpe = router(e, 'CPE');
  const bras = router(e, 'BRAS');
  const srv = e.addDevice('server', { name: 'WWW' });
  link(e, cpe.id, 'p0', bras.id, 'p0');
  link(e, srv, 'p0', bras.id, 'p1');
  e.setHostIp(srv, '198.51.100.10', '255.255.255.0', '198.51.100.1');
  const brasCfg = (): string =>
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
  if (!opts.brasLater) brasCfg();
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
    'ip route 0.0.0.0 0.0.0.0 dialer 1',
    'end',
  );
  return { e, cpe, bras, srv, brasCfg };
}

describe('QA2: PPPoE-Lebenszyklus', () => {
  it('BRAS wird erst später konfiguriert: der Client wählt sich danach ein', () => {
    const { e, cpe, brasCfg } = lab({ brasLater: true });
    sec(e, 30);
    expect(cpe.s.input('show pppoe session')).not.toContain('UP');
    brasCfg();
    sec(e, 60);
    expect(cpe.s.input('show pppoe session')).toContain('UP');
  });

  it('Neustart des BRAS: die Sitzung wird neu aufgebaut, Ping geht wieder', () => {
    const { e, cpe, bras } = lab();
    sec(e, 15);
    expect(cpe.run('ping 198.51.100.10')).toContain('Success rate is 100 percent');
    e.setPower(bras.id, false);
    sec(e, 5);
    e.setPower(bras.id, true);
    sec(e, 120);
    expect(cpe.s.input('show pppoe session')).toContain('UP');
    expect(cpe.run('ping 198.51.100.10')).toContain('Success rate is 100 percent');
  });

  it('BRAS: die geliehene Adresse (ip unnumbered) erzeugt keine zweite Connected-Route', () => {
    const { e, bras } = lab();
    sec(e, 15);
    const rt = bras.s.input('show ip route');
    expect(rt).toMatch(/C\s+203\.0\.113\.100\/32 is directly connected, Virtual-Access1/);
    expect(rt).toMatch(/C\s+203\.0\.113\.1\/32 is directly connected, Loopback0/);
    expect(rt).not.toMatch(/203\.0\.113\.1\/32 is directly connected, Virtual-Access1/);
  });

  it('shutdown/no shutdown am Dialer', () => {
    const { e, cpe } = lab();
    sec(e, 15);
    cpe.run('configure terminal', 'interface dialer 1', 'shutdown', 'end');
    sec(e, 5);
    expect(cpe.s.input('show ip interface brief')).toMatch(/Dialer1\s+unassigned/);
    cpe.run('configure terminal', 'interface dialer 1', 'no shutdown', 'end');
    sec(e, 30);
    expect(cpe.run('ping 198.51.100.10')).toContain('Success rate is 100 percent');
  });
});
