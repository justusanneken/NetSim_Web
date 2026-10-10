import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { cli, replayEqual, secs } from './ccnaLab';

function lab() {
  const e = new Engine({ seed: 1 });
  const r1 = cli(e, 'R1', 'router');
  const a = e.addDevice('pc', { name: 'A' });
  const b = e.addDevice('pc', { name: 'B' });
  e.connect({ deviceId: a, portId: 'p0' }, { deviceId: r1.id, portId: 'p0' }, 'straight');
  e.connect({ deviceId: b, portId: 'p0' }, { deviceId: r1.id, portId: 'p1' }, 'straight');
  r1.cfg(
    'interface gi0/0',
    'ip address 10.0.1.1 255.255.255.0',
    'no shutdown',
    'exit',
    'interface gi0/1',
    'ip address 10.0.2.1 255.255.255.0',
    'no shutdown',
  );
  e.setHostIp(a, '10.0.1.10', '255.255.255.0', '10.0.1.1');
  e.setHostIp(b, '10.0.2.10', '255.255.255.0', '10.0.2.1');
  secs(e, 2);
  return { e, r1, a, b };
}

const CONFIG = [
  'ip access-list extended WEB',
  'permit tcp any any eq 80',
  'exit',
  'class-map match-all VOICE',
  'match protocol icmp',
  'exit',
  'class-map match-any WEBC',
  'match access-group name WEB',
  'match dscp af21',
  'exit',
  'policy-map MARK',
  'class VOICE',
  'set dscp ef',
  'priority 100',
  'class WEBC',
  'set dscp af21',
  'bandwidth percent 30',
  'class class-default',
  'exit',
  'exit',
  'interface gi0/0',
  'service-policy input MARK',
];

describe('QoS classification and marking', () => {
  it('marks matching packets with the DSCP and counts them per class', () => {
    const { e, r1, a } = lab();
    r1.cfg(...CONFIG);
    e.ping(a, '10.0.2.10', { count: 3 });
    e.runAll();
    const marked = e.log.filter(
      (l) => l.frame?.payload.kind === 'ipv4' && l.frame.payload.dscp === 46,
    );
    expect(marked.length).toBeGreaterThan(0);
    const out = r1.out('enable', 'show policy-map interface gi0/0');
    expect(out).toContain('Service-policy input: MARK');
    expect(out).toMatch(/Class-map: VOICE \(match-all\)\n\s+\d+ packets, \d+ bytes/);
    expect(out).toContain('        dscp ef');
    expect(out).toMatch(/Packets marked [1-9]/);
    expect(out).toContain('Class-map: class-default (match-any)');
  });

  it('show class-map / policy-map, errors and no forms', () => {
    const { r1 } = lab();
    r1.cfg(...CONFIG);
    const cm = r1.out('enable', 'show class-map VOICE');
    expect(cm).toContain('Class Map match-all VOICE');
    expect(cm).toContain('Match protocol icmp');
    expect(r1.out('show class-map WEBC')).toContain('Match dscp af21 (18)');
    const pm = r1.out('show policy-map MARK');
    expect(pm).toContain('Policy Map MARK');
    expect(pm).toContain('Class VOICE\n      set dscp ef\n      priority 100');
    expect(r1.out('configure terminal', 'policy-map X', 'class NOPE')).toContain('not configured');
    expect(r1.out('exit', 'interface gi0/1', 'service-policy input NOPE')).toContain(
      'not configured',
    );
    r1.cfg('interface gi0/0', 'no service-policy input MARK');
    expect(r1.out('show running-config')).not.toContain('service-policy input');
  });

  it('running-config renders and replays class-maps, policy-maps and service-policy', () => {
    const { e, r1 } = lab();
    r1.cfg(...CONFIG, 'exit', 'interface gi0/1', 'service-policy output MARK');
    const rc = replayEqual(e, r1);
    expect(rc).toContain('class-map match-all VOICE\n match protocol icmp\n!');
    expect(rc).toContain(
      'class-map match-any WEBC\n match dscp af21\n match access-group name WEB\n!',
    );
    expect(rc).toContain(
      'policy-map MARK\n class VOICE\n  set dscp ef\n  priority 100\n class WEBC\n  set dscp af21\n  bandwidth percent 30\n class class-default\n!',
    );
    expect(rc).toContain(' service-policy input MARK');
    expect(rc).toContain(' service-policy output MARK');
  });
});
