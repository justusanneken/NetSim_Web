import { isValidIpv4, isValidIpv6, linkLocalFromMac, normalizeIpv6 } from '@netsim/protocols';
import type { Device, Engine, HostConfig, PingResult } from '@netsim/engine';
import { winMac } from './format';
import type { Shell, ShellNest } from './shell';
import { FtpShell } from './ftpshell';
import { openRemote } from './remote';
import { clockOf, formatClock } from '@netsim/engine';
import { waitFor } from './util';

const NOT_YET = ['netstat'];

const ms = (us: number): string => (us < 1000 ? '<1ms' : `${Math.round(us / 1000)}ms`);

/** Windows-ähnliche Eingabeaufforderung eines Hosts (`ping`, `tracert`, `ipconfig`, `arp -a`). */
export class HostShell implements Shell {
  readonly history: string[] = [];
  readonly terminalLength = 0;
  /** Terminal-Schicht für `telnet`/`ssh`/`ftp`-Sitzungen. */
  nest?: ShellNest;

  constructor(
    private readonly engine: Engine,
    private readonly deviceId: string,
    /** Liefert `true`, wenn nicht bis zum Ende simuliert werden soll (Simulationsmodus). */
    private readonly deferred: () => boolean = () => false,
  ) {}

  private get dev(): Device & { config: HostConfig } {
    const d = this.engine.getDevice(this.deviceId);
    if (!d || d.config.kind !== 'host') throw new Error('Kein Host');
    return d as Device & { config: HostConfig };
  }

  prompt = (): string => 'C:\\>';
  secret = (): boolean => false;
  help = (): undefined => undefined;
  complete = (line: string): string => line;
  interrupt = (): string => '';
  end = (): string => '';
  start = (): string => 'NetSim PC Command Line 1.0\n';

  input(raw: string): string {
    const line = raw.trim();
    if (line === '') return '';
    this.history.push(line);
    const [cmd, ...args] = line.split(/\s+/);
    const c = (cmd ?? '').toLowerCase();
    const out: string[] = [];
    switch (c) {
      case 'ping':
        this.ping(args, out);
        break;
      case 'tracert':
        this.tracert(args, out);
        break;
      case 'ipconfig':
        this.ipconfig(args, out);
        break;
      case 'arp':
        this.arp(args, out);
        break;
      case 'nslookup':
        this.nslookup(args, out);
        break;
      case 'telnet':
        out.push(this.remote(args, 'telnet'));
        break;
      case 'ssh':
        out.push(this.remote(args, 'ssh'));
        break;
      case 'ftp':
        out.push(this.ftp(args));
        break;
      case 'tftp':
        out.push(this.tftp(args));
        break;
      case 'time':
      case 'date':
        out.push(this.time());
        break;
      case 'w32tm':
        out.push(this.w32tm(args));
        break;
      case 'dir':
        out.push(this.dirFiles());
        break;
      case 'type': {
        const f = this.dev.config.files?.[args[0] ?? ''];
        out.push(f ?? 'The system cannot find the file specified.');
        break;
      }
      case 'del':
        if (args[0] && this.dev.config.files) delete this.dev.config.files[args[0]];
        break;
      case 'echo': {
        const m = /^echo\s+(.*?)\s*>\s*(\S+)\s*$/i.exec(line);
        if (m) (this.dev.config.files ??= {})[m[2] as string] = m[1] as string;
        else out.push(line.slice(5));
        break;
      }
      case 'cls':
        return '\x1b[2J\x1b[H';
      case 'help':
      case '?':
        out.push(
          'Available commands: ping, tracert, ipconfig [/all|/release|/renew], nslookup, arp -a, telnet, ssh -l user host, ftp, tftp, time, w32tm /resync, echo text > file, type, dir, del, cls, help',
        );
        break;
      default:
        if (NOT_YET.includes(c)) out.push(`The command '${c}' is not available in this version.`);
        else
          out.push(
            `'${cmd}' is not recognized as an internal or external command,`,
            'operable program or batch file.',
          );
    }
    return out.length ? out.join('\n') + '\n' : '';
  }

