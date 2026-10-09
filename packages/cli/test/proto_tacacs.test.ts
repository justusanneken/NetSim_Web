import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { router, roundTrip } from './gapsLab';

describe('TACACS+ (CLI)', () => {
  it('tacacs-server host, tacacs server NAME, AAA-Liste und show tacacs', () => {
    const e = new Engine({ seed: 1 });
    const r = router(e, 'R1');
    r.run(
      'enable',
      'configure terminal',
      'aaa new-model',
      'tacacs-server host 10.0.1.10 key tackey',
      'tacacs server TAC2',
      'address ipv4 10.0.1.11',
      'key key2',
      'exit',
      'aaa authentication login default group tacacs+ local',
      'end',
    );
    const rc = r.s.input('show running-config');
    expect(rc).toContain('aaa authentication login default group tacacs+ local');
    expect(rc).toContain('tacacs-server host 10.0.1.10 key tackey');
    expect(rc).toContain('tacacs server TAC2\n address ipv4 10.0.1.11\n key key2');
    const sh = r.s.input('show tacacs');
    expect(sh).toContain('Server address: 10.0.1.10');
    expect(sh).toContain('Server name: TAC2');
    expect(sh).toContain('Server port: 49');
    expect(r.s.input('show aaa')).toContain('group tacacs+ local');
  });

  it('running-config überlebt Speichern/Reload (Replay); no-Formen', () => {
    const e = new Engine({ seed: 1 });
    const r = router(e, 'R1');
    r.run(
      'enable',
      'configure terminal',
      'aaa new-model',
      'tacacs-server host 10.0.1.10 key tackey',
      'tacacs server TAC2',
      'address ipv4 10.0.1.11',
      'key key2',
      'exit',
      'aaa authentication login default group radius group tacacs+ local',
      'end',
    );
    const rc = roundTrip(e, r);
    expect(rc).toContain('group radius group tacacs+ local');
    r.run('configure terminal', 'no tacacs-server host 10.0.1.10', 'no tacacs server TAC2', 'end');
    const after = r.s.input('show running-config');
    expect(after).not.toContain('tacacs-server');
    expect(after).not.toContain('tacacs server');
    expect(r.s.input('show tacacs')).toContain('No TACACS+ servers configured');
  });
});
