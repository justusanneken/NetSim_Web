/**
 * „Equivalent IOS Commands“: aus der Differenz zweier running-configs die IOS-Befehle ableiten,
 * die eine GUI-Änderung bewirkt hat (inklusive `no …` für entfernte Zeilen).
 */

interface Block {
  head: string;
  children: string[];
}

/** Zeilen, bei denen eine neue Zeile die alte ersetzt (kein `no …` für die alte nötig). */
const REPLACES =
  /^(hostname|description|ip address|duplex|speed|switchport (?:access vlan|mode|trunk native vlan)|banner \w+|enable (?:secret|password)|ip default-gateway|ip domain[- ]name|encapsulation|bandwidth|mtu|clock rate|service-policy \w+|ntp server|logging host|ip dhcp pool|network|default-router|dns-server|spanning-tree mode|vtp (?:mode|domain)|ip nat (?:inside|outside))\b/;

function parse(cfg: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of cfg.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (
      !line.trim() ||
      line.trim() === '!' ||
      /^(Building configuration|Current configuration|end$)/.test(line)
    )
      continue;
    if (/^\s/.test(line)) blocks[blocks.length - 1]?.children.push(line);
    else blocks.push({ head: line, children: [] });
  }
  return blocks;
}

const negate = (line: string): string => {
  const ind = /^\s*/.exec(line)?.[0] ?? '';
  const body = line.trim();
  return ind + (body.startsWith('no ') ? body.slice(3) : `no ${body}`);
};

const key = (line: string): string | undefined =>
  REPLACES.exec(line.trim().replace(/^no /, ''))?.[0];

/** Befehle, die von `oldCfg` zu `newCfg` führen (leer, wenn es keinen Unterschied gibt). */
export function iosDiff(oldCfg: string, newCfg: string): string[] {
  const a = parse(oldCfg);
  const b = parse(newCfg);
  const out: string[] = [];
  const oldByHead = new Map<string, Block>();
  for (const x of a) if (!oldByHead.has(x.head)) oldByHead.set(x.head, x);
  const newHeads = new Set(b.map((x) => x.head));

  // entfernte Kopfzeilen (Ersatz durch gleichartige neue Kopfzeile erzeugt kein `no`)
  const addedHeads = b.filter((x) => !oldByHead.has(x.head));
  for (const x of a) {
    if (newHeads.has(x.head)) continue;
    const k = key(x.head);
    if (k && addedHeads.some((n) => key(n.head) === k)) continue;
    // Block-Köpfe wie `interface …` werden nicht gelöscht, sondern nur angelegt
    out.push(negate(x.head));
  }
  for (const n of b) {
    const o = oldByHead.get(n.head);
    if (!o) {
      out.push(n.head, ...n.children);
      continue;
    }
    const removed = o.children.filter((c) => !n.children.includes(c));
    const added = n.children.filter((c) => !o.children.includes(c));
    const lines: string[] = [];
    for (const r of removed) {
      const k = key(r);
      if (k && added.some((c) => key(c) === k)) continue;
      lines.push(negate(r));
    }
    lines.push(...added);
    if (lines.length > 0) out.push(n.head, ...lines);
  }
  return out;
}
