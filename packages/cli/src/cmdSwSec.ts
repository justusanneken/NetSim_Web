import {
  DAI_DEFAULT_RATE,
  daiOf,
  liveBindings,
  snoopOf,
  type StormCfg,
  type StormThresh,
  type SwitchConfig,
} from '@netsim/engine';
import { targets } from './commands';
import { IFM, compressVlans, parseVlanList, resolveIface } from './ifnames';
import { K, P, R, choice, opt, type ModeId, type Registry } from './parser';
import { CliError, type CliSession } from './session';
import { ciscoMac, shortName } from './format';

const CF: ModeId[] = ['config'];
const U: ModeId[] = ['user', 'priv'];
const SHOW = K('show', 'Show running system information');
const IP = K('ip', 'Global IP configuration subcommands');
const SW = K('switchport', 'Set switching mode characteristics');
const SNOOP = [IP, K('dhcp', 'Configure DHCP parameters'), K('snooping', 'DHCP Snooping')];
const ARPI = [IP, K('arp', 'Configure ARP features'), K('inspection', 'Configure ARP inspection')];
const STORM = K('storm-control', 'Storm Control command');

export const ERRDISABLE_CAUSES = [
  'all',
  'arp-inspection',
  'bpduguard',
  'dhcp-rate-limit',
  'link-flap',
  'loopback',
  'psecure-violation',
  'storm-control',
  'udld',
] as const;

const sw = (s: CliSession): SwitchConfig => {
  const c = s.device.config;
  if (c.kind !== 'switch') throw new CliError('% Invalid input');
  return c;
};

const portsOf = (s: CliSession): string[] =>
  targets(s).filter((id) => s.device.ports.some((p) => p.id === id));

function setPorts(
  s: CliSession,
  patch: Parameters<CliSession['engine']['setSwitchport']>[2],
): void {
  for (const id of portsOf(s)) s.engine.setSwitchport(s.deviceId, id, patch);
}

const mac6 = (m: string): string => m.toUpperCase();

function parseLevel(txt: string): number {
  const n = Number(txt);
  if (!/^\d+(\.\d+)?$/.test(txt) || n < 0 || n > 100) throw new CliError('% Invalid input');
  return n;
}

const fmtLevel = (t: StormThresh): string =>
  t.unit === 'pct'
    ? `${t.rising}${t.falling !== undefined ? ` ${t.falling}` : ''}`
    : `${t.unit} ${t.rising}${t.falling !== undefined ? ` ${t.falling}` : ''}`;

