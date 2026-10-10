import { discOf, type L3Cfg } from '@netsim/engine';
import { targets } from './commands';
import { IFM, resolveIface } from './ifnames';
import { K, P, opt, type ModeId, type Registry } from './parser';
import { CliError, type CliSession } from './session';
import {
  showCdp,
  showCdpDetail,
  showCdpInterface,
  showCdpNeighbors,
  showCdpTraffic,
  showLldp,
  showLldpInterface,
  showLldpNeighbors,
  showLldpTraffic,
} from './showDisc';

const CF: ModeId[] = ['config'];
const U: ModeId[] = ['user', 'priv'];
const SHOW = K('show', 'Show running system information');
const CDP = K('cdp', 'Global CDP configuration subcommands');
const LLDP = K('lldp', 'Global LLDP configuration subcommands');

const cfgOf = (s: CliSession): L3Cfg => s.device.config as unknown as L3Cfg;

const toggle = (list: string[], id: string, on: boolean): string[] =>
  on ? [...new Set([...list, id])] : list.filter((x) => x !== id);

/** CDP und LLDP: Konfiguration, `show`-Befehle, `clear`. */
export function addDiscovery(r: Registry<CliSession>): void {
  // ------------------------------------------------------------ global
  r.add({
    modes: CF,
    negatable: true,
    slots: [CDP, K('run', 'Enable CDP')],
    run: (s) => {
      discOf(cfgOf(s)).cdpRun = !s.negated;
      s.engine.discChanged(s.deviceId);
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      CDP,
      K('timer', 'Specify rate at which CDP packets are sent (in sec)'),
      P('sec', 'int', '<5-254>', 'Rate at which CDP packets are sent (in sec)', [5, 254]),
    ],
    run: (s, a) => {
      discOf(cfgOf(s)).cdpTimer = s.negated ? 60 : Number(a.sec);
      s.engine.discChanged(s.deviceId);
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      CDP,
      K('holdtime', 'Specify the holdtime (in sec) to be sent in packets'),
      P(
        'sec',
        'int',
        '<10-255>',
        'Length of time (in sec) that receiver must keep this packet',
        [10, 255],
      ),
    ],
    run: (s, a) => {
      discOf(cfgOf(s)).cdpHold = s.negated ? 180 : Number(a.sec);
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [LLDP, K('run', 'Enable LLDP')],
    run: (s) => {
      discOf(cfgOf(s)).lldpRun = !s.negated;
      s.engine.discChanged(s.deviceId);
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      LLDP,
      K('timer', 'Specify rate at which LLDP packets are sent (in sec)'),
      P('sec', 'int', '<5-65534>', 'LLDP rate at which packets are sent (in sec)', [5, 65534]),
    ],
    run: (s, a) => {
      discOf(cfgOf(s)).lldpTimer = s.negated ? 30 : Number(a.sec);
      s.engine.discChanged(s.deviceId);
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      LLDP,
      K('holdtime', 'Specify the holdtime of LLDP packets (in sec)'),
      P('sec', 'int', '<0-65535>', 'LLDP hold time to be sent in packets (in sec)', [0, 65535]),
    ],
    run: (s, a) => {
      discOf(cfgOf(s)).lldpHold = s.negated ? 120 : Number(a.sec);
    },
  });
  r.add({
    modes: CF,
    negatable: true,
    slots: [
      LLDP,
      K('reinit', 'Specify the delay (in sec) for LLDP initialization on any interface'),
      P('sec', 'int', '<1-10>', 'LLDP initialization delay (in sec)', [1, 10]),
    ],
    run: (s, a) => {
      discOf(cfgOf(s)).lldpReinit = s.negated ? 2 : Number(a.sec);
    },
  });

  // ------------------------------------------------------------ Interface
  r.add({
    modes: IFM,
    negatable: true,
    slots: [CDP, K('enable', 'Enable CDP on interface')],
    run: (s) => {
      const d = discOf(cfgOf(s));
      for (const id of targets(s))
        if (s.device.ports.some((p) => p.id === id)) d.cdpOff = toggle(d.cdpOff, id, s.negated);
    },
  });
  r.add({
    modes: IFM,
    negatable: true,
    slots: [LLDP, K('transmit', 'Enable LLDP packet transmit on interface')],
    run: (s) => {
      const d = discOf(cfgOf(s));
      for (const id of targets(s)) d.lldpTxOff = toggle(d.lldpTxOff, id, s.negated);
    },
  });
  r.add({
    modes: IFM,
    negatable: true,
    slots: [LLDP, K('receive', 'Enable LLDP packet reception on interface')],
    run: (s) => {
      const d = discOf(cfgOf(s));
      for (const id of targets(s)) d.lldpRxOff = toggle(d.lldpRxOff, id, s.negated);
    },
  });

  // ------------------------------------------------------------ show cdp
  const now = (s: CliSession): number => s.engine.state.now;
  r.add({ modes: U, slots: [SHOW, CDP], run: (s) => s.outLines(showCdp(s.device)) });
  r.add({
    modes: U,
    slots: [
      SHOW,
      CDP,
      K('neighbors', 'CDP neighbor entries'),
      opt(K('detail', 'Show detailed information')),
    ],
    run: (s, a) =>
      s.outLines(a['kw:3'] ? showCdpDetail(s.device, now(s)) : showCdpNeighbors(s.device, now(s))),
  });
  r.add({
    modes: U,
    slots: [
      SHOW,
      CDP,
      K('neighbors', 'CDP neighbor entries'),
      P('if', 'iface', 'IFNAME', 'Interface name'),
      opt(K('detail', 'Show detailed information')),
    ],
    run: (s, a) => {
      const ref = resolveIface(s.device, a.if as string);
      if (!ref) throw new CliError('% Invalid interface');
      s.outLines(
        a['kw:4']
          ? showCdpDetail(s.device, now(s), undefined, ref.id)
          : showCdpNeighbors(s.device, now(s), ref.id),
      );
    },
  });
  r.add({
    modes: U,
    slots: [
      SHOW,
      CDP,
      K('entry', 'Information for specific neighbor entry'),
      P('name', 'word', 'WORD', 'Name of CDP neighbor entry'),
    ],
    run: (s, a) => s.outLines(showCdpDetail(s.device, now(s), a.name as string)),
  });
  r.add({
    modes: U,
    slots: [SHOW, CDP, K('interface', 'CDP interface status and configuration')],
    run: (s) => s.outLines(showCdpInterface(s.device)),
  });
  r.add({
    modes: U,
    slots: [
      SHOW,
      CDP,
      K('interface', 'CDP interface status and configuration'),
      P('if', 'iface', 'IFNAME', 'Interface name'),
    ],
    run: (s, a) => {
      const ref = resolveIface(s.device, a.if as string);
      if (!ref) throw new CliError('% Invalid interface');
      s.outLines(showCdpInterface(s.device, ref.id));
    },
  });
  r.add({
    modes: U,
    slots: [SHOW, CDP, K('traffic', 'CDP statistics')],
    run: (s) => s.outLines(showCdpTraffic(s.device)),
  });

  // ------------------------------------------------------------ show lldp
  r.add({ modes: U, slots: [SHOW, LLDP], run: (s) => s.outLines(showLldp(s.device)) });
  r.add({
    modes: U,
    slots: [
      SHOW,
      LLDP,
      K('neighbors', 'LLDP neighbor entries'),
      opt(K('detail', 'Show detailed information')),
    ],
    run: (s, a) => s.outLines(showLldpNeighbors(s.device, now(s), !!a['kw:3'])),
  });
  r.add({
    modes: U,
    slots: [
      SHOW,
      LLDP,
      K('entry', 'Information for specific neighbor entry'),
      P('name', 'word', 'WORD', 'Name of LLDP neighbor entry'),
    ],
    run: (s, a) => s.outLines(showLldpNeighbors(s.device, now(s), true, a.name as string)),
  });
  r.add({
    modes: U,
    slots: [SHOW, LLDP, K('interface', 'LLDP interface status and configuration')],
    run: (s) => s.outLines(showLldpInterface(s.device)),
  });
  r.add({
    modes: U,
    slots: [
      SHOW,
      LLDP,
      K('interface', 'LLDP interface status and configuration'),
      P('if', 'iface', 'IFNAME', 'Interface name'),
    ],
    run: (s, a) => {
      const ref = resolveIface(s.device, a.if as string);
      if (!ref) throw new CliError('% Invalid interface');
      s.outLines(showLldpInterface(s.device, ref.id));
    },
  });
  r.add({
    modes: U,
    slots: [SHOW, LLDP, K('traffic', 'LLDP statistics')],
    run: (s) => s.outLines(showLldpTraffic(s.device)),
  });

  // ------------------------------------------------------------ clear
  const CLEAR = K('clear', 'Reset functions');
  r.add({
    modes: ['priv'],
    slots: [CLEAR, CDP, K('table', 'Clear cached CDP information')],
    run: (s) => {
      discOf(cfgOf(s)).cdp = {};
    },
  });
  r.add({
    modes: ['priv'],
    slots: [CLEAR, CDP, K('counters', 'Clear CDP counters')],
    run: (s) => {
      const st = discOf(cfgOf(s)).stats;
      st.cdpSent = 0;
      st.cdpRecv = 0;
    },
  });
  r.add({
    modes: ['priv'],
    slots: [CLEAR, LLDP, K('table', 'Clear cached LLDP information')],
    run: (s) => {
      discOf(cfgOf(s)).lldp = {};
    },
  });
  r.add({
    modes: ['priv'],
    slots: [CLEAR, LLDP, K('counters', 'Clear LLDP counters')],
    run: (s) => {
      const st = discOf(cfgOf(s)).stats;
      st.lldpSent = 0;
      st.lldpRecv = 0;
    },
  });
}

/** Zeilen der globalen Konfiguration (running-config). */
export function discGlobalLines(cfg: L3Cfg): string[] {
  const d = cfg.disc;
  if (!d) return [];
  const L: string[] = [];
  if (!d.cdpRun) L.push('no cdp run');
  if (d.cdpTimer !== 60) L.push(`cdp timer ${d.cdpTimer}`);
  if (d.cdpHold !== 180) L.push(`cdp holdtime ${d.cdpHold}`);
  if (d.lldpRun) L.push('lldp run');
  if (d.lldpTimer !== 30) L.push(`lldp timer ${d.lldpTimer}`);
  if (d.lldpHold !== 120) L.push(`lldp holdtime ${d.lldpHold}`);
  if (d.lldpReinit !== 2) L.push(`lldp reinit ${d.lldpReinit}`);
  if (L.length > 0) L.push('!');
  return L;
}

/** Zeilen je Schnittstelle. */
export function discIfLines(cfg: L3Cfg, portId: string): string[] {
  const d = cfg.disc;
  if (!d) return [];
  const L: string[] = [];
  if (d.cdpOff.includes(portId)) L.push(' no cdp enable');
  if (d.lldpTxOff.includes(portId)) L.push(' no lldp transmit');
  if (d.lldpRxOff.includes(portId)) L.push(' no lldp receive');
  return L;
}
