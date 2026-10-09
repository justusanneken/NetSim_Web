/**
 * Kleiner, sandboxed Interpreter für eine JavaScript-Teilmenge (IoT-/SBC-Programme).
 *
 * - Kein `eval`/`new Function`, kein Zugriff auf Globals, DOM, Netzwerk, Prototypen oder `constructor`.
 * - Deterministisch: kein `Math.random`, keine Uhr; Zeit kommt nur über die Host-API.
 * - Schrittgrenze (`maxSteps`) und Aufruftiefe begrenzen die CPU-Zeit; Überschreitung ist ein `ScriptError`.
 *
 * Unterstützt: var/let/const, Funktionen (Deklaration, Ausdruck, Pfeil), if/else, while, for, for…of, break,
 * continue, return, Zahlen/Strings/Template-Strings/Booleans/null/undefined, Arrays und Objekte, die üblichen
 * Operatoren (inkl. `**`, `??`, `?:`, `typeof`, Zuweisungs-/Inkrement-Operatoren) sowie `Math`, `Number`,
 * `String`, `parseFloat`, `parseInt`, `isNaN`, `JSON.stringify` und einfache String-/Array-Methoden.
 */

export class ScriptError extends Error {
  constructor(
    message: string,
    readonly line = 0,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ Lexer

type Tok = {
  t: 'num' | 'str' | 'tpl' | 'id' | 'kw' | 'p' | 'eof';
  v: string;
  line: number;
  n?: number;
};

const KEYWORDS = new Set([
  'var',
  'let',
  'const',
  'function',
  'return',
  'if',
  'else',
  'while',
  'for',
  'of',
  'break',
  'continue',
  'true',
  'false',
  'null',
  'undefined',
  'typeof',
]);

const PUNCT = [
  '>>>=',
  '===',
  '!==',
  '**=',
  '...',
  '&&=',
  '||=',
  '??=',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '**',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '=>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '=',
  '<',
  '>',
  '!',
  '?',
  ':',
  ';',
  ',',
  '.',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  const isId = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '\n') {
      line++;
      i++;
    } else if (/\s/.test(c)) i++;
    else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line++;
        i++;
      }
      i += 2;
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9a-fA-F]+|\d*\.?\d+(?:[eE][+-]?\d+)?|\d+\.)/.exec(src.slice(i));
      const s = (m as RegExpExecArray)[0];
      out.push({ t: 'num', v: s, n: Number(s), line });
      i += s.length;
    } else if (c === '"' || c === "'") {
      let s = '';
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\n') throw new ScriptError('unterminated string', line);
        if (src[i] === '\\') {
          i++;
          const e = src[i] as string;
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
        } else s += src[i];
        i++;
      }
      if (i >= src.length) throw new ScriptError('unterminated string', line);
      i++;
      out.push({ t: 'str', v: s, line });
    } else if (c === '`') {
      let s = '';
      i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\n') line++;
        if (src[i] === '\\') {
          i++;
          const e = src[i] as string;
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
        } else if (src[i] === '$' && src[i + 1] === '{') {
          let depth = 1;
          let j = i + 2;
          while (j < src.length && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
          }
          s += '\u0000' + src.slice(i + 2, j - 1) + '\u0001';
          i = j - 1;
        } else s += src[i];
        i++;
      }
      if (i >= src.length) throw new ScriptError('unterminated template', line);
      i++;
      out.push({ t: 'tpl', v: s, line });
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && isId(src[j] as string)) j++;
      const w = src.slice(i, j);
      out.push({ t: KEYWORDS.has(w) ? 'kw' : 'id', v: w, line });
      i = j;
    } else {
      const p = PUNCT.find((x) => src.startsWith(x, i));
      if (!p) throw new ScriptError(`unexpected character '${c}'`, line);
      out.push({ t: 'p', v: p, line });
      i += p.length;
    }
  }
  out.push({ t: 'eof', v: '', line });
  return out;
}

// ------------------------------------------------------------------ AST / Parser

