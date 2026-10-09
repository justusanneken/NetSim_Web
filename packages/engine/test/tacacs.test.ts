import { describe, expect, it } from 'vitest';
import { Engine, type Result, type RouterConfig } from '../src';
import { mgmtOf } from '../src/p5defaults';

const must = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const rcfg = (e: Engine, id: string): RouterConfig => e.getDevice(id)?.config as RouterConfig;
const run = (e: Engine, s = 10): void => void e.runUntil(e.state.now + s * 1_000_000);

/** PC (10.0.0.2) – R1 (.1 / 10.0.1.1) – TACACS+-Server (10.0.1.10). */
function lab(secret = 'tackey') {
  const e = new Engine();
  const r1 = e.addDevice('router');
  const pc = e.addDevice('pc');
  const srv = e.addDevice('server');
  must(e.connect({ deviceId: pc, portId: 'p0' }, { deviceId: r1, portId: 'p0' }, 'straight'));
  must(e.connect({ deviceId: srv, portId: 'p0' }, { deviceId: r1, portId: 'p1' }, 'straight'));
  must(e.setInterfaceIp(r1, 'p0', '10.0.0.1', '255.255.255.0'));
  must(e.setInterfaceIp(r1, 'p1', '10.0.1.1', '255.255.255.0'));
  e.setPortAdmin(r1, 'p0', true);
  e.setPortAdmin(r1, 'p1', true);
  must(e.setHostIp(pc, '10.0.0.2', '255.255.255.0', '10.0.0.1'));
  must(e.setHostIp(srv, '10.0.1.10', '255.255.255.0', '10.0.1.1'));
  rcfg(e, r1).sys.hostname = 'R1';
  rcfg(e, r1).sys.lineVty = { login: true, password: 'cisco' };
  must(
    e.p5.setServices(srv, {
      tacacs: {
        enabled: true,
        clients: [{ ip: '10.0.1.1', secret }],
        users: [{ user: 'alice', pass: 'wonderland' }],
      },
    }),
  );
  const m = mgmtOf(rcfg(e, r1).sys);
  m.aaa = {
    newModel: true,
    radius: [],
    tacacs: [{ host: '10.0.1.10', key: 'tackey' }],
    methods: ['tacacs', 'local'],
    listName: 'default',
  };
  m.users.local = { secret: 'localpw', privilege: 1 };
  run(e, 1);
  return { e, r1, pc, srv, m };
}

function login(e: Engine, from: string, user: string, pass: string) {
  const o = e.p5.open(from, '10.0.0.1', 'telnet');
  must(o);
  const key = (o as { value: string }).value;
  run(e, 5);
  e.p5.send(from, key, 'login', { user, pass });
  run(e, 8);
  return e.p5.connState(from, key)?.reply;
}

describe('TACACS+', () => {
  it('Anmeldung gegen TACACS+ (TCP 49): pass, fail, Zähler und Ereignisse', () => {
    const { e, pc, m } = lab();
    expect(login(e, pc, 'alice', 'wonderland')?.op).toBe('login-ok');
    expect(m.aaa.tacacs?.[0]).toMatchObject({ opens: 1, pass: 1 });
    // auf der Leitung: TCP/49 mit Dienstnachricht
    const wire = e.log.filter((l) => l.proto === 'TACACS' || l.summary?.includes(':49'));
    expect(wire.length).toBeGreaterThan(0);
    expect(e.log.map((l) => l.msg.key)).toContain('svc.tacacs.pass');
    // falsches Passwort: abgewiesen, KEIN Fallback auf local
    const bad = login(e, pc, 'local', 'localpw');
    expect(bad?.op).toBe('login-fail');
    expect(m.aaa.tacacs?.[0]?.fail).toBe(1);
    expect(e.log.map((l) => l.msg.key)).toContain('svc.tacacs.fail');
  });

  it('falscher Schlüssel (Fehler) oder Server nicht erreichbar: Fallback auf local', () => {
    const wrong = lab('other-key');
    expect(login(wrong.e, wrong.pc, 'local', 'localpw')?.op).toBe('login-ok');
    expect(wrong.m.aaa.tacacs?.[0]?.errors).toBe(1);
    const down = lab();
    down.m.aaa.tacacs = [{ host: '10.0.1.99', key: 'tackey' }];
    expect(login(down.e, down.pc, 'local', 'localpw')?.op).toBe('login-ok');
  });

  it('Dienst am Server abgeschaltet: Verbindung abgelehnt, Fallback local', () => {
    const { e, pc, srv } = lab();
    must(e.p5.setServices(srv, { tacacs: { enabled: false, clients: [], users: [] } }));
    expect(login(e, pc, 'local', 'localpw')?.op).toBe('login-ok');
  });

  it('Verlauf ist deterministisch', () => {
    const go = () => {
      const { e, pc } = lab();
      login(e, pc, 'alice', 'wonderland');
      return JSON.stringify(e.log.map((l) => [l.t, l.msg.key]));
    };
    expect(go()).toBe(go());
  });
});
