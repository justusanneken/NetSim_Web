import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { CliSession, HostShell, Terminal } from '../src';
import { matchGolden } from './golden';
import { CONFIG_ROUTER, rig } from './helpers';

/** PC0 – R1 – PC1 mit konfiguriertem Router. */
function hostRig() {
  const r = rig();
  r.run(...CONFIG_ROUTER);
  return { ...r, sh: new HostShell(r.e, r.pc0) };
}

describe('Host-Eingabeaufforderung (Abnahme Phase 2: ping + tracert)', () => {
  it('ping/tracert/ipconfig/arp als Golden-Test', () => {
    const { sh } = hostRig();
    const run = (l: string) => `C:\\>${l}\n${sh.input(l)}`;
    const out = [
      'ping 10.0.2.10',
      'tracert 10.0.2.10',
      'ipconfig',
      'ipconfig /all',
      'arp -a',
      'ping 10.0.2.99 -n 2',
      'ping 172.16.0.1 -n 1',
      'ping 10.0.2.10 -n 1 -l 1472 -f',
      'tracert 10.0.2.99 -h 3',
    ]
      .map(run)
      .join('');
    matchGolden('hostshell', out);
  });

  it('falsches Gateway: korrekte ICMP-Meldung am Host', () => {
    const { e, pc0, sh } = hostRig();
    e.setHostIp(pc0, '10.0.1.10', '255.255.255.0', '10.0.1.99');
    expect(sh.input('ping 10.0.2.10 -n 1')).toContain(
      'Reply from 10.0.1.10: Destination host unreachable.',
    );
    e.setHostIp(pc0, '10.0.1.10', '255.255.255.0');
    expect(sh.input('ping 10.0.2.10 -n 1')).toContain('PING: transmit failed. General failure.');
    e.setHostIp(pc0, '10.0.1.10', '255.255.255.0', '10.0.1.1');
    expect(sh.input('ping 172.16.0.1 -n 1')).toContain(
      'Reply from 10.0.1.1: Destination net unreachable.',
    );
  });

  it('Simulationsmodus: Ping/Tracert werden nur eingereiht', () => {
    const r = rig();
    r.run(...CONFIG_ROUTER);
    const sh = new HostShell(r.e, r.pc0, () => true);
    expect(sh.input('ping 10.0.2.10 -n 1')).toContain('Simulation mode: packets were queued');
    expect(sh.input('tracert 10.0.2.10')).toContain('Simulation mode: probes were queued');
    expect(r.e.queueLength).toBeGreaterThan(0);
    const s2 = new CliSession(r.e, r.r1, () => true);
    s2.input('enable');
    expect(s2.input('ping 10.0.2.10')).toContain('Simulation mode');
    expect(s2.input('traceroute 10.0.2.10')).toContain('Simulation mode');
  });

  it('Hilfe, Fehler, Platzhalter-Befehle, cls', () => {
    const { sh } = hostRig();
    expect(sh.input('')).toBe('');
    expect(sh.input('help')).toContain('ping, tracert');
    expect(sh.input('foo')).toContain("'foo' is not recognized");
    expect(sh.input('nslookup x')).toContain('not available in this version');
    expect(sh.input('ping')).toContain('Usage');
    expect(sh.input('tracert')).toContain('Usage');
    expect(sh.input('arp')).toContain('Usage');
    expect(sh.input('arp -a')).toContain('No ARP Entries');
    expect(sh.input('ipconfig /renew')).toContain('operation failed');
    expect(sh.input('ping abc')).toContain('could not find host');
    expect(sh.input('cls')).toContain('\x1b[2J');
    expect(sh.input('tracert abc')).toContain('Unable to resolve');
    expect(sh.history.length).toBeGreaterThan(5);
    expect(sh.start()).toContain('Command Line');
    expect(sh.prompt()).toBe('C:\\>');
  });

  it('ping 4 Pakete mit Statistik', () => {
    const { sh } = hostRig();
    const o = sh.input('ping 10.0.2.10');
    expect(o).toContain('Packets: Sent = 4, Received = 4, Lost = 0 (0% loss)');
    expect(o).toContain('Reply from 10.0.2.10: bytes=32 time<1ms TTL=127');
  });
});

