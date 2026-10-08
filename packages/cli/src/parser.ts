/**
 * Deklarative Befehlsdefinition + Parser (IOS-Stil): eindeutige Präfix-Abkürzungen,
 * `?`-Hilfe, Tab-Completion, `no`/`default`-Präfix. Neue Befehle sind nur Daten + Handler.
 */
import { isValidIpv4, isValidIpv6, maskToPrefix } from '@netsim/protocols';

export type ModeId =
  | 'user'
  | 'priv'
  | 'config'
  | 'config-if'
  | 'config-subif'
  | 'config-if-range'
  | 'config-line'
  | 'config-vlan'
  | 'dhcp-config'
  | 'config-std-nacl'
  | 'config-ext-nacl'
  | 'config-rip'
  | 'config-ospf'
  | 'config-ospf6'
  | 'config-eigrp'
  | 'config-bgp'
  | 'config-route-map'
  | 'config-bgp-af6'
  | 'config-dhcp6'
  | 'config-rip6';
export type ParamType =
  'word' | 'int' | 'ip' | 'mask' | 'iface' | 'vlans' | 'mac' | 'wildcard' | 'ipv6' | 'prefix6';
export type Family = 'router' | 'switch' | 'switch-l3';
export type Args = Record<string, string>;

export interface KwSlot {
  kind: 'kw';
  /** Name, unter dem das gewählte (ausgeschriebene) Schlüsselwort in `args` landet. */
  name?: string;
  alts: { word: string; help: string }[];
  opt?: boolean;
}
export interface ParamSlot {
  kind: 'param';
  name: string;
  type: ParamType;
  label: string;
  help: string;
  opt?: boolean;
  min?: number;
  max?: number;
}
/** Restlicher Zeilentext (z. B. Beschreibungen, Banner). */
export interface RestSlot {
  kind: 'rest';
  name: string;
  label: string;
  help: string;
  opt?: boolean;
}
export type Slot = KwSlot | ParamSlot | RestSlot;

export interface CommandDef<C> {
  modes: ModeId[];
  slots: Slot[];
  run: (cx: C, args: Args) => void;
  /** Zusätzlich als `no …` und `default …` verfügbar; Handler bekommt `cx.negated`. */
  negatable?: boolean;
  /** Nur für diese Gerätefamilie sichtbar (`switch` umfasst L2- und L3-Switches). */
  only?: 'router' | 'switch' | 'switch-l3' | 'l3';
}

// ---------------------------------------------------------------- Builder (DSL)

/** Schlüsselwort mit Hilfetext. */
export const K = (word: string, help: string): KwSlot => ({ kind: 'kw', alts: [{ word, help }] });
/** Auswahl mehrerer Schlüsselwörter. */
export const choice = (name: string, ...alts: [string, string][]): KwSlot => ({
  kind: 'kw',
  name,
  alts: alts.map(([word, help]) => ({ word, help })),
});
export const P = (
  name: string,
  type: ParamType,
  label: string,
  help: string,
  range?: [number, number],
): ParamSlot => ({ kind: 'param', name, type, label, help, min: range?.[0], max: range?.[1] });
export const R = (name: string, label: string, help: string): RestSlot => ({
  kind: 'rest',
  name,
  label,
  help,
});
export const opt = <T extends Slot>(s: T): T => ({ ...s, opt: true });

// ---------------------------------------------------------------- Parser

export interface Env {
  /** Gerätefamilie für `only`. */
  family: Family;
  /** Prüft, ob Text eine gültige Schnittstellenbezeichnung des Geräts ist. */
  iface(text: string): boolean;
}

interface Compiled<C> extends CommandDef<C> {
  negated: boolean;
}

interface Pos<C> {
  def: Compiled<C>;
  idx: number;
  args: Args;
}

export type ParseResult<C> =
  | { ok: true; def: CommandDef<C>; args: Args; negated: boolean }
  | { ok: false; error: 'empty' }
  | { ok: false; error: 'invalid'; at: number }
  | { ok: false; error: 'incomplete' }
  | { ok: false; error: 'ambiguous'; text: string };

export interface Token {
  text: string;
  start: number;
}

export function tokenize(line: string): Token[] {
  const out: Token[] = [];
  const re = /\S+/g;
  for (let m = re.exec(line); m; m = re.exec(line)) out.push({ text: m[0], start: m.index });
  return out;
}