type Node = { k: string; line: number; [key: string]: unknown };
const N = (k: string, line: number, rest: Record<string, unknown> = {}): Node => ({
  k,
  line,
  ...rest,
});

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  private get cur(): Tok {
    return this.toks[this.i] as Tok;
  }
  private is(v: string): boolean {
    const c = this.cur;
    return (c.t === 'p' || c.t === 'kw') && c.v === v;
  }
  private eat(v: string): boolean {
    if (this.is(v)) {
      this.i++;
      return true;
    }
    return false;
  }
  private expect(v: string): void {
    if (!this.eat(v))
      throw new ScriptError(`expected '${v}' but found '${this.cur.v || 'end'}'`, this.cur.line);
  }
  private ident(): string {
    const c = this.cur;
    if (c.t !== 'id')
      throw new ScriptError(`expected identifier but found '${c.v || 'end'}'`, c.line);
    this.i++;
    return c.v;
  }
  private semi(): void {
    this.eat(';');
  }

  program(): Node[] {
    const body: Node[] = [];
    while (this.cur.t !== 'eof') body.push(this.stmt());
    return body;
  }

  private block(): Node {
    const line = this.cur.line;
    this.expect('{');
    const body: Node[] = [];
    while (!this.is('}')) {
      if (this.cur.t === 'eof') throw new ScriptError("missing '}'", line);
      body.push(this.stmt());
    }
    this.expect('}');
    return N('block', line, { body });
  }

  private stmt(): Node {
    const c = this.cur;
    const line = c.line;
    if (this.is('{')) return this.block();
    if (this.eat(';')) return N('empty', line);
    if (this.is('var') || this.is('let') || this.is('const')) {
      const d = this.decl();
      this.semi();
      return d;
    }
    if (this.is('function') && this.toks[this.i + 1]?.t === 'id') {
      this.i++;
      const name = this.ident();
      return N('fundecl', line, { name, fn: this.fnRest(name, line) });
    }
    if (this.eat('if')) {
      this.expect('(');
      const test = this.expr();
      this.expect(')');
      const then = this.stmt();
      const other = this.eat('else') ? this.stmt() : undefined;
      return N('if', line, { test, then, other });
    }
    if (this.eat('while')) {
      this.expect('(');
      const test = this.expr();
      this.expect(')');
      return N('while', line, { test, body: this.stmt() });
    }
    if (this.eat('for')) {
      this.expect('(');
      if (
        (this.is('let') || this.is('const') || this.is('var')) &&
        this.toks[this.i + 2]?.v === 'of'
      ) {
        this.i++;
        const name = this.ident();
        this.expect('of');
        const iter = this.expr();
        this.expect(')');
        return N('forof', line, { name, iter, body: this.stmt() });
      }
      let init: Node | undefined;
      if (!this.is(';'))
        init =
          this.is('let') || this.is('const') || this.is('var')
            ? this.decl()
            : N('expr', line, { e: this.expr() });
      this.expect(';');
      const test = this.is(';') ? undefined : this.expr();
      this.expect(';');
      const update = this.is(')') ? undefined : this.expr();
      this.expect(')');
      return N('for', line, { init, test, update, body: this.stmt() });
    }
    if (this.eat('return')) {
      const e = this.is(';') || this.is('}') || this.cur.t === 'eof' ? undefined : this.expr();
      this.semi();
      return N('return', line, { e });
    }
    if (this.eat('break')) {
      this.semi();
      return N('break', line);
    }
    if (this.eat('continue')) {
      this.semi();
      return N('continue', line);
    }
    const e = this.expr();
    this.semi();
    return N('expr', line, { e });
  }

  private decl(): Node {
    const line = this.cur.line;
    const kind = this.cur.v;
    this.i++;
    const list: { name: string; init?: Node }[] = [];
    do {
      const name = this.ident();
      list.push({ name, init: this.eat('=') ? this.assign() : undefined });
    } while (this.eat(','));
    return N('decl', line, { kind, list });
  }

  private fnRest(name: string, line: number): Node {
    this.expect('(');
    const params: string[] = [];
    while (!this.is(')')) {
      params.push(this.ident());
      if (!this.eat(',')) break;
    }
    this.expect(')');
    return N('fn', line, { name, params, body: this.block() });
  }

  expr(): Node {
    const e = this.assign();
    if (this.is(',')) {
      const list = [e];
      while (this.eat(',')) list.push(this.assign());
      return N('seq', e.line, { list });
    }
    return e;
  }

  private arrowAhead(): boolean {
    // ( … ) =>  oder  ident =>
    if (this.cur.t === 'id' && this.toks[this.i + 1]?.v === '=>') return true;
    if (!this.is('(')) return false;
    let depth = 0;
    for (let j = this.i; j < this.toks.length; j++) {
      const t = this.toks[j] as Tok;
      if (t.t === 'p' && t.v === '(') depth++;
      else if (t.t === 'p' && t.v === ')' && --depth === 0) return this.toks[j + 1]?.v === '=>';
    }
    return false;
  }

  private assign(): Node {
    const line = this.cur.line;
    if (this.arrowAhead()) {
      const params: string[] = [];
      if (this.cur.t === 'id') params.push(this.ident());
      else {
        this.expect('(');
        while (!this.is(')')) {
          params.push(this.ident());
          if (!this.eat(',')) break;
        }
        this.expect(')');
      }
      this.expect('=>');
      const body = this.is('{')
        ? this.block()
        : N('block', line, { body: [N('return', line, { e: this.assign() })] });
      return N('fn', line, { name: '', params, body });
    }
    const left = this.ternary();
    const c = this.cur;
    if (
      c.t === 'p' &&
      ['=', '+=', '-=', '*=', '/=', '%=', '**=', '&&=', '||=', '??='].includes(c.v)
    ) {
      if (left.k !== 'id' && left.k !== 'member')
        throw new ScriptError('invalid assignment target', c.line);
      this.i++;
      return N('assign', c.line, { op: c.v, target: left, value: this.assign() });
    }
    return left;
  }

  private ternary(): Node {
    const test = this.bin(0);
    if (this.eat('?')) {
      const a = this.assign();
      this.expect(':');
      const b = this.assign();
      return N('cond', test.line, { test, a, b });
    }
    return test;
  }

  private static LEVELS: string[][] = [
    ['??'],
    ['||'],
    ['&&'],
    ['==', '!=', '===', '!=='],
    ['<', '>', '<=', '>='],
    ['+', '-'],
    ['*', '/', '%'],
  ];

  private bin(level: number): Node {
    if (level >= Parser.LEVELS.length) return this.unary();
    let left = this.bin(level + 1);
    for (;;) {
      const c = this.cur;
      if (c.t === 'p' && (Parser.LEVELS[level] as string[]).includes(c.v)) {
        this.i++;
        const right = this.bin(level + 1);
        left = N(c.v === '&&' || c.v === '||' || c.v === '??' ? 'logic' : 'bin', c.line, {
          op: c.v,
          left,
          right,
        });
      } else return left;
    }
  }

  private unary(): Node {
    const c = this.cur;
    if (c.t === 'p' && (c.v === '!' || c.v === '-' || c.v === '+')) {
      this.i++;
      return N('unary', c.line, { op: c.v, e: this.unary() });
    }
    if (c.t === 'kw' && c.v === 'typeof') {
      this.i++;
      return N('unary', c.line, { op: 'typeof', e: this.unary() });
    }
    if (c.t === 'p' && (c.v === '++' || c.v === '--')) {
      this.i++;
      const target = this.unary();
      if (target.k !== 'id' && target.k !== 'member')
        throw new ScriptError('invalid increment target', c.line);
      return N('update', c.line, { op: c.v, target, prefix: true });
    }
    return this.power();
  }

  private power(): Node {
    const base = this.postfix();
    if (this.eat('**')) return N('bin', base.line, { op: '**', left: base, right: this.unary() });
    return base;
  }

  private postfix(): Node {
    let e = this.call();
    const c = this.cur;
    if (c.t === 'p' && (c.v === '++' || c.v === '--')) {
      if (e.k !== 'id' && e.k !== 'member')
        throw new ScriptError('invalid increment target', c.line);
      this.i++;
      e = N('update', c.line, { op: c.v, target: e, prefix: false });
    }
    return e;
  }

  private call(): Node {
    let e = this.primary();
    for (;;) {
      const line = this.cur.line;
      if (this.eat('.')) {
        const c = this.cur;
        if (c.t !== 'id' && c.t !== 'kw') throw new ScriptError('expected property name', c.line);
        this.i++;
        e = N('member', line, { obj: e, prop: N('lit', line, { v: c.v }), computed: false });
      } else if (this.eat('[')) {
        const prop = this.expr();
        this.expect(']');
        e = N('member', line, { obj: e, prop, computed: true });
      } else if (this.eat('(')) {
        const args: Node[] = [];
        while (!this.is(')')) {
          args.push(this.assign());
          if (!this.eat(',')) break;
        }
        this.expect(')');
        e = N('call', line, { callee: e, args });
      } else return e;
    }
  }

  private primary(): Node {
    const c = this.cur;
    const line = c.line;
    if (c.t === 'num') {
      this.i++;
      return N('lit', line, { v: c.n });
    }
    if (c.t === 'str') {
      this.i++;
      return N('lit', line, { v: c.v });
    }
    if (c.t === 'tpl') {
      this.i++;
      const parts: (string | Node)[] = [];
      let rest = c.v;
      while (rest.length > 0) {
        const a = rest.indexOf('\u0000');
        if (a < 0) {
          parts.push(rest);
          break;
        }
        if (a > 0) parts.push(rest.slice(0, a));
        const b = rest.indexOf('\u0001', a);
        const sub = new Parser(lex(rest.slice(a + 1, b)));
        parts.push(sub.expr());
        rest = rest.slice(b + 1);
      }
      return N('tpl', line, { parts });
    }
    if (c.t === 'id') {
      this.i++;
      return N('id', line, { name: c.v });
    }
    if (c.t === 'kw') {
      if (c.v === 'true' || c.v === 'false') {
        this.i++;
        return N('lit', line, { v: c.v === 'true' });
      }
      if (c.v === 'null') {
        this.i++;
        return N('lit', line, { v: null });
      }
      if (c.v === 'undefined') {
        this.i++;
        return N('lit', line, { v: undefined });
      }
      if (c.v === 'function') {
        this.i++;
        const name = this.cur.t === 'id' ? this.ident() : '';
        return this.fnRest(name, line);
      }
    }
    if (this.eat('(')) {
      const e = this.expr();
      this.expect(')');
      return e;
    }
    if (this.eat('[')) {
      const items: Node[] = [];
      while (!this.is(']')) {
        items.push(this.assign());
        if (!this.eat(',')) break;
      }
      this.expect(']');
      return N('array', line, { items });
    }
    if (this.eat('{')) {
      const props: { key: string; value: Node }[] = [];
      while (!this.is('}')) {
        const k = this.cur;
        let key: string;
        if (k.t === 'id' || k.t === 'kw' || k.t === 'str') key = k.v;
        else if (k.t === 'num') key = String(k.n);
        else throw new ScriptError('invalid object key', k.line);
        this.i++;
        if (this.eat(':')) props.push({ key, value: this.assign() });
        else props.push({ key, value: N('id', k.line, { name: key }) });
        if (!this.eat(',')) break;
      }
      this.expect('}');
      return N('object', line, { props });
    }
    throw new ScriptError(`unexpected '${c.v || 'end of script'}'`, c.line);
  }
}

