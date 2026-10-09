import type { Device } from '@netsim/engine';
import { ciscoMac } from './format';
import { ifDisplay, ifShort } from './ifnames';

const l3 = (d: Device) =>
  d.config.kind === 'router' || d.config.kind === 'switch' ? d.config : undefined;

/** Zeilen für `show ip interface brief`: Dialer (immer) und Virtual-Access (mit Sitzung). */
export function pppBriefRows(d: Device): [string, string | undefined, string, string][] {
  const cfg = l3(d);
  const rows: [string, string | undefined, string, string][] = [];
  const sess = Object.values(cfg?.ppp?.sessions ?? {});
  for (const [id, c] of Object.entries(cfg?.ifaces ?? {})) {
    if (c.kind === 'vtemplate') rows.push([ifDisplay(d, id), undefined, 'up', 'down']);
    if (c.kind !== 'dialer') continue;
    const s = sess.find((x) => x.ifaceId === id);
    const up = s?.state === 'up';
    rows.push([
      ifDisplay(d, id),
      up ? s?.localIp : undefined,
      c.shutdown ? 'administratively down' : up ? 'up' : 'down',
      up ? 'up' : 'down',
    ]);
  }
  for (const s of sess)
    if (s.role === 'server' && s.state === 'up')
      rows.push([ifDisplay(d, s.ifaceId), s.localIp, 'up', 'up']);
  return rows;
}

/** `show pppoe session`. */
export function showPppoeSession(d: Device): string[] {
  const cfg = l3(d);
  const sess = Object.values(cfg?.ppp?.sessions ?? {});
  const out: string[] = [];
  const clients = sess.filter((s) => s.role === 'client');
  const servers = sess.filter((s) => s.role === 'server');
  const stateOf = (s: (typeof sess)[number]): string =>
    s.state === 'up' ? 'UP' : s.state.toUpperCase();
  if (clients.length) out.push(`${String(clients.length).padStart(6)} client session`);
  if (servers.length)
    out.push(
      `${String(servers.length).padStart(6)} session in LOCALLY_TERMINATED (PTA) State`,
      `${String(servers.length).padStart(6)} session total`,
    );
  if (sess.length === 0) return ['No PPPoE sessions.'];
  out.push(
    '',
    'Uniq ID  PPPoE  RemMAC          Port                    VT  VA         State',
    '           SID  LocMAC                                      VA-st      Type',
  );
  for (const s of sess) {
    const port = d.ports.find((p) => p.id === s.portId);
    const va = s.role === 'server' ? `Vi${s.ifaceId.slice(2)}` : '';
    const vt = s.role === 'client' ? ifShort(d, s.ifaceId) : 'N/A';
    out.push(
      `${'N/A'.padStart(7)}${String(s.sessionId).padStart(7)}  ${(s.peerMac ? ciscoMac(s.peerMac) : '-').padEnd(16)}${ifShort(d, port?.id ?? s.portId).padEnd(24)}${vt.padEnd(4)}${va.padEnd(11)}${stateOf(s)}`,
      `${' '.repeat(16)}${ciscoMac(port?.mac ?? '').padEnd(52)}${s.state === 'up' ? 'UP' : ''}`,
    );
    if (s.localIp)
      out.push(
        `${' '.repeat(16)}local ${s.localIp} peer ${s.peerIp ?? '-'}${s.user ? ` user ${s.user}` : ''}`,
      );
  }
  return out;
}