function validParam(s: ParamSlot, tok: string, env: Env): boolean {
  switch (s.type) {
    case 'word':
      return true;
    case 'int': {
      if (!/^\d+$/.test(tok)) return false;
      const n = Number(tok);
      return (s.min === undefined || n >= s.min) && (s.max === undefined || n <= s.max);
    }
    case 'ip':
      return isValidIpv4(tok);
    case 'mask':
      return maskToPrefix(tok) !== undefined;
    case 'iface':
      return env.iface(tok);
    case 'vlans':
      return /^\d+([-,]\d+)*$/.test(tok) || tok === 'all' || tok === 'none';
    case 'mac':
      return /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i.test(tok);
    case 'wildcard':
      return isValidIpv4(tok);
    case 'ipv6':
      return isValidIpv6(tok);
    case 'prefix6': {
      const [a, l] = tok.split('/');
      return (
        a !== undefined &&
        l !== undefined &&
        isValidIpv6(a) &&
        /^\d{1,3}$/.test(l) &&
        Number(l) <= 128
      );
    }
  }
}

export function familyOk(only: CommandDef<never>['only'], family: Family): boolean {
  if (!only) return true;
  if (only === 'router') return family === 'router';
  if (only === 'switch') return family !== 'router';
  if (only === 'switch-l3') return family === 'switch-l3';
  return family !== 'switch'; // 'l3': Router oder L3-Switch
}

const reachable = (slots: Slot[], idx: number): number[] => {
  const out: number[] = [];
  for (let j = idx; j < slots.length; j++) {
    out.push(j);
    if (!(slots[j] as Slot).opt) break;
  }
  return out;
};
const isComplete = (slots: Slot[], idx: number): boolean => slots.slice(idx).every((s) => s.opt);

export class Registry<C> {
  private readonly defs: CommandDef<C>[] = [];

  add(def: CommandDef<C>): this {
    this.defs.push(def);
    return this;
  }

  private compiled(mode: ModeId, env: Env): Compiled<C>[] {
    const out: Compiled<C>[] = [];
    for (const d of this.defs) {
      if (!d.modes.includes(mode) || !familyOk(d.only, env.family)) continue;
      out.push({ ...d, negated: false });
      if (d.negatable) {
        // Bei `no …` sind nachfolgende Parameter optional (z. B. `no hostname`).
        const relaxed = d.slots.map((x) => (x.kind === 'kw' ? x : { ...x, opt: true }));
        out.push({
          ...d,
          slots: [K('no', 'Negate a command or set its defaults'), ...relaxed],
          negated: true,
        });
        out.push({
          ...d,
          slots: [K('default', 'Set a command to its defaults'), ...relaxed],
          negated: true,
        });
      }
    }
    return out;
  }

  /** Konsumiert die Tokens; liefert Positionen oder den ersten Fehler. */
  private consume(
    mode: ModeId,
    line: string,
    tokens: Token[],
    env: Env,
  ): { ok: true; pos: Pos<C>[] } | Exclude<ParseResult<C>, { ok: true }> {
    let positions: Pos<C>[] = this.compiled(mode, env).map((def) => ({ def, idx: 0, args: {} }));
    for (let n = 0; n < tokens.length; n++) {
      const tok = tokens[n] as Token;
      const low = tok.text.toLowerCase();
      const kwHits: { pos: Pos<C>; j: number; word: string }[] = [];
      const other: { pos: Pos<C>; j: number }[] = [];
      for (const pos of positions) {
        for (const j of reachable(pos.def.slots, pos.idx)) {
          const slot = pos.def.slots[j] as Slot;
          if (slot.kind === 'kw') {
            for (const a of slot.alts) {
              if (a.word.startsWith(low)) kwHits.push({ pos, j, word: a.word });
            }
          } else if (slot.kind === 'rest' || validParam(slot, tok.text, env)) {
            other.push({ pos, j });
          }
        }
      }
      let chosen: { pos: Pos<C>; j: number; word?: string }[] = kwHits;
      if (kwHits.length > 0) {
        const exact = kwHits.filter((h) => h.word === low);
        if (exact.length > 0) chosen = exact;
        const words = new Set(chosen.map((h) => (h as { word: string }).word));
        if (words.size > 1) {
          return {
            ok: false,
            error: 'ambiguous',
            text: line.slice(0, tok.start + tok.text.length).trim(),
          };
        }
      } else chosen = other;
      if (chosen.length === 0) return { ok: false, error: 'invalid', at: tok.start };
      const next: Pos<C>[] = [];
      for (const h of chosen) {
        const slot = h.pos.def.slots[h.j] as Slot;
        const args = { ...h.pos.args };
        let idx = h.j + 1;
        if (slot.kind === 'param') args[slot.name] = tok.text;
        else if (slot.kind === 'rest') {
          args[slot.name] = line.slice(tok.start).trim();
          n = tokens.length; // Rest verbraucht den Zeilenrest
          idx = h.j + 1;
        } else args[slot.name ?? `kw:${h.j}`] = h.word ?? tok.text;
        if (!next.some((p) => p.def === h.pos.def && p.idx === idx)) {
          next.push({ def: h.pos.def, idx, args });
        }
      }
      positions = next;
    }
    return { ok: true, pos: positions };
  }