  private remote(args: string[], proto: 'telnet' | 'ssh'): string {
    let user: string | undefined;
    let host: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string;
      if (a === '-l') user = args[++i];
      else if (!a.startsWith('-')) host = a;
    }
    if (!host) return `Usage: ${proto === 'ssh' ? 'ssh -l user ' : 'telnet '}host`;
    const dst = this.resolve(host);
    if (!dst)
      return `Could not open connection to the host, on port ${proto === 'ssh' ? 22 : 23}: Connect failed`;
    return openRemote({
      engine: this.engine,
      fromId: this.deviceId,
      nest: this.nest,
      dst,
      proto,
      user,
      deferred: this.deferred,
      style: 'win',
    }).replace(/\n$/, '');
  }

  private ftp(args: string[]): string {
    const host = args[0];
    if (!host) return 'Usage: ftp host';
    const dst = this.resolve(host);
    if (!dst) return `Unknown host ${host}.`;
    if (this.deferred()) return 'Simulation mode: FTP is not available while stepping.';
    const r = this.engine.p5.open(this.deviceId, dst, 'ftp');
    if (!r.ok) return `> ftp: connect :Network is unreachable`;
    const key = r.value;
    waitFor(this.engine, () => this.engine.p5.connState(this.deviceId, key)?.state !== 'syn-sent');
    const c = this.engine.p5.connState(this.deviceId, key);
    if (c?.state !== 'open') {
      this.engine.p5.close(this.deviceId, key);
      return '> ftp: connect :Connection timed out';
    }
    this.nest?.push(
      new FtpShell(this.engine, this.deviceId, key, dst, String(c.banner?.args.text ?? '220')),
      () => '',
    );
    return '';
  }

  private tftp(args: string[]): string {
    const a = args.filter((x) => x.toLowerCase() !== '-i');
    const [host, op, file, remote] = a;
    if (!host || !file || !/^(get|put)$/i.test(op ?? ''))
      return 'Usage: tftp [-i] host [GET | PUT] source [destination]';
    const dst = this.resolve(host);
    if (!dst) return 'Transfer timed out.';
    const files = (this.dev.config.files ??= {});
    const put = (op as string).toLowerCase() === 'put';
    if (put && files[file] === undefined) return `Error: File ${file} not found.`;
    const r = this.engine.p5.request(
      this.deviceId,
      dst,
      'tftp',
      put ? 'wrq' : 'rrq',
      { file: put ? (remote ?? file) : file },
      put ? files[file] : undefined,
    );
    if (!r.ok) return 'Transfer timed out.';
    waitFor(
      this.engine,
      () => this.engine.p5.reqStatus(this.deviceId, r.value)?.status !== 'pending',
    );
    const st = this.engine.p5.reqStatus(this.deviceId, r.value);
    if (st?.status !== 'done') return 'Transfer timed out.';
    if (st.reply?.op === 'error') return `Error on server : ${String(st.reply.args.text)}`;
    if (!put) files[remote ?? file] = st.reply?.body ?? '';
    const n = put ? (files[file] ?? '').length : (st.reply?.body ?? '').length;
    return `Transfer successful: ${n} bytes in 1 second, ${n} bytes/s`;
  }

  private time(): string {
    const ms = this.engine.p5.clockMs(this.deviceId) ?? 0;
    return `The current time is: ${formatClock(ms, true).split(' ')[0]?.replace(/^\*/, '')}\n${formatClock(ms, true).split(' ').slice(2).join(' ')}`;
  }

  private w32tm(args: string[]): string {
    if ((args[0] ?? '').toLowerCase() !== '/resync') return 'Usage: w32tm /resync';
    const cfg = this.dev.config;
    if (!cfg.ntpServer) return 'The computer did not resync because no time data was available.';
    const before = clockOf(this.dev)?.lastSyncUs;
    this.engine.p5.ntpNow(this.deviceId);
    waitFor(this.engine, () => clockOf(this.dev)?.lastSyncUs !== before);
    return clockOf(this.dev)?.lastSyncUs !== before
      ? 'Sending resync command to local computer\nThe command completed successfully.'
      : 'The computer did not resync because no time data was available.';
  }

  private dirFiles(): string {
    const f = Object.entries(this.dev.config.files ?? {});
    return f.length
      ? [
          ' Directory of C:\\',
          '',
          ...f.map(([n, c]) => `${String(c.length).padStart(10)} ${n}`),
        ].join('\n')
      : 'File Not Found';
  }

  private flagValue(args: string[], flag: string): number | undefined {
    const i = args.findIndex((a) => a.toLowerCase() === flag);
    return i >= 0 ? Number(args[i + 1]) : undefined;
  }

  private target(args: string[]): string | undefined {
    const skip = new Set(['-n', '-l', '-h', '-i']);
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string;
      if (skip.has(a.toLowerCase())) i++;
      else if (!a.startsWith('-')) return a;
    }
    return undefined;
  }

  /** Löst einen Namen über DNS auf (blockiert bis zur Antwort); liefert die IP oder `undefined`. */
  private resolve(name: string): string | undefined {
    if (isValidIpv4(name)) return name;
    const r = this.engine.resolveName(this.deviceId, name);
    if (!r.ok) return undefined;
    if (r.value.cached) return r.value.cached;
    const id = r.value.id;
    if (id === undefined) return undefined;
    const cfg = this.dev.config;
    waitFor(this.engine, () => cfg.dnsResults[id]?.done === true);
    return cfg.dnsResults[id]?.answers[0]?.data;
  }

  private nslookup(args: string[], out: string[]): void {
    const name = args[0];
    if (!name) return void out.push('Usage: nslookup name');
    const cfg = this.dev.config;
    const server = cfg.dnsServers[0];
    out.push(`Server:  ${server ?? 'UnKnown'}`, `Address:  ${server ?? '0.0.0.0'}`, '');
    const ip = this.resolve(name);
    if (!ip)
      return void out.push(`*** ${server ?? 'UnKnown'} can't find ${name}: Non-existent domain`);
    out.push('Non-authoritative answer:', `Name:    ${name}`, `Address:  ${ip}`);
  }

  private ping(args: string[], out: string[]): void {
    let dst = this.target(args);
    if (!dst) return void out.push('Usage: ping [-n count] [-l size] [-f] target_name');
    const name = dst;
    if (isValidIpv6(dst)) dst = normalizeIpv6(dst) ?? dst;
    else if (!isValidIpv4(dst)) {
      const ip = this.resolve(dst);
      if (!ip)
        return void out.push(
          `Ping request could not find host ${dst}. Please check the name and try again.`,
        );
      dst = ip;
    }
    const count = this.flagValue(args, '-n') ?? 4;
    const size = this.flagValue(args, '-l') ?? 32;
    const df = args.some((a) => a.toLowerCase() === '-f');
    const r = this.engine.ping(this.deviceId, dst, { count, dataSize: size, df });
    if (!r.ok) {
      out.push(
        r.error === 'ip.invalidIp'
          ? `Ping request could not find host ${dst}. Please check the name and try again.`
          : 'PING: transmit failed. General failure.',
      );
      return;
    }
    out.push(`Pinging ${name === dst ? dst : `${name} [${dst}]`} with ${size} bytes of data:`, '');
    if (this.deferred()) {
      out.push(
        'Simulation mode: packets were queued. Step through the events in the simulation panel.',
      );
      return;
    }
    const cfg = this.dev.config;
    const mine = (): PingResult[] => cfg.pings.filter((p) => p.id === r.value);
    waitFor(
      this.engine,
      () => mine().length >= count && mine().every((p) => p.status !== 'pending'),
    );
    const res = mine();
    for (const p of res) out.push(this.pingLine(p));
    const ok = res.filter((p) => p.status === 'reply');
    out.push('', `Ping statistics for ${dst}:`);
    out.push(
      `    Packets: Sent = ${count}, Received = ${ok.length}, Lost = ${count - ok.length} (${Math.round(((count - ok.length) * 100) / count)}% loss),`,
    );
    if (ok.length > 0) {
      const t = ok.map((p) => Math.round((p.rttUs ?? 0) / 1000));
      out.push('Approximate round trip times in milli-seconds:');
      out.push(
        `    Minimum = ${Math.min(...t)}ms, Maximum = ${Math.max(...t)}ms, Average = ${Math.round(t.reduce((a, b) => a + b, 0) / t.length)}ms`,
      );
    }
  }

  private pingLine(p: PingResult): string {
    if (p.status === 'reply' && p.from?.includes(':'))
      return `Reply from ${p.from}: time${p.rttUs !== undefined && p.rttUs < 1000 ? '<1ms' : `=${ms(p.rttUs ?? 0)}`}`;
    if (p.status === 'reply')
      return `Reply from ${p.from}: bytes=${p.bytes} time${p.rttUs !== undefined && p.rttUs < 1000 ? '<1ms' : `=${ms(p.rttUs ?? 0)}`} TTL=${p.ttl}`;
    if (p.status === 'timeout' || p.status === 'pending') return 'Request timed out.';
    const reasons: Record<string, string> = {
      'ping.hostUnreachable': 'Destination host unreachable.',
      'ping.netUnreachable': 'Destination net unreachable.',
      'ping.ttlExpired': 'TTL expired in transit.',
      'ping.fragNeeded': 'Packet needs to be fragmented but DF set.',
    };
    const text = p.note ? reasons[p.note] : undefined;
    return text ? `Reply from ${p.from}: ${text}` : 'PING: transmit failed. General failure.';
  }

  private tracert(args: string[], out: string[]): void {
    let dst = this.target(args);
    if (!dst) return void out.push('Usage: tracert [-h maximum_hops] target_name');
    if (isValidIpv6(dst)) dst = normalizeIpv6(dst) ?? dst;
    else if (!isValidIpv4(dst)) {
      const ip = this.resolve(dst);
      if (!ip) return void out.push(`Unable to resolve target system name ${dst}.`);
      dst = ip;
    }
    const maxHops = this.flagValue(args, '-h') ?? 30;
    const r = this.engine.trace(this.deviceId, dst, maxHops);
    if (!r.ok) return void out.push(`Unable to resolve target system name ${dst}.`);
    out.push('', `Tracing route to ${dst} over a maximum of ${maxHops} hops:`, '');
    if (this.deferred()) {
      out.push(
        'Simulation mode: probes were queued. Step through the events in the simulation panel.',
      );
      return;
    }
    const cfg = this.dev.config;
    const tr = () => cfg.traces.find((t) => t.id === r.value);
    waitFor(this.engine, () => tr()?.done ?? true);
    for (const hop of tr()?.hops ?? []) {
      const bad = hop.probes.find((p) => p.outcome === 'unreachable');
      if (bad) {
        out.push(
          `${String(hop.ttl).padStart(3)}  ${bad.from}  reports: Destination host unreachable.`,
        );
        continue;
      }
      const cells = hop.probes.map((p) =>
        (p.status === 'reply' ? ms(p.rttUs ?? 0).replace('ms', ' ms') : '*').padStart(8),
      );
      const from = hop.probes.find((p) => p.status === 'reply')?.from;
      out.push(`${String(hop.ttl).padStart(3)}${cells.join('')}  ${from ?? 'Request timed out.'}`);
    }
    out.push('', 'Trace complete.');
  }

  private ipconfig(args: string[], out: string[]): void {
    const flag = (args[0] ?? '').toLowerCase();
    const cfg = this.dev.config;
    const port = this.dev.ports[0];
    if (flag === '/renew6' || flag === '/release6') {
      if (!cfg.v6.dhcp6) {
        out.push(
          'The operation failed as no adapter is in the state permissible for this operation.',
        );
        return;
      }
      this.engine.setHostIpv6(this.deviceId, { dhcp6: false });
      if (flag === '/renew6') {
        this.engine.setHostIpv6(this.deviceId, { dhcp6: true });
        // Der Client folgt dem nächsten Router Advertisement; RS anstoßen, solange keines aktiv ist
        if (!this.deferred())
          waitFor(
            this.engine,
            () => cfg.v6.dh6?.state === 'bound' || this.engine.queueLength === 0,
            50_000,
          );
      }
      out.push('', 'Windows IP Configuration', '');
      for (const a of cfg.v6.dhcpAddrs ?? [])
        out.push(`   IPv6 Address....................: ${a.addr}`);
      return;
    }
    if (flag === '/release' || flag === '/renew') {
      if (flag === '/release' && !cfg.dhcpClient.enabled) {
        out.push(
          'The operation failed as no adapter is in the state permissible for this operation.',
        );
        return;
      }
      if (flag === '/renew' && !cfg.dhcpClient.enabled && cfg.ip) {
        out.push(
          'The operation failed as no adapter is in the state permissible for this operation.',
        );
        return;
      }
      this.engine.setHostDhcp(this.deviceId, false);
      cfg.ip = undefined;
      cfg.mask = undefined;
      cfg.gateway = undefined;
      if (flag === '/renew') {
        this.engine.setHostDhcp(this.deviceId, true);
        if (!this.deferred())
          waitFor(
            this.engine,
            () => cfg.dhcpClient.state === 'bound' || this.engine.queueLength === 0,
          );
        if (!cfg.ip)
          return void out.push(
            'An error occurred while renewing interface FastEthernet0: unable to contact your DHCP server.',
          );
      }
      out.push(
        '',
        'Windows IP Configuration',
        '',
        `   IPv4 Address....................: ${cfg.ip ?? '0.0.0.0'}`,
      );
      return;
    }
    const all = flag === '/all';
    out.push('', 'FastEthernet0 Connection:(default port)', '');
    out.push('   Connection-specific DNS Suffix..: ');
    if (all) {
      out.push(`   Physical Address................: ${winMac(port?.mac ?? '')}`);
      out.push(`   DHCP Enabled....................: ${cfg.dhcpClient.enabled ? 'Yes' : 'No'}`);
      out.push(
        `   DNS Servers.....................: ${[...cfg.dnsServers, ...(cfg.v6.dns6 ?? [])].join(', ')}`,
      );
      if (cfg.v6.domain6) out.push(`   Connection-specific DNS Suffix..: ${cfg.v6.domain6}`);
      out.push(`   DHCPv6 Enabled..................: ${cfg.v6.dhcp6 ? 'Yes' : 'No'}`);
    }
    if (cfg.v6.enabled && port) {
      out.push(`   Link-local IPv6 Address.........: ${linkLocalFromMac(port.mac)}`);
      for (const a of [...cfg.v6.addrs, ...cfg.v6.slaac, ...(cfg.v6.dhcpAddrs ?? [])]) {
        const st = cfg.dad?.[normalizeIpv6(a.addr) ?? a.addr]?.state;
        const tag =
          st === 'dup' ? '(Duplicate)' : st === 'tentative' || !st ? '(Tentative)' : '(Preferred)';
        out.push(`   IPv6 Address....................: ${a.addr}${tag}`);
      }
    }
    out.push(`   IPv4 Address....................: ${cfg.ip ?? '0.0.0.0'}`);
    out.push(`   Subnet Mask.....................: ${cfg.mask ?? '0.0.0.0'}`);
    const gw6 = cfg.v6.gateway ?? (cfg.v6.raGateway ? cfg.v6.raGateway.addr : undefined);
    out.push(
      `   Default Gateway.................: ${[gw6, cfg.gateway].filter(Boolean).join(' ') || '0.0.0.0'}`,
    );
  }

  private arp(args: string[], out: string[]): void {
    if ((args[0] ?? '').toLowerCase() !== '-a') return void out.push('Usage: arp -a');
    const rows = this.engine.arpTable(this.deviceId);
    if (rows.length === 0) return void out.push('No ARP Entries Found.');
    out.push(
      '',
      `Interface: ${this.dev.config.ip ?? '0.0.0.0'} --- 0x2`,
      '  Internet Address      Physical Address      Type',
    );
    for (const r of rows) out.push(`  ${r.ip.padEnd(22)}${winMac(r.mac).padEnd(22)}dynamic`);
  }
}
