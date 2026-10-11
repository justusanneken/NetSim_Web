/** WAN-Ausgaben: `show interfaces serial`, `show controllers serial`, `show interfaces dialer`. */
import { maskToPrefix } from '@netsim/protocols';
import type { Device, Engine, Port } from '@netsim/engine';
import { ifDisplay } from './ifnames';

const l3 = (d: Device) => (d.config.kind === 'router' ? d.config : undefined);

/** `show interfaces serialN/N/N` (IOS 15, GT96K-Hardware). */
export function showSerialInterface(d: Device, p: Port): string[] {
  const ic = l3(d)?.ifaces[p.id];
  const sc = ic?.serial ?? { encap: 'hdlc' as const };
  const line = p.operUp && !p.protoDown;
  const status = !p.adminUp ? 'administratively down' : p.operUp ? 'up' : 'down';
  const c = p.counters;
  const desc = d.config.kind === 'router' ? d.config.sys.descriptions[p.id] : undefined;
  const ka = sc.keepalive ?? 10;
  const out = [
    `${p.name} is ${status}, line protocol is ${line ? 'up' : 'down'} `,
    '  Hardware is GT96K Serial',
  ];
  if (desc) out.push(`  Description: ${desc}`);
  if (ic?.ip && ic.mask) out.push(`  Internet address is ${ic.ip}/${maskToPrefix(ic.mask)}`);
  out.push(
    `  MTU ${p.mtu} bytes, BW ${ic?.bandwidth ?? 1544} Kbit/sec, DLY ${(ic?.delay ?? 2000) * 10} usec, `,
    '     reliability 255/255, txload 1/255, rxload 1/255',
  );
  if (sc.encap === 'ppp') {
    out.push(`  Encapsulation PPP, LCP ${line ? 'Open' : 'Closed'}`);
    if (line) out.push('  Open: IPCP, CDPCP, loopback not set');
    else out.push('  Closed: IPCP, CDPCP');
  } else out.push('  Encapsulation HDLC, loopback not set');
  out.push(ka > 0 ? `  Keepalive set (${ka} sec)` : '  Keepalive not set');
  out.push(
    '  Last input never, output never, output hang never',
    '  Last clearing of "show interface" counters never',
    '  Input queue: 0/75/0/0 (size/max/drops/flushes); Total output drops: 0',
    '  Queueing strategy: fifo',
    '  Output queue: 0/40 (size/max)',
    '  5 minute input rate 0 bits/sec, 0 packets/sec',
    '  5 minute output rate 0 bits/sec, 0 packets/sec',
    `     ${c.inPkts} packets input, ${c.inBytes} bytes, 0 no buffer`,
    `     Received ${c.inPkts} broadcasts (0 IP multicasts)`,
    '     0 runts, 0 giants, 0 throttles',
    `     ${c.inErrors} input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored, 0 abort`,
    `     ${c.outPkts} packets output, ${c.outBytes} bytes, 0 underruns`,
    `     ${c.outErrors} output errors, 0 collisions, 0 interface resets`,
    '     0 unknown protocol drops',
    '     0 output buffer failures, 0 output buffers swapped out',
    '     0 carrier transitions',
    p.adminUp && p.linkId
      ? '     DCD=up  DSR=up  DTR=up  RTS=up  CTS=up'
      : p.adminUp
        ? '     DCD=down  DSR=down  DTR=up  RTS=up  CTS=down'
        : '     DCD=down  DSR=down  DTR=down  RTS=down  CTS=down',
  );
  return out;
}

