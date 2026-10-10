import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { cli, replayEqual, secs, wire } from './ccnaLab';

function pair() {
  const e = new Engine({ seed: 1 });
  const r1 = cli(e, 'R1', 'router');
  const r2 = cli(e, 'R2', 'router');
  wire(e, r1, 'p0', r2, 'p0');
  r1.cfg('interface gi0/0', 'ip address 10.0.12.1 255.255.255.0', 'no shutdown');
  r2.cfg('interface gi0/0', 'ip address 10.0.12.2 255.255.255.0', 'no shutdown');
  return { e, r1, r2 };
}

describe('NTP authentication', () => {
  it('syncs only with matching trusted key; mismatching key is rejected', () => {
    const { e, r1, r2 } = pair();
    r1.cfg('ntp master 3', 'ntp authentication-key 1 md5 SECRET');
    r2.cfg(
      'ntp authenticate',
      'ntp authentication-key 1 md5 WRONG',
      'ntp trusted-key 1',
      'ntp server 10.0.12.1 key 1',
    );
    secs(e, 200);
    expect(r2.out('enable', 'show ntp status')).toContain('unsynchronized');
    r2.cfg('ntp authentication-key 1 md5 SECRET');
    secs(e, 200);
    expect(r2.out('show ntp status')).toContain('Clock is synchronized, stratum 4');
  });

  it('untrusted key blocks sync; render shows type-7 key and replays', () => {
    const { e, r1, r2 } = pair();
    r1.cfg('ntp master 3', 'ntp authentication-key 5 md5 SECRET');
    r2.cfg('ntp authenticate', 'ntp authentication-key 5 md5 SECRET', 'ntp server 10.0.12.1 key 5');
    secs(e, 200);
    expect(r2.out('enable', 'show ntp status')).toContain('unsynchronized');
    r2.cfg('ntp trusted-key 5');
    secs(e, 200);
    expect(r2.out('show ntp status')).toContain('synchronized, stratum 4');
    const rc = replayEqual(e, r2);
    expect(rc).toMatch(
      /ntp authenticate\nntp authentication-key 5 md5 [0-9A-F]+ 7\nntp trusted-key 5\nntp server 10\.0\.12\.1 key 5/,
    );
    r2.cfg('no ntp trusted-key 5', 'no ntp authenticate', 'no ntp authentication-key 5');
    const after = r2.out('show running-config');
    expect(after).not.toContain('ntp trusted-key');
    expect(after).not.toContain('ntp authenticate');
  });
});

describe('Logging levels', () => {
  it('logging buffered size/level, console, monitor render, show logging and replay', () => {
    const { e, r1 } = pair();
    r1.cfg(
      'logging buffered 8192 warnings',
      'logging console errors',
      'logging monitor informational',
    );
    const rc = replayEqual(e, r1);
    expect(rc).toContain('logging buffered 8192 warnings');
    expect(rc).toContain('logging console errors');
    expect(rc).toContain('logging monitor informational');
    const sh = r1.out('enable', 'show logging');
    expect(sh).toContain('Console logging: level errors');
    expect(sh).toContain('Monitor logging: level informational');
    expect(sh).toContain('Buffer logging:  level warnings');
    expect(sh).toContain('Log Buffer (8192 bytes):');
    r1.cfg('no logging buffered');
    expect(r1.out('show logging')).toContain('Buffer logging: disabled');
    expect(r1.out('show running-config')).toContain('no logging buffered');
  });

  it('only messages up to the buffer level are stored', () => {
    const { e, r1 } = pair();
    r1.cfg('logging buffered errors');
    const count = (t: string): number => (t.match(/%SYS-5-CONFIG_I/g) ?? []).length;
    const before = count(r1.out('show logging'));
    r1.cfg('interface gi0/0', 'description x');
    r1.cfg('interface gi0/0', 'description y');
    secs(e, 5);
    expect(count(r1.out('show logging'))).toBe(before);
    r1.cfg('logging buffered informational');
    r1.cfg('interface gi0/0', 'description z');
    expect(count(r1.out('show logging'))).toBe(before + 2);
  });
});

describe('SSH and SNMPv3', () => {
  it('ssh defaults to version 1.99 until ip ssh version 2; timers render and replay', () => {
    const { e, r1 } = pair();
    r1.cfg('ip domain-name lab.local');
    expect(
      r1.out('enable', 'configure terminal', 'crypto key generate rsa modulus 2048'),
    ).toContain('% Generating 2048 bit RSA keys, keys will be non-exportable...');
    r1.run('end');
    expect(r1.out('show ip ssh')).toContain('SSH Enabled - version 1.99');
    r1.cfg('ip ssh version 2', 'ip ssh time-out 60', 'ip ssh authentication-retries 2');
    const sh = r1.out('show ip ssh');
    expect(sh).toContain('SSH Enabled - version 2.0');
    expect(sh).toContain('Authentication timeout: 60 secs; Authentication retries: 2');
    const rc = replayEqual(e, r1);
    expect(rc).toContain('ip ssh version 2\nip ssh time-out 60\nip ssh authentication-retries 2');
  });

  it('snmp-server group/user v3 with show snmp group/user, render and replay', () => {
    const { e, r1 } = pair();
    const err = r1.out(
      'enable',
      'configure terminal',
      'snmp-server user bob ADMINS v3 auth sha secret123',
    );
    expect(err).toContain('does not exist');
    r1.cfg(
      'snmp-server group ADMINS v3 priv',
      'snmp-server user bob ADMINS v3 auth sha authpass123 priv aes 128 privpass123',
    );
    expect(r1.out('enable', 'show snmp group')).toContain('groupname: ADMINS');
    const u = r1.out('show snmp user');
    expect(u).toContain('User name: bob');
    expect(u).toContain('Authentication Protocol: SHA');
    expect(u).toContain('Privacy Protocol: AES128');
    expect(u).toContain('Group-name: ADMINS');
    const rc = replayEqual(e, r1);
    expect(rc).toContain('snmp-server group ADMINS v3 priv');
    expect(rc).toContain(
      'snmp-server user bob ADMINS v3 auth sha authpass123 priv aes 128 privpass123',
    );
    r1.cfg('no snmp-server user bob ADMINS v3', 'no snmp-server group ADMINS v3 priv');
    expect(r1.out('show snmp user')).toBe('');
  });
});