// ------------------------------------------------------------------ Laufzeit

export type Value = undefined | null | boolean | number | string | Value[] | Obj | Fn | Native;
export interface Obj {
  [key: string]: Value;
}

export class Fn {
  constructor(
    readonly node: Node,
    readonly env: Env,
  ) {}
}
export class Native {
  constructor(readonly fn: (args: Value[]) => Value) {}
}

class Env {
  readonly vars = new Map<string, { v: Value; konst: boolean }>();
  constructor(readonly parent?: Env) {}
  lookup(name: string): { v: Value; konst: boolean } | undefined {
    for (let e: Env | undefined = this; e; e = e.parent) {
      const r = e.vars.get(name);
      if (r) return r;
    }
    return undefined;
  }
}

class Brk {}
class Cnt {}
class Ret {
  constructor(readonly v: Value) {}
}

const FORBIDDEN = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__lookupGetter__',
]);

const isObj = (v: Value): v is Obj =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof Fn) &&
  !(v instanceof Native);

const newObj = (): Obj => Object.create(null) as Obj;
/** Schlüsselzahl je Objekt (vermeidet `Object.keys` bei jeder Zuweisung). */
const keyCount = new WeakMap<Obj, number>();

/** Größte Array-Länge und Schlüsselzahl je Objekt (Speichergrenze der Sandbox). */
export const MAX_ITEMS = 10_000;
/** Größe des gespeicherten Zustands (JSON der Hauptteil-Variablen). */
export const MAX_STATE = 100_000;