/** `show controllers serial N/N/N` (GT96K). */
export function showControllerSerial(e: Engine, d: Device, p: Port): string[] {
  const role = e.serialRole(d.id, p.id);
  const sc = l3(d)?.ifaces[p.id]?.serial;
  const out = [`Interface ${p.name}`, 'Hardware is GT96K'];
  if (role === undefined) out.push('No serial cable attached');
  else if (role === 'dce') {
    out.push(sc?.clockRate ? `DCE V.35, clock rate ${sc.clockRate}` : 'DCE V.35, no clock');
  } else {
    const peerClock = p.operUp && !!p.linkId && peerHasClock(e, d, p);
    out.push(peerClock ? 'DTE V.35 TX and RX clocks detected.' : 'DTE V.35 clocks stopped.');
  }
  const idx = d.ports.filter((x) => x.kind === 'serial').indexOf(p);
  out.push(
    'idb at 0x4650E6F0, driver data structure at 0x46510A8C',
    'wic_info 0x4651109C',
    `Physical Port ${idx}, SCC Num ${idx}`,
    'MPSC Registers:',
    'MMCR_L=0x000304C0, MMCR_H=0x00000000, MPCR=0x00000000',
    'CHR1=0x00000000, CHR2=0x00000000, CHR3=0x00000000, CHR4=0x00000000',
    'CHR5=0x00000000, CHR6=0x00000000, CHR7=0x00000000, CHR8=0x00000000',
    'CHR9=0x00000000, CHR10=0x00000000',
    'SDMA Registers:',
    'SDC=0x00002201, SDCM=0x00000080',
    'Rx ring:  rxr head 0, rxr tail 0, rxr count 0',
    'Tx ring:  txr head 0, txr tail 0, txr count 0',
    // Abbrüche beim Flag-Empfang (Leitungsfehler) simuliert die Engine nicht: immer 0 wie „0 abort“ in show interfaces
    '0 input aborts on receiving flag sequence',
    '0 throttles, 0 enables',
    '0 overruns',
    '0 transmitter underruns',
    '0 transmitter CTS losts',
    '0 residual bit errors',
  );
  return out;
}

function peerHasClock(e: Engine, d: Device, p: Port): boolean {
  const link = p.linkId ? e.state.links[p.linkId] : undefined;
  if (!link) return false;
  const ref = link.a.deviceId === d.id && link.a.portId === p.id ? link.b : link.a;
  const pd = e.state.devices[ref.deviceId];
  const sc = pd?.config.kind === 'router' ? pd.config.ifaces[ref.portId]?.serial : undefined;
  return !!sc?.clockRate;
}

/** `show controllers` ohne Argument: alle Serial-Ports. */
export function showControllers(e: Engine, d: Device): string[] {
  const out: string[] = [];
  for (const p of d.ports.filter((x) => x.kind === 'serial')) {
    out.push(...showControllerSerial(e, d, p), '');
  }
  return out;
}

/** `show interfaces dialerN` (PPPoE-Client). */
export function showDialerInterface(d: Device, id: string): string[] {
  const cfg = l3(d);
  const ic = cfg?.ifaces[id];
  if (!ic || ic.kind !== 'dialer') return [];
  const sess = Object.values(cfg?.ppp?.sessions ?? {}).find((s) => s.ifaceId === id);
  const up = sess?.state === 'up';
  const status = ic.shutdown ? 'administratively down' : up ? 'up' : 'down';
  const out = [
    `${ifDisplay(d, id)} is ${status} (spoofing), line protocol is ${up ? 'up' : 'down'} `,
    '  Hardware is Unknown',
  ];
  if (up && sess) out.push(`  Internet address is ${sess.localIp}/32`);
  out.push(
    '  MTU 1492 bytes, BW 56 Kbit/sec, DLY 20000 usec, ',
    '     reliability 255/255, txload 1/255, rxload 1/255',
    `  Encapsulation PPP, LCP ${up ? 'Open' : 'Closed'}`,
    up ? '  Open: IPCP' : '  Closed: IPCP',
    '  Keepalive set (10 sec)',
    '  DTR is pulsed for 1 seconds on reset',
    '  Last input never, output never, output hang never',
    '  Last clearing of "show interface" counters never',
    '  Input queue: 0/75/0/0 (size/max/drops/flushes); Total output drops: 0',
    '  Queueing strategy: fifo',
    '  Output queue: 0/40 (size/max)',
    '  5 minute input rate 0 bits/sec, 0 packets/sec',
    '  5 minute output rate 0 bits/sec, 0 packets/sec',
    '     0 packets input, 0 bytes',
    '     0 packets output, 0 bytes',
  );
  return out;
}
