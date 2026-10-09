import { describe, expect, it } from 'vitest';
import { Engine, type HostConfig, type Result, type RouterConfig } from '../src';
import { appcOf } from '../src/p5/node';

const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const run = (e: Engine, s = 3): void => void e.runUntil(e.state.now + s * 1_000_000);

function lab() {
  const e = new Engine({ seed: 1 });
  const r1 = e.addDevice('router');
  const pc = e.addDevice('pc');
  must(e.connect({ deviceId: pc, portId: 'p0' }, { deviceId: r1, portId: 'p0' }, 'straight'));
  must(e.setInterfaceIp(r1, 'p0', '10.0.0.1', '255.255.255.0'));
  e.setPortAdmin(r1, 'p0', true);
  must(e.setHostIp(pc, '10.0.0.2', '255.255.255.0', '10.0.0.1'));
  (e.getDevice(r1)?.config as RouterConfig).sys.lineVty = { login: true, password: 'pw' };
  run(e, 1);
  return { e, r1, pc };
}

describe('QA2: lokale Client-Ports bleiben im dynamischen Bereich', () => {
  it('TCP-Dienstverbindungen laufen nach 65535 auf 49152 um und überspringen belegte Ports', () => {
    const { e, pc } = lab();
    const h = e.getDevice(pc)?.config as HostConfig;
    const core = appcOf(h);
    core.nextPort = 65535;
    const a = must(e.p5.open(pc, '10.0.0.1', 'telnet'));
    run(e);
    core.nextPort = 65535; // Port 65535 ist noch belegt
    const b = must(e.p5.open(pc, '10.0.0.1', 'telnet'));
    run(e);
    const pa = e.p5.connState(pc, a)?.lport ?? 0;
    const pb = e.p5.connState(pc, b)?.lport ?? 0;
    expect(pa).toBe(65535);
    expect(pb).toBeGreaterThanOrEqual(49152);
    expect(pb).toBeLessThanOrEqual(65535);
    expect(pb).not.toBe(pa);
    expect(e.p5.connState(pc, b)?.state).toBe('open');
  });

  it('UDP-Dienstanfragen und Host-HTTP/DNS überschreiten 65535 nicht', () => {
    const { e, pc } = lab();
    const h = e.getDevice(pc)?.config as HostConfig;
    h.nextPort = 65535;
    e.httpGet(pc, 'http://10.0.0.1/');
    e.httpGet(pc, 'http://10.0.0.1/');
    run(e);
    const ports = e.log
      .map((l) => l.frame?.payload)
      .flatMap((p) => (p?.kind === 'ipv4' && p.payload.kind === 'tcp' ? [p.payload.srcPort] : []));
    expect(ports.length).toBeGreaterThan(0);
    expect(Math.max(...ports)).toBeLessThanOrEqual(65535);
    const core = appcOf(h);
    core.nextPort = 65536;
    e.p5.request(pc, '10.0.0.1', 'tftp', 'rrq', { file: 'x' });
    run(e);
    const udp = e.log
      .map((l) => l.frame?.payload)
      .flatMap((p) => (p?.kind === 'ipv4' && p.payload.kind === 'udp' ? [p.payload.srcPort] : []));
    expect(udp).toContain(49152);
  });

  it('neuer SYN auf dem Port einer verwaisten Serververbindung baut eine neue Verbindung auf', () => {
    const { e, pc, r1 } = lab();
    const core = appcOf(e.getDevice(pc)?.config as HostConfig);
    core.nextPort = 60000;
    const a = must(e.p5.open(pc, '10.0.0.1', 'telnet'));
    run(e);
    e.p5.send(pc, a, 'login', { user: '', pass: 'pw' });
    run(e);
    expect(e.p5.connState(pc, a)?.reply?.op).toBe('login-ok');
    // Client „vergisst“ die Verbindung ohne FIN (Absturz); der Router hält seine Seite noch
    delete core.conns[a];
    const rc = appcOf(e.getDevice(r1)?.config as RouterConfig);
    expect(Object.keys(rc.conns).length).toBe(1);
    core.nextPort = 60000; // derselbe lokale Port wird nach dem Umlauf wiederverwendet
    const b = must(e.p5.open(pc, '10.0.0.1', 'telnet'));
    run(e, 5);
    expect(e.p5.connState(pc, b)?.state).toBe('open');
    e.p5.send(pc, b, 'login', { user: '', pass: 'pw' });
    run(e);
    expect(e.p5.connState(pc, b)?.reply?.op).toBe('login-ok');
  });
});