interface Budget {
  left: number;
}

function charge(b: Budget, n: number): void {
  b.left -= n;
  if (b.left < 0) throw new ScriptError('string too long');
}

function strIn(v: Value, b: Budget, depth: number): string {
  if (Array.isArray(v)) {
    // zyklische/sehr tief verschachtelte Arrays: Skriptfehler statt Stacküberlauf
    if (depth > 20) throw new ScriptError('array nesting too deep');
    const parts: string[] = [];
    v.forEach((x, i) => {
      if (i > 0) charge(b, 1);
      parts.push(x === undefined || x === null ? '' : strIn(x, b, depth + 1));
    });
    return parts.join(',');
  }
  let s: string;
  if (v === undefined) s = 'undefined';
  else if (v === null) s = 'null';
  else if (typeof v === 'number')
    s = Number.isInteger(v) ? String(v) : String(Math.round(v * 1e9) / 1e9);
  else if (typeof v === 'string' || typeof v === 'boolean') s = String(v);
  else if (v instanceof Fn || v instanceof Native) s = 'function';
  else s = '[object Object]';
  charge(b, s.length);
  return s;
}

/** Textdarstellung wie in JavaScript; `max` begrenzt die Länge, bevor ein großer String entsteht. */
export function toStr(v: Value, max = Infinity): string {
  return strIn(v, { left: max }, 0);
}

/** `Array.prototype.join` mit Längengrenze. */
function joinArr(a: Value[], sep: string, max: number): string {
  const b = { left: max };
  return a
    .map((x, i) => {
      if (i > 0) charge(b, sep.length);
      return x === undefined || x === null ? '' : strIn(x, b, 1);
    })
    .join(sep);
}

const truthy = (v: Value): boolean =>
  !(v === undefined || v === null || v === false || v === 0 || v === '' || Number.isNaN(v));
const num = (v: Value): number =>
  typeof v === 'number'
    ? v
    : v === null || v === false
      ? 0
      : v === true
        ? 1
        : v === undefined
          ? NaN
          : typeof v === 'string'
            ? v.trim() === ''
              ? 0
              : Number(v)
            : NaN;

export function jsonOf(v: Value, depth = 0, b: Budget = { left: Infinity }): string | undefined {
  if (depth > 20) return undefined;
  if (v === undefined || v instanceof Fn || v instanceof Native) return undefined;
  let s: string;
  if (v === null) s = 'null';
  else if (typeof v === 'number') s = Number.isFinite(v) ? String(v) : 'null';
  else if (typeof v === 'string' || typeof v === 'boolean') s = JSON.stringify(v);
  else if (Array.isArray(v)) {
    charge(b, 2);
    return '[' + v.map((x) => jsonOf(x, depth + 1, b) ?? 'null').join(',') + ']';
  } else {
    const parts: string[] = [];
    charge(b, 2);
    for (const k of Object.keys(v)) {
      const s2 = jsonOf(v[k], depth + 1, b);
      if (s2 !== undefined) {
        const kk = JSON.stringify(k);
        charge(b, kk.length + 2);
        parts.push(kk + ':' + s2);
      }
    }
    return '{' + parts.join(',') + '}';
  }
  charge(b, s.length + 1);
  return s;
}

