import type { Engine, HostConfig } from '@netsim/engine';
import type { Shell } from './shell';
import { waitFor } from './util';

/** Interaktiver FTP-Client (`ftp <host>` in der Eingabeaufforderung). */
export class FtpShell implements Shell {
  readonly history: string[] = [];
  readonly terminalLength = 0;
  closed = false;
  next?: Shell;
  private stage: 'user' | 'pass' | 'cmd' = 'user';
  private user = '';

  constructor(
    private readonly engine: Engine,
    private readonly deviceId: string,
    private readonly key: string,
    private readonly host: string,
    private readonly banner: string,
  ) {}

  private get files(): Record<string, string> {
    const c = this.engine.getDevice(this.deviceId)?.config as HostConfig;
    return (c.files ??= {});
  }

  prompt(): string {
    return this.stage === 'user'
      ? `User (${this.host}:(none)): `
      : this.stage === 'pass'
        ? 'Password: '
        : 'ftp> ';
  }
  secret(): boolean {
    return this.stage === 'pass';
  }
  help = (): undefined => undefined;
  complete = (l: string): string => l;
  interrupt = (): string => '';
  end = (): string => '';
  start(): string {
    return `Connected to ${this.host}.\n${this.banner}\n`;
  }

  private call(op: string, args: Record<string, string>, body?: string) {
    this.engine.p5.send(this.deviceId, this.key, op, args, body);
    waitFor(this.engine, () => this.engine.p5.connState(this.deviceId, this.key)?.waiting !== true);
    const c = this.engine.p5.connState(this.deviceId, this.key);
    if (!c || c.state !== 'open') {
      this.quit();
      return undefined;
    }
    return c.reply;
  }

  private quit(): void {
    this.closed = true;
    this.engine.p5.close(this.deviceId, this.key);
  }

  input(raw: string): string {
    const line = raw.trim();
    if (this.stage === 'user') {
      this.user = line;
      this.stage = 'pass';
      return '';
    }
    if (this.stage === 'pass') {
      const r = this.call('user', { user: this.user, pass: raw });
      if (r?.op === 'login-ok') {
        this.stage = 'cmd';
        return `${String(r.args.text)}\n`;
      }
      this.stage = 'user';
      return r
        ? `${String(r.args.text ?? '530 Login incorrect')}\nLogin failed.\n`
        : '421 Connection lost.\n';
    }
    const [cmd = '', ...args] = line.split(/\s+/);
    switch (cmd.toLowerCase()) {
      case 'dir':
      case 'ls': {
        const r = this.call('list', {});
        if (!r) return '421 Connection lost.\n';
        return r.op === 'list'
          ? `200 PORT command successful.\n150 Opening data connection.\n${r.body ?? ''}\n226 Transfer complete.\n`
          : `${String(r.args.text)}\n`;
      }
      case 'get': {
        const f = args[0];
        if (!f) return 'Remote file name required.\n';
        const r = this.call('get', { file: f });
        if (!r) return '421 Connection lost.\n';
        if (r.op !== 'data') return `${String(r.args.text)}\n`;
        this.files[args[1] ?? f] = r.body ?? '';
        return `200 PORT command successful.\n${String(r.args.text)}\nftp: ${(r.body ?? '').length} bytes received.\n`;
      }
      case 'put': {
        const f = args[0];
        if (!f) return 'Local file name required.\n';
        const body = this.files[f];
        if (body === undefined) return `${f}: File not found\n`;
        const r = this.call('put', { file: args[1] ?? f }, body);
        if (!r) return '421 Connection lost.\n';
        return `200 PORT command successful.\n${String(r.args.text)}\nftp: ${body.length} bytes sent.\n`;
      }
      case 'delete': {
        const r = this.call('delete', { file: args[0] ?? '' });
        return r ? `${String(r.args.text)}\n` : '421 Connection lost.\n';
      }
      case 'quit':
      case 'bye':
      case 'exit':
        this.quit();
        return '221 Goodbye.\n';
      case '?':
      case 'help':
        return 'Commands: dir, get <file> [local], put <file> [remote], delete <file>, quit\n';
      default:
        return 'Invalid command.\n';
    }
  }
}
