import { describe, expect, it } from 'vitest';
import { Engine, mgmtOf, type RouterConfig } from '@netsim/engine';
import { CliSession, HostShell, ShellStack } from '../src';

const sec = (e: Engine, s: number): void => {
  e.runUntil(e.state.now + s * 1_000_000);
};

/** PC (10.0.0.2) – R1 (.1 / 10.0.1.1) – R2 (10.0.1.2). */
function lab() {
  const e = new Engine({ seed: 1 });
  const r1 = e.addDevice('router', { name: 'R1' });
  const r2 = e.addDevice('router', { name: 'R2' });
  const pc = e.addDevice('pc', { name: 'PC' });
  e.connect({ deviceId: pc, portId: 'p0' }, { deviceId: r1, portId: 'p0' }, 'straight');
  e.connect({ deviceId: r2, portId: 'p0' }, { deviceId: r1, portId: 'p1' }, 'crossover');
  e.setHostIp(pc, '10.0.0.2', '255.255.255.0', '10.0.0.1');
  for (const id of [r1, r2]) {
    const d = e.getDevice(id);
    if (d?.config.kind === 'router') d.config.sys.setupDone = true;
  }
  const mk = (id: string) => {
    const st = new ShellStack(new CliSession(e, id));
    const run = (...ls: string[]): string =>
      ls.map((l) => `${st.prompt()}${st.secret() ? '' : l}\n${st.input(l)}`).join('');
    return { st, run };
  };
  const c1 = mk(r1);
  const c2 = mk(r2);
  c1.run(
    'enable',
    'configure terminal',
    'interface gi0/0',
    'ip address 10.0.0.1 255.255.255.0',
    'no shutdown',
    'exit',
    'interface gi0/1',
    'ip address 10.0.1.1 255.255.255.0',
    'no shutdown',
    'exit',
    'line vty 0 4',
    'password cisco',
    'login',
    'end',
  );
  c2.run(
    'enable',
    'configure terminal',
    'interface gi0/0',
    'ip address 10.0.1.2 255.255.255.0',
    'no shutdown',
    'exit',
    'ip route 0.0.0.0 0.0.0.0 10.0.1.1',
    'enable secret en',
    'line vty 0 4',
    'password two',
    'login',
    'end',
  );
  sec(e, 1);
  const pcStack = new ShellStack(new HostShell(e, pc));
  const pcRun = (...ls: string[]): string =>
    ls.map((l) => `${pcStack.prompt()}${pcStack.secret() ? '' : l}\n${pcStack.input(l)}`).join('');
  return { e, r1, r2, pc, c1, c2, pcStack, pcRun };
}

const rcfg = (e: Engine, id: string): RouterConfig => e.getDevice(id)?.config as RouterConfig;

