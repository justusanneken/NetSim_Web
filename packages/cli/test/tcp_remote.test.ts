import { describe, expect, it } from 'vitest';
import { Engine, mgmtOf, type RouterConfig } from '@netsim/engine';
import { CliSession, HostShell, ShellStack } from '../src';

const sec = (e: Engine, s: number): void => {
  e.runUntil(e.state.now + s * 1_000_000);
};

/** PC (10.0.0.2) – R1 (.1 / 10.0.1.1) – R2 (10.0.1.2); Telnet/SSH von PC zu R2 durch R1. */
function lab() {
  const e = new Engine({ seed: 1 });
  const r1 = e.addDevice('router', { name: 'R1' });
  const r2 = e.addDevice('router', { name: 'R2' });
  const pc = e.addDevice('pc', { name: 'PC' });
  e.connect({ deviceId: pc, portId: 'p0' }, { deviceId: r1, portId: 'p0' }, 'straight');
  const l12 = e.connect(
    { deviceId: r2, portId: 'p0' },
    { deviceId: r1, portId: 'p1' },
    'crossover',
  );
  if (!l12.ok) throw new Error(l12.error);
  e.setHostIp(pc, '10.0.0.2', '255.255.255.0', '10.0.0.1');
  for (const id of [r1, r2]) {
    const d = e.getDevice(id);
    if (d?.config.kind === 'router') d.config.sys.setupDone = true;
  }
  const mk = (id: string) => {
    const st = new ShellStack(new CliSession(e, id));
    return (...ls: string[]): string =>
      ls.map((l) => `${st.prompt()}${st.secret() ? '' : l}\n${st.input(l)}`).join('');
  };
  mk(r1)(
    'enable',
    'configure terminal',
    'interface gi0/0',
    'ip address 10.0.0.1 255.255.255.0',
    'no shutdown',
    'exit',
    'interface gi0/1',
    'ip address 10.0.1.1 255.255.255.0',
    'no shutdown',
    'end',
  );
  mk(r2)(
    'enable',
    'configure terminal',
    'interface gi0/0',
    'ip address 10.0.1.2 255.255.255.0',
    'no shutdown',
    'exit',
    'ip route 0.0.0.0 0.0.0.0 10.0.1.1',
    'ip domain-name lab.local',
    'username admin secret pw',
    'crypto key generate rsa modulus 1024',
    'line vty 0 4',
    'login local',
    'transport input telnet ssh',
    'end',
  );
  sec(e, 1);
  const stack = new ShellStack(new HostShell(e, pc));
  const run = (...ls: string[]): string =>
    ls.map((l) => `${stack.prompt()}${stack.secret() ? '' : l}\n${stack.input(l)}`).join('');
  return { e, r1, r2, pc, stack, run, link: l12.value.id };
}

describe('Telnet/SSH-Sitzung über TCP', () => {
  it('Eingabezeilen und Ausgabe sind TCP-Segmente (Telnet im Klartext)', () => {
    const { e, run, stack } = lab();
    run('telnet 10.0.1.2', 'admin', 'pw');
    expect(stack.prompt()).toBe('R2>');
    e.log.length = 0;
    const out = run('show clock');
    expect(out).toContain('R2>show clock');
    const ops = e.log.filter((l) => l.msg.key === 'svc.request' || l.msg.key === 'svc.reply');
    expect(ops.some((l) => l.msg.params?.op === 'line')).toBe(true);
    expect(ops.some((l) => l.msg.params?.op === 'out')).toBe(true);
    const encrypted = e.log.some((l) => {
      const ip = l.frame?.payload;
      return (
        ip?.kind === 'ipv4' &&
        ip.payload.kind === 'tcp' &&
        ip.payload.app?.kind === 'svc' &&
        ip.payload.app.encrypted === true
      );
    });
    expect(encrypted).toBe(false);
  });

  it('SSH-Segmente sind im Inspektor als verschlüsselt markiert', () => {
    const { e, run, stack } = lab();
    run('ssh -l admin 10.0.1.2', 'pw');
    expect(stack.prompt()).toBe('R2>');
    e.log.length = 0;
    run('show clock');
    const seen = e.log.some((l) => {
      const ip = l.frame?.payload;
      return (
        ip?.kind === 'ipv4' &&
        ip.payload.kind === 'tcp' &&
        ip.payload.app?.kind === 'svc' &&
        ip.payload.app.op === 'line' &&
        ip.payload.app.encrypted === true
      );
    });
    expect(seen).toBe(true);
  });

  it('Pfad bricht ab: die Sitzung steht still und schließt nach dem TCP-Timeout', () => {
    const { e, r2, run, stack, link } = lab();
    run('telnet 10.0.1.2', 'admin', 'pw');
    expect(stack.prompt()).toBe('R2>');
    e.disconnect(link);
    const t0 = e.state.now;
    const out = run('show clock');
    expect(out).toContain('% Connection timed out; remote host not responding');
    expect(out).toContain('[Connection to 10.0.1.2 closed by foreign host]');
    expect((e.state.now - t0) / 1e6).toBeGreaterThan(25); // Stillstand während der Wiederholungen
    expect(stack.prompt()).toBe('C:\\>');
    const cfg = e.getDevice(r2)?.config as RouterConfig;
    expect(mgmtOf(cfg.sys).sessions).toHaveLength(0);
  });
});
