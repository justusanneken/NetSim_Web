import { isValidIpv4 } from '@netsim/protocols';
import type { Device, Engine } from '@netsim/engine';
import { CliSession } from './session';
import type { Shell, ShellNest } from './shell';
import { waitFor } from './util';

/** Gerät, dem die IPv4-Adresse gehört (Host, Router, Switch). */
export function deviceByIp(e: Engine, ip: string): Device | undefined {
  for (const d of Object.values(e.state.devices)) {
    const c = d.config;
    if (c.kind === 'host' && c.ip === ip) return d;
    if (
      (c.kind === 'router' || c.kind === 'switch') &&
      Object.values(c.ifaces).some((i) => i.ip === ip)
    )
      return d;
  }
  return undefined;
}

/**
 * Telnet-/SSH-Sitzung nach der Anmeldung: Zeilen und Ausgabe der Ziel-CLI werden als TCP-Segmente zwischen den
 * Geräten übertragen (eine Zeile = ein Segment `line`, die Ausgabe = ein Segment `out`). Fällt der Pfad aus,
 * wiederholt TCP die Segmente und die Sitzung steht still, bis die Retransmission aufgibt (≈ 31 s); dann wird
 * sie mit der Meldung „Connection timed out“ geschlossen. SSH-Segmente sind im Inspektor als verschlüsselt markiert.
 */
export class RemoteNetShell implements Shell {
  private dead = false;

  constructor(
    private readonly engine: Engine,
    private readonly fromId: string,
    private readonly key: string,
    private readonly targetId: string,
    private readonly serverKey: string,
    private readonly inner: CliSession,
  ) {}

  get closed(): boolean {
    return this.dead || this.inner.closed;
  }
  set closed(v: boolean) {
    this.inner.closed = v;
  }
  next?: Shell;
  set nest(n: ShellNest | undefined) {
    this.inner.nest = n;
  }
  get history(): readonly string[] {
    return this.inner.history;
  }
  get terminalLength(): number {
    return this.inner.terminalLength;
  }
  prompt = (): string => this.inner.prompt();
  secret = (): boolean => this.inner.secret();
  help = (l: string): string | undefined => this.inner.help(l);
  complete = (l: string): string => this.inner.complete(l);
  end = (): string => this.inner.end();
  start = (): string => this.inner.start();
  poll = (): string => this.inner.poll();
  interrupt = (): string => this.inner.interrupt();

  private failed(): boolean {
    const c = this.engine.p5.connState(this.fromId, this.key);
    return !c || c.state !== 'open';
  }

  private timeout(): string {
    this.dead = true;
    this.engine.p5.abortRemote(this.fromId, this.key);
    return '\n% Connection timed out; remote host not responding\n';
  }

  input(line: string): string {
    const e = this.engine;
    const before = e.p5.connState(this.fromId, this.key)?.replySeq ?? 0;
    if (!e.p5.send(this.fromId, this.key, 'line', {}, line)) return this.timeout();
    // Zeile zum Zielgerät: warten, bis das Segment bestätigt ist (oder TCP aufgibt)
    waitFor(
      e,
      () => this.failed() || (e.p5.connState(this.fromId, this.key)?.rtx ?? []).length === 0,
    );
    if (this.failed()) return this.timeout();
    const out = this.inner.input(line);
    // Ausgabe zurück zum Client: ebenfalls als TCP-Segment
    if (!e.p5.pushOut(this.targetId, this.serverKey, out)) return out;
    waitFor(
      e,
      () => this.failed() || (e.p5.connState(this.fromId, this.key)?.replySeq ?? 0) > before,
    );
    if (this.failed() && this.inner.closed === false) return this.timeout();
    return e.p5.connState(this.fromId, this.key)?.reply?.body ?? out;
  }
}

/** Anmeldedialog einer Telnet-/SSH-Verbindung; wird nach Erfolg durch die CLI des Zielgeräts ersetzt. */
export class RemoteLoginShell implements Shell {
  readonly history: string[] = [];
  readonly terminalLength = 0;
  closed = false;
  next?: Shell;
  private stage: 'user' | 'pass' | 'done';
  private user: string;
  private bannerText: string;
  private mode: string;
  private readonly fixedUser: boolean;

  constructor(
    private readonly engine: Engine,
    private readonly fromId: string,
    private readonly key: string,
    private readonly dst: string,
    private readonly proto: 'telnet' | 'ssh',
    user: string | undefined,
    private readonly deferred: () => boolean,
  ) {
    const c = engine.p5.connState(fromId, key);
    this.mode = String(c?.banner?.args.auth ?? 'none');
    this.bannerText = c?.banner?.body ?? '';
    this.user = user ?? '';
    this.fixedUser = !!user;
    this.stage = this.mode === 'local' || this.mode === 'aaa' ? (user ? 'pass' : 'user') : 'pass';
  }

  prompt(): string {
    if (this.stage === 'user') return 'Username: ';
    return 'Password: ';
  }
  secret(): boolean {
    return this.stage === 'pass';
  }
  help = (): undefined => undefined;
  complete = (l: string): string => l;
  interrupt = (): string => {
    this.finish();
    return '';
  };
  end = (): string => '';