export interface InterpLimits {
  maxSteps: number;
  maxDepth: number;
  maxString: number;
}

export class Interp {
  readonly builtins = new Env();
  readonly global: Env;
  private ast: Node[] = [];
  steps = 0;
  private depth = 0;
  limits: InterpLimits;

  constructor(
    readonly code: string,
    host: Record<string, Value> = {},
    limits: Partial<InterpLimits> = {},
  ) {
    this.limits = { maxSteps: 200_000, maxDepth: 40, maxString: 20_000, ...limits };
    this.installBuiltins(host);
    this.global = new Env(this.builtins);
  }

  parse(): void {
    this.ast = new Parser(lex(this.code)).program();
  }

  /** Setzt die Schrittzählung für eine neue Aktivierung zurück. */
  resetBudget(): void {
    this.steps = 0;
    this.depth = 0;
  }

  /** Programm-Hauptteil ausführen. */
  runTop(): void {
    this.hoist(this.ast, this.global);
    this.execList(this.ast, this.global);
  }

  call(fn: Value, args: Value[]): Value {
    return this.invoke(fn, args, 0);
  }

  // ---- Builtins

  private installBuiltins(host: Record<string, Value>): void {
    const def = (name: string, v: Value): void => {
      this.builtins.vars.set(name, { v, konst: true });
    };
    const nat = (f: (a: Value[]) => Value): Native => new Native(f);
    const math = newObj();
    const m1 = (n: string, f: (x: number) => number): void => {
      math[n] = nat((a) => f(num(a[0])));
    };
    m1('floor', Math.floor);
    m1('ceil', Math.ceil);
    m1('round', Math.round);
    m1('abs', Math.abs);
    m1('sqrt', Math.sqrt);
    m1('sin', Math.sin);
    m1('cos', Math.cos);
    m1('trunc', Math.trunc);
    m1('sign', Math.sign);
    math.min = nat((a) => Math.min(...a.map(num)));
    math.max = nat((a) => Math.max(...a.map(num)));
    math.pow = nat((a) => num(a[0]) ** num(a[1]));
    math.PI = Math.PI;
    def('Math', math);
    def(
      'Number',
      nat((a) => num(a[0])),
    );
    def(
      'String',
      nat((a) => toStr(a[0], this.limits.maxString)),
    );
    def(
      'Boolean',
      nat((a) => truthy(a[0])),
    );
    def(
      'parseFloat',
      nat((a) => parseFloat(toStr(a[0]))),
    );
    def(
      'parseInt',
      nat((a) => parseInt(toStr(a[0]), a[1] === undefined ? 10 : num(a[1]))),
    );
    def(
      'isNaN',
      nat((a) => Number.isNaN(num(a[0]))),
    );
    def('NaN', NaN);
    def('Infinity', Infinity);
    const json = newObj();
    json.stringify = nat((a) => jsonOf(a[0], 0, { left: this.limits.maxString }));
    def('JSON', json);
    for (const [k, v] of Object.entries(host)) def(k, v);
  }

  // ---- Auswertung

  private tick(line: number): void {
    if (++this.steps > this.limits.maxSteps) throw new ScriptError('step limit exceeded', line);
  }

  private hoist(list: Node[], env: Env): void {
    for (const s of list) {
      if (s.k === 'fundecl')
        env.vars.set(s.name as string, { v: new Fn(s.fn as Node, env), konst: false });
    }
  }

  private execList(list: Node[], env: Env): void {
    for (const s of list) this.exec(s, env);
  }

