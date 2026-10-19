import { maskToPrefix, isValidIpv4, prefixToMask } from '@netsim/protocols';
import { networkOf } from '@netsim/engine';
import type { Acl, HostConfig, SwitchPortCfg } from '@netsim/engine';
import { AclParseError, addEntry, parseAclEntry } from './aclparse';
import { targets } from './commands';
import { IFM, SUBMODES, compressVlans, ifDisplay, parseVlanList, resolveIface } from './ifnames';
import { K, P, R, choice, opt, type ModeId, type Registry } from './parser';
import { CliError, type CliSession } from './session';
import * as show from './show';

const U: ModeId[] = ['user', 'priv'];
const CF: ModeId[] = ['config'];
const IF = IFM;

const SHOW = K('show', 'Show running system information');
const IP = K('ip', 'Global IP configuration subcommands');

const classfulMask = (ip: string): string => {
  const a = Number(ip.split('.')[0]);
  return a < 128 ? '255.0.0.0' : a < 192 ? '255.255.0.0' : '255.255.255.0';
};
const isStd = (name: string): boolean => /^(?:[1-9]\d?|1[3-9]\d{2})$/.test(name);
const isExt = (name: string): boolean => /^(?:1\d\d|2[0-6]\d\d)$/.test(name) && !isStd(name);

function swPorts(s: CliSession, patch: (pc: SwitchPortCfg) => Partial<SwitchPortCfg>): void {
  const cfg = s.device.config;
  if (cfg.kind !== 'switch') return;
  for (const id of targets(s)) {
    const pc = cfg.ports[id];
    if (!pc) continue;
    const res = s.engine.setSwitchport(s.deviceId, id, patch(pc));
    if (!res.ok) throw new CliError('% Invalid input');
  }
}

function aclFor(s: CliSession, name: string, type: 'standard' | 'extended'): Acl {
  const cfg = s.device.config;
  return (cfg.acls[name] ??= { name, type, entries: [] });
}

function aclLine(s: CliSession, name: string, type: 'standard' | 'extended', text: string): void {
  try {
    const rm = /^remark\s+(.*)$/.exec(text.trim());
    if (rm) {
      const acl = aclFor(s, name, type);
      if (s.negated) acl.pendingRemark = undefined;
      else acl.pendingRemark = rm[1];
      return;
    }
    const entry = parseAclEntry(type, text);
    const acl = aclFor(s, name, type);
    if (s.negated) {
      const i = acl.entries.findIndex((e) =>
        entry.seq !== undefined
          ? e.seq === entry.seq
          : JSON.stringify({ ...e, seq: 0, matches: 0, remark: undefined }) ===
            JSON.stringify({ ...entry, seq: 0, matches: 0, remark: undefined }),
      );
      if (i >= 0) acl.entries.splice(i, 1);
    } else {
      if (acl.pendingRemark) {
        entry.remark = acl.pendingRemark;
        acl.pendingRemark = undefined;
      }
      addEntry(acl.entries, entry);
    }
  } catch (e) {
    if (e instanceof AclParseError) throw new CliError(e.message);
    throw e;
  }
}

function showClamp(s: CliSession, lines: string[]): void {
  s.outLines(lines);
}