/** Gesamte Switch-Sicherheit: Snooping, DAI, Storm-Control, Voice-VLAN, errdisable. */
export function addSwitchSecurity(r: Registry<CliSession>): void {
  // ------------------------------------------------------------ DHCP-Snooping (global)
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [...SNOOP],
    run: (s) => {
      snoopOf(sw(s)).enabled = !s.negated;
    },
  });
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [...SNOOP, K('vlan', 'DHCP Snooping vlan'), P('v', 'vlans', 'WORD', 'vlan range')],
    run: (s, a) => {
      const sn = snoopOf(sw(s));
      const list = parseVlanList(a.v as string);
      sn.vlans = s.negated
        ? sn.vlans.filter((v) => !list.includes(v))
        : [...new Set([...sn.vlans, ...list])].sort((x, y) => x - y);
    },
  });
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      ...SNOOP,
      K('information', 'DHCP Snooping Information'),
      K('option', 'DHCP Snooping Information Option'),
    ],
    run: (s) => {
      snoopOf(sw(s)).option82 = !s.negated;
    },
  });
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      ...SNOOP,
      K('information', 'DHCP Snooping Information'),
      K('option', 'DHCP Snooping Information Option'),
      K('allow-untrusted', 'DHCP Snooping Option 82 on untrusted port'),
    ],
    run: (s) => {
      snoopOf(sw(s)).allowUntrusted = !s.negated;
    },
  });
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      ...SNOOP,
      K('verify', 'DHCP Snooping Verify'),
      K('mac-address', 'DHCP Snooping verify mac-address'),
    ],
    run: (s) => {
      snoopOf(sw(s)).verifyMac = !s.negated;
    },
  });
  r.add({
    modes: CF,
    only: 'l3',
    negatable: true,
    slots: [
      IP,
      K('dhcp', 'Configure DHCP parameters'),
      K('relay', 'DHCP relay agent parameters'),
      K('information', 'DHCP relay information option'),
      K('trust-all', 'Received DHCP packets may contain relay info option with zero giaddr'),
    ],
    run: (s) => {
      s.device.config.dhcp.trustAll = !s.negated;
    },
  });
  r.add({
    modes: IFM,
    only: 'l3',
    negatable: true,
    slots: [
      IP,
      K('dhcp', 'Configure DHCP parameters'),
      K('relay', 'DHCP relay agent parameters'),
      K('information', 'DHCP relay information option'),
      K('trusted', 'Received DHCP packets may contain relay info option with zero giaddr'),
    ],
    run: (s) => {
      for (const id of targets(s)) {
        const c = s.device.config.ifaces[id];
        if (c) c.relayTrusted = !s.negated;
      }
    },
  });

  // ------------------------------------------------------------ DHCP-Snooping (Interface)
  r.add({
    modes: IFM,
    only: 'switch',
    negatable: true,
    slots: [...SNOOP, K('trust', 'DHCP Snooping trust config')],
    run: (s) => setPorts(s, { snoopTrust: !s.negated }),
  });
  r.add({
    modes: IFM,
    only: 'switch',
    negatable: true,
    slots: [
      ...SNOOP,
      K('limit', 'DHCP Snooping limit'),
      K('rate', 'DHCP Snooping rate limit'),
      P('n', 'int', '<1-2048>', 'Number of packets per second', [1, 2048]),
    ],
    run: (s, a) => setPorts(s, { snoopRate: s.negated ? undefined : Number(a.n) }),
  });

  // ------------------------------------------------------------ exec: binding
  r.add({
    modes: ['priv'],
    only: 'switch',
    slots: [
      ...SNOOP,
      K('binding', 'DHCP Snooping binding'),
      P('mac', 'mac', 'H.H.H', 'MAC address'),
      K('vlan', 'Set a VLAN'),
      P('v', 'int', '<1-4094>', 'VLAN number', [1, 4094]),
      P('ip', 'ip', 'A.B.C.D', 'IP address'),
      K('interface', 'DHCP Snooping interface'),
      P('if', 'iface', 'IFNAME', 'Interface name'),
      K('expiry', 'Binding expiry time'),
      P('sec', 'int', '<1-4294967295>', 'Seconds', [1, 4294967295]),
    ],
    run: (s, a) => {
      const ref = resolveIface(s.device, a.if as string);
      if (!ref) throw new CliError('% Invalid interface');
      const sn = snoopOf(sw(s));
      const h = (a.mac as string).replace(/\./g, '').toLowerCase();
      const mac = (h.match(/../g) ?? []).join(':');
      sn.bindings = sn.bindings.filter((b) => !(b.mac === mac && b.vlan === Number(a.v)));
      sn.bindings.push({
        mac,
        ip: a.ip as string,
        vlan: Number(a.v),
        portId: ref.id,
        expiresAt: s.engine.state.now + Number(a.sec) * 1_000_000,
        type: 'dhcp-snooping',
      });
    },
  });
  r.add({
    modes: ['priv'],
    only: 'switch',
    slots: [
      K('clear', 'Reset functions'),
      ...SNOOP,
      K('binding', 'DHCP Snooping binding'),
      opt(K('*', 'all')),
    ],
    run: (s) => {
      snoopOf(sw(s)).bindings = [];
    },
  });

  // ------------------------------------------------------------ DAI
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      ...ARPI,
      K('vlan', 'Enable/Disable ARP Inspection on vlans'),
      P('v', 'vlans', 'WORD', 'vlan range'),
    ],
    run: (s, a) => {
      const d = daiOf(sw(s));
      const list = parseVlanList(a.v as string);
      d.vlans = s.negated
        ? d.vlans.filter((v) => !list.includes(v))
        : [...new Set([...d.vlans, ...list])].sort((x, y) => x - y);
    },
  });
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      ...ARPI,
      K('validate', 'Validate addresses'),
      opt(K('src-mac', 'Validate source MAC address')),
      opt(K('dst-mac', 'Validate destination MAC address')),
      opt(K('ip', 'Validate IP addresses')),
    ],
    run: (s, a) => {
      const v = daiOf(sw(s)).validate;
      const words = Object.entries(a)
        .filter(([k]) => /^kw:([4-9])$/.test(k))
        .map(([, v]) => v);
      const on = !s.negated;
      if (words.length === 0) throw new CliError('% Incomplete command.');
      if (words.includes('src-mac')) v.srcMac = on;
      if (words.includes('dst-mac')) v.dstMac = on;
      if (words.includes('ip')) v.ip = on;
    },
  });
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      ...ARPI,
      K('filter', 'Specify ARP acl to be applied'),
      P('acl', 'word', 'WORD', 'ARP acl name'),
      K('vlan', 'Enable/Disable ARP Inspection on vlans'),
      P('v', 'vlans', 'WORD', 'vlan range'),
      opt(K('static', 'Apply the ACL without DHCP bindings')),
    ],
    run: (s, a) => {
      const d = daiOf(sw(s));
      for (const v of parseVlanList(a.v as string)) {
        d.filters = d.filters.filter((f) => f.vlan !== v);
        if (!s.negated) d.filters.push({ acl: a.acl as string, vlan: v, static: !!a['kw:7'] });
      }
    },
  });
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      K('arp', 'Configure ARP features'),
      K('access-list', 'Specify ARP access list'),
      P('name', 'word', 'WORD', 'ARP access list name'),
    ],
    run: (s, a) => {
      const d = daiOf(sw(s));
      const name = a.name as string;
      if (s.negated) {
        delete d.acls[name];
        return;
      }
      d.acls[name] ??= [];
      s.aclName = name;
      s.mode = 'config-arp-nacl';
    },
  });
  r.add({
    modes: ['config-arp-nacl'],
    only: 'switch',
    negatable: true,
    slots: [
      choice(
        'act',
        ['permit', 'Specify packets to forward'],
        ['deny', 'Specify packets to reject'],
      ),
      K('ip', 'IP address'),
      K('host', 'Single sender host'),
      P('ip', 'ip', 'A.B.C.D', 'Sender IP address'),
      K('mac', 'Sender MAC address'),
      K('host', 'Single sender host'),
      P('mac', 'mac', 'H.H.H', 'Sender MAC address'),
      opt(K('log', 'Log on match')),
    ],
    run: (s, a) => {
      const acl = (daiOf(sw(s)).acls[s.aclName] ??= []);
      const h = (a.mac as string).replace(/\./g, '').toLowerCase();
      const mac = (h.match(/../g) ?? []).join(':');
      const i = acl.findIndex((e) => e.ip === a.ip && e.mac === mac);
      if (s.negated) {
        if (i >= 0) acl.splice(i, 1);
      } else if (a.act === 'permit' && i < 0) acl.push({ ip: a.ip as string, mac });
    },
  });
  r.add({
    modes: IFM,
    only: 'switch',
    negatable: true,
    slots: [...ARPI, K('trust', 'Trust ARP packets on this interface')],
    run: (s) => setPorts(s, { daiTrust: !s.negated }),
  });
  r.add({
    modes: IFM,
    only: 'switch',
    negatable: true,
    slots: [
      ...ARPI,
      K('limit', 'Configure Rate limit of incoming ARP packets'),
      K('rate', 'Rate limit'),
      P('n', 'int', '<0-2048>', 'Packets per second', [0, 2048]),
      opt(K('burst', 'Configure Burst parameters')),
      opt(K('interval', 'Burst interval')),
      opt(P('sec', 'int', '<1-15>', 'Burst interval in seconds', [1, 15])),
    ],
    run: (s, a) =>
      setPorts(s, {
        daiRate: s.negated ? undefined : Number(a.n),
        daiBurst: s.negated || !a.sec ? undefined : Number(a.sec),
      }),
  });

  // ------------------------------------------------------------ Storm-Control
  r.add({
    modes: IFM,
    only: 'switch',
    negatable: true,
    slots: [
      STORM,
      choice(
        't',
        ['broadcast', 'Broadcast address storm control'],
        ['multicast', 'Multicast address storm control'],
        ['unicast', 'Unicast address storm control'],
      ),
      K('level', 'Enable port storm control on a given type'),
      opt(
        choice(
          'unit',
          ['bps', 'Enter suppression level in bits per second'],
          ['pps', 'Enter suppression level in packets per second'],
        ),
      ),
      P('rise', 'word', '<0.00 - 100.00>', 'Rising threshold'),
      opt(P('fall', 'word', '<0.00 - 100.00>', 'Falling threshold')),
    ],
    run: (s, a) => {
      const t = a.t as 'broadcast' | 'multicast' | 'unicast';
      const unit = (a.unit as 'bps' | 'pps' | undefined) ?? 'pct';
      const num = (x: string): number => (unit === 'pct' ? parseLevel(x) : Number(x));
      const th: StormThresh = { unit, rising: s.negated ? 0 : num(a.rise as string) };
      if (a.fall) th.falling = num(a.fall);
      for (const id of portsOf(s)) {
        const pc = sw(s).ports[id];
        if (!pc) continue;
        const cur: StormCfg = { ...(pc.storm ?? { action: 'filter' }) };
        if (s.negated) delete cur[t];
        else cur[t] = th;
        const any = cur.broadcast || cur.multicast || cur.unicast;
        s.engine.setSwitchport(s.deviceId, id, { storm: any ? cur : undefined });
      }
    },
  });
  r.add({
    modes: IFM,
    only: 'switch',
    negatable: true,
    slots: [
      STORM,
      K('action', 'Action to take for storm-control'),
      opt(
        choice(
          'act',
          ['shutdown', 'Shutdown this interface if a storm occurs'],
          ['trap', 'Send SNMP trap if a storm occurs'],
        ),
      ),
    ],
    run: (s, a) => {
      if (!s.negated && !a.act) throw new CliError('% Incomplete command.');
      for (const id of portsOf(s)) {
        const pc = sw(s).ports[id];
        if (!pc) continue;
        const cur: StormCfg = { ...(pc.storm ?? { action: 'filter' }) };
        cur.action = s.negated ? 'filter' : (a.act as 'shutdown' | 'trap');
        const any = cur.broadcast || cur.multicast || cur.unicast;
        s.engine.setSwitchport(s.deviceId, id, { storm: any || !s.negated ? cur : undefined });
      }
    },
  });

  // ------------------------------------------------------------ Voice VLAN, DTP, PortFast
  r.add({
    modes: IFM,
    only: 'switch',
    negatable: true,
    slots: [
      SW,
      K('voice', 'Voice appliance attributes'),
      K('vlan', 'Set VLAN when using a voice appliance'),
      choice(
        'v',
        ['dot1p', 'Set priority tag for voice traffic'],
        ['untagged', 'Use untagged voice traffic'],
        ['none', 'Do not tell the voice appliance anything'],
      ),
    ],
    run: (s, a) =>
      setPorts(s, {
        voiceVlan: s.negated || a.v === 'none' ? undefined : (a.v as 'dot1p' | 'untagged'),
      }),
  });
  r.add({
    modes: IFM,
    only: 'switch',
    negatable: true,
    slots: [
      SW,
      K('voice', 'Voice appliance attributes'),
      K('vlan', 'Set VLAN when using a voice appliance'),
      P('vid', 'int', '<1-4094>', 'Vlan for voice traffic', [1, 4094]),
    ],
    run: (s, a) => setPorts(s, { voiceVlan: s.negated ? undefined : Number(a.vid) }),
  });
  r.add({
    modes: IFM,
    only: 'switch',
    negatable: true,
    slots: [
      SW,
      K('nonegotiate', 'Device will not engage in negotiation protocol on this interface'),
    ],
    run: (s) => {
      if (!s.negated)
        for (const id of portsOf(s)) {
          const m = sw(s).ports[id]?.mode;
          if (m === 'dynamic-auto' || m === 'dynamic-desirable')
            throw new CliError(
              "Command rejected: Conflict between 'nonegotiate' and 'dynamic' status.",
            );
        }
      setPorts(s, { nonegotiate: !s.negated });
    },
  });
  r.add({
    modes: IFM,
    only: 'switch',
    negatable: true,
    slots: [
      K('spanning-tree', 'Spanning Tree Subsystem'),
      K('portfast', 'Enable an interface to move directly to forwarding on link up'),
      K('disable', 'Disable portfast for this interface'),
    ],
    run: (s) => setPorts(s, { portfastOff: !s.negated }),
  });
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      K('spanning-tree', 'Spanning Tree Subsystem'),
      K('portfast', 'Spanning tree portfast options'),
      K('default', 'Enable portfast by default on all access ports'),
    ],
    run: (s) => {
      sw(s).portfastDefault = !s.negated;
      s.engine.setStp(s.deviceId, {});
    },
  });
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      K('spanning-tree', 'Spanning Tree Subsystem'),
      K('portfast', 'Spanning tree portfast options'),
      K('bpduguard', 'Enable bpdu guard by default on all portfast ports'),
      K('default', 'Enable bpduguard by default on all portfast ports'),
    ],
    run: (s) => {
      sw(s).bpduguardDefault = !s.negated;
      s.engine.setStp(s.deviceId, {});
    },
  });
  r.add({
    modes: IFM,
    only: 'switch',
    negatable: true,
    slots: [
      SW,
      K('port-security', 'Security related command'),
      K('aging', 'Port-security aging commands'),
      K('time', 'Port-security aging time'),
      P('min', 'int', '<0-1440>', 'Aging time in minutes', [0, 1440]),
    ],
    run: (s, a) => {
      for (const id of portsOf(s)) {
        const pc = sw(s).ports[id];
        if (pc)
          s.engine.setSwitchport(s.deviceId, id, {
            psec: { ...pc.psec, agingTime: s.negated ? 0 : Number(a.min) },
          });
      }
    },
  });
  r.add({
    modes: IFM,
    only: 'switch',
    negatable: true,
    slots: [
      SW,
      K('port-security', 'Security related command'),
      K('aging', 'Port-security aging commands'),
      K('type', 'Port-security aging type'),
      choice(
        't',
        ['absolute', 'Absolute aging (default)'],
        ['inactivity', 'Aging based on inactivity time period'],
      ),
    ],
    run: (s, a) => {
      for (const id of portsOf(s)) {
        const pc = sw(s).ports[id];
        if (pc)
          s.engine.setSwitchport(s.deviceId, id, {
            psec: {
              ...pc.psec,
              agingType: s.negated ? undefined : (a.t as 'absolute' | 'inactivity'),
            },
          });
      }
    },
  });

  // ------------------------------------------------------------ errdisable
  r.add({
    modes: CF,
    only: 'switch',
    negatable: true,
    slots: [
      K('errdisable', 'Error disable'),
      K('recovery', 'Configure errdisable recovery'),
      K('cause', 'Enable error disable for:'),
      choice(
        'c',
        ...ERRDISABLE_CAUSES.map(
          (c) => [c, `Timer to recover from ${c} error disable state`] as [string, string],
        ),
      ),
    ],
    run: (s, a) => {
      const rec = sw(s).errdisableRecovery;
      const c = a.c as string;
      const set = new Set(rec.causes ?? []);
      if (s.negated) set.delete(c);
      else set.add(c);
      if (c === 'psecure-violation') rec.psecure = !s.negated;
      if (c === 'all' && s.negated) {
        set.clear();
        rec.psecure = false;
      }
      set.delete('psecure-violation');
      rec.causes = [...set].sort();
    },
  });

  // ------------------------------------------------------------ show
  const swOnly = 'switch' as const;
  r.add({
    modes: U,
    only: swOnly,
    slots: [SHOW, ...SNOOP],
    run: (s) => s.outLines(showSnooping(s)),
  });
  r.add({
    modes: U,
    only: swOnly,
    slots: [SHOW, ...SNOOP, K('binding', 'DHCP Snooping binding entries')],
    run: (s) => s.outLines(showBindings(s)),
  });
  r.add({
    modes: U,
    only: swOnly,
    slots: [
      SHOW,
      ...SNOOP,
      K('statistics', 'DHCP Snooping statistics'),
      opt(K('detail', 'Detailed statistics')),
    ],
    run: (s) => {
      const st = snoopOf(sw(s)).stats;
      s.outLines([
        ` Packets Forwarded                                     = ${st.forwarded}`,
        ` Packets Dropped                                       = ${st.untrustedDrop + st.macFail + st.opt82Drop + st.rateDrop}`,
        ` Packets Dropped From untrusted ports                  = ${st.untrustedDrop}`,
        ` Packets Dropped Because of chaddr/MAC mismatch        = ${st.macFail}`,
        ` Packets Dropped Because of option82 or giaddr         = ${st.opt82Drop}`,
        ` Packets Dropped Because of rate limit                 = ${st.rateDrop}`,
      ]);
    },
  });
  r.add({
    modes: U,
    only: swOnly,
    slots: [
      SHOW,
      ...ARPI.slice(0, 2),
      K('inspection', 'Show ARP inspection'),
      opt(K('vlan', 'Show vlan information')),
      opt(P('v', 'int', '<1-4094>', 'VLAN', [1, 4094])),
    ],
    run: (s, a) => s.outLines(showDai(s, a.v ? Number(a.v) : undefined)),
  });
  r.add({
    modes: U,
    only: swOnly,
    slots: [
      SHOW,
      K('ip', 'IP information'),
      K('arp', 'IP ARP table'),
      K('inspection', 'Show ARP inspection'),
      K('interfaces', 'Show ARP inspection interfaces'),
    ],
    run: (s) => s.outLines(showDaiIfs(s)),
  });
  r.add({
    modes: U,
    only: swOnly,
    slots: [
      SHOW,
      K('arp', 'ARP table'),
      K('access-list', 'List access lists'),
      opt(P('name', 'word', 'WORD', 'ARP access list name')),
    ],
    run: (s, a) => {
      const acls = daiOf(sw(s)).acls;
      for (const [n, es] of Object.entries(acls)) {
        if (a.name && a.name !== n) continue;
        s.outLines([
          `ARP access list ${n}`,
          ...es.map((e) => `    permit ip host ${e.ip} mac host ${ciscoMac(e.mac)}`),
        ]);
      }
    },
  });
  r.add({
    modes: U,
    only: swOnly,
    slots: [
      SHOW,
      K('storm-control', 'Show storm control'),
      opt(
        choice('t', ['broadcast', 'Broadcast'], ['multicast', 'Multicast'], ['unicast', 'Unicast']),
      ),
    ],
    run: (s, a) => s.outLines(showStorm(s, a.t as string | undefined)),
  });
  r.add({
    modes: U,
    only: swOnly,
    slots: [
      SHOW,
      K('errdisable', 'Show errdisable status'),
      K('recovery', 'Show errdisable recovery'),
    ],
    run: (s) => s.outLines(showErrdisableRecovery(s)),
  });
  r.add({
    modes: U,
    only: swOnly,
    slots: [SHOW, K('errdisable', 'Show errdisable status'), K('detect', 'Show errdisable detect')],
    run: (s) =>
      s.outLines([
        'ErrDisable Reason            Detection    Mode',
        '-----------------            ---------    ----',
        ...[
          'arp-inspection',
          'bpduguard',
          'dhcp-rate-limit',
          'link-flap',
          'loopback',
          'psecure-violation',
          'storm-control',
          'udld',
        ].map((c) => `${c.padEnd(29)}Enabled      port`),
      ]),
  });
  r.add({
    modes: U,
    only: swOnly,
    slots: [
      SHOW,
      K('port-security', 'Show secure port information'),
      K('address', 'Show secure address'),
    ],
    run: (s) => s.outLines(showPsecAddr(s)),
  });
  r.add({
    modes: U,
    only: swOnly,
    slots: [
      SHOW,
      K('interfaces', 'Interface status and configuration'),
      K('status', 'Show interface line status'),
      K('err-disabled', 'Show interfaces in err-disabled state'),
    ],
    run: (s) => {
      const all = s.engine.state.devices[s.deviceId]?.ports ?? [];
      const out = ['Port      Name               Status       Vlan       Duplex  Speed Type'];
      for (const p of all.filter((x) => x.errdisabled))
        out.push(
          `${shortName(p.name).padEnd(10)}${(s.sys.descriptions[p.id] ?? '').slice(0, 18).padEnd(19)}${'err-disabled'.padEnd(13)}${String(sw(s).ports[p.id]?.accessVlan ?? 1).padEnd(11)}${'auto'.padEnd(8)}${'auto'.padEnd(6)}${p.kind === 'ge' ? '10/100/1000BaseTX' : '10/100BaseTX'}`,
        );
      s.outLines(out.length > 1 ? out : []);
    },
  });
  r.add({
    modes: ['priv'],
    only: swOnly,
    slots: [
      K('clear', 'Reset functions'),
      K('port-security', 'Clear dynamic secure addresses'),
      choice(
        't',
        ['dynamic', 'Clear dynamic secure addresses'],
        ['sticky', 'Clear sticky secure addresses'],
      ),
      opt(K('interface', 'Interface')),
    ],
    run: (s, a) => {
      for (const p of s.device.ports) {
        const pc = sw(s).ports[p.id];
        if (!pc) continue;
        pc.psec.dynMacs = [];
        if (a.t === 'sticky' && pc.psec.sticky) pc.psec.macs = [];
      }
    },
  });
  r.add({
    modes: ['priv'],
    only: swOnly,
    slots: [
      K('clear', 'Reset functions'),
      K('ip', 'IP'),
      K('arp', 'ARP'),
      K('inspection', 'Clear ARP inspection'),
      K('statistics', 'Clear statistics'),
    ],
    run: (s) => {
      daiOf(sw(s)).stats = {};
    },
  });
}

