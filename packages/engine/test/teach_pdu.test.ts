import { describe, expect, it } from 'vitest';
import { PduSpecSchema, cloneEngine, runAttempt, resolveTarget, type PduSpecInput } from '../src';
import { serializeLog, routerLab, switchLab } from './helpers';

const spec = (s: PduSpecInput) => PduSpecSchema.parse(s);

describe('cloneEngine', () => {
  it('liefert eine unabhaengige, deterministische Kopie', () => {
    const { e, ids } = switchLab(2);
    const c = cloneEngine(e);
    expect(c).not.toBe(e);
    e.ping(ids[0] as string, '10.0.0.2');
    c.ping(ids[0] as string, '10.0.0.2');
    e.runUntil(e.state.now + 5_000_000);
    c.runUntil(c.state.now + 5_000_000);
    expect(serializeLog(c.log)).toEqual(serializeLog(e.log));
    expect(c.log.length).toBeGreaterThan(0);
  });

  it('aendert das Original nicht', () => {
    const { e, ids } = switchLab(2);
    const before = JSON.stringify(e.state);
    const c = cloneEngine(e);
    c.ping(ids[0] as string, '10.0.0.2');
    c.runUntil(c.state.now + 5_000_000);
    expect(JSON.stringify(e.state)).toBe(before);
  });
});

describe('PDU-Versuche', () => {
  it('ICMP: erfolgreich im selben Subnetz', () => {
    const { e, ids } = switchLab(2);
    const o = runAttempt(e, spec({ protocol: 'icmp', src: ids[0] as string, dst: '10.0.0.2' }));
    expect(o.status).toBe('ok');
  });

  it('ICMP: Ziel per Geraetename aufgeloest', () => {
    const { e, ids } = switchLab(2);
    const name = e.getDevice(ids[1] as string)?.name as string;
    expect(resolveTarget(e, name)).toBe('10.0.0.2');
    expect(runAttempt(e, spec({ protocol: 'icmp', src: ids[0] as string, dst: name })).status).toBe(
      'ok',
    );
  });

  it('ICMP: nicht erreichbares Ziel scheitert', () => {
    const { e, ids } = switchLab(2);
    const o = runAttempt(e, spec({ protocol: 'icmp', src: ids[0] as string, dst: '10.0.0.99' }));
    expect(o.status).toBe('failed');
  });

  it('ICMP ueber Router mit Quelladresse', () => {
    const lab = routerLab();
    const o = runAttempt(
      lab.e,
      spec({ protocol: 'icmp', src: lab.pc0, dst: '10.0.2.10', srcIp: '10.0.1.10' }),
    );
    expect(o.status).toBe('ok');
  });

  it('UDP auf geschlossenen Port: kein Dienst = gescheitert', () => {
    const lab = routerLab();
    const o = runAttempt(
      lab.e,
      spec({ protocol: 'udp', src: lab.pc0, dst: '10.0.2.10', dport: 9999 }),
    );
    expect(o).toEqual({ status: 'failed', note: 'ip.noService' });
  });

  it('UDP ohne Route scheitert sofort', () => {
    const { e, ids } = switchLab(2);
    const o = runAttempt(
      e,
      spec({ protocol: 'udp', src: ids[0] as string, dst: '192.168.9.9', dport: 53 }),
    );
    expect(o.status).toBe('failed');
  });

  it('TCP auf Port ohne Dienst wird zurueckgesetzt', () => {
    const lab = routerLab();
    const o = runAttempt(
      lab.e,
      spec({ protocol: 'tcp', src: lab.pc0, dst: '10.0.2.10', dport: 4444 }),
    );
    expect(o.status).toBe('failed');
  });

  it('HTTP gegen Server mit Webdienst: erfolgreich; ohne Dienst: gescheitert', () => {
    const lab = routerLab();
    const srv = lab.e.getDevice(lab.pc1);
    expect(srv).toBeDefined();
    const bad = runAttempt(lab.e, spec({ protocol: 'http', src: lab.pc0, dst: '10.0.2.10' }));
    expect(bad.status).toBe('failed');
    lab.e.setService(lab.pc1, { http: { enabled: true } });
    const good = runAttempt(lab.e, spec({ protocol: 'http', src: lab.pc0, dst: '10.0.2.10' }));
    expect(good.status).toBe('ok');
  });

  it('Fehler: unbekannte Quelle, ausgeschaltetes Geraet, kein Ziel', () => {
    const { e, ids } = switchLab(2);
    expect(runAttempt(e, spec({ protocol: 'icmp', src: 'nope', dst: '10.0.0.2' })).note).toBe(
      'pdu.err.noSource',
    );
    expect(runAttempt(e, spec({ protocol: 'icmp', src: ids[0] as string, dst: 'xyz' })).note).toBe(
      'pdu.err.noTarget',
    );
    e.setPower(ids[0] as string, false);
    expect(
      runAttempt(e, spec({ protocol: 'icmp', src: ids[0] as string, dst: '10.0.0.2' })).note,
    ).toBe('dev.off');
  });

  it('Spezifikation: Standardwerte und Grenzen', () => {
    const s = spec({ protocol: 'udp', src: 'a', dst: 'b' });
    expect(s.count).toBe(1);
    expect(s.delaySec).toBe(0);
    expect(() => spec({ protocol: 'icmp', src: 'a', dst: 'b', count: 0 })).toThrow();
    expect(() => spec({ protocol: 'xxx' as never, src: 'a', dst: 'b' })).toThrow();
  });
});
