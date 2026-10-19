import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { cli, replayEqual, secs, wire } from './ccnaLab';

/** R1 = DHCP-Server (Gi0/0 10.0.0.1), R2 bezieht Gi0/0 per `ip address dhcp`. */
function lab(manual = false) {
  const e = new Engine({ seed: 3 });
  const r1 = cli(e, 'R1', 'router');
  const r2 = cli(e, 'R2', 'router');
  wire(e, r1, 'p0', r2, 'p0');
  const mac = e.getDevice(r2.id)?.ports[0]?.mac.replace(/:/g, '') ?? '';
  const dotted = (mac.match(/.{4}/g) ?? []).join('.');
  r1.cfg(
    'interface gi0/0',
    'ip address 10.0.0.1 255.255.255.0',
    'no shutdown',
    'exit',
    'ip dhcp excluded-address 10.0.0.1 10.0.0.9',
    'ip dhcp pool LAN',
    'network 10.0.0.0 255.255.255.0',
    'default-router 10.0.0.1',
    'exit',
    ...(manual
      ? ['ip dhcp pool R2', 'host 10.0.0.50 255.255.255.0', `hardware-address ${dotted}`]
      : []),
  );
  r2.cfg('interface gi0/0', 'ip address dhcp', 'no shutdown');
  secs(e, 20);
  return { e, r1, r2 };
}

describe('DHCP: router as client, manual bindings, statistics', () => {
  it('ip address dhcp: address, default route (AD 254), statistics, replay', () => {
    const { e, r1, r2 } = lab();
    expect(r2.out('show ip interface brief')).toMatch(
      /GigabitEthernet0\/0\s+10\.0\.0\.10\s+YES DHCP/,
    );
    expect(r2.out('show ip route')).toMatch(/S\*\s+0\.0\.0\.0\/0 \[254\/0\] via 10\.0\.0\.1/);
    expect(r2.out('ping 10.0.0.1')).toContain('!!!');
    const st = r1.out('show ip dhcp server statistics');
    expect(st).toMatch(/DHCPDISCOVER\s+1/);
    expect(st).toMatch(/DHCPACK\s+1/);
    expect(replayEqual(e, r2)).toContain(' ip address dhcp');
  });

  it('manual binding hands out the fixed address (Infinite / Manual)', () => {
    const { e, r1, r2 } = lab(true);
    expect(r2.out('show ip interface brief')).toMatch(/10\.0\.0\.50\s+YES DHCP/);
    expect(r1.out('show ip dhcp binding')).toMatch(/10\.0\.0\.50\s+01\S+\s+Infinite\s+Manual/);
    r1.run('clear ip dhcp server statistics');
    expect(r1.out('show ip dhcp server statistics')).toMatch(/DHCPACK\s+0/);
    expect(replayEqual(e, r1)).toMatch(
      /ip dhcp pool R2\n host 10\.0\.0\.50 255\.255\.255\.0\n hardware-address /,
    );
  });
});
