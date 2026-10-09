import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { router, roundTrip } from './gapsLab';

describe('SNMP-Traps (CLI)', () => {
  it('snmp-server host / enable traps: running-config, show snmp, Replay, no-Formen', () => {
    const e = new Engine({ seed: 1 });
    const r = router(e, 'R1');
    r.run(
      'enable',
      'configure terminal',
      'snmp-server community public ro',
      'snmp-server host 10.0.1.10 version 2c trapcomm',
      'snmp-server enable traps snmp linkdown linkup coldstart',
      'end',
    );
    const rc = r.s.input('show running-config');
    expect(rc).toContain('snmp-server host 10.0.1.10 version 2c trapcomm');
    expect(rc).toContain('snmp-server enable traps snmp linkdown linkup coldstart');
    const sh = r.s.input('show snmp');
    expect(sh).toContain('Trap host: 10.0.1.10');
    expect(sh).toContain('Enabled traps: linkdown linkup coldstart');
    roundTrip(e, r);
    r.run('configure terminal', 'no snmp-server enable traps linkup', 'end');
    expect(r.s.input('show running-config')).toContain(
      'snmp-server enable traps snmp linkdown coldstart',
    );
    r.run('configure terminal', 'no snmp-server host 10.0.1.10', 'end');
    expect(r.s.input('show running-config')).not.toContain('snmp-server host');
  });

  it('snmp-server enable traps ohne Argumente schaltet alle Typen frei; Version 1 ist Default', () => {
    const e = new Engine({ seed: 1 });
    const r = router(e, 'R1');
    r.run(
      'enable',
      'configure terminal',
      'snmp-server host 10.0.1.10 pub',
      'snmp-server enable traps',
      'end',
    );
    const rc = r.s.input('show running-config');
    expect(rc).toContain('snmp-server host 10.0.1.10 version 1 pub');
    expect(rc).toContain('snmp-server enable traps snmp linkdown linkup coldstart');
  });
});