describe('QA remote sessions', () => {
  it('enable on vty without enable password: % No password set', () => {
    const { pcRun, pcStack } = lab();
    pcRun('telnet 10.0.0.1', 'cisco');
    expect(pcStack.prompt()).toBe('R1>');
    const out = pcRun('enable');
    expect(out).toContain('% No password set');
    expect(pcStack.prompt()).toBe('R1>');
  });

  it('nested telnet PC -> R1 -> R2 and back', () => {
    const { pcRun, pcStack, e, r2 } = lab();
    pcRun('telnet 10.0.0.1', 'cisco');
    pcRun('telnet 10.0.1.2', 'two');
    expect(pcStack.prompt()).toBe('R2>');
    pcRun('enable', 'en');
    expect(pcStack.prompt()).toBe('R2#');
    expect(pcRun('show users')).toContain('10.0.1.1');
    expect(mgmtOf(rcfg(e, r2).sys).sessions).toHaveLength(1);
    const out = pcRun('exit');
    expect(out).toContain('[Connection to 10.0.1.2 closed by foreign host]');
    expect(pcStack.prompt()).toBe('R1>');
    sec(e, 1);
    expect(mgmtOf(rcfg(e, r2).sys).sessions).toHaveLength(0);
    pcRun('exit');
    expect(pcStack.prompt()).toBe('C:\\>');
  });

  it('6th telnet session is refused with 5 vty lines', () => {
    const { e, pc, r1 } = lab();
    void r1;
    const stacks: ShellStack[] = [];
    for (let i = 0; i < 6; i++) {
      const st = new ShellStack(new HostShell(e, pc));
      st.input('telnet 10.0.0.1');
      st.input('cisco');
      stacks.push(st);
    }
    expect(stacks.slice(0, 5).every((s) => s.prompt() === 'R1>')).toBe(true);
    expect(stacks[5]?.prompt()).toBe('C:\\>');
    expect(mgmtOf(rcfg(e, r1).sys).sessions).toHaveLength(5);
  });

  it('debug on vty only with terminal monitor', () => {
    const { e, c1, pcRun, pcStack, r1 } = lab();
    c1.run('configure terminal', 'enable secret x', 'end');
    pcRun('telnet 10.0.0.1', 'cisco', 'enable', 'x');
    expect(pcStack.prompt()).toBe('R1#');
    expect(pcRun('debug ip ospf hello')).toContain('is on');
    void r1;
    c1.run('configure terminal', 'router ospf 1', 'network 10.0.1.0 0.0.0.255 area 0', 'end');
    const change = (): void => {
      sec(e, 25);
    };
    pcStack.poll();
    change();
    expect(pcStack.poll()).toBe('');
    pcRun('terminal monitor');
    change();
    expect(pcStack.poll()).toContain('HELLO');
    pcRun('terminal no monitor');
    change();
    expect(pcStack.poll()).toBe('');
  });

  it('power-cycling the target closes the vty session', () => {
    const { e, r1, pcRun, pcStack } = lab();
    pcRun('telnet 10.0.0.1', 'cisco');
    expect(pcStack.prompt()).toBe('R1>');
    e.setPower(r1, false);
    sec(e, 1);
    e.setPower(r1, true);
    sec(e, 5);
    const out = pcRun('show users');
    expect(pcStack.prompt()).toBe('C:\\>');
    void out;
  });

  it('removing the target device ends the vty session without throwing', () => {
    const { e, r1, pcRun, pcStack } = lab();
    pcRun('telnet 10.0.0.1', 'cisco');
    e.removeDevice(r1);
    expect(pcStack.poll()).toContain('closed by foreign host');
    expect(pcStack.prompt()).toBe('C:\\>');
  });

  it('reload over vty drops the session', () => {
    const { c1, pcRun, pcStack, e } = lab();
    c1.run('configure terminal', 'enable secret x', 'end');
    pcRun('telnet 10.0.0.1', 'cisco', 'enable', 'x', 'reload', 'no', '');
    sec(e, 5);
    pcRun('show version');
    expect(pcStack.prompt()).toBe('C:\\>');
  });

  it('client powered off mid-session does not leak vty lines forever', () => {
    const { e, pc, r1 } = lab();
    for (let i = 0; i < 6; i++) {
      const s = new ShellStack(new HostShell(e, pc));
      s.input('telnet 10.0.0.1');
      s.input('cisco');
      expect(s.prompt()).toBe('R1>');
      e.setPower(pc, false);
      e.setPower(pc, true);
      sec(e, 2);
    }
    const st = new ShellStack(new HostShell(e, pc));
    st.input('telnet 10.0.0.1');
    st.input('cisco');
    expect(st.prompt()).toBe('R1>');
    void r1;
  });

  it('telnet to an IP that exists twice in the topology opens the right device', () => {
    // R2 also owns 10.0.0.1 on a disconnected LAN interface; PC must still reach R1.
    const { pcRun, pcStack, c2 } = lab();
    c2.run(
      'configure terminal',
      'interface gi0/1',
      'ip address 10.0.0.1 255.255.255.0',
      'no shutdown',
      'end',
    );
    pcRun('telnet 10.0.0.1', 'cisco');
    expect(pcStack.prompt()).toBe('R1>');
  });

  it('telnet to a static-NAT address reaches the inside device', () => {
    const { e, c1, pcRun, pcStack } = lab();
    c1.run(
      'configure terminal',
      'ip nat inside source static 10.0.1.2 10.0.0.100',
      'interface gi0/0',
      'ip nat outside',
      'exit',
      'interface gi0/1',
      'ip nat inside',
      'end',
    );
    sec(e, 1);
    const out = pcRun('telnet 10.0.0.100', 'two');
    expect(out).not.toContain('Connection closed');
    expect(pcStack.prompt()).toBe('R2>');
  });

  it('telnet to an HSRP virtual IP reaches the active router', () => {
    const { e, c1, c2, pcRun, pcStack } = lab();
    // HSRP on the R1-R2 link, VIP 10.0.1.254
    c1.run(
      'configure terminal',
      'interface gi0/1',
      'standby 1 ip 10.0.1.254',
      'standby 1 priority 150',
      'standby 1 preempt',
      'end',
    );
    c2.run('configure terminal', 'interface gi0/0', 'standby 1 ip 10.0.1.254', 'end');
    sec(e, 30);
    void pcRun;
    void pcStack;
    // from R2's point of view R1 is active; R2 console telnets the VIP
    const out = c2.run('telnet 10.0.1.254');
    const out2 = c2.run('cisco');
    expect(out + out2).not.toContain('Connection closed');
    expect(c2.st.prompt()).toBe('R1>');
  });
});