// ---------------------------------------------------------------- show-Ausgaben

function showSnooping(s: CliSession): string[] {
  const cfg = sw(s);
  const sn = snoopOf(cfg);
  const vl = compressVlans(sn.vlans);
  const L = [
    `Switch DHCP snooping is ${sn.enabled ? 'enabled' : 'disabled'}`,
    'DHCP snooping is configured on following VLANs:',
    vl,
    'DHCP snooping is operational on following VLANs:',
    sn.enabled ? vl : '',
    'DHCP snooping is configured on the following L3 Interfaces:',
    '',
    `Insertion of option 82 is ${sn.option82 ? 'enabled' : 'disabled'}`,
    '   circuit-id default format: vlan-mod-port',
    `   remote-id: ${ciscoMac(s.device.ports[0]?.mac ?? '')} (MAC)`,
    `Option 82 on untrusted port is ${sn.allowUntrusted ? '' : 'not '}allowed`,
    `Verification of hwaddr field is ${sn.verifyMac ? 'enabled' : 'disabled'}`,
    'Verification of giaddr field is enabled',
    'DHCP snooping trust/rate is configured on the following Interfaces:',
    '',
    'Interface                  Trusted    Allow option    Rate limit (pps)',
    '-----------------------    -------    ------------    ----------------',
  ];
  for (const p of s.device.ports) {
    const pc = cfg.ports[p.id];
    if (!pc?.snoopTrust && pc?.snoopRate === undefined) continue;
    L.push(
      `${p.name.padEnd(27)}${(pc.snoopTrust ? 'yes' : 'no').padEnd(11)}${(sn.allowUntrusted ? 'yes' : 'no').padEnd(16)}${pc.snoopRate ?? 'unlimited'}`,
    );
  }
  return L;
}