/** Phase 3: VLAN, Trunk, STP, EtherChannel, Port-Security, DHCP, ACL, NAT, L3-Switch. */
export function addPhase3(r: Registry<CliSession>): void {
  // ------------------------------------------------------------ show
  const sh = (
    words: [string, string][],
    run: (s: CliSession, a: Record<string, string>) => void,
    extra: ReturnType<typeof opt>[] = [],
    only?: 'router' | 'switch' | 'switch-l3' | 'l3',
  ): void => {
    r.add({ modes: U, only, slots: [SHOW, ...words.map(([w, h]) => K(w, h)), ...extra], run });
  };
  const { e, d } = { e: null, d: null };
  void e;
  void d;
  sh(
    [['vlan', 'VTP VLAN status']],
    (s) => showClamp(s, show.showVlanBrief(s.device)),
    [opt(K('brief', 'VTP all VLAN status in brief'))],
    'switch',
  );
  sh(
    [
      ['interfaces', 'Interface status and configuration'],
      ['trunk', 'Interface trunk information'],
    ],
    (s) => showClamp(s, show.showTrunk(s.device)),
    [],
    'switch',
  );
  r.add({
    modes: U,
    only: 'switch',
    slots: [
      SHOW,
      K('interfaces', 'Interface status and configuration'),
      P('if', 'iface', 'IFNAME', 'Interface name'),
      K('switchport', 'Show interface switchport information'),
    ],
    run: (s, a) => {
      const ref = resolveIface(s.device, a.if as string);
      const p = s.device.ports.find((x) => x.id === ref?.id);
      if (p) showClamp(s, show.showInterfacesSwitchport(s.device, p));
    },
  });
  sh(
    [
      ['spanning-tree', 'Spanning tree topology'],
      ['summary', 'Summary of port states'],
    ],
    (s) => showClamp(s, show.showSpanningTreeSummary(s.device)),
    [],
    'switch',
  );
  r.add({
    modes: U,
    only: 'switch',
    slots: [
      SHOW,
      K('vlan', 'VTP VLAN status'),
      K('id', 'VTP VLAN status by VLAN id'),
      P('vid', 'int', '<1-4094>', 'VLAN ID', [1, 4094]),
    ],
    run: (s, a) => {
      const all = show.showVlanBrief(s.device);
      showClamp(s, [...all.slice(0, 2), ...all.slice(2).filter((l) => l.startsWith(`${a.vid} `))]);
    },
  });
  r.add({
    modes: U,
    only: 'switch',
    slots: [
      SHOW,
      K('interfaces', 'Interface status and configuration'),
      K('switchport', 'Show interface switchport information'),
    ],
    run: (s) => {
      for (const p of s.device.ports)
        showClamp(s, [...show.showInterfacesSwitchport(s.device, p), '']);
    },
  });
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      IP,
      K('nat', 'NAT configuration commands'),
      K('translation', 'NAT translation entry configuration'),
      K('timeout', 'Specify timeout for NAT translations'),
      P('sec', 'int', '<0-2147483647>', 'Timeout in seconds', [0, 2147483647]),
    ],
    run: (s, a) => {
      s.device.config.nat.timeoutSec = s.negated ? undefined : Number(a.sec);
    },
  });
  sh(
    [['spanning-tree', 'Spanning tree topology']],
    (s, a) => showClamp(s, show.showSpanningTree(s.device, a.vlan ? Number(a.vlan) : undefined)),
    [
      opt(K('vlan', 'VLAN Switch Spanning Trees')),
      opt(P('vlan', 'int', '<1-4094>', 'VLAN ID', [1, 4094])),
    ],
    'switch',
  );
  sh(
    [
      ['etherchannel', 'EtherChannel information'],
      ['summary', 'One-line summary per channel-group'],
    ],
    (s) => showClamp(s, show.showEtherchannel(s.device)),
    [],
    'switch',
  );
  r.add({
    modes: U,
    only: 'switch',
    slots: [
      SHOW,
      K('port-security', 'Show secure port information'),
      opt(K('interface', 'Show secure port information for an interface')),
      opt(P('if', 'iface', 'IFNAME', 'Interface name')),
    ],
    run: (s, a) => {
      const ref = a.if ? resolveIface(s.device, a.if) : undefined;
      showClamp(s, show.showPortSecurity(s.device, ref?.id));
    },
  });
  sh(
    [
      ['vtp', 'VTP information'],
      ['status', 'VTP domain status'],
    ],
    (s) => showClamp(s, show.showVtp(s.device)),
    [],
    'switch',
  );
  r.add({
    modes: U,
    slots: [
      SHOW,
      IP,
      K('interface', 'IP interface status and configuration'),
      P('if', 'iface', 'IFNAME', 'Interface name'),
    ],
    run: (s, a) => {
      const ref = resolveIface(s.device, a.if as string);
      if (ref) showClamp(s, show.showIpInterface(s.device, ref.id));
    },
  });
  for (const [word, help, fn] of [
    [
      'binding',
      'DHCP address bindings',
      (s: CliSession) => show.showDhcpBinding(s.engine, s.device),
    ],
    ['pool', 'DHCP pools information', (s: CliSession) => show.showDhcpPool(s.engine, s.device)],
    [
      'conflict',
      'DHCP address conflicts',
      (s: CliSession) => show.showDhcpConflict(s.engine, s.device),
    ],
  ] as const) {
    r.add({
      modes: U,
      slots: [SHOW, IP, K('dhcp', 'Show items in the DHCP database'), K(word, help)],
      run: (s) => showClamp(s, fn(s)),
    });
  }
  r.add({
    modes: U,
    slots: [
      SHOW,
      K('access-lists', 'List access lists'),
      opt(P('name', 'word', 'WORD', 'Access list name/number')),
    ],
    run: (s, a) => showClamp(s, show.showAccessLists(s.device, a.name)),
  });
  r.add({
    modes: U,
    slots: [
      SHOW,
      IP,
      K('access-lists', 'List access lists'),
      opt(P('name', 'word', 'WORD', 'Access list name/number')),
    ],
    run: (s, a) => showClamp(s, show.showAccessLists(s.device, a.name)),
  });
  r.add({
    modes: U,
    slots: [SHOW, IP, K('nat', 'IP NAT information'), K('translations', 'Translation entries')],
    run: (s) => showClamp(s, show.showNatTranslations(s.device)),
  });
  r.add({
    modes: U,
    slots: [SHOW, IP, K('nat', 'IP NAT information'), K('statistics', 'Translation statistics')],
    run: (s) => showClamp(s, show.showNatStatistics(s.device)),
  });
  r.add({
    modes: ['priv'],
    slots: [
      K('clear', 'Reset functions'),
      IP,
      K('nat', 'IP NAT information'),
      K('translation', 'Clear NAT translation table'),
      K('*', 'Delete all dynamic translations'),
    ],
    run: (s) => {
      s.device.config.nat.table = s.device.config.nat.table.filter((t) => t.kind === 'static');
    },
  });
  const CLR_DHCP = [
    K('clear', 'Reset functions'),
    IP,
    K('dhcp', 'Delete items from the DHCP database'),
  ];
  r.add({
    modes: ['priv'],
    slots: [
      ...CLR_DHCP,
      K('binding', 'Delete DHCP address bindings'),
      choice('which', ['*', 'Clear all bindings'], ['A.B.C.D', 'Clear a specific binding']),
    ],
    run: (s, a) => {
      const dh = s.device.config.dhcp;
      if (a.which === '*') dh.bindings = {};
      else delete dh.bindings[a.which as string];
    },
  });
  r.add({
    modes: ['priv'],
    slots: [...CLR_DHCP, K('conflict', 'DHCP address conflicts'), K('*', 'Clear all conflicts')],
    run: (s) => {
      s.device.config.dhcp.conflicts = [];
    },
  });
  r.add({
    modes: ['priv'],
    slots: [
      ...CLR_DHCP,
      K('server', 'Miscellaneous DHCP server information'),
      K('statistics', 'DHCP server statistics'),
    ],
    run: (s) => {
      s.device.config.dhcp.stats = undefined;
    },
  });
  r.add({
    modes: U,
    slots: [
      SHOW,
      IP,
      K('dhcp', 'Show items in the DHCP database'),
      K('server', 'Miscellaneous DHCP server information'),
      K('statistics', 'DHCP server statistics'),
    ],
    run: (s) => showClamp(s, show.showDhcpServerStats(s.engine, s.device)),
  });

  // ------------------------------------------------------------ Switch: global
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      K('vlan', 'VLAN commands'),
      P('id', 'int', '<1-4094>', 'ISL VLAN IDs 1-4094', [1, 4094]),
    ],
    run: (s, a) => {
      const id = Number(a.id);
      if (s.negated) {
        const res = s.engine.removeVlan(s.deviceId, id);
        if (!res.ok)
          throw new CliError(
            res.error === 'sw.defaultVlan'
              ? '%Default VLAN 1 may not be deleted.'
              : '% VTP client: VLAN configuration is not allowed',
          );
        return;
      }
      const res = s.engine.addVlan(s.deviceId, id);
      if (!res.ok) throw new CliError('% VTP client: VLAN configuration is not allowed');
      s.vlanId = id;
      s.mode = 'config-vlan';
    },
  });
  r.add({
    modes: ['config-vlan'],
    only: 'switch',
    negatable: true,
    slots: [
      K('name', 'Ascii name of the VLAN'),
      P('name', 'word', 'WORD', 'The ascii name for the VLAN'),
    ],
    run: (s, a) => {
      const res = s.engine.addVlan(
        s.deviceId,
        s.vlanId,
        s.negated ? `VLAN${String(s.vlanId).padStart(4, '0')}` : (a.name as string),
      );
      if (!res.ok) throw new CliError('% VTP client: VLAN configuration is not allowed');
    },
  });
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      K('vtp', 'Configure global VTP state'),
      K('mode', 'Configure VTP device mode'),
      choice(
        'm',
        ['server', 'Set the device to server mode'],
        ['client', 'Set the device to client mode'],
        ['transparent', 'Set the device to transparent mode'],
      ),
    ],
    run: (s, a) => {
      s.engine.setVtp(s.deviceId, {
        mode: s.negated ? 'server' : (a.m as 'server' | 'client' | 'transparent'),
      });
    },
  });
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      K('vtp', 'Configure global VTP state'),
      K('domain', 'Set the name of the VTP administrative domain'),
      P('name', 'word', 'WORD', 'The ascii name of the domain'),
    ],
    run: (s, a) => {
      s.engine.setVtp(s.deviceId, { domain: s.negated ? '' : (a.name as string) });
    },
  });
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      K('vtp', 'Configure global VTP state'),
      K('version', 'Set the administrative domain VTP version'),
      P('v', 'int', '<1-3>', 'Version', [1, 3]),
    ],
    run: () => undefined,
  });
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      K('spanning-tree', 'Spanning Tree Subsystem'),
      K('mode', 'Spanning tree operating mode'),
      choice(
        'm',
        ['pvst', 'Per-Vlan spanning tree mode'],
        ['rapid-pvst', 'Per-Vlan rapid spanning tree mode'],
      ),
    ],
    run: (s, a) => {
      s.engine.setStp(s.deviceId, { mode: s.negated ? 'pvst' : (a.m as 'pvst' | 'rapid-pvst') });
    },
  });
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      K('spanning-tree', 'Spanning Tree Subsystem'),
      K('vlan', 'VLAN Switch Spanning Tree'),
      P('vlans', 'vlans', 'WORD', 'vlan range, example: 1,3-5,7,9-11'),
      K('priority', 'Set the bridge priority for the spanning tree'),
      P('p', 'int', '<0-61440>', 'Bridge priority in increments of 4096', [0, 61440]),
    ],
    run: (s, a) => {
      for (const v of parseVlanList(a.vlans as string)) {
        const res = s.engine.setStp(s.deviceId, {
          vlan: v,
          priority: s.negated ? 32768 : Number(a.p),
        });
        if (!res.ok)
          throw new CliError(
            '% Bridge Priority must be in increments of 4096.\n% Allowed values are:\n  0     4096  8192  12288 16384 20480 24576 28672\n  32768 36864 40960 45056 49152 53248 57344 61440',
          );
      }
    },
  });
  r.add({
    modes: CF,
    only: 'switch',
    slots: [
      K('spanning-tree', 'Spanning Tree Subsystem'),
      K('vlan', 'VLAN Switch Spanning Tree'),
      P('vlans', 'vlans', 'WORD', 'vlan range'),
      K('root', 'Configure switch as root'),
      choice(
        'role',
        ['primary', 'Configure this switch as primary root for this spanning tree'],
        ['secondary', 'Configure switch as secondary root'],
      ),
    ],
    run: (s, a) => {
      for (const v of parseVlanList(a.vlans as string)) {
        s.engine.setStp(s.deviceId, { vlan: v, priority: a.role === 'primary' ? 24576 : 28672 });
      }
    },
  });
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      K('errdisable', 'Error disable'),
      K('recovery', 'Configure errdisable recovery'),
      K('interval', 'Timer to recover from error disable'),
      P('sec', 'int', '<30-86400>', 'timer-interval(sec)', [30, 86400]),
    ],
    run: (s, a) => {
      const cfg = s.device.config;
      if (cfg.kind === 'switch')
        cfg.errdisableRecovery.intervalSec = s.negated ? 300 : Number(a.sec);
    },
  });
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      K('mac', 'MAC configuration commands'),
      K('address-table', 'MAC forwarding table'),
      K('aging-time', 'Set MAC address table entry maximum age'),
      P('sec', 'int', '<0-1000000>', 'Maximum age in seconds', [0, 1000000]),
    ],
    run: (s, a) => {
      const cfg = s.device.config;
      if (cfg.kind === 'switch') cfg.agingSec = s.negated ? 300 : Number(a.sec);
    },
  });
  r.add({
    modes: CF,
    only: 'switch-l3',
    negatable: true,
    slots: [IP, K('routing', 'Enable IP routing')],
    run: (s) => {
      s.device.config.ipRouting = !s.negated;
    },
  });
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      IP,
      K('default-gateway', 'Specify default gateway (if not routing IP)'),
      P('ip', 'ip', 'A.B.C.D', 'IP address of default gateway'),
    ],
    run: (s, a) => {
      s.device.config.defaultGateway = s.negated ? undefined : (a.ip as string);
    },
  });

  // ------------------------------------------------------------ Switch: Interface
  r.add({
    modes: IF,
    only: 'switch',
    negatable: true,
    slots: [K('switchport', 'Set switching mode characteristics')],
    run: (s) => swPorts(s, () => ({ routed: s.negated })),
  });
  r.add({
    modes: IF,
    only: 'switch',
    slots: [
      K('switchport', 'Set switching mode characteristics'),
      K('mode', 'Set trunking mode of the interface'),
      choice(
        'm',
        ['access', 'Set trunking mode to ACCESS unconditionally'],
        ['trunk', 'Set trunking mode to TRUNK unconditionally'],
        ['dynamic', 'Set trunking mode to dynamically negotiate access or trunk mode'],
      ),
      opt(
        choice(
          'd',
          ['auto', 'Set trunking mode dynamic negotiation parameter to AUTO'],
          ['desirable', 'Set trunking mode dynamic negotiation parameter to DESIRABLE'],
        ),
      ),
    ],
    run: (s, a) => {
      const mode =
        a.m === 'dynamic'
          ? a.d === 'desirable'
            ? 'dynamic-desirable'
            : 'dynamic-auto'
          : (a.m as 'access' | 'trunk');
      swPorts(s, () => ({ mode }));
    },
  });
  r.add({
    modes: IF,
    only: 'switch',
    negatable: true,
    slots: [
      K('switchport', 'Set switching mode characteristics'),
      K('mode', 'Set trunking mode of the interface'),
    ],
    run: (s) => swPorts(s, () => ({ mode: 'dynamic-auto' })),
  });
  r.add({
    modes: IF,
    only: 'switch',
    negatable: true,
    slots: [
      K('switchport', 'Set switching mode characteristics'),
      K('access', 'Set access mode characteristics of the interface'),
      K('vlan', 'Set VLAN when interface is in access mode'),
      P('v', 'int', '<1-4094>', 'VLAN ID of the VLAN when this port is in access mode', [1, 4094]),
    ],
    run: (s, a) => swPorts(s, () => ({ accessVlan: s.negated ? 1 : Number(a.v) })),
  });
  r.add({
    modes: IF,
    only: 'switch',
    negatable: true,
    slots: [
      K('switchport', 'Set switching mode characteristics'),
      K('trunk', 'Set trunking characteristics of the interface'),
      K('native', 'Set trunking native characteristics when interface is in trunking mode'),
      K('vlan', 'Set native VLAN when interface is in trunking mode'),
      P(
        'v',
        'int',
        '<1-4094>',
        'VLAN ID of the native VLAN when this port is in trunking mode',
        [1, 4094],
      ),
    ],
    run: (s, a) => swPorts(s, () => ({ nativeVlan: s.negated ? 1 : Number(a.v) })),
  });
  r.add({
    modes: IF,
    only: 'switch',
    negatable: true,
    slots: [
      K('switchport', 'Set switching mode characteristics'),
      K('trunk', 'Set trunking characteristics of the interface'),
      K('allowed', 'Set allowed VLAN characteristics when interface is in trunking mode'),
      K('vlan', 'Set allowed VLAN characteristics when interface is in trunking mode'),
      opt(
        choice(
          'op',
          ['add', 'add VLANs to the current list'],
          ['remove', 'remove VLANs from the current list'],
          ['except', 'all VLANs except the following'],
        ),
      ),
      opt(
        P(
          'list',
          'vlans',
          'WORD',
          'VLAN IDs of the allowed VLANs when this port is in trunking mode',
        ),
      ),
    ],
    run: (s, a) => {
      swPorts(s, (pc) => {
        if (s.negated) return { allowed: 'all' };
        const list =
          a.list === 'all' ? 'all' : a.list === 'none' ? [] : parseVlanList(a.list ?? '');
        if (list === 'all') return { allowed: 'all' };
        const cur =
          pc.allowed === 'all' ? Array.from({ length: 4094 }, (_, i) => i + 1) : pc.allowed;
        if (a.op === 'add')
          return {
            allowed: [...new Set([...(pc.allowed === 'all' ? [] : cur), ...list])].sort(
              (x, y) => x - y,
            ),
          };
        if (a.op === 'remove') return { allowed: cur.filter((v) => !list.includes(v)) };
        if (a.op === 'except')
          return {
            allowed: Array.from({ length: 4094 }, (_, i) => i + 1).filter((v) => !list.includes(v)),
          };
        return { allowed: list };
      });
    },
  });
  r.add({
    modes: IF,
    only: 'switch',
    negatable: true,
    slots: [
      K('switchport', 'Set switching mode characteristics'),
      K('trunk', 'Set trunking characteristics of the interface'),
      K('encapsulation', 'Set trunking encapsulation when interface is in trunking mode'),
      K('dot1q', 'Interface uses only 802.1q trunking encapsulation when trunking'),
    ],
    run: () => undefined,
  });
  r.add({
    modes: IF,
    only: 'switch',
    negatable: true,
    slots: [
      K('spanning-tree', 'Spanning Tree Subsystem'),
      K('portfast', 'Enable an interface to move directly to forwarding on link up'),
    ],
    // `no spanning-tree portfast` stellt den Standard her (auch ein `portfast disable` entfällt)
    run: (s) => swPorts(s, () => ({ portfast: !s.negated, portfastOff: false })),
  });
  r.add({
    modes: IF,
    only: 'switch',
    negatable: true,
    slots: [
      K('spanning-tree', 'Spanning Tree Subsystem'),
      K('bpduguard', "Don't accept BPDUs on this interface"),
      opt(choice('v', ['enable', 'Enable BPDU guard'], ['disable', 'Disable BPDU guard'])),
    ],
    run: (s, a) =>
      swPorts(s, () => ({
        bpduguard: !s.negated && a.v !== 'disable',
        bpduguardOff: !s.negated && a.v === 'disable',
      })),
  });
  r.add({
    modes: IF,
    only: 'switch',
    negatable: true,
    slots: [
      K('spanning-tree', 'Spanning Tree Subsystem'),
      K('guard', "Change an interface's spanning tree guard mode"),
      choice(
        'g',
        ['root', 'Set guard mode to root guard'],
        ['loop', 'Set guard mode to loop guard'],
        ['none', 'Set guard mode to none'],
      ),
    ],
    run: (s, a) => swPorts(s, () => ({ rootguard: !s.negated && a.g === 'root' })),
  });
  r.add({
    modes: IF,
    only: 'switch',
    negatable: true,
    slots: [
      K('channel-group', 'Etherchannel/port bundling configuration'),
      P('n', 'int', '<1-6>', 'Channel group number', [1, 6]),
      K('mode', 'Etherchannel Mode of the interface'),
      choice(
        'm',
        ['on', 'Enable Etherchannel only'],
        ['active', 'Enable LACP unconditionally'],
        ['passive', 'Enable LACP only if a LACP device is detected'],
        ['desirable', 'Enable PAgP unconditionally'],
        ['auto', 'Enable PAgP only if a PAgP device is detected'],
      ),
    ],
    run: (s, a) =>
      swPorts(s, () =>
        s.negated
          ? { channel: undefined, channelMode: undefined }
          : { channel: Number(a.n), channelMode: a.m as SwitchPortCfg['channelMode'] },
      ),
  });
  const PS = [
    K('switchport', 'Set switching mode characteristics'),
    K('port-security', 'Security related command'),
  ];
  r.add({
    modes: IF,
    only: 'switch',
    negatable: true,
    slots: [...PS],
    run: (s) => swPorts(s, (pc) => ({ psec: { ...pc.psec, enabled: !s.negated } })),
  });
  r.add({
    modes: IF,
    only: 'switch',
    negatable: true,
    slots: [
      ...PS,
      K('maximum', 'Max secure addresses'),
      P('n', 'int', '<1-132>', 'Maximum addresses', [1, 132]),
    ],
    run: (s, a) => swPorts(s, (pc) => ({ psec: { ...pc.psec, max: s.negated ? 1 : Number(a.n) } })),
  });
  r.add({
    modes: IF,
    only: 'switch',
    negatable: true,
    slots: [
      ...PS,
      K('violation', 'Security Violation Mode'),
      choice(
        'v',
        ['protect', 'Security violation protect mode'],
        ['restrict', 'Security violation restrict mode'],
        ['shutdown', 'Security violation shutdown mode'],
      ),
    ],
    run: (s, a) =>
      swPorts(s, (pc) => ({
        psec: {
          ...pc.psec,
          violation: s.negated ? 'shutdown' : (a.v as 'protect' | 'restrict' | 'shutdown'),
        },
      })),
  });
  r.add({
    modes: IF,
    only: 'switch',
    negatable: true,
    slots: [
      ...PS,
      K('mac-address', 'Secure mac address'),
      opt(K('sticky', 'Configure dynamic secure addresses as sticky')),
      opt(P('mac', 'mac', 'H.H.H', ' 48 bit mac address')),
    ],
    run: (s, a) =>
      swPorts(s, (pc) => {
        const ps = { ...pc.psec };
        const hex = a.mac?.replace(/\./g, '').toLowerCase();
        const mac = hex ? (hex.match(/../g) ?? []).join(':') : undefined;
        if (a['kw:3'] && !mac) ps.sticky = !s.negated;
        else if (mac) {
          ps.macs = s.negated ? ps.macs.filter((x) => x !== mac) : [...new Set([...ps.macs, mac])];
          if (a['kw:3']) ps.sticky = true;
        }
        return { psec: ps };
      }),
  });

  // ------------------------------------------------------------ L3-Interface
  r.add({
    modes: ['config-subif'],
    only: 'router',
    slots: [
      K('encapsulation', 'Set encapsulation type for an interface'),
      K('dot1Q', 'IEEE 802.1Q Virtual LAN'),
      P('v', 'int', '<1-4094>', 'IEEE 802.1Q VLAN ID', [1, 4094]),
      opt(K('native', 'Make this VLAN the native VLAN on the trunk')),
    ],
    run: (s, a) => {
      for (const id of s.ifaces) {
        const c = s.device.config.ifaces[id];
        if (c) c.vlan = Number(a.v);
      }
    },
  });
  r.add({
    modes: IF,
    only: 'l3',
    negatable: true,
    slots: [
      IP,
      K('helper-address', 'Specify a destination address for UDP broadcasts'),
      P('ip', 'ip', 'A.B.C.D', 'IP destination address'),
    ],
    run: (s, a) => {
      for (const id of targets(s)) {
        const c = s.device.config.ifaces[id];
        if (!c) continue;
        const list = c.helpers ?? [];
        c.helpers = s.negated
          ? list.filter((x) => x !== a.ip)
          : [...new Set([...list, a.ip as string])];
      }
    },
  });
  r.add({
    modes: IF,
    only: 'l3',
    negatable: true,
    slots: [
      IP,
      K('access-group', 'Specify access control for packets'),
      P('acl', 'word', 'WORD', 'Access list name/number'),
      choice('dir', ['in', 'inbound packets'], ['out', 'outbound packets']),
    ],
    run: (s, a) => {
      for (const id of targets(s)) {
        const c = s.device.config.ifaces[id];
        if (!c) continue;
        if (a.dir === 'in') c.aclIn = s.negated ? undefined : (a.acl as string);
        else c.aclOut = s.negated ? undefined : (a.acl as string);
      }
    },
  });
  r.add({
    modes: IF,
    only: 'l3',
    negatable: true,
    slots: [
      IP,
      K('nat', 'NAT interface commands'),
      choice(
        'side',
        ['inside', 'Inside interface for address translation'],
        ['outside', 'Outside interface for address translation'],
      ),
    ],
    run: (s, a) => {
      for (const id of targets(s)) {
        const c = s.device.config.ifaces[id];
        if (c) c.natSide = s.negated ? undefined : (a.side as 'inside' | 'outside');
      }
    },
  });

  // ------------------------------------------------------------ DHCP
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      IP,
      K('dhcp', 'Configure DHCP server and relay parameters'),
      K('excluded-address', 'Prevent DHCP from assigning certain addresses'),
      P('from', 'ip', 'A.B.C.D', 'Low IP address'),
      opt(P('to', 'ip', 'A.B.C.D', 'High IP address')),
    ],
    run: (s, a) => {
      const dh = s.device.config.dhcp;
      const ex = { from: a.from as string, to: a.to ?? (a.from as string) };
      dh.excluded = s.negated
        ? dh.excluded.filter((x) => !(x.from === ex.from && x.to === ex.to))
        : [...dh.excluded.filter((x) => !(x.from === ex.from && x.to === ex.to)), ex];
    },
  });
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      IP,
      K('dhcp', 'Configure DHCP server and relay parameters'),
      K('pool', 'Configure DHCP address pools'),
      P('name', 'word', 'WORD', 'Pool name'),
    ],
    run: (s, a) => {
      const dh = s.device.config.dhcp;
      const name = a.name as string;
      if (s.negated) {
        dh.pools = dh.pools.filter((p) => p.name !== name);
        return;
      }
      if (!dh.pools.some((p) => p.name === name)) {
        dh.pools.push({ name, network: '0.0.0.0', mask: '0.0.0.0', dns: [], leaseSec: 86400 });
      }
      s.poolName = name;
      s.mode = 'dhcp-config';
    },
  });
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      K('service', 'Modify use of network based services'),
      K('dhcp', 'Enable DHCP server and relay agent'),
    ],
    run: () => undefined,
  });
  const pool = (s: CliSession) => {
    const p = s.device.config.dhcp.pools.find((x) => x.name === s.poolName);
    if (!p) throw new CliError('% Pool not found');
    return p;
  };
  const D = ['dhcp-config'] as ModeId[];
  r.add({
    modes: D,
    only: 'l3',
    negatable: true,
    slots: [
      K('network', 'Network number and mask'),
      P('net', 'ip', 'A.B.C.D', 'Network number in dotted-decimal notation'),
      P('mask', 'mask', 'A.B.C.D', 'Network mask'),
    ],
    run: (s, a) => {
      const p = pool(s);
      p.network = s.negated ? '0.0.0.0' : (a.net as string);
      p.mask = s.negated ? '0.0.0.0' : (a.mask as string);
    },
  });
  r.add({
    modes: D,
    only: 'l3',
    negatable: true,
    slots: [
      K('default-router', 'Default routers'),
      P('ip', 'ip', 'A.B.C.D', "Router's IP address"),
    ],
    run: (s, a) => {
      pool(s).router = s.negated ? undefined : (a.ip as string);
    },
  });
  r.add({
    modes: D,
    only: 'l3',
    negatable: true,
    slots: [
      K('dns-server', 'Specify DNS servers'),
      P('a', 'ip', 'A.B.C.D', 'DNS server IP address'),
      opt(P('b', 'ip', 'A.B.C.D', 'DNS server IP address')),
      opt(P('c', 'ip', 'A.B.C.D', 'DNS server IP address')),
    ],
    run: (s, a) => {
      pool(s).dns = s.negated ? [] : [a.a, a.b, a.c].filter((x): x is string => !!x);
    },
  });
  r.add({
    modes: D,
    only: 'l3',
    negatable: true,
    slots: [K('domain-name', 'Domain name'), P('name', 'word', 'WORD', 'Domain name')],
    run: (s, a) => {
      pool(s).domain = s.negated ? undefined : (a.name as string);
    },
  });
  r.add({
    modes: D,
    only: 'l3',
    negatable: true,
    slots: [
      K('lease', 'Address lease time'),
      P('d', 'int', '<0-365>', 'Days', [0, 365]),
      opt(P('h', 'int', '<0-23>', 'Hours', [0, 23])),
      opt(P('m', 'int', '<0-59>', 'Minutes', [0, 59])),
    ],
    run: (s, a) => {
      pool(s).leaseSec = s.negated
        ? 86400
        : Number(a.d) * 86400 + Number(a.h ?? 0) * 3600 + Number(a.m ?? 0) * 60;
    },
  });
  // Manuelle Bindung: `host A.B.C.D [mask | /len]` + `hardware-address` / `client-identifier`
  r.add({
    modes: D,
    only: 'l3',
    negatable: true,
    slots: [
      K('host', 'Client IP address and mask'),
      P('ip', 'ip', 'A.B.C.D', 'IP address in dotted-decimal notation'),
      opt(P('mask', 'word', 'A.B.C.D | /nn', 'IP subnet mask or prefix length')),
    ],
    run: (s, a) => {
      const p = pool(s);
      if (s.negated) {
        p.host = undefined;
        return;
      }
      const m = a.mask ?? '';
      const mask = m.startsWith('/')
        ? prefixToMask(Number(m.slice(1)))
        : m || classfulMask(a.ip as string);
      const plen = maskToPrefix(mask);
      if (plen === undefined) throw new CliError('% Invalid mask');
      p.host = a.ip as string;
      p.mask = mask;
      p.network = networkOf(a.ip as string, plen);
    },
  });
  for (const [word, help] of [
    ['hardware-address', 'Client hardware address'],
    ['client-identifier', 'Client identifier'],
  ] as const) {
    r.add({
      modes: D,
      only: 'l3',
      negatable: true,
      slots: [K(word, help), P('id', 'word', 'H.H.H', 'Hexadecimal identifier')],
      run: (s, a) => {
        const p = pool(s);
        if (s.negated) {
          p.hwAddr = undefined;
          return;
        }
        let hex = (a.id as string).replace(/\./g, '').toLowerCase();
        // client-identifier: führendes `01` (Hardwaretyp Ethernet) entfernen
        if (word === 'client-identifier' && hex.length === 14 && hex.startsWith('01'))
          hex = hex.slice(2);
        if (!/^[0-9a-f]{12}$/.test(hex)) throw new CliError('% Invalid hardware address');
        p.hwAddr = (hex.match(/.{2}/g) ?? []).join(':');
      },
    });
  }
  r.add({
    modes: D,
    only: 'l3',
    negatable: true,
    slots: [
      K('option', 'Raw DHCP options'),
      choice('o', ['66', 'TFTP server name'], ['150', 'TFTP server address']),
      choice('t', ['ascii', 'ASCII string'], ['ip', 'IP address']),
      P('v', 'word', 'WORD', 'Value'),
    ],
    run: (s, a) => {
      pool(s).tftp = s.negated ? undefined : (a.v as string);
    },
  });

  // ------------------------------------------------------------ ACL
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      K('access-list', 'Add an access list entry'),
      P('n', 'word', '<1-199>', 'IP access list number'),
      opt(R('rest', 'LINE', 'permit|deny …')),
    ],
    run: (s, a) => {
      const n = a.n as string;
      const type = isStd(n) ? 'standard' : isExt(n) ? 'extended' : undefined;
      if (!type) throw new CliError('% Invalid access list number');
      if (s.negated && !a.rest) {
        delete s.device.config.acls[n];
        return;
      }
      aclLine(s, n, type, a.rest ?? '');
    },
  });
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      IP,
      K('access-list', 'Named access list'),
      choice('t', ['standard', 'Standard Access List'], ['extended', 'Extended Access List']),
      P('name', 'word', 'WORD', 'Access-list name'),
    ],
    run: (s, a) => {
      const name = a.name as string;
      if (s.negated) {
        delete s.device.config.acls[name];
        return;
      }
      aclFor(s, name, a.t as 'standard' | 'extended');
      s.aclName = name;
      s.mode = a.t === 'standard' ? 'config-std-nacl' : 'config-ext-nacl';
    },
  });
  for (const [mode, type] of [
    ['config-std-nacl', 'standard'],
    ['config-ext-nacl', 'extended'],
  ] as const) {
    for (const action of ['permit', 'deny'] as const) {
      r.add({
        modes: [mode],
        only: 'l3',
        negatable: true,
        slots: [
          K(
            action,
            action === 'permit' ? 'Specify packets to forward' : 'Specify packets to reject',
          ),
          R('rest', 'LINE', 'access-list entry'),
        ],
        run: (s, a) => aclLine(s, s.aclName, type, `${action} ${a.rest}`),
      });
    }
    r.add({
      modes: [mode],
      only: 'l3',
      negatable: true,
      slots: [
        P('seq', 'int', '<1-2147483647>', 'Sequence Number', [1, 2147483647]),
        choice(
          'act',
          ['permit', 'Specify packets to forward'],
          ['deny', 'Specify packets to reject'],
        ),
        R('rest', 'LINE', 'access-list entry'),
      ],
      run: (s, a) => aclLine(s, s.aclName, type, `${a.seq} ${a.act} ${a.rest}`),
    });
    r.add({
      modes: [mode],
      only: 'l3',
      slots: [K('remark', 'Access list entry comment'), R('t', 'LINE', 'comment')],
      run: (s, a) => aclLine(s, s.aclName, type, `remark ${a.t ?? ''}`),
    });
  }

  // ------------------------------------------------------------ NAT
  const NAT = [IP, K('nat', 'NAT configuration commands')];
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      ...NAT,
      K('pool', 'Define pool of addresses'),
      P('name', 'word', 'WORD', 'Pool name'),
      P('start', 'ip', 'A.B.C.D', 'Start IP address'),
      P('end', 'ip', 'A.B.C.D', 'End IP address'),
      K('netmask', 'Specify the network mask'),
      P('mask', 'mask', 'A.B.C.D', 'Network mask'),
    ],
    run: (s, a) => {
      const nat = s.device.config.nat;
      if (s.negated) delete nat.pools[a.name as string];
      else
        nat.pools[a.name as string] = {
          name: a.name as string,
          start: a.start as string,
          end: a.end as string,
          mask: a.mask as string,
        };
    },
  });
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      ...NAT,
      K('inside', 'Inside address translation'),
      K('source', 'Source address translation'),
      K('list', 'Specify access list describing local addresses'),
      P('acl', 'word', 'WORD', 'Access list name/number'),
      K('pool', 'Name pool of global addresses'),
      P('pool', 'word', 'WORD', 'Pool name for global addresses'),
      opt(K('overload', 'Overload an address translation')),
    ],
    run: (s, a) => {
      const rules = s.device.config.nat.rules;
      const rule = {
        kind: 'dynamic' as const,
        acl: a.acl as string,
        pool: a.pool as string,
        overload: a['kw:10'] !== undefined,
      };
      const i = rules.findIndex(
        (x) => x.kind === 'dynamic' && x.acl === rule.acl && x.pool === rule.pool,
      );
      if (i >= 0) rules.splice(i, 1);
      if (!s.negated) rules.push(rule);
    },
  });
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      ...NAT,
      K('inside', 'Inside address translation'),
      K('source', 'Source address translation'),
      K('list', 'Specify access list describing local addresses'),
      P('acl', 'word', 'WORD', 'Access list name/number'),
      K('interface', 'Specify interface for global address'),
      P('if', 'iface', 'IFNAME', 'Interface name'),
      opt(K('overload', 'Overload an address translation')),
    ],
    run: (s, a) => {
      const ref = resolveIface(s.device, a.if as string);
      if (!ref) throw new CliError('% Invalid interface');
      const rules = s.device.config.nat.rules;
      const i = rules.findIndex((x) => x.kind === 'interface' && x.acl === a.acl);
      if (i >= 0) rules.splice(i, 1);
      if (!s.negated) rules.push({ kind: 'interface', acl: a.acl as string, ifaceId: ref.id });
    },
  });
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      ...NAT,
      K('inside', 'Inside address translation'),
      K('source', 'Source address translation'),
      K('static', 'Specify static local->global mapping'),
      opt(
        choice(
          'proto',
          ['tcp', 'Transmission Control Protocol'],
          ['udp', 'User Datagram Protocol'],
        ),
      ),
      P('local', 'ip', 'A.B.C.D', 'Inside local IP address'),
      opt(P('lport', 'int', '<1-65535>', 'Local UDP/TCP port', [1, 65535])),
      P('global', 'ip', 'A.B.C.D', 'Inside global IP address'),
      opt(P('gport', 'int', '<1-65535>', 'Global UDP/TCP port', [1, 65535])),
    ],
    run: (s, a) => {
      const rules = s.device.config.nat.rules;
      const rule = {
        kind: 'static' as const,
        local: a.local as string,
        global: a.global as string,
        proto: a.proto as 'tcp' | 'udp' | undefined,
        lport: a.lport ? Number(a.lport) : undefined,
        gport: a.gport ? Number(a.gport) : undefined,
      };
      const same = (x: (typeof rules)[number]): boolean =>
        x.kind === 'static' &&
        x.local === rule.local &&
        x.global === rule.global &&
        x.proto === rule.proto;
      const i = rules.findIndex(same);
      if (i >= 0) rules.splice(i, 1);
      if (!s.negated) rules.push(rule);
    },
  });
}

export { compressVlans, ifDisplay, isValidIpv4, maskToPrefix, SUBMODES };
export type { HostConfig };