  private exec(s: Node, env: Env): void {
    this.tick(s.line);
    switch (s.k) {
      case 'empty':
      case 'fundecl':
        return;
      case 'expr':
        this.ev(s.e as Node, env);
        return;
      case 'decl':
        for (const d of s.list as { name: string; init?: Node }[])
          env.vars.set(d.name, {
            v: d.init ? this.ev(d.init, env) : undefined,
            konst: s.kind === 'const',
          });
        return;
      case 'block': {
        const inner = new Env(env);
        this.hoist(s.body as Node[], inner);
        this.execList(s.body as Node[], inner);
        return;
      }
      case 'if':
        if (truthy(this.ev(s.test as Node, env))) this.exec(s.then as Node, env);
        else if (s.other) this.exec(s.other as Node, env);
        return;
      case 'while':
        while (truthy(this.ev(s.test as Node, env))) {
          this.tick(s.line);
          try {
            this.exec(s.body as Node, env);
          } catch (e) {
            if (e instanceof Brk) break;
            if (e instanceof Cnt) continue;
            throw e;
          }
        }
        return;
      case 'for': {
        const loop = new Env(env);
        if (s.init) this.exec(s.init as Node, loop);
        while (!s.test || truthy(this.ev(s.test as Node, loop))) {
          this.tick(s.line);
          try {
            this.exec(s.body as Node, loop);
          } catch (e) {
            if (e instanceof Brk) break;
            if (!(e instanceof Cnt)) throw e;
          }
          if (s.update) this.ev(s.update as Node, loop);
        }
        return;
      }
      case 'forof': {
        const it = this.ev(s.iter as Node, env);
        if (!Array.isArray(it)) throw new ScriptError('for…of needs an array', s.line);
        for (const x of [...it]) {
          this.tick(s.line);
          const loop = new Env(env);
          loop.vars.set(s.name as string, { v: x, konst: false });
          try {
            this.exec(s.body as Node, loop);
          } catch (e) {
            if (e instanceof Brk) break;
            if (!(e instanceof Cnt)) throw e;
          }
        }
        return;
      }
      case 'return':
        throw new Ret(s.e ? this.ev(s.e as Node, env) : undefined);
      case 'break':
        throw new Brk();
      case 'continue':
        throw new Cnt();
    }
    throw new ScriptError(`unsupported statement ${s.k}`, s.line);
  }

  private invoke(fn: Value, args: Value[], line: number): Value {
    if (fn instanceof Native) return fn.fn(args);
    if (!(fn instanceof Fn)) throw new ScriptError('not a function', line);
    if (++this.depth > this.limits.maxDepth) throw new ScriptError('call depth exceeded', line);
    try {
      const params = fn.node.params as string[];
      const env = new Env(fn.env);
      params.forEach((p, i) => env.vars.set(p, { v: args[i], konst: false }));
      const body = (fn.node.body as Node).body as Node[];
      this.hoist(body, env);
      try {
        this.execList(body, env);
      } catch (e) {
        if (e instanceof Ret) return e.v;
        if (e instanceof Brk || e instanceof Cnt)
          throw new ScriptError('illegal break/continue', line);
        throw e;
      }
      return undefined;
    } finally {
      this.depth--;
    }
  }

  private getMember(o: Value, key: Value, line: number): Value {
    const k = typeof key === 'number' ? key : toStr(key);
    if (typeof k === 'string' && FORBIDDEN.has(k))
      throw new ScriptError(`access to '${k}' is not allowed`, line);
    if (Array.isArray(o)) {
      if (typeof k === 'number') return o[k];
      if (k === 'length') return o.length;
      if (/^\d+$/.test(k)) return o[Number(k)];
      return methodRef(o, k);
    }
    if (typeof o === 'string') {
      if (typeof k === 'number') return o[k];
      if (k === 'length') return o.length;
      return methodRef(o, k);
    }
    if (typeof o === 'number') return methodRef(o, toStr(k));
    if (isObj(o)) return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
    if (o === undefined || o === null)
      throw new ScriptError(`cannot read property '${toStr(k)}' of ${toStr(o)}`, line);
    return undefined;
  }

  private setMember(o: Value, key: Value, v: Value, line: number): void {
    const k = typeof key === 'number' ? key : toStr(key);
    if (typeof k === 'string' && FORBIDDEN.has(k))
      throw new ScriptError(`access to '${k}' is not allowed`, line);
    if (Array.isArray(o)) {
      const i = typeof k === 'number' ? k : Number(k);
      if (!Number.isInteger(i) || i < 0 || i > o.length + 1000)
        throw new ScriptError('invalid array index', line);
      if (i >= MAX_ITEMS) throw new ScriptError('array too large', line);
      o[i] = v;
    } else if (isObj(o)) {
      const key = String(k);
      if (!Object.prototype.hasOwnProperty.call(o, key)) {
        const n = keyCount.get(o) ?? Object.keys(o).length;
        if (n >= MAX_ITEMS) throw new ScriptError('too many properties', line);
        keyCount.set(o, n + 1);
      }
      o[key] = v;
    } else throw new ScriptError('cannot set property', line);
  }