function showBindings(s: CliSession): string[] {
  const cfg = sw(s);
  const b = liveBindings(cfg, s.engine.state.now);
  const L = [
    'MacAddress          IpAddress        Lease(sec)  Type           VLAN  Interface',
    '------------------  ---------------  ----------  -------------  ----  --------------------',
  ];
  for (const x of b) {
    const port = s.device.ports.find((p) => p.id === x.portId)?.name ?? x.portId;
    const lease =
      x.type === 'static' ? 0 : Math.max(0, Math.round((x.expiresAt - s.engine.state.now) / 1e6));
    L.push(
      `${mac6(x.mac).padEnd(20)}${x.ip.padEnd(17)}${String(lease).padEnd(12)}${x.type.padEnd(15)}${String(x.vlan).padEnd(6)}${port}`,
    );
  }
  L.push(`Total number of bindings: ${b.length}`);
  return L;
}

function showDai(s: CliSession, only?: number): string[] {
  const d = daiOf(sw(s));
  const on = (b: boolean): string => (b ? 'Enabled' : 'Disabled');
  const vl = d.vlans.filter((v) => only === undefined || v === only);
  const L = [
    `Source Mac Validation      : ${on(d.validate.srcMac)}`,
    `Destination Mac Validation : ${on(d.validate.dstMac)}`,
    `IP Address Validation      : ${on(d.validate.ip)}`,
    '',
    ' Vlan     Configuration    Operation   ACL Match          Static ACL',
    ' ----     -------------    ---------   ---------          ----------',
  ];
  for (const v of vl) {
    const f = d.filters.find((x) => x.vlan === v);
    L.push(
      `${String(v).padStart(5)}     ${'Enabled'.padEnd(17)}${'Active'.padEnd(12)}${(f?.acl ?? '').padEnd(19)}${f ? (f.static ? 'Yes' : 'No') : ''}`,
    );
  }
  const row = (cols: number[], v: number): string =>
    `${String(v).padStart(5)}${cols.map((c) => String(c).padStart(15)).join('')}`;
  const stats = (v: number) =>
    d.stats[v] ?? {
      forwarded: 0,
      dropped: 0,
      dhcpDrops: 0,
      dhcpPermits: 0,
      aclDrops: 0,
      aclPermits: 0,
      srcMacFail: 0,
      dstMacFail: 0,
      ipFail: 0,
    };
  L.push(
    '',
    ' Vlan      Forwarded        Dropped     DHCP Drops      ACL Drops',
    ' ----      ---------        -------     ----------      ---------',
  );
  for (const v of vl)
    L.push(row([stats(v).forwarded, stats(v).dropped, stats(v).dhcpDrops, stats(v).aclDrops], v));
  L.push(
    '',
    ' Vlan   DHCP Permits    ACL Permits  Probe Permits   Source MAC Failures',
    ' ----   ------------    -----------  -------------   -------------------',
  );
  for (const v of vl)
    L.push(row([stats(v).dhcpPermits, stats(v).aclPermits, 0, stats(v).srcMacFail], v));
  L.push(
    '',
    ' Vlan   Dest MAC Failures   IP Validation Failures   Invalid Protocol Data',
    ' ----   -----------------   ----------------------   ---------------------',
  );
  for (const v of vl) L.push(row([stats(v).dstMacFail, stats(v).ipFail, 0], v));
  return L;
}

