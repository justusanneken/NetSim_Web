import type { Device, Engine, RouterConfig, SwitchConfig } from '@netsim/engine';
import { resolvePort, shortName } from './format';
import { tokenize, type Args, type Env, type ModeId, type Registry } from './parser';
import { isCliDevice } from './render';
import type { Shell } from './shell';
import { buildRegistry } from './commands';

export class CliError extends Error {}

interface Pending {
  text: string;
  secret: boolean;
  cb: (answer: string) => void;
}

const MODE_SUFFIX: Record<ModeId, string> = {
  user: '>',
  priv: '#',
  config: '(config)#',
  'config-if': '(config-if)#',
  'config-line': '(config-line)#',
};

let REGISTRY: Registry<CliSession> | undefined;
const registry = (): Registry<CliSession> => (REGISTRY ??= buildRegistry());

/** Eine CLI-Sitzung (Console) an einem Router oder Switch. */
export class CliSession implements Shell {
  mode: ModeId = 'user';
  terminalLength = 24;
  historySize = 20;
  negated = false;
  /** Ausgewählte Ports im Interface-Modus. */
  ifaces: string[] = [];
  /** Zeilenziel im Line-Modus. */
  lineTarget: 'con' | 'vty' = 'con';
  silent = false;
  /** Konfigurations-Replay: ein Interface-Block ohne `shutdown` bedeutet „aktiv“. */
  replay = false;
  readonly history: string[] = [];
  private pending: Pending | undefined;
  private buf: string[] = [];
  private started = false;

  constructor(
    readonly engine: Engine,
    readonly deviceId: string,
  ) {}

  get device(): Device & { config: RouterConfig | SwitchConfig } {
    const d = this.engine.getDevice(this.deviceId);
    if (!d || !isCliDevice(d)) throw new Error('Kein CLI-fähiges Gerät');
    return d as Device & { config: RouterConfig | SwitchConfig };
  }
  get sys() {
    return this.device.config.sys;
  }

  // ------------------------------------------------------------ Ausgabe / Rückfragen

  out(text = ''): void {
    if (!this.silent) this.buf.push(text);
  }
  outLines(lines: string[]): void {
    for (const l of lines) this.out(l);
  }
  /** Rückfrage; die nächste Eingabe geht an `cb`. */
  ask(text: string, cb: (answer: string) => void, secret = false): void {
    this.pending = { text, secret, cb };
  }
  private flush(): string {
    const s = this.buf.join('\n');
    const had = this.buf.length > 0;
    this.buf = [];
    return had ? s + '\n' : '';
  }

  // ------------------------------------------------------------ Shell

  prompt(): string {
    if (this.pending) return this.pending.text;
    return this.sys.hostname + MODE_SUFFIX[this.mode];
  }
  secret(): boolean {
    return this.pending?.secret ?? false;
  }

  start(): string {
    if (this.started) return '';
    this.begin();
    return this.flush();
  }

  /** (Neu-)Start der Sitzung: Setup-Dialog bzw. Banner und Login. */
  begin(): void {
    this.started = true;
    const sys = this.sys;
    if (!sys.setupDone && sys.startupConfig === undefined) {
      this.out('         --- System Configuration Dialog ---');
      this.out('');
      this.ask('Would you like to enter the initial configuration dialog? [yes/no]: ', (a) => {
        if (/^y/i.test(a.trim())) {
          this.out(
            'The initial configuration dialog is not available in this simulator; skipping.',
          );
        }
        this.sys.setupDone = true;
        this.out('');
        this.out('Press RETURN to get started!');
        this.out('');
        this.loginBanner();
      });
    } else this.loginBanner();
  }

  private loginBanner(): void {
    const sys = this.sys;
    if (sys.bannerMotd) this.out(sys.bannerMotd);
    if (sys.lineCon.login && sys.lineCon.password !== undefined) {
      this.out('User Access Verification');
      this.out('');
      this.askLoginPassword();
    }
  }

  private askLoginPassword(): void {
    this.ask(
      'Password: ',
      (a) => {
        if (a === this.sys.lineCon.password) return;
        this.out('% Bad passwords');
        this.askLoginPassword();
      },
      true,
    );
  }

  input(raw: string): string {
    if (this.pending) {
      const p = this.pending;
      this.pending = undefined;
      try {
        p.cb(raw);
      } catch (e) {
        if (e instanceof CliError) this.out(e.message);
        else throw e;
      }
      return this.flush();
    }
    const line = raw.replace(/\s+$/, '');
    if (line.trim() === '') return '';
    if (this.history[this.history.length - 1] !== line) this.history.push(line);
    while (this.history.length > this.historySize) this.history.shift();
    this.execute(line);
    return this.flush();
  }

  private env(): Env {
    const d = this.device;
    return {
      family: d.config.kind === 'router' ? 'router' : 'switch',
      iface: (t) => resolvePort(d.ports, t) !== undefined,
    };
  }

