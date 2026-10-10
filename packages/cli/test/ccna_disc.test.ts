import { describe, expect, it } from 'vitest';
import { Engine } from '@netsim/engine';
import { cli, replayEqual, secs, wire } from './ccnaLab';

function lab() {
  const e = new Engine({ seed: 1 });
  const r1 = cli(e, 'R1', 'router');
  const s1 = cli(e, 'SW1');
  const s2 = cli(e, 'SW2');
  wire(e, r1, 'p0', s1, 'p0');
  wire(e, s1, 'p25', s2, 'p25');
  r1.cfg('interface gi0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown');
  s1.cfg('interface vlan1', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown');
  return { e, r1, s1, s2 };
}

describe('CDP CLI', () => {
  it('show cdp neighbors renders the IOS table', () => {
    const { e, s1 } = lab();
    secs(e, 10);
    const out = s1.out('enable', 'show cdp neighbors');
    expect(out).toContain(
      'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
    );
    expect(out).toContain(
      'Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID',
    );
    expect(out).toMatch(/^R1\s+Fas 0\/1\s+1[78]\d\s+R S I\s+CISCO1941 Gig 0\/0$/m);
    expect(out).toMatch(/^SW2\s+Gig 0\/2\s+1[78]\d\s+S I\s+WS-C2960- Gig 0\/2$/m);
    expect(out).toContain('Total cdp entries displayed : 2');
  });

  it('show cdp neighbors detail shows address, platform and native VLAN', () => {
    const { e, s1 } = lab();
    secs(e, 10);
    const out = s1.out('enable', 'show cdp neighbors detail');
    expect(out).toContain('Device ID: R1');
    expect(out).toContain('  IP address: 10.0.0.1');
    expect(out).toContain('Platform: Cisco CISCO1941/K9,  Capabilities: Router Switch IGMP');
    expect(out).toContain(
      'Interface: FastEthernet0/1,  Port ID (outgoing port): GigabitEthernet0/0',
    );
    expect(out).toContain('advertisement version: 2');
    expect(out).toContain('Duplex: full');
  });

  it('show cdp / timers / no cdp run', () => {
    const { e, s1 } = lab();
    expect(s1.out('enable', 'show cdp')).toBe(
      'Global CDP information:\n\tSending CDP packets every 60 seconds\n\tSending a holdtime value of 180 seconds\n\tSending CDPv2 advertisements is  enabled\n',
    );
    s1.cfg('cdp timer 30', 'cdp holdtime 90');
    expect(s1.out('show cdp')).toContain('every 30 seconds');
    s1.cfg('no cdp run');
    expect(s1.out('show cdp')).toBe('% CDP is not enabled\n');
    expect(s1.out('show cdp neighbors')).toBe('% CDP is not enabled\n');
    secs(e, 10);
    s1.cfg('cdp run');
    secs(e, 70);
    expect(s1.out('show cdp neighbors')).toContain('Total cdp entries displayed : 2');
  });

  it('no cdp enable on an interface stops CDP on that port only', () => {
    const { e, s1 } = lab();
    s1.cfg('interface fa0/1', 'no cdp enable');
    secs(e, 10);
    const out = s1.out('show cdp neighbors');
    expect(out).not.toContain('R1 ');
    expect(out).toContain('SW2');
    expect(s1.out('show cdp interface fa0/1')).toBe('');
    expect(s1.out('show cdp interface gi0/2')).toContain(
      'GigabitEthernet0/2 is up, line protocol is up',
    );
  });

  it('running-config renders and replays the CDP/LLDP settings', () => {
    const { e, s1 } = lab();
    s1.cfg(
      'no cdp run',
      'cdp timer 45',
      'lldp run',
      'lldp timer 15',
      'lldp holdtime 60',
      'interface fa0/3',
      'no lldp transmit',
      'no cdp enable',
    );
    const rc = replayEqual(e, s1);
    expect(rc).toContain('no cdp run\ncdp timer 45\nlldp run\nlldp timer 15\nlldp holdtime 60');
    expect(rc).toMatch(/interface FastEthernet0\/3\n no cdp enable\n no lldp transmit/);
    s1.cfg('cdp run', 'no lldp run');
    expect(s1.out('show running-config')).not.toContain('no cdp run');
  });
});

describe('LLDP CLI', () => {
  it('is disabled by default and lists neighbours once enabled', () => {
    const { e, s1, s2 } = lab();
    expect(s1.out('enable', 'show lldp')).toBe('% LLDP is not enabled\n');
    s1.cfg('lldp run');
    s2.cfg('lldp run');
    secs(e, 40);
    const out = s1.out('show lldp neighbors');
    expect(out).toContain('(R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device');
    expect(out).toContain('Device ID           Local Intf      Hold-time  Capability      Port ID');
    expect(out).toMatch(/^SW2\s+Gi0\/2\s+1[12]\d\s+B\s+Gi0\/2$/m);
    expect(out).toContain('Total entries displayed: 1');
    expect(s1.out('show lldp')).toContain('LLDP advertisements are sent every 30 seconds');
    expect(s1.out('show lldp neighbors detail')).toContain('System Name: SW2');
    expect(s1.out('show lldp traffic')).toContain('Total frames out:');
    expect(s1.out('show lldp interface fa0/1')).toContain('FastEthernet0/1:\n    Tx: enabled');
  });
});
