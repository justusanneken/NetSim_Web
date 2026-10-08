import type { Shell } from './shell';

const crlf = (s: string): string => s.replace(/\r?\n/g, '\r\n');

interface Pager {
  lines: string[];
  pos: number;
  page: number;
}

/**
 * Zeileneditor für xterm.js (und Tests): verarbeitet Tastatureingaben, schreibt Ausgabe als
 * Terminal-Daten. Unterstützt Historie, Cursor, Ctrl+A/E/U/W/C/Z, Tab, `?` und `--More--`.
 */
export class Terminal {
  private buf = '';
  private cur = 0;
  private histIdx: number | null = null;
  private saved = '';
  private pager: Pager | undefined;

  constructor(private readonly sh: Shell) {}

  /** Initialausgabe + Prompt. */
  start(): string {
    return crlf(this.sh.start()) + this.paintPrompt();
  }

  /** Zeichnet Prompt und aktuellen Puffer neu (z. B. beim erneuten Öffnen). */
  redraw(): string {
    return '\r\x1b[K' + this.paintPrompt();
  }

  private paintPrompt(): string {
    const shown = this.sh.secret() ? '' : this.buf;
    const back = this.sh.secret() ? 0 : this.buf.length - this.cur;
    return this.sh.prompt() + shown + (back > 0 ? `\x1b[${back}D` : '');
  }

  private repaint(): string {
    if (this.sh.secret()) return '';
    return '\r\x1b[K' + this.paintPrompt();
  }

  /** Verarbeitet Eingabedaten; liefert die auszugebenden Terminal-Daten. */
  handle(data: string): string {
    let out = '';
    for (let i = 0; i < data.length; i++) {
      const ch = data[i] as string;
      if (this.pager) {
        out += this.pagerKey(ch);
        continue;
      }
      if (ch === '\x1b') {
        // eslint-disable-next-line no-control-regex
        const m = /^\x1b(?:\[([0-9;]*)([A-Za-z~])|O([A-Za-z]))/.exec(data.slice(i));
        if (m) {
          i += m[0].length - 1;
          out += this.escape(m[2] ?? m[3] ?? '', m[1] ?? '');
        }
        continue;
      }
      out += this.key(ch);
    }
    return out;
  }

  private escape(code: string, param: string): string {
    switch (code) {
      case 'A':
        return this.history(-1);
      case 'B':
        return this.history(1);
      case 'C':
        if (this.cur < this.buf.length) {
          this.cur++;
          return this.sh.secret() ? '' : '\x1b[C';
        }
        return '';
      case 'D':
        if (this.cur > 0) {
          this.cur--;
          return this.sh.secret() ? '' : '\x1b[D';
        }
        return '';
      case 'H':
        return this.home();
      case 'F':
        return this.endKey();
      case '~':
        if (param === '3' && this.cur < this.buf.length) {
          this.buf = this.buf.slice(0, this.cur) + this.buf.slice(this.cur + 1);
          return this.repaint();
        }
        return '';
      default:
        return '';
    }
  }

  private home(): string {
    this.cur = 0;
    return this.repaint();
  }
  private endKey(): string {
    this.cur = this.buf.length;
    return this.repaint();
  }

  private history(dir: -1 | 1): string {
    if (this.sh.secret()) return '';
    const h = this.sh.history;
    if (dir < 0) {
      if (h.length === 0) return '';
      if (this.histIdx === null) {
        this.saved = this.buf;
        this.histIdx = h.length - 1;
      } else if (this.histIdx > 0) this.histIdx--;
    } else {
      if (this.histIdx === null) return '';
      if (this.histIdx < h.length - 1) this.histIdx++;
      else {
        this.histIdx = null;
        this.buf = this.saved;
        this.cur = this.buf.length;
        return this.repaint();
      }
    }
    this.buf = h[this.histIdx as number] ?? '';
    this.cur = this.buf.length;
    return this.repaint();
  }

  private key(ch: string): string {
    switch (ch) {
      case '\r':
      case '\n':
        return this.enter();
      case '\x7f':
      case '\b':
        if (this.cur === 0) return '';
        this.buf = this.buf.slice(0, this.cur - 1) + this.buf.slice(this.cur);
        this.cur--;
        return this.repaint();
      case '\t': {
        if (this.sh.secret()) return '';
        const c = this.sh.complete(this.buf);
        if (c === this.buf) return '';
        this.buf = c;
        this.cur = c.length;
        return this.repaint();
      }
      case '\x01':
        return this.home();
      case '\x05':
        return this.endKey();
      case '\x15':
        this.buf = this.buf.slice(this.cur);
        this.cur = 0;
        return this.repaint();
      case '\x17': {
        const before = this.buf.slice(0, this.cur).replace(/\s+$/, '');
        const start = before.search(/\S+$/);
        const keep = start < 0 ? 0 : start;
        this.buf = this.buf.slice(0, keep) + this.buf.slice(this.cur);
        this.cur = keep;
        return this.repaint();
      }
      case '\x03': {
        this.sh.interrupt();
        this.buf = '';
        this.cur = 0;
        this.histIdx = null;
        return '^C\r\n' + this.paintPrompt();
      }
      case '\x1a': {
        const o = this.sh.end();
        this.buf = '';
        this.cur = 0;
        return '^Z\r\n' + crlf(o) + this.paintPrompt();
      }
      case '?': {
        const h = this.sh.secret() ? undefined : this.sh.help(this.buf);
        if (h !== undefined) return '?\r\n' + crlf(h) + this.paintPrompt();
        return this.insert(ch);
      }
      default:
        return ch >= ' ' ? this.insert(ch) : '';
    }
  }

  private insert(ch: string): string {
    this.buf = this.buf.slice(0, this.cur) + ch + this.buf.slice(this.cur);
    this.cur++;
    if (this.sh.secret()) return '';
    return this.cur === this.buf.length ? ch : this.repaint();
  }

  private enter(): string {
    const line = this.buf;
    this.buf = '';
    this.cur = 0;
    this.histIdx = null;
    const result = this.sh.input(line);
    return '\r\n' + this.emit(result);
  }

  /** Gibt Text aus (mit Seitenumbruch) und danach den Prompt. */
  private emit(text: string): string {
    const len = this.sh.terminalLength;
    const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
    if (len > 0 && lines.length > len) {
      this.pager = { lines, pos: 0, page: len - 1 };
      return this.nextPage();
    }
    return (lines.length ? lines.join('\r\n') + '\r\n' : '') + this.paintPrompt();
  }

  private nextPage(): string {
    const p = this.pager as Pager;
    const chunk = p.lines.slice(p.pos, p.pos + p.page);
    p.pos += chunk.length;
    p.page = this.sh.terminalLength - 1;
    let out = chunk.join('\r\n') + '\r\n';
    if (p.pos >= p.lines.length) {
      this.pager = undefined;
      return out + this.paintPrompt();
    }
    out += ' --More-- ';
    return out;
  }

  private pagerKey(ch: string): string {
    const p = this.pager as Pager;
    const clear = '\r\x1b[K';
    if (ch === ' ') {
      p.page = this.sh.terminalLength - 1;
      return clear + this.nextPage();
    }
    if (ch === '\r' || ch === '\n') {
      p.page = 1;
      return clear + this.nextPage();
    }
    // q, Ctrl+C oder beliebige andere Taste bricht ab
    this.pager = undefined;
    return clear + this.paintPrompt();
  }
}