  /** Führt eine Zeile aus (inkl. Pipes) und sammelt die Ausgabe. */
  execute(line: string, mode: ModeId = this.mode): void {
    const pipe = line.indexOf('|');
    if (pipe < 0) return this.run(line, mode);
    const cmd = line.slice(0, pipe);
    const filter = tokenize(line.slice(pipe + 1));
    const kind = filter[0]?.text.toLowerCase() ?? '';
    const kinds = ['include', 'exclude', 'begin', 'section', 'count'];
    const full = kinds.find((k) => k.startsWith(kind));
    const rx = filter
      .slice(1)
      .map((t) => t.text)
      .join(' ');
    if (!full || (full !== 'count' && rx === '')) {
      this.out(`${' '.repeat(this.prompt().length + pipe + 1)}^`);
      this.out("% Invalid input detected at '^' marker.");
      this.out('');
      return;
    }
    let re: RegExp;
    try {
      re = new RegExp(rx || '.');
    } catch {
      this.out('% Invalid regular expression');
      return;
    }
    const mark = this.buf.length;
    this.run(cmd, mode);
    const produced = this.buf.splice(mark).join('\n').split('\n');
    const lines = produced[produced.length - 1] === '' ? produced.slice(0, -1) : produced;
    let res: string[];
    switch (full) {
      case 'include':
        res = lines.filter((l) => re.test(l));
        break;
      case 'exclude':
        res = lines.filter((l) => !re.test(l));
        break;
      case 'begin': {
        const i = lines.findIndex((l) => re.test(l));
        res = i < 0 ? [] : lines.slice(i);
        break;
      }
      case 'section': {
        res = [];
        let inSec = false;
        for (const l of lines) {
          if (!l.startsWith(' ')) inSec = re.test(l);
          if (inSec || re.test(l)) res.push(l);
        }
        break;
      }
      default:
        res = [`Number of lines which match regexp = ${lines.filter((l) => re.test(l)).length}`];
    }
    for (const l of res) this.out(l);
  }

  private run(line: string, mode: ModeId): void {
    const r = registry().parse(mode, line, this.env());
    if (r.ok) {
      this.negated = r.negated;
      try {
        r.def.run(this, r.args);
      } catch (e) {
        if (e instanceof CliError) this.out(e.message);
        else throw e;
      }
      return;
    }
    switch (r.error) {
      case 'empty':
        return;
      case 'invalid':
        this.out(`${' '.repeat(this.prompt().length + r.at)}^`);
        this.out("% Invalid input detected at '^' marker.");
        this.out('');
        return;
      case 'incomplete':
        this.out('% Incomplete command.');
        this.out('');
        return;
      case 'ambiguous':
        this.out(`% Ambiguous command:  "${r.text}"`);
        this.out('');
    }
  }

  /** Führt `line` in einem anderen Modus aus (für `do`). */
  runIn(mode: ModeId, line: string): void {
    this.execute(line, mode);
  }

  help(line: string): string | undefined {
    if (this.pending) return undefined;
    const doMatch = /^\s*do\s+(.*)$/i.exec(line);
    const [mode, text] =
      doMatch && this.mode.startsWith('config')
        ? (['priv', doMatch[1] ?? ''] as const)
        : ([this.mode, line] as const);
    return registry().help(mode, text, this.env()).join('\n') + '\n';
  }

  complete(line: string): string {
    const doMatch = /^(\s*do\s+)(.*)$/i.exec(line);
    if (doMatch && this.mode.startsWith('config')) {
      return (doMatch[1] ?? '') + registry().complete('priv', doMatch[2] ?? '', this.env());
    }
    return registry().complete(this.mode, line, this.env());
  }

  interrupt(): string {
    this.pending = undefined;
    this.buf = [];
    return '';
  }

  end(): string {
    if (this.pending) return this.interrupt();
    if (this.mode.startsWith('config')) this.mode = 'priv';
    return '';
  }

  // ------------------------------------------------------------ Hilfen für Handler

  /** Meldungen wie IOS, wenn sich der Linkstatus durch eine Portänderung ändert. */
  setAdmin(portId: string, up: boolean): void {
    const p = this.device.ports.find((x) => x.id === portId);
    if (!p) return;
    const before = p.operUp;
    this.engine.setPortAdmin(this.deviceId, portId, up);
    if (before === p.operUp) return;
    if (up) {
      this.out(`%LINK-3-UPDOWN: Interface ${p.name}, changed state to up`);
      this.out(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${p.name}, changed state to up`);
    } else {
      this.out(`%LINK-5-CHANGED: Interface ${p.name}, changed state to administratively down`);
      this.out(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${p.name}, changed state to down`);
    }
  }

  /** Setzt die Konfiguration aus Text um (Startup-Config laden / Replay). */
  applyConfigText(text: string): void {
    const t = new CliSession(this.engine, this.deviceId);
    t.silent = true;
    t.replay = true;
    t.started = true;
    t.mode = 'config';
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (line.trim() === '' || line.trim() === '!' || line.trim() === 'end') continue;
      if (!t.pending && !line.startsWith(' ')) t.mode = 'config';
      t.input(line.trim() === line ? line : line.trim());
    }
  }

  shortName(name: string): string {
    return shortName(name);
  }
}

export type { Args };
