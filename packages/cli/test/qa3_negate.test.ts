import { describe, expect, it } from 'vitest';
import {
  cloneDevices,
  decodeNsim,
  encodeNsim,
  Engine,
  exportNsim,
  importNsim,
} from '@netsim/engine';
import { CliSession } from '../src';
import { cli, replayEqual, type Cli } from './ccnaLab';
import { wanRouter } from './wanLab';
import { apply, fullLab, R_CFG, R_NO, strip, SW_CFG, SW_NO } from './qa3Lab';

describe('QA3: neue Befehle – Render/Replay und vollständige no-Formen', () => {
  it('Switch: alle ccna-Befehle, replay, no-Formen ergeben die Ausgangs-Konfiguration', () => {
    const e = new Engine({ seed: 1 });
    const s1 = cli(e, 'SW1');
    s1.run('enable');
    const pristine = strip(s1.s.input('show running-config'));
    apply(s1, SW_CFG);
    replayEqual(e, s1);
    apply(s1, SW_NO);
    expect(strip(s1.s.input('show running-config'))).toBe(pristine);
  });

  it('Router: alle ccna/wan-Befehle, replay, no-Formen ergeben die Ausgangs-Konfiguration', () => {
    const e = new Engine({ seed: 1 });
    const r = wanRouter(e, 'R1');
    const c = { ...r, out: () => '', cfg: () => '' } as unknown as Cli;
    c.run('enable');
    const pristine = strip(c.s.input('show running-config'));
    apply(c, R_CFG);
    replayEqual(e, c);
    apply(c, R_NO);
    expect(strip(c.s.input('show running-config'))).toBe(pristine);
  });
});

function runCfg(e: Engine, id: string): string {
  const s = new CliSession(e, id);
  s.input('enable');
  return strip(s.input('show running-config'));
}

describe('QA3: optionale no-Argumente bleiben in der positiven Form Pflicht', () => {
  it('ntp authentication-key / ip ssh version / ppp authentication / ppp pap sent-username', () => {
    const e = new Engine({ seed: 1 });
    const r = wanRouter(e, 'R1');
    r.run('enable', 'configure terminal');
    for (const l of ['ntp authentication-key 5', 'ntp authentication-key 5 md5', 'ip ssh version'])
      expect(r.s.input(l), l).toContain('% Incomplete command.');
    r.run('interface serial0/0/0');
    for (const l of ['ppp authentication', 'ppp pap sent-username R1 cisco'])
      expect(r.s.input(l), l).toContain('% Incomplete command.');
    r.run('end');
    const rc = r.s.input('show running-config');
    for (const x of [
      'ntp authentication-key',
      'ip ssh version',
      'ppp authentication',
      'sent-username',
    ])
      expect(rc).not.toContain(x);
  });
});

describe('QA3: .nsim-Round-Trip und Kopieren/Einfügen der neuen Konfiguration', () => {
  it('.nsim: running-config jedes Geräts bleibt identisch', () => {
    const { e, s1, r } = fullLab();
    const before = [runCfg(e, s1.id), runCfg(e, r.id)];
    const doc = decodeNsim(encodeNsim(exportNsim(e)));
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    const e2 = new Engine({ seed: 1 });
    expect(importNsim(e2, doc.value).ok).toBe(true);
    expect([runCfg(e2, s1.id), runCfg(e2, r.id)]).toEqual(before);
  });

  it('Kopieren/Einfügen: Kopie hat dieselbe Konfiguration (bis auf Hostname/Adressen)', () => {
    const { e, s1, r } = fullLab();
    const res = cloneDevices(e, [s1.id, r.id], { x: 50, y: 50 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [cs, cr] = res.value.ids as [string, string];
    const norm = (x: string): string =>
      x
        .replace(/^hostname .*$/m, 'hostname X')
        .replace(/ip address \S+ \S+/g, 'ip address A M')
        .replace(/ipv6 address \S+/g, 'ipv6 address A');
    expect(norm(runCfg(e, cs))).toBe(norm(runCfg(e, s1.id)));
    expect(norm(runCfg(e, cr))).toBe(norm(runCfg(e, r.id)));
  });
});