  private finish(): void {
    this.closed = true;
    this.stage = 'done';
    this.engine.p5.close(this.fromId, this.key);
  }

  start(): string {
    const out: string[] = [];
    if (this.bannerText) out.push(this.bannerText);
    if (this.mode === 'none') {
      out.push('% Password required, but none set', '');
      this.finish();
      return out.join('\n') + '\n';
    }
    if (this.proto === 'telnet') out.push('', 'User Access Verification', '');
    return out.join('\n') + (out.length ? '\n' : '');
  }

  input(line: string): string {
    if (this.stage === 'user') {
      this.user = line.trim();
      this.stage = 'pass';
      return '';
    }
    const pass = line;
    this.engine.p5.send(this.fromId, this.key, 'login', { user: this.user, pass });
    waitFor(this.engine, () => this.engine.p5.connState(this.fromId, this.key)?.waiting !== true);
    const c = this.engine.p5.connState(this.fromId, this.key);
    const reply = c?.reply;
    if (reply?.op === 'login-ok' && c) {
      const byId = this.engine.getDevice(String(c.banner?.args.dev ?? ''));
      const target = byId ?? deviceByIp(this.engine, this.dst);
      if (!target) {
        this.finish();
        return '% Connection closed\n';
      }
      const from = this.engine.getDevice(this.fromId);
      const sess = new CliSession(this.engine, target.id, this.deferred);
      sess.beginRemote({
        vty: Number(reply.args.vty ?? 0),
        user: this.user,
        from: sourceIpOf(from, this.dst),
        proto: this.proto,
      });
      this.next = new RemoteNetShell(
        this.engine,
        this.fromId,
        this.key,
        target.id,
        String(c.banner?.args.sk ?? ''),
        sess,
      );
      this.stage = 'done';
      return '';
    }
    if (!c || c.state === 'failed' || c.state === 'closed') {
      this.closed = true;
      const msg =
        c?.err === 'conn.timeout' ? '% Connection timed out; remote host not responding' : '';
      return `${this.mode === 'password' ? '% Bad passwords' : '% Authentication failed'}\n${msg}`;
    }
    this.stage = this.mode === 'password' || this.fixedUser ? 'pass' : 'user';
    return `${this.mode === 'password' ? '% Bad passwords' : '% Authentication failed'}\n`;
  }
}

function sourceIpOf(from: Device | undefined, dst: string): string {
  const c = from?.config;
  if (c?.kind === 'host') return c.ip ?? '';
  if (c?.kind === 'router' || c?.kind === 'switch')
    return Object.values(c.ifaces).find((i) => i.ip)?.ip ?? dst;
  return '';
}

/**
 * `telnet`/`ssh` von `fromId` aus: Verbindung über das simulierte Netz aufbauen, bei Erfolg den Anmeldedialog
 * als neue Shell öffnen. Liefert den Text, der vor dem Dialog ausgegeben wird.
 */
export function openRemote(o: {
  engine: Engine;
  fromId: string;
  nest: ShellNest | undefined;
  dst: string;
  proto: 'telnet' | 'ssh';
  user?: string;
  deferred: () => boolean;
  /** Text der Sitzungsmeldungen (Windows- bzw. IOS-Stil). */
  style: 'ios' | 'win';
}): string {
  const { engine: e, fromId, dst, proto } = o;
  if (!isValidIpv4(dst))
    return o.style === 'ios'
      ? '% Unrecognized host or address.\n'
      : `Could not open connection to the host, on port ${proto === 'ssh' ? 22 : 23}: Connect failed\n`;
  if (o.deferred())
    return 'Simulation mode: remote sessions are not available while stepping through events.\n';
  const r = e.p5.open(fromId, dst, proto);
  const trying = `Trying ${dst} ... `;
  if (!r.ok) return `${trying}\n% Destination unreachable; gateway or host down\n`;
  const key = r.value;
  waitFor(e, () => e.p5.connState(fromId, key)?.state !== 'syn-sent');
  const c = e.p5.connState(fromId, key);
  if (c?.state !== 'open') {
    const err = c?.err;
    e.p5.close(fromId, key);
    if (o.style === 'win')
      return `Connecting To ${dst}...Could not open connection to the host, on port ${proto === 'ssh' ? 22 : 23}: Connect failed\n`;
    return `${trying}\n${
      err === 'conn.refused'
        ? '% Connection refused by remote host'
        : '% Connection timed out; remote host not responding'
    }\n`;
  }
  const shell = new RemoteLoginShell(e, fromId, key, dst, proto, o.user, o.deferred);
  const bye = (): string => {
    e.p5.close(fromId, key);
    e.runUntil(e.state.now + 20_000);
    return `[Connection to ${dst} closed by foreign host]\n`;
  };
  o.nest?.push(shell, bye);
  return o.style === 'ios' ? `${trying}Open\n` : `Connecting To ${dst}...\n`;
}
