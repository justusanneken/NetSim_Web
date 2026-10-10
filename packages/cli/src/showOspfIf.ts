/** `show ip ospf interface [brief|<if>]` im IOS-15-Format. */
import { maskToPrefix } from '@netsim/protocols';
import type { Device, Engine, IfaceCfg, OspfCfg, OspfIfState } from '@netsim/engine';
import { ifDisplay, ifShort } from './ifnames';

const NET_NAMES: Record<string, string> = {
  broadcast: 'BROADCAST',
  'point-to-point': 'POINT_TO_POINT',
};

const hms = (us: number): string => {
  const s = Math.max(0, Math.floor(us / 1e6));
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

/** OSPF-Kosten wie die Engine: `cost` oder Referenzbandbreite / Schnittstellenbandbreite (Serial 1544 kbit/s). */
export function ospfIfCost(d: Device, c: OspfCfg, id: string, ic: IfaceCfg, v6 = false): number {
  const set = v6 ? ic.v6?.ospf?.cost : ic.ospf?.cost;
  if (set !== undefined) return set;
  if (ic.kind === 'loop') return 1;
  const port = d.ports.find((p) => p.id === id);
  const bw =
    ic.bandwidth ??
    (ic.kind === 'tunnel'
      ? 100
      : ic.kind === 'svi'
        ? 1_000_000
        : port?.kind === 'serial'
          ? 1544
          : (port?.operSpeed ?? 100) * 1000 || 100_000);
  return Math.max(1, Math.floor((c.refBwMbps * 1000) / bw));
}

function networkType(ic: IfaceCfg, ifs: OspfIfState, v6: boolean): string {
  const set = (v6 ? ic.v6?.ospf?.network : ic.ospf?.network) as string | undefined;
  if (set) return NET_NAMES[set] ?? 'BROADCAST';
  if (ifs.state === 'loopback') return 'LOOPBACK';
  return ifs.state === 'p2p' ? 'POINT_TO_POINT' : 'BROADCAST';
}

const nbrRoleTxt = (ifs: OspfIfState, rid: string): string =>
  rid === ifs.dr ? ' (Designated Router)' : rid === ifs.bdr ? ' (Backup Designated Router)' : '';

/** Detailansicht einer Schnittstelle (nur IPv4). */
export function showOspfInterfaceDetail(
  e: Engine,
  d: Device,
  c: OspfCfg,
  id: string,
  ifs: OspfIfState,
): string[] {
  const cfg = d.config.kind === 'router' || d.config.kind === 'switch' ? d.config : undefined;
  const ic = cfg?.ifaces[id];
  if (!ic) return [];
  const port = d.ports.find((p) => p.id === id);
  const up = port ? port.operUp && !port.protoDown : true;
  const plen = ic.mask ? maskToPrefix(ic.mask) : undefined;
  const o = ic.ospf;
  const how =
    o?.area !== undefined ? 'Attached via Interface Enable' : 'Attached via Network Statement';
  const rid = c.routerId ?? c.rid ?? '0.0.0.0';
  const cost = ospfIfCost(d, c, id, ic);
  const hello = o?.helloSec ?? 10;
  const dead = o?.deadSec ?? hello * 4;
  const nb = Object.values(ifs.neighbors);
  const full = nb.filter((n) => n.state === 'full');
  const state =
    ifs.state === 'loopback'
      ? 'LOOP'
      : ifs.state === 'p2p'
        ? 'POINT_TO_POINT'
        : ifs.state === 'drother'
          ? 'DROTHER'
          : ifs.state === 'waiting'
            ? 'WAITING'
            : ifs.state.toUpperCase();
  const out = [
    `${ifDisplay(d, id)} is ${up ? 'up' : 'down'}, line protocol is ${up ? 'up' : 'down'} `,
    `  Internet Address ${ic.ip}/${plen}, Area ${ifs.area}, ${how}`,
    `  Process ID ${c.pid}, Router ID ${rid}, Network Type ${networkType(ic, ifs, false)}, Cost: ${cost}`,
    '  Topology-MTID    Cost    Disabled    Shutdown      Topology Name',
    `        0           ${String(cost).padEnd(9)}no          no            Base`,
  ];
  if (ifs.state === 'loopback') {
    out.push('  Loopback interface is treated as a stub Host');
    return out;
  }
  out.push(`  Transmit Delay is 1 sec, State ${state}, Priority ${o?.priority ?? 1}`);
  if (ifs.state !== 'p2p') {
    out.push(
      ifs.dr === '0.0.0.0' || ifs.dr === ''
        ? '  No designated router on this network'
        : `  Designated Router (ID) ${ifs.dr}, Interface address ${ifs.drAddr}`,
      ifs.bdr === '0.0.0.0' || ifs.bdr === ''
        ? '  No backup designated router on this network'
        : `  Backup Designated router (ID) ${ifs.bdr}, Interface address ${ifs.bdrAddr}`,
    );
  }
  const wait = ifs.state === 'p2p' ? '' : `, Wait ${dead}`;
  out.push(`  Timer intervals configured, Hello ${hello}, Dead ${dead}${wait}, Retransmit 5`);
  out.push(`    oob-resync timeout ${ifs.state === 'p2p' ? 40 : dead}`);
  const due = e.state.queue.find(
    (ev) =>
      ev.kind === 'timer' &&
      ev.deviceId === d.id &&
      ev.payload.name === `bg:rt:ospf:hello:${c.pid}:${id}`,
  );
  if (due) out.push(`    Hello due in ${hms(due.t - e.state.now)}`);
  out.push(
    '  Supports Link-local Signaling (LLS)',
    '  Cisco NSF helper support enabled',
    '  IETF NSF helper support enabled',
    '  Index 1/1, flood queue length 0',
    '  Next 0x0(0)/0x0(0)',
    '  Last flood scan length is 1, maximum is 1',
    '  Last flood scan time is 0 msec, maximum is 0 msec',
    `  Neighbor Count is ${nb.length}, Adjacent neighbor count is ${full.length} `,
  );
  for (const n of full) out.push(`    Adjacent with neighbor ${n.rid}${nbrRoleTxt(ifs, n.rid)}`);
  out.push('  Suppress hello for 0 neighbor(s)');
  return out;
}

/** `Interface PID Area ...` Tabelle bzw. Detailblöcke; `only` filtert auf eine Schnittstelle. */
export function showOspfInterfacesV4(
  e: Engine,
  d: Device,
  brief: boolean,
  only?: string,
): string[] {
  const cfg = d.config.kind === 'router' || d.config.kind === 'switch' ? d.config : undefined;
  if (!cfg) return [];
  const out: string[] = [];
  if (brief) out.push('Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C');
  for (const c of Object.values(cfg.routing.ospf)) {
    for (const [id, ifs] of Object.entries(c.ifs)) {
      if (only !== undefined && id !== only) continue;
      const ic = cfg.ifaces[id];
      if (!ic) continue;
      if (brief) {
        const nb = Object.values(ifs.neighbors);
        const full = nb.filter((n) => n.state === 'full').length;
        const plen = ic.mask ? maskToPrefix(ic.mask) : undefined;
        const st =
          ifs.state === 'loopback' ? 'LOOP' : ifs.state === 'p2p' ? 'P2P' : ifs.state.toUpperCase();
        out.push(
          `${ifShort(d, id).padEnd(13)}${String(c.pid).padEnd(6)}${ifs.area.padEnd(16)}${`${ic.ip}/${plen}`.padEnd(19)}${String(ospfIfCost(d, c, id, ic)).padEnd(6)}${st.padEnd(6)}${full}/${nb.length}`,
        );
      } else out.push(...showOspfInterfaceDetail(e, d, c, id, ifs));
    }
  }
  return out;
}