describe('Terminal (Zeileneditor)', () => {
  const term = () => {
    const r = rig();
    const t = new Terminal(r.s);
    t.start();
    return { r, t };
  };
  // eslint-disable-next-line no-control-regex
  const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');

  it('Tippen, Backspace, Enter, Historie', () => {
    const { t, r } = term();
    expect(t.handle('en')).toBe('en');
    t.handle('\x7f');
    t.handle('n');
    const out = t.handle('\r');
    expect(out).toBe('\r\nR1#');
    expect(r.s.mode).toBe('priv');
    t.handle('show clock\r');
    const up = t.handle('\x1b[A');
    expect(strip(up)).toBe('R1#show clock');
    const up2 = t.handle('\x1b[A');
    expect(strip(up2)).toBe('R1#en');
    expect(strip(t.handle('\x1b[B'))).toBe('R1#show clock');
    expect(strip(t.handle('\x1b[B'))).toBe('R1#');
    expect(t.handle('\x1b[B')).toBe('');
  });

  it('Cursorbewegung und Ctrl+A/E/U/W', () => {
    const { t } = term();
    t.handle('show ip route');
    expect(strip(t.handle('\x01'))).toBe('R1>show ip route');
    expect(t.handle('\x1b[C')).toBe('\x1b[C');
    t.handle('X');
    expect(strip(t.handle('\x05'))).toBe('R1>sXhow ip route');
    expect(strip(t.handle('\x17'))).toBe('R1>sXhow ip ');
    expect(strip(t.handle('\x15'))).toBe('R1>');
    expect(t.handle('\x1b[D')).toBe('');
    expect(t.handle('\x1b[C')).toBe('');
    t.handle('abc');
    t.handle('\x1b[D');
    expect(strip(t.handle('\x1b[3~'))).toBe('R1>ab');
    expect(strip(t.handle('\x1b[H'))).toBe('R1>ab');
    expect(strip(t.handle('\x1bOF'))).toBe('R1>ab');
    expect(t.handle('\x1b[Z')).toBe('');
    t.handle('\x03');
  });

  it('? zeigt Hilfe sofort, Tab vervollständigt, Ctrl+C bricht ab, Ctrl+Z verlässt Konfig', () => {
    const { t, r } = term();
    const h = t.handle('?');
    expect(h).toContain('?\r\n');
    expect(h).toContain('enable');
    expect(h.endsWith('R1>')).toBe(true);
    t.handle('en\r');
    t.handle('conf');
    expect(strip(t.handle('\t'))).toBe('R1#configure ');
    expect(t.handle('\t')).toBe('');
    expect(t.handle('\x03')).toBe('^C\r\nR1#');
    t.handle('configure terminal\r');
    expect(r.s.mode).toBe('config');
    expect(t.handle('\x1a')).toBe('^Z\r\nR1#');
    expect(r.s.mode).toBe('priv');
  });

  it('Passwörter werden nicht angezeigt; ? ist dort ein normales Zeichen', () => {
    const { t, r } = term();
    r.run('enable', 'configure terminal', 'enable secret ab?c', 'end', 'disable');
    t.handle('enable\r');
    expect(r.s.secret()).toBe(true);
    expect(t.handle('ab?c')).toBe('');
    expect(t.handle('\x7f')).toBe('');
    expect(t.handle('\t')).toBe('');
    expect(t.handle('\x1b[A')).toBe('');
    t.handle('c');
    expect(t.handle('\r')).toBe('\r\nR1#');
  });

  it('--More-- Paging: Leertaste, Enter, q', () => {
    const { t, r } = term();
    r.run('enable');
    r.s.terminalLength = 12;
    const first = t.handle('show running-config\r');
    expect(first).toContain(' --More-- ');
    const rows = (first.match(/\r\n/g) ?? []).length;
    expect(rows).toBeLessThanOrEqual(12);
    const next = t.handle(' ');
    expect(next).toContain('\r\x1b[K');
    expect(strip(t.handle('\r'))).toContain('\n');
    expect(t.handle('q')).toBe('\r\x1b[KR1#');
    // terminal length 0 → kein Paging
    t.handle('terminal length 0\r');
    expect(t.handle('show running-config\r')).not.toContain('--More--');
    t.handle('terminal length 5\r');
    let o = t.handle('show running-config\r');
    for (let i = 0; i < 60 && o.includes('--More--'); i++) o = t.handle(' ');
    expect(o.endsWith('R1#')).toBe(true);
  });

  it('start() und redraw() zeigen Prompt bzw. Puffer', () => {
    const e = new Engine();
    const id = e.addDevice('switch-l2', { name: 'S1' });
    const s = new CliSession(e, id);
    const t = new Terminal(s);
    expect(t.start()).toContain('System Configuration Dialog');
    t.handle('n');
    expect(strip(t.redraw())).toContain('[yes/no]: n');
    t.handle('o\r');
    expect(s.prompt()).toBe('S1>');
    expect(t.start()).toContain('S1>');
  });
});