  private ev(n: Node, env: Env): Value {
    this.tick(n.line);
    switch (n.k) {
      case 'lit':
        return n.v as Value;
      case 'id': {
        const r = env.lookup(n.name as string);
        if (!r) throw new ScriptError(`${n.name as string} is not defined`, n.line);
        return r.v;
      }
      case 'tpl': {
        let s = '';
        for (const p of n.parts as (string | Node)[])
          s += typeof p === 'string' ? p : toStr(this.ev(p, env), this.limits.maxString);
        return this.str(s, n.line);
      }
      case 'array':
        return (n.items as Node[]).map((x) => this.ev(x, env));
      case 'object': {
        const o = newObj();
        for (const p of n.props as { key: string; value: Node }[]) {
          if (FORBIDDEN.has(p.key)) throw new ScriptError(`key '${p.key}' is not allowed`, n.line);
          o[p.key] = this.ev(p.value, env);
        }
        return o;
      }
      case 'fn': {
        if (!n.name) return new Fn(n, env);
        const own = new Env(env); // benannte Funktionsausdrücke sehen sich selbst
        const f = new Fn(n, own);
        own.vars.set(n.name as string, { v: f, konst: false });
        return f;
      }
      case 'seq': {
        let v: Value;
        for (const x of n.list as Node[]) v = this.ev(x, env);
        return v;
      }
      case 'cond':
        return truthy(this.ev(n.test as Node, env))
          ? this.ev(n.a as Node, env)
          : this.ev(n.b as Node, env);
      case 'logic': {
        const l = this.ev(n.left as Node, env);
        if (n.op === '&&') return truthy(l) ? this.ev(n.right as Node, env) : l;
        if (n.op === '||') return truthy(l) ? l : this.ev(n.right as Node, env);
        return l === undefined || l === null ? this.ev(n.right as Node, env) : l;
      }
      case 'unary': {
        if (n.op === 'typeof') {
          const e = n.e as Node;
          if (e.k === 'id' && !env.lookup(e.name as string)) return 'undefined';
          const v = this.ev(e, env);
          return v === null
            ? 'object'
            : v instanceof Fn || v instanceof Native
              ? 'function'
              : typeof v;
        }
        const v = this.ev(n.e as Node, env);
        if (n.op === '!') return !truthy(v);
        if (n.op === '-') return -num(v);
        return num(v);
      }
      case 'bin':
        return this.binop(
          n.op as string,
          this.ev(n.left as Node, env),
          this.ev(n.right as Node, env),
          n.line,
        );
      case 'member':
        return this.getMember(this.ev(n.obj as Node, env), this.ev(n.prop as Node, env), n.line);
      case 'call': {
        const callee = n.callee as Node;
        const args = (n.args as Node[]).map((a) => this.ev(a, env));
        if (callee.k === 'member') {
          const obj = this.ev(callee.obj as Node, env);
          const key = this.ev(callee.prop as Node, env);
          const f = this.getMember(obj, key, n.line);
          if (f instanceof MethodRef) return this.method(f.recv, f.name, args, n.line);
          return this.invoke(f, args, n.line);
        }
        return this.invoke(this.ev(callee, env), args, n.line);
      }
      case 'assign':
        return this.assignOp(n, env);
      case 'update': {
        const old = num(this.read(n.target as Node, env));
        const nv = n.op === '++' ? old + 1 : old - 1;
        this.write(n.target as Node, nv, env);
        return n.prefix ? nv : old;
      }
    }
    throw new ScriptError(`unsupported expression ${n.k}`, n.line);
  }

  private read(t: Node, env: Env): Value {
    return this.ev(t, env);
  }

  private write(t: Node, v: Value, env: Env): void {
    if (t.k === 'id') {
      const r = env.lookup(t.name as string);
      if (!r) throw new ScriptError(`${t.name as string} is not defined`, t.line);
      if (r.konst) throw new ScriptError(`assignment to constant '${t.name as string}'`, t.line);
      r.v = v;
    } else {
      this.setMember(this.ev(t.obj as Node, env), this.ev(t.prop as Node, env), v, t.line);
    }
  }

  private assignOp(n: Node, env: Env): Value {
    const op = n.op as string;
    const target = n.target as Node;
    let v: Value;
    if (op === '=') v = this.ev(n.value as Node, env);
    else if (op === '&&=' || op === '||=' || op === '??=') {
      const cur = this.read(target, env);
      const keep =
        op === '&&='
          ? !truthy(cur)
          : op === '||='
            ? truthy(cur)
            : cur !== undefined && cur !== null;
      if (keep) return cur;
      v = this.ev(n.value as Node, env);
    } else
      v = this.binop(
        op.slice(0, -1),
        this.read(target, env),
        this.ev(n.value as Node, env),
        n.line,
      );
    this.write(target, v, env);
    return v;
  }

  private str(s: string, line: number): string {
    if (s.length > this.limits.maxString) throw new ScriptError('string too long', line);
    return s;
  }

  private binop(op: string, a: Value, b: Value, line: number): Value {
    switch (op) {
      case '+':
        if (typeof a === 'string' || typeof b === 'string' || Array.isArray(a) || Array.isArray(b))
          return this.str(toStr(a, this.limits.maxString) + toStr(b, this.limits.maxString), line);
        return num(a) + num(b);
      case '-':
        return num(a) - num(b);
      case '*':
        return num(a) * num(b);
      case '/':
        return num(a) / num(b);
      case '%':
        return num(a) % num(b);
      case '**':
        return num(a) ** num(b);
      case '===':
        return a === b;
      case '!==':
        return a !== b;
      case '==': {
        const nil = (x: Value): boolean => x === null || x === undefined;
        if (nil(a) || nil(b)) return nil(a) && nil(b);
        if (typeof a === typeof b) return a === b;
        return num(a) === num(b);
      }
      case '!=':
        return !this.binop('==', a, b, line);
      case '<':
      case '>':
      case '<=':
      case '>=': {
        const bothStr = typeof a === 'string' && typeof b === 'string';
        const x = bothStr ? (a as string) : num(a);
        const y = bothStr ? (b as string) : num(b);
        return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
      }
    }
    throw new ScriptError(`unsupported operator ${op}`, line);
  }

