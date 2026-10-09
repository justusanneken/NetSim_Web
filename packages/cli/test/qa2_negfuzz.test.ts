import { describe, expect, it } from 'vitest';
import { Engine, type DeviceType } from '@netsim/engine';
import { CliError, CliSession, type CommandDef, type ModeId } from '../src';
import { buildRegistry } from '../src/commands';

/** Zeilen, mit denen eine Sitzung (ab Privileged EXEC) in den jeweiligen Modus gelangt. */
const ENTER: Partial<Record<ModeId, string[]>> = {
  config: [],
  'config-if': ['interface gi0/0'],
  'config-subif': ['interface gi0/0.10'],
  'config-if-range': ['interface range gi0/0 - 1'],
  'config-line': ['line vty 0 4'],
  'config-vlan': ['vlan 10'],
  'dhcp-config': ['ip dhcp pool P'],
  'config-std-nacl': ['ip access-list standard S'],
  'config-ext-nacl': ['ip access-list extended E'],
  'config-rip': ['router rip'],
  'config-ospf': ['router ospf 1'],
  'config-ospf6': ['ipv6 unicast-routing', 'ipv6 router ospf 1'],
  'config-eigrp': ['router eigrp 1'],
  'config-eigrp6': ['ipv6 unicast-routing', 'ipv6 router eigrp 1'],
  'config-bgp': ['router bgp 1'],
  'config-bgp-af6': ['router bgp 1', 'address-family ipv6'],
  'config-route-map': ['route-map RM permit 10'],
  'config-dhcp6': ['ipv6 dhcp pool P6'],
  'config-rip6': ['ipv6 unicast-routing', 'ipv6 router rip R'],
  'config-tacacs': ['tacacs server T'],
  'config-bba': ['bba-group pppoe G'],
  'config-isakmp': ['crypto isakmp policy 10'],
  'config-trans': ['crypto ipsec transform-set TS esp-aes'],
  'config-crypto-map': ['crypto map M 10 ipsec-isakmp'],
  'config-obj-net': ['object network O'],
};

const deviceFor = (only: CommandDef<CliSession>['only']): DeviceType =>
  only === 'firewall'
    ? 'firewall'
    : only === 'switch'
      ? 'switch-l2'
      : only === 'switch-l3'
        ? 'switch-l3'
        : 'router';

/** `no` + alle Schlüsselwörter (jeweils das erste), Parameter ausgelassen bzw. nur bis zum ersten Parameter. */
function negations(def: CommandDef<CliSession>): string[] {
  const all: string[] = [];
  const prefix: string[] = [];
  let stop = false;
  for (const s of def.slots) {
    if (s.kind === 'kw') {
      if (s.opt) continue;
      const w = s.alts[0]?.word ?? '';
      all.push(w);
      if (!stop) prefix.push(w);
    } else stop = true;
  }
  return [...new Set([`no ${all.join(' ')}`, `no ${prefix.join(' ')}`])];
}

describe('QA2: no-Formen ohne Parameter werfen keine internen Fehler', () => {
  it('jede negierbare Befehlsdefinition in jedem Modus', () => {
    const reg = buildRegistry() as unknown as { defs: CommandDef<CliSession>[] };
    const crashes: string[] = [];
    let tried = 0;
    for (const def of reg.defs) {
      if (!def.negatable) continue;
      for (const mode of def.modes) {
        const enter = ENTER[mode];
        if (!enter) continue;
        for (const line of negations(def)) {
          const e = new Engine({ seed: 1 });
          const id = e.addDevice(deviceFor(def.only));
          const d = e.getDevice(id);
          if (d?.config.kind === 'router' || d?.config.kind === 'switch')
            d.config.sys.setupDone = true;
          const s = new CliSession(e, id);
          for (const l of ['enable', 'configure terminal', ...enter]) s.input(l);
          if (s.mode !== mode) continue;
          tried++;
          try {
            s.input(line);
          } catch (err) {
            if (!(err instanceof CliError))
              crashes.push(`${mode}: "${line}" → ${(err as Error).message}`);
          }
        }
      }
    }
    expect(tried).toBeGreaterThan(200);
    expect(crashes).toEqual([]);
  }, 60_000);

  it('IOS-gültige verkürzte no-Formen wirken; unvollständige melden % Incomplete', () => {
    const e = new Engine({ seed: 1 });
    const id = e.addDevice('router');
    const d = e.getDevice(id);
    if (d?.config.kind === 'router') d.config.sys.setupDone = true;
    const s = new CliSession(e, id);
    const run = (...ls: string[]): string => ls.map((l) => s.input(l)).join('');
    run(
      'enable',
      'configure terminal',
      'ipv6 unicast-routing',
      'interface virtual-template 1',
      'ip unnumbered loopback0',
      'exit',
      'interface gi0/0',
      'ipv6 address 2001:db8::1/64',
      'ipv6 address 2001:db8:1::1/64',
      'exit',
      'router ospf 1',
      'passive-interface gi0/0',
      'area 1 stub',
      'exit',
    );
    expect(run('interface virtual-template 1', 'no ip unnumbered', 'exit')).not.toContain('%');
    expect(run('interface gi0/0', 'no ipv6 address', 'exit')).not.toContain('%');
    const rc = s.input('do show running-config');
    expect(rc).not.toContain('ip unnumbered');
    expect(rc).not.toContain('2001:DB8');
    expect(run('router ospf 1', 'no passive-interface')).toContain('% Incomplete command.');
    expect(run('no area stub')).toMatch(/% (Invalid|Incomplete)/);
    expect(s.input('do show running-config')).toContain(' area 1 stub');
  });
});
