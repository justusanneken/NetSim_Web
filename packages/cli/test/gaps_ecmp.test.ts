import { describe, expect, it } from 'vitest';
import { diamond, sec } from './gapsLab';

describe('Lücken: ECMP im CLI', () => {
  it('OSPF maximum-paths; show ip route zeigt mehrere via-Zeilen; show ip route <net> mit zwei Blöcken', () => {
    const { e, r1, r2, r3, r4 } = diamond();
    for (const r of [r1, r2, r3, r4])
      r.run('configure terminal', 'router ospf 1', 'network 10.0.0.0 0.255.255.255 area 0', 'end');
    sec(e, 100);
    const rt = r1.run('show ip route');
    expect(rt).toMatch(
      /O\s+10\.4\.0\.0\/24 \[110\/3\] via 10\.0\.12\.2, \d\d:\d\d:\d\d, GigabitEthernet0\/0\n\s+\[110\/3\] via 10\.0\.13\.3, \d\d:\d\d:\d\d, GigabitEthernet0\/1/,
    );
    const one = r1.run('show ip route 10.4.0.0');
    expect(one).toContain('traffic share count is 1');
    expect(one.match(/Route metric is 3/g)).toHaveLength(2);
    r1.run('configure terminal', 'router ospf 1', 'maximum-paths 1', 'end');
    sec(e, 5);
    expect(r1.run('show ip route')).not.toMatch(/\n\s+\[110\/3\] via 10\.0\.13\.3/);
    const cfg = r1.run('show running-config');
    expect(cfg).toContain(' maximum-paths 1');
    r1.run('configure terminal', 'router ospf 1', 'no maximum-paths', 'end');
    expect(r1.run('show running-config')).not.toContain(' maximum-paths');
  });
});
