import type { AppConn, Device } from '@netsim/engine';

const STATE: Record<AppConn['state'], string> = {
  'syn-sent': 'SYNSENT',
  open: 'ESTAB',
  closed: 'CLOSEWAIT',
  failed: 'CLOSED',
};

/** `show tcp brief`: Verbindungstabelle des Geräts (Telnet, SSH, BGP, FTP, SMTP, POP3). */
export function showTcpBrief(d: Device): string[] {
  const c = d.config;
  const conns = 'appc' in c ? Object.values(c.appc?.conns ?? {}) : [];
  const out = ['TCB       Local Address               Foreign Address             (state)'];
  const rows = conns.map((x) => {
    const tcb = (0x6a000000 + x.id * 0x58).toString(16).toUpperCase().padStart(8, '0');
    const local = `${x.laddr ?? '0.0.0.0'}.${x.lport}`;
    const foreign = `${x.raddr}.${x.rport}`;
    return `${tcb}  ${local.padEnd(27)} ${foreign.padEnd(27)} ${STATE[x.state]}`;
  });
  return [...out, ...rows.sort()];
}