function showDaiIfs(s: CliSession): string[] {
  const cfg = sw(s);
  const L = [
    ' Interface        Trust State     Rate (pps)    Burst Interval',
    ' ---------------  -----------     ----------    --------------',
  ];
  for (const p of s.device.ports) {
    const pc = cfg.ports[p.id];
    if (!pc) continue;
    const short = shortName(p.name).replace('Fa', 'Fa').replace('Gi', 'Gi');
    L.push(
      pc.daiTrust
        ? ` ${short.padEnd(17)}${'Trusted'.padEnd(16)}${'None'.padStart(10)}${'N/A'.padStart(18)}`
        : ` ${short.padEnd(17)}${'Untrusted'.padEnd(16)}${String(pc.daiRate ?? DAI_DEFAULT_RATE).padStart(10)}${String(pc.daiBurst ?? 1).padStart(18)}`,
    );
  }
  return L;
}

function showStorm(s: CliSession, type?: string): string[] {
  const cfg = sw(s);
  const L = [
    'Interface  Filter State   Upper        Lower        Current',
    '---------  -------------  -----------  -----------  -------',
  ];
  for (const p of s.device.ports) {
    const sc = cfg.ports[p.id]?.storm;
    if (!sc) continue;
    for (const t of ['broadcast', 'multicast', 'unicast'] as const) {
      if (type && type !== t) continue;
      const th = sc[t];
      if (!th) continue;
      const state = p.errdisabled ? 'Shutdown' : p.operUp ? 'Forwarding' : 'Link Down';
      const up = th.unit === 'pct' ? `${th.rising.toFixed(2)}%` : `${th.rising} ${th.unit}`;
      const lo =
        th.unit === 'pct'
          ? `${(th.falling ?? th.rising).toFixed(2)}%`
          : `${th.falling ?? th.rising} ${th.unit}`;
      L.push(
        `${shortName(p.name).padEnd(11)}${state.padEnd(15)}${up.padStart(10)}${lo.padStart(13)}${(th.unit === 'pct' ? '0.00%' : '0 ' + th.unit).padStart(9)}`,
      );
    }
  }
  return L;
}

