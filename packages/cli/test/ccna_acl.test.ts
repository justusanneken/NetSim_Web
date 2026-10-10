import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { cli, replayEqual, secs } from './ccnaLab';

function v6lab() {
  const e = new Engine({ seed: 1 });
  const r1 = cli(e, 'R1', 'router');
  const a = e.addDevice('pc', { name: 'A' });
  const b = e.addDevice('pc', { name: 'B' });
  e.connect({ deviceId: a, portId: 'p0' }, { deviceId: r1.id, portId: 'p0' }, 'straight');
  e.connect({ deviceId: b, portId: 'p0' }, { deviceId: r1.id, portId: 'p1' }, 'straight');
  r1.cfg(
    'ipv6 unicast-routing',
    'interface gi0/0',
    'ipv6 address 2001:db8:1::1/64',
    'no shutdown',
    'exit',
    'interface gi0/1',
    'ipv6 address 2001:db8:2::1/64',
    'no shutdown',
  );
  e.setHostIpv6(a, { addr: '2001:db8:1::10', plen: 64, gateway: '2001:db8:1::1' });
  e.setHostIpv6(b, { addr: '2001:db8:2::10', plen: 64, gateway: '2001:db8:2::1' });
  secs(e, 5);
  const ping = (): string | undefined => {
    e.ping(a, '2001:db8:2::10', { count: 1 });
    e.runAll();
    const c = e.getDevice(a)?.config;
    return c?.kind === 'host' ? c.pings.at(-1)?.status : undefined;
  };
  return { e, r1, a, b, ping };
}

describe('IPv6 ACL', () => {
  it('traffic-filter in: deny blocks the ping, permit lets it through, counters in show', () => {
    const { e, r1, ping } = v6lab();
    expect(ping()).toBe('reply');
    r1.cfg(
      'ipv6 access-list BLOCK',
      'deny icmp 2001:db8:1::/64 2001:db8:2::/64',
      'permit ipv6 any any',
      'exit',
      'interface gi0/0',
      'ipv6 traffic-filter BLOCK in',
    );
    expect(ping()).not.toBe('reply');
    const sh = r1.out('enable', 'show ipv6 access-list BLOCK');
    expect(sh).toMatch(/^IPv6 access list BLOCK$/m);
    expect(sh).toMatch(
      /^ {4}deny icmp 2001:DB8:1::\/64 2001:DB8:2::\/64 \(\d+ match(es)?\) sequence 10$/m,
    );
    expect(sh).toContain('    permit ipv6 any any sequence 20');
    r1.cfg('interface gi0/0', 'no ipv6 traffic-filter BLOCK in');
    expect(ping()).toBe('reply');
    void secs;
    void e;
  });

  it('implicit deny at the end; out direction works too', () => {
    const { r1, ping } = v6lab();
    r1.cfg(
      'ipv6 access-list ONLYWEB',
      'permit tcp any any eq www',
      'exit',
      'interface gi0/1',
      'ipv6 traffic-filter ONLYWEB out',
    );
    expect(ping()).not.toBe('reply');
  });

  it('renders (sequence only when custom), remarks, and replays', () => {
    const { e, r1 } = v6lab();
    r1.cfg(
      'ipv6 access-list WEB',
      'remark allow web',
      'permit tcp 2001:db8:1::/64 host 2001:db8:2::10 eq www',
      'deny ipv6 any any sequence 100',
      'exit',
      'interface gi0/0',
      'ipv6 traffic-filter WEB in',
      'ipv6 traffic-filter WEB out',
    );
    const rc = replayEqual(e, r1);
    expect(rc).toContain(
      'ipv6 access-list WEB\n remark allow web\n permit tcp 2001:DB8:1::/64 host 2001:DB8:2::10 eq www\n deny ipv6 any any sequence 100\n!',
    );
    expect(rc).toContain(' ipv6 traffic-filter WEB in');
    expect(rc).toContain(' ipv6 traffic-filter WEB out');
    r1.cfg('no ipv6 access-list WEB');
    expect(r1.out('show running-config')).not.toContain('ipv6 access-list WEB');
  });
});

describe('IPv4 ACL remarks and resequence', () => {
  it('remark is stored, rendered before its entry, replayed; resequence renumbers', () => {
    const e = new Engine({ seed: 1 });
    const r1 = cli(e, 'R1', 'router');
    r1.cfg(
      'ip access-list extended WEB',
      'remark permit http',
      'permit tcp any any eq 80',
      'remark block rest',
      'deny ip any any',
      'exit',
      'access-list 10 remark mgmt hosts',
      'access-list 10 permit 10.0.0.1',
    );
    const rc = replayEqual(e, r1);
    expect(rc).toContain(
      'ip access-list extended WEB\n remark permit http\n 10 permit tcp any any eq www\n remark block rest\n 20 deny ip any any',
    );
    expect(rc).toContain('access-list 10 remark mgmt hosts\naccess-list 10 permit host 10.0.0.1');
    r1.cfg('ip access-list resequence WEB 100 50');
    const sh = r1.out('show access-lists WEB');
    expect(sh).toContain('    100 permit tcp any any eq www');
    expect(sh).toContain('    150 deny ip any any');
    expect(sh).not.toContain('remark');
  });
});
