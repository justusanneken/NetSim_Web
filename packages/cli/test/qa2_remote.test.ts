import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { CliSession, HostShell, ShellStack } from '../src';

const sec = (e: Engine, s: number): void => void e.runUntil(e.state.now + s * 1_000_000);

/** PC (10.0.0.2) – R1 (10.0.0.1, vty-Passwort cisco). */
function lab() {
  const e = new Engine({ seed: 1 });
  const r1 = e.addDevice('router', { name: 'R1' });
  const pc = e.addDevice('pc', { name: 'PC' });
  e.connect({ deviceId: pc, portId: 'p0' }, { deviceId: r1, portId: 'p0' }, 'straight');
  e.setHostIp(pc, '10.0.0.2', '255.255.255.0', '10.0.0.1');
  const d = e.getDevice(r1);
  if (d?.config.kind === 'router') d.config.sys.setupDone = true;
  const c1 = new CliSession(e, r1);
  for (const l of [
    'enable',
    'configure terminal',
    'interface gi0/0',
    'ip address 10.0.0.1 255.255.255.0',
    'no shutdown',
    'exit',
    'line vty 0 4',
    'password cisco',
    'login',
    'end',
  ])
    c1.input(l);
  sec(e, 1);
  const st = new ShellStack(new HostShell(e, pc));
  const run = (...ls: string[]): string =>
    ls.map((l) => `${st.prompt()}${st.secret() ? '' : l}\n${st.input(l)}`).join('');
  return { e, r1, pc, st, run };
}

describe('QA2: Telnet-Sitzung und Step Back/Restore', () => {
  it('Restore auf einen Zeitpunkt vor dem Telnet: die Sitzung endet sauber statt zu hängen', () => {
    const { e, st, run } = lab();
    const snap = e.snapshot();
    run('telnet 10.0.0.1', 'cisco');
    expect(st.prompt()).toBe('R1>');
    e.restore(snap);
    let out = '';
    expect(() => {
      out = run('show clock') + st.poll();
      sec(e, 40);
      out += st.poll();
    }).not.toThrow();
    expect(st.prompt()).toBe('C:\\>');
    expect(out).toMatch(/closed|timed out/);
  });

  it('Restore während der Sitzung: Eingaben funktionieren weiter', () => {
    const { e, st, run } = lab();
    run('telnet 10.0.0.1', 'cisco');
    const snap = e.snapshot();
    run('show clock');
    e.restore(snap);
    const out = run('show version');
    expect(out).toContain('Cisco IOS');
    expect(st.prompt()).toBe('R1>');
  });
});