function showErrdisableRecovery(s: CliSession): string[] {
  const rec = sw(s).errdisableRecovery;
  const all = [
    'arp-inspection',
    'bpduguard',
    'channel-misconfig (STP)',
    'dhcp-rate-limit',
    'dtp-flap',
    'gbic-invalid',
    'inline-power',
    'l2ptguard',
    'link-flap',
    'mac-limit',
    'link-monitor-failure',
    'loopback',
    'oam-remote-failure',
    'pagp-flap',
    'port-mode-failure',
    'pppoe-ia-rate-limit',
    'psecure-violation',
    'security-violation',
    'sfp-config-mismatch',
    'storm-control',
    'udld',
    'unicast-flood',
    'vmps',
  ];
  const on = (c: string): boolean =>
    !!rec.causes?.includes('all') ||
    !!rec.causes?.includes(c) ||
    (c === 'psecure-violation' && rec.psecure);
  const L = [
    'ErrDisable Reason            Timer Status',
    '-----------------            --------------',
  ];
  for (const c of all) L.push(`${c.padEnd(29)}${on(c) ? 'Enabled' : 'Disabled'}`);
  L.push('', `Timer interval: ${rec.intervalSec} seconds`);
  const dis = s.device.ports.filter((p) => p.errdisabled && on(p.errdisabled));
  if (dis.length > 0) {
    L.push(
      '',
      'Interfaces that will be enabled at the next timeout:',
      '',
      'Interface      Errdisable reason      Time left(sec)',
      '---------      -----------------      --------------',
    );
    for (const p of dis) {
      const left = Math.max(
        0,
        rec.intervalSec - Math.floor((s.engine.state.now - (p.errdisabledAt ?? 0)) / 1e6),
      );
      L.push(
        `${shortName(p.name).padEnd(15)}${(p.errdisabled ?? '').padEnd(23)}${String(left).padStart(6)}`,
      );
    }
  }
  return L;
}

