import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { router, roundTrip, sec } from './gapsLab';
import { ping, vpnLab } from './qa2Labs';

const ERR = /% (Invalid|Incomplete|Ambiguous|Unknown)/;

describe('QA2: IPsec-CLI wie IOS', () => {
  it('encryption aes 256, group 14 und esp-aes 256 werden angenommen und gespeichert', () => {
    const e = new Engine({ seed: 1 });
    const r = router(e, 'R1');
    const out = r.run(
      'enable',
      'configure terminal',
      'crypto isakmp policy 10',
      'encryption aes 256',
      'hash sha',
      'authentication pre-share',
      'group 14',
      'exit',
      'crypto ipsec transform-set TS esp-aes 256 esp-sha-hmac',
      'end',
    );
    expect(out).not.toMatch(ERR);
    const rc = roundTrip(e, r);
    expect(rc).toContain(
      'crypto isakmp policy 10\n encr aes 256\n authentication pre-share\n group 14',
    );
    expect(rc).toContain('crypto ipsec transform-set TS esp-aes 256 esp-sha-hmac');
    const pol = r.s.input('show crypto isakmp policy');
    expect(pol).toContain('AES - Advanced Encryption Standard (256 bit keys).');
    expect(pol).toContain('#14 (2048 bit)');
  });

  it('unbekannte Transforms werden abgewiesen', () => {
    const e = new Engine({ seed: 1 });
    const r = router(e, 'R1');
    expect(
      r.run('enable', 'configure terminal', 'crypto ipsec transform-set TS esp-foo esp-sha-hmac'),
    ).toMatch(/% Invalid/);
  });

  it('no-Formen ohne Wert setzen die Policy-Parameter auf den Standard zurück', () => {
    const e = new Engine({ seed: 1 });
    const r = router(e, 'R1');
    r.run(
      'enable',
      'configure terminal',
      'crypto isakmp policy 5',
      'encryption 3des',
      'hash md5',
      'authentication pre-share',
      'group 5',
      'lifetime 600',
    );
    const out = r.run(
      'no encryption',
      'no hash',
      'no authentication',
      'no group',
      'no lifetime',
      'end',
    );
    expect(out).not.toMatch(ERR);
    expect(r.s.input('show running-config')).toMatch(/crypto isakmp policy 5\n!/);
    // ohne Wert und ohne no: unvollständig
    expect(r.run('configure terminal', 'crypto isakmp policy 5', 'hash')).toContain(
      '% Incomplete command.',
    );
  });

  it('unterschiedliche AES-Schlüssellängen passen nicht zusammen (keine SA)', () => {
    const { e, r1, pc1 } = vpnLab();
    r1.run('configure terminal', 'crypto isakmp policy 10', 'encryption aes 256', 'end');
    sec(e, 2);
    ping(e, pc1, '10.2.0.10');
    expect(ping(e, pc1, '10.2.0.10')).toBe(false);
    expect(r1.s.input('show crypto ipsec sa')).toContain('no matching ISAKMP policy');
  });
});
