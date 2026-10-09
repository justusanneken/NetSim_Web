import { describe, expect, it } from 'vitest';
import { Engine, type DeviceType } from '@netsim/engine';
import {
  CliError,
  CliSession,
  renderRunningConfig,
  type CommandDef,
  type ModeId,
  type Slot,
} from '../src';
import { buildRegistry } from '../src/commands';

/** Zeilen, mit denen eine Sitzung (ab Privileged EXEC) in den jeweiligen Modus gelangt. */
const ENTER: Partial<Record<ModeId, string[]>> = {
  config: [],
  'config-if': ['interface gi0/0'],
  'config-subif': ['interface gi0/0.10'],
  'config-line': ['line vty 0 4'],
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

const SAMPLE: Record<string, string> = {
  word: 'X1',
  ip: '10.9.9.9',
  mask: '255.255.255.0',
  iface: 'gi0/1',
  vlans: '10',
  mac: '0000.1111.2222',
  wildcard: '0.0.0.255',
  ipv6: '2001:db8::9',
  prefix6: '2001:db8:9::/64',
};

function sample(s: Slot): string {
  if (s.kind === 'kw') return s.alts[0]?.word ?? '';
  if (s.kind === 'rest') return 'x';
  if (s.type === 'int') return String(s.min ?? 1);
  return SAMPLE[s.type] ?? 'x';
}

/** Zwei Varianten: nur Pflichtteile bzw. alle optionalen Teile mit Beispielwerten. */
function lines(def: CommandDef<CliSession>): string[] {
  const req = def.slots.filter((s) => !s.opt).map(sample);
  const all = def.slots.map(sample);
  return [...new Set([req.join(' '), all.join(' ')])];
}

const devicesFor = (only: CommandDef<CliSession>['only']): DeviceType[] =>
  only === 'firewall'
    ? ['firewall']
    : only === 'switch'
      ? ['switch-l2']
      : only === 'switch-l3'
        ? ['switch-l3']
        : only === 'router' || only === 'l3'
          ? ['router']
          : ['router', 'switch-l2'];

/** Switches haben FastEthernet-Ports. */
const enterFor = (type: DeviceType, mode: ModeId): string[] | undefined =>
  type.startsWith('switch')
    ? ((
        {
          'config-if': ['interface fa0/1'],
          'config-if-range': ['interface range fa0/1 - 2'],
          'config-vlan': ['vlan 10'],
        } as Partial<Record<ModeId, string[]>>
      )[mode] ?? ENTER[mode])
    : ENTER[mode];

const strip = (x: string): string =>
  x
    .split('\n')
    .filter((l) => !/^(Building configuration|Current configuration)/.test(l))
    .join('\n');

describe('QA2: Befehlsfuzzing – keine internen Fehler, running-config-Replay stabil', () => {
  it('jede Konfigurationsbefehlsdefinition (Router, Switch, Firewall) mit Beispielwerten', () => {
    const reg = buildRegistry() as unknown as { defs: CommandDef<CliSession>[] };
    const crashes: string[] = [];
    const replay: string[] = [];
    let tried = 0;
    for (const def of reg.defs)
      for (const type of devicesFor(def.only))
        for (const mode of def.modes) {
          const enter = enterFor(type, mode);
          if (!enter) continue;
          for (const line of lines(def)) {
            // keine Befehle, die die Sitzung/das Gerät neu starten oder löschen
            if (/^(reload|write erase|erase|end|exit|do|copy|configure)\b/.test(line)) continue;
            const e = new Engine({ seed: 1 });
            const id = e.addDevice(type);
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
                crashes.push(`${type} ${mode}: "${line}" → ${(err as Error).message}`);
              continue;
            }
            const dev = e.getDevice(id);
            if (!dev) continue;
            const before = strip(renderRunningConfig(e, dev as never).join('\n'));
            const e2 = new Engine({ seed: 1 });
            const id2 = e2.addDevice(type);
            const d2 = e2.getDevice(id2);
            if (d2?.config.kind === 'router' || d2?.config.kind === 'switch')
              d2.config.sys.setupDone = true;
            try {
              new CliSession(e2, id2).applyConfigText(before);
            } catch (err) {
              replay.push(`${mode}: "${line}" → replay threw ${(err as Error).message}`);
              continue;
            }
            const after = strip(renderRunningConfig(e2, e2.getDevice(id2) as never).join('\n'));
            if (after !== before) {
              const a = before.split('\n');
              const b = after.split('\n');
              const diff = a
                .filter((x) => !b.includes(x))
                .concat(b.filter((x) => !a.includes(x)).map((x) => `+${x}`));
              replay.push(`${type} ${mode}: "${line}" → ${diff.slice(0, 4).join(' | ')}`);
            }
          }
        }
    expect(tried).toBeGreaterThan(300);
    expect(crashes).toEqual([]);
    expect(replay).toEqual([]);
  }, 60_000);
});