function showPsecAddr(s: CliSession): string[] {
  const cfg = sw(s);
  const L = [
    '               Secure Mac Address Table',
    '-------------------------------------------------------------------',
    'Vlan    Mac Address       Type                          Ports   Remaining Age',
    '                                                                   (mins)',
    '----    -----------       ----                          -----   -------------',
  ];
  let n = 0;
  for (const p of s.device.ports) {
    const ps = cfg.ports[p.id]?.psec;
    if (!ps?.enabled) continue;
    const vlan = cfg.ports[p.id]?.accessVlan ?? 1;
    for (const m of ps.macs) {
      L.push(
        `${String(vlan).padStart(4)}    ${ciscoMac(m)}   ${(ps.sticky ? 'SecureSticky' : 'SecureConfigured').padEnd(30)}${shortName(p.name).padEnd(8)}-`,
      );
      n++;
    }
    for (const m of ps.dynMacs) {
      L.push(
        `${String(vlan).padStart(4)}    ${ciscoMac(m)}   ${'SecureDynamic'.padEnd(30)}${shortName(p.name).padEnd(8)}-`,
      );
      n++;
    }
  }
  L.push(
    '-------------------------------------------------------------------',
    `Total Addresses in System (excluding one mac per port)     : ${Math.max(0, n)}`,
    'Max Addresses limit in System (excluding one mac per port) : 6144',
  );
  return L;
}

