import { isValidIpv4 } from '@netsim/protocols';
import type { Device, Engine, HostConfig, PingResult } from '@netsim/engine';
import { winMac } from './format';
import type { Shell } from './shell';
import { waitFor } from './util';

const NOT_YET = ['netstat', 'telnet', 'ssh', 'ftp', 'tftp'];

const ms = (us: number): string => (us < 1000 ? '<1ms' : `${Math.round(us / 1000)}ms`);

/** Windows-ähnliche Eingabeaufforderung eines Hosts (`ping`, `tracert`, `ipconfig`, `arp -a`). */
export class HostShell implements Shell {
  readonly history: string[] = [];
  readonly terminalLength = 0;

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
      case 'cls':
        return '\x1b[2J\x1b[H';
      case 'help':
      case '?':
        out.push(
          'Available commands: ping, tracert, ipconfig [/all|/release|/renew], nslookup, arp -a, cls, help',
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
    if (!isValidIpv4(dst)) {
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
    const dst = this.target(args);
    if (!dst) return void out.push('Usage: tracert [-h maximum_hops] target_name');
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
      out.push(`   DNS Servers.....................: ${cfg.dnsServers.join(', ')}`);
    }
    out.push(`   IPv4 Address....................: ${cfg.ip ?? '0.0.0.0'}`);
    out.push(`   Subnet Mask.....................: ${cfg.mask ?? '0.0.0.0'}`);
    out.push(`   Default Gateway.................: ${cfg.gateway ?? '0.0.0.0'}`);
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