  parse(mode: ModeId, line: string, env: Env): ParseResult<C> {
    const tokens = tokenize(line);
    if (tokens.length === 0) return { ok: false, error: 'empty' };
    const r = this.consume(mode, line, tokens, env);
    if (!r.ok) return r;
    const done = r.pos.find((p) => isComplete(p.def.slots, p.idx));
    if (!done) return { ok: false, error: 'incomplete' };
    return { ok: true, def: done.def, args: done.args, negated: done.def.negated };
  }

  /** `?`: Folgeoptionen nach dem Text vor dem Cursor. */
  help(mode: ModeId, line: string, env: Env): string[] {
    const endsWithSpace = line.length === 0 || /\s$/.test(line);
    const tokens = tokenize(line);
    const partial = endsWithSpace ? '' : (tokens.pop()?.text ?? '');
    const prefixLine = line.slice(
      0,
      tokens.length
        ? (tokens[tokens.length - 1] as Token).start +
            (tokens[tokens.length - 1] as Token).text.length
        : 0,
    );
    const r = this.consume(mode, prefixLine, tokens, env);
    if (!r.ok) return ['% Unrecognized command'];
    const items = new Map<string, string>();
    let cr = false;
    for (const pos of r.pos) {
      if (isComplete(pos.def.slots, pos.idx)) cr = true;
      for (const j of reachable(pos.def.slots, pos.idx)) {
        const s = pos.def.slots[j] as Slot;
        if (s.kind === 'kw') {
          for (const a of s.alts) {
            if (a.word.startsWith(partial.toLowerCase()) && !items.has(a.word))
              items.set(a.word, a.help);
          }
        } else if (partial === '' && !items.has(s.label)) items.set(s.label, s.help);
      }
    }
    if (partial !== '') {
      const words = [...items.keys()].sort();
      return words.length ? [words.join('  ')] : ['% Unrecognized command'];
    }
    const keys = [...items.keys()].sort((a, b) => {
      const pa = /^[<A-Z]/.test(a);
      const pb = /^[<A-Z]/.test(b);
      return pa === pb ? a.localeCompare(b) : pa ? 1 : -1;
    });
    const width = Math.max(0, ...keys.map((k) => k.length), cr ? 4 : 0);
    const lines = keys.map((k) => `  ${k.padEnd(width)}  ${items.get(k)}`);
    if (cr) lines.push(`  ${'<cr>'.padEnd(width)}`.trimEnd());
    return lines.length ? lines : ['% Unrecognized command'];
  }

  /** Tab: ergänzt das letzte Wort (eindeutig oder bis zum gemeinsamen Präfix). */
  complete(mode: ModeId, line: string, env: Env): string {
    if (/\s$/.test(line) || line.length === 0) return line;
    const tokens = tokenize(line);
    const last = tokens.pop() as Token;
    const before = tokens.length ? (tokens[tokens.length - 1] as Token) : undefined;
    const prefixLine = before ? line.slice(0, before.start + before.text.length) : '';
    const r = this.consume(mode, prefixLine, tokens, env);
    if (!r.ok) return line;
    const words = new Set<string>();
    for (const pos of r.pos) {
      for (const j of reachable(pos.def.slots, pos.idx)) {
        const s = pos.def.slots[j] as Slot;
        if (s.kind === 'kw') {
          for (const a of s.alts) if (a.word.startsWith(last.text.toLowerCase())) words.add(a.word);
        }
      }
    }
    const list = [...words];
    if (list.length === 0) return line;
    const head = line.slice(0, last.start);
    if (list.length === 1) return `${head}${list[0]} `;
    let common = list[0] as string;
    for (const w of list) while (!w.startsWith(common)) common = common.slice(0, -1);
    return common.length > last.text.length ? `${head}${common}` : line;
  }
}