// ---------------------------------------------------------------- Rendering

/** Globale Zeilen der running-config. */
export function swSecGlobalLines(cfg: SwitchConfig): string[] {
  const L: string[] = [];
  const sn = cfg.snoop;
  if (sn) {
    if (sn.enabled) L.push('ip dhcp snooping');
    if (sn.vlans.length) L.push(`ip dhcp snooping vlan ${compressVlans(sn.vlans)}`);
    if (!sn.option82) L.push('no ip dhcp snooping information option');
    if (sn.allowUntrusted) L.push('ip dhcp snooping information option allow-untrusted');
    if (!sn.verifyMac) L.push('no ip dhcp snooping verify mac-address');
  }
  const d = cfg.dai;
  if (d) {
    for (const [name, es] of Object.entries(d.acls)) {
      L.push(`arp access-list ${name}`);
      for (const e of es) L.push(` permit ip host ${e.ip} mac host ${ciscoMac(e.mac)}`);
      L.push('!');
    }
    if (d.vlans.length) L.push(`ip arp inspection vlan ${compressVlans(d.vlans)}`);
    const v = [
      d.validate.srcMac && 'src-mac',
      d.validate.dstMac && 'dst-mac',
      d.validate.ip && 'ip',
    ].filter(Boolean);
    if (v.length) L.push(`ip arp inspection validate ${v.join(' ')}`);
    for (const f of d.filters)
      L.push(`ip arp inspection filter ${f.acl} vlan ${f.vlan}${f.static ? ' static' : ''}`);
  }
  if (cfg.portfastDefault) L.push('spanning-tree portfast default');
  if (cfg.bpduguardDefault) L.push('spanning-tree portfast bpduguard default');
  const causes = [
    ...(cfg.errdisableRecovery.causes ?? []),
    ...(cfg.errdisableRecovery.psecure ? ['psecure-violation'] : []),
  ].sort();
  for (const c of causes) L.push(`errdisable recovery cause ${c}`);
  return L;
}

/** Zeilen je Switchport. */
export function swSecIfLines(cfg: SwitchConfig, portId: string): string[] {
  const pc = cfg.ports[portId];
  if (!pc) return [];
  const L: string[] = [];
  if (pc.voiceVlan !== undefined) L.push(` switchport voice vlan ${pc.voiceVlan}`);
  if (pc.nonegotiate) L.push(' switchport nonegotiate');
  const ps = pc.psec;
  if (ps.enabled && ps.agingTime) L.push(` switchport port-security aging time ${ps.agingTime}`);
  if (ps.enabled && ps.agingType) L.push(` switchport port-security aging type ${ps.agingType}`);
  if (pc.portfastOff) L.push(' spanning-tree portfast disable');
  if (pc.storm) {
    for (const t of ['broadcast', 'multicast', 'unicast'] as const) {
      const th = pc.storm[t];
      if (th) L.push(` storm-control ${t} level ${fmtLevel(th)}`);
    }
    if (pc.storm.action !== 'filter') L.push(` storm-control action ${pc.storm.action}`);
  }
  if (pc.snoopTrust) L.push(' ip dhcp snooping trust');
  if (pc.snoopRate !== undefined) L.push(` ip dhcp snooping limit rate ${pc.snoopRate}`);
  if (pc.daiTrust) L.push(' ip arp inspection trust');
  if (pc.daiRate !== undefined)
    L.push(
      ` ip arp inspection limit rate ${pc.daiRate}${pc.daiBurst ? ` burst interval ${pc.daiBurst}` : ''}`,
    );
  return L;
}
void R;