  private method(recv: Value, name: string, args: Value[], line: number): Value {
    const s = typeof recv === 'string' ? recv : undefined;
    if (s !== undefined) {
      switch (name) {
        case 'toUpperCase':
          return s.toUpperCase();
        case 'toLowerCase':
          return s.toLowerCase();
        case 'includes':
          return s.includes(toStr(args[0]));
        case 'indexOf':
          return s.indexOf(toStr(args[0]));
        case 'slice':
          return s.slice(
            args[0] === undefined ? 0 : num(args[0]),
            args[1] === undefined ? undefined : num(args[1]),
          );
        case 'trim':
          return s.trim();
        case 'startsWith':
          return s.startsWith(toStr(args[0]));
        case 'endsWith':
          return s.endsWith(toStr(args[0]));
        case 'split':
          return s.split(toStr(args[0]));
        case 'padStart':
          if (num(args[0]) > this.limits.maxString) throw new ScriptError('string too long', line);
          return s.padStart(num(args[0]), args[1] === undefined ? ' ' : toStr(args[1]));
      }
    } else if (typeof recv === 'number') {
      if (name === 'toFixed')
        return recv.toFixed(Math.min(20, Math.max(0, args[0] === undefined ? 0 : num(args[0]))));
      if (name === 'toString') return toStr(recv);
    } else if (Array.isArray(recv)) {
      switch (name) {
        case 'push':
          if (recv.length + args.length > MAX_ITEMS) throw new ScriptError('array too large', line);
          return recv.push(...args);
        case 'pop':
          return recv.pop();
        case 'shift':
          return recv.shift();
        case 'unshift':
          if (recv.length + args.length > MAX_ITEMS) throw new ScriptError('array too large', line);
          return recv.unshift(...args);
        case 'indexOf':
          return recv.indexOf(args[0]);
        case 'includes':
          return recv.includes(args[0]);
        case 'join':
          return joinArr(
            recv,
            args[0] === undefined ? ',' : toStr(args[0], this.limits.maxString),
            this.limits.maxString,
          );
        case 'slice':
          return recv.slice(
            args[0] === undefined ? 0 : num(args[0]),
            args[1] === undefined ? undefined : num(args[1]),
          );
        case 'reverse':
          return recv.reverse();
        case 'map':
          return recv.map((x, i) => this.invoke(args[0], [x, i], line));
        case 'filter':
          return recv.filter((x, i) => truthy(this.invoke(args[0], [x, i], line)));
        case 'forEach':
          recv.forEach((x, i) => this.invoke(args[0], [x, i], line));
          return undefined;
        case 'reduce': {
          let acc = args[1];
          let start = 0;
          if (args.length < 2) {
            acc = recv[0];
            start = 1;
          }
          for (let i = start; i < recv.length; i++)
            acc = this.invoke(args[0], [acc, recv[i], i], line);
          return acc;
        }
      }
    }
    throw new ScriptError(`${name} is not a function`, line);
  }
}

class MethodRef {
  constructor(
    readonly recv: Value,
    readonly name: string,
  ) {}
}

function methodRef(recv: Value, name: string): Value {
  // Methodenreferenzen bleiben intern; sie sind keine Skriptwerte und können nur direkt aufgerufen werden.
  return new MethodRef(recv, name) as unknown as Value;
}

/** Alle deklarierten Variablen des Hauptteils, die sich als JSON darstellen lassen (Zustand zwischen Aktivierungen). */
export function exportVars(it: Interp): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const budget = { left: MAX_STATE };
  for (const [k, r] of it.global.vars) {
    if (r.v instanceof Fn || r.v instanceof Native || r.v === undefined) continue;
    let s: string | undefined;
    try {
      s = jsonOf(r.v, 0, budget);
    } catch {
      throw new ScriptError('program state too large');
    }
    if (s !== undefined) out[k] = JSON.parse(s) as unknown;
  }
  return out;
}

/** Gespeicherte Variablen wieder einsetzen. */
export function importVars(it: Interp, vars: Record<string, unknown>): void {
  const conv = (x: unknown): Value => {
    if (Array.isArray(x)) return x.map(conv);
    if (typeof x === 'object' && x !== null) {
      const o = newObj();
      for (const [k, v] of Object.entries(x)) if (!FORBIDDEN.has(k)) o[k] = conv(v);
      return o;
    }
    return x as Value;
  };
  for (const [k, v] of Object.entries(vars)) {
    const r = it.global.vars.get(k);
    if (r && !(r.v instanceof Fn)) r.v = conv(v);
  }
}
