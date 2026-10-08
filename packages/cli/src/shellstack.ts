import type { Shell, ShellNest } from './shell';

/**
 * Stapel von Shells eines Terminals: die Basis-Shell (Console bzw. Eingabeaufforderung) und darüber
 * geöffnete Telnet-/SSH-/FTP-Sitzungen. Alle Shell-Aufrufe gehen an die oberste Shell; beendet sich
 * diese (`closed`) oder wird sie ersetzt (`next`), wird der Stapel angepasst und der Übergang ausgegeben.
 */
export class ShellStack implements Shell, ShellNest {
  private readonly stack: Shell[];
  /** Beim Schließen einer Shell auszuführen (z. B. FIN senden); liefert Text für die darunterliegende Shell. */
  private readonly onClose = new Map<Shell, () => string>();

  constructor(base: Shell & { nest?: ShellNest }) {
    this.stack = [base];
    base.nest = this;
  }

  get top(): Shell {
    return this.stack[this.stack.length - 1] as Shell;
  }
  get depth(): number {
    return this.stack.length;
  }

  push(shell: Shell, onClose?: () => string): void {
    this.stack.push(shell);
    if (onClose) this.onClose.set(shell, onClose);
    (shell as { nest?: ShellNest }).nest = this;
  }

  /** Nach einem Aufruf an die oberste Shell: Pushes, Ersetzungen und Beenden abarbeiten. */
  private settle(before: Shell, depthBefore: number): string {
    let out = '';
    // Neu geöffnete Shell(s)
    for (let i = depthBefore; i < this.stack.length; i++) out += this.fresh(this.stack[i]);
    for (let guard = 0; guard < 8; guard++) {
      const t = this.top;
      if (t.next) {
        const nx = t.next;
        t.next = undefined;
        const cb = this.onClose.get(t);
        this.onClose.delete(t);
        this.stack[this.stack.length - 1] = nx;
        if (cb) this.onClose.set(nx, cb);
        (nx as { nest?: ShellNest }).nest = this;
        out += this.fresh(nx);
        continue;
      }
      if (t.closed && this.stack.length > 1) {
        this.stack.pop();
        const cb = this.onClose.get(t);
        this.onClose.delete(t);
        if (cb) out += cb();
        continue;
      }
      break;
    }
    void before;
    return out;
  }

  private fresh(sh: Shell | undefined): string {
    return sh ? sh.start() : '';
  }

  /** Text eines Übergangs, der außerhalb von input/poll erkannt wurde (z. B. Zielgerät ausgeschaltet). */
  private carry = '';

  /** Von außen beendete Sitzungen (Zielgerät entfernt/aus) abbauen, bevor die oberste Shell benutzt wird. */
  private reap(): void {
    if (this.top.closed && this.stack.length > 1)
      this.carry += this.settle(this.top, this.stack.length);
  }
  private takeCarry(): string {
    const c = this.carry;
    this.carry = '';
    return c;
  }

  // ---- Shell
  prompt(): string {
    this.reap();
    return this.top.prompt();
  }
  secret(): boolean {
    this.reap();
    return this.top.secret();
  }
  input(line: string): string {
    this.reap();
    const t = this.top;
    const d = this.stack.length;
    return this.takeCarry() + t.input(line) + this.settle(t, d);
  }
  help(line: string): string | undefined {
    this.reap();
    return this.top.help(line);
  }
  complete(line: string): string {
    this.reap();
    return this.top.complete(line);
  }
  interrupt(): string {
    this.reap();
    const t = this.top;
    const d = this.stack.length;
    return this.takeCarry() + t.interrupt() + this.settle(t, d);
  }
  end(): string {
    this.reap();
    const t = this.top;
    const d = this.stack.length;
    return this.takeCarry() + t.end() + this.settle(t, d);
  }
  start(): string {
    return this.stack[0]?.start() ?? '';
  }
  poll(): string {
    const t = this.top;
    const d = this.stack.length;
    return this.takeCarry() + (t.poll?.() ?? '') + this.settle(t, d);
  }
  get history(): readonly string[] {
    this.reap();
    return this.top.history;
  }
  get terminalLength(): number {
    this.reap();
    return this.top.terminalLength;
  }
}
