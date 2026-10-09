/**
 * Formularbeschreibung der Prüfungen (Autorenmodus). Die Felder entsprechen dem Zod-Schema der Engine
 * (`CheckSchema`); die endgültige Validierung macht immer die Engine.
 */
export type FieldKind = 'text' | 'num' | 'bool' | 'select' | 'list';
export interface FieldDef {
  name: string;
  kind: FieldKind;
  options?: string[];
  optional?: boolean;
  /** Vorgabewert (als Text bzw. Wahrheitswert). */
  def?: string | boolean;
  /** Eingabe schlägt Gerätenamen vor. */
  device?: boolean;
}

const dev = (name = 'device'): FieldDef => ({ name, kind: 'text', device: true });

export const CHECK_TYPES = [
  'deviceExists',
  'hostIp',
  'ifaceIp',
  'ifaceState',
  'vlanExists',
  'vlanMember',
  'trunk',
  'route',
  'config',
  'ping',
  'service',
  'ospfNeighbors',
  'dhcpLease',
  'natTranslations',
] as const;
export type AuthorCheckType = (typeof CHECK_TYPES)[number];

export const ROUTE_SOURCES = ['any', 'connected', 'static', 'rip', 'ospf', 'eigrp', 'bgp'];
export const PROTOCOLS = ['icmp', 'http', 'https', 'tcp', 'udp', 'dns', 'telnet', 'ssh', 'ftp'];

export const DEFS: Record<AuthorCheckType, FieldDef[]> = {
  deviceExists: [dev(), { name: 'deviceType', kind: 'text', optional: true }],
  hostIp: [
    dev(),
    { name: 'ip', kind: 'text' },
    { name: 'mask', kind: 'text', optional: true },
    { name: 'gateway', kind: 'text', optional: true },
  ],
  ifaceIp: [
    dev(),
    { name: 'iface', kind: 'text' },
    { name: 'ip', kind: 'text' },
    { name: 'mask', kind: 'text', optional: true },
  ],
  ifaceState: [dev(), { name: 'iface', kind: 'text' }, { name: 'up', kind: 'bool', def: true }],
  vlanExists: [
    dev(),
    { name: 'vlan', kind: 'num' },
    { name: 'name', kind: 'text', optional: true },
  ],
  vlanMember: [dev(), { name: 'port', kind: 'text' }, { name: 'vlan', kind: 'num' }],
  trunk: [
    dev(),
    { name: 'port', kind: 'text' },
    { name: 'native', kind: 'num', optional: true },
    { name: 'allowed', kind: 'list', optional: true },
  ],
  route: [
    dev(),
    { name: 'prefix', kind: 'text' },
    { name: 'plen', kind: 'num' },
    { name: 'via', kind: 'text', optional: true },
    { name: 'source', kind: 'select', options: ROUTE_SOURCES, def: 'any' },
  ],
  config: [dev()],
  ping: [
    dev('from'),
    { name: 'to', kind: 'text', device: true },
    { name: 'expect', kind: 'select', options: ['success', 'fail'], def: 'success' },
  ],
  service: [
    dev('from'),
    { name: 'to', kind: 'text', device: true },
    { name: 'protocol', kind: 'select', options: PROTOCOLS, def: 'http' },
    { name: 'port', kind: 'num', optional: true },
    { name: 'expect', kind: 'select', options: ['success', 'fail'], def: 'success' },
  ],
  ospfNeighbors: [dev(), { name: 'min', kind: 'num', def: '1' }],
  dhcpLease: [dev()],
  natTranslations: [dev(), { name: 'min', kind: 'num', def: '1' }],
};

export const ITEMS = [
  'hostname',
  'domainName',
  'enableSecret',
  'username',
  'ssh',
  'ntpServer',
  'description',
  'ifaceAcl',
  'aclEntry',
  'natRole',
  'natOverload',
  'natStatic',
  'dhcpPool',
  'helperAddress',
  'ospfNetwork',
  'portSecurity',
  'portfast',
  'stpMode',
  'vtp',
  'defaultGateway',
] as const;

export const ITEM_DEFS: Record<(typeof ITEMS)[number], FieldDef[]> = {
  hostname: [{ name: 'value', kind: 'text' }],
  domainName: [{ name: 'value', kind: 'text' }],
  enableSecret: [],
  username: [{ name: 'name', kind: 'text' }],
  ssh: [],
  ntpServer: [{ name: 'ip', kind: 'text' }],
  description: [
    { name: 'iface', kind: 'text' },
    { name: 'text', kind: 'text', optional: true },
  ],
  ifaceAcl: [
    { name: 'iface', kind: 'text' },
    { name: 'direction', kind: 'select', options: ['in', 'out'], def: 'in' },
    { name: 'acl', kind: 'text' },
  ],
  aclEntry: [
    { name: 'acl', kind: 'text' },
    { name: 'action', kind: 'select', options: ['permit', 'deny'], def: 'deny' },
    {
      name: 'protocol',
      kind: 'select',
      options: ['', 'ip', 'icmp', 'tcp', 'udp'],
      optional: true,
    },
    { name: 'dstPort', kind: 'num', optional: true },
    { name: 'src', kind: 'text', optional: true },
    { name: 'dst', kind: 'text', optional: true },
  ],
  natRole: [
    { name: 'iface', kind: 'text' },
    { name: 'side', kind: 'select', options: ['inside', 'outside'], def: 'inside' },
  ],
  natOverload: [],
  natStatic: [
    { name: 'local', kind: 'text' },
    { name: 'global', kind: 'text' },
  ],
  dhcpPool: [
    { name: 'network', kind: 'text' },
    { name: 'router', kind: 'text', optional: true },
    { name: 'dns', kind: 'text', optional: true },
  ],
  helperAddress: [
    { name: 'iface', kind: 'text' },
    { name: 'ip', kind: 'text' },
  ],
  ospfNetwork: [
    { name: 'pid', kind: 'num', def: '1' },
    { name: 'network', kind: 'text' },
    { name: 'area', kind: 'text', optional: true },
  ],
  portSecurity: [{ name: 'port', kind: 'text' }],
  portfast: [{ name: 'port', kind: 'text' }],
  stpMode: [{ name: 'mode', kind: 'select', options: ['pvst', 'rapid-pvst'], def: 'rapid-pvst' }],
  vtp: [
    { name: 'mode', kind: 'select', options: ['server', 'client', 'transparent'], def: 'server' },
    { name: 'domain', kind: 'text', optional: true },
  ],
  defaultGateway: [{ name: 'ip', kind: 'text' }],
};

export type Raw = Record<string, unknown>;

/** Neue Prüfung mit Vorgabewerten. */
export function blank(type: AuthorCheckType): Raw {
  const raw: Raw = { type };
  for (const f of DEFS[type]) if (f.def !== undefined) raw[f.name] = f.def;
  if (type === 'config') raw.spec = blankItem('hostname');
  return raw;
}

export function blankItem(item: (typeof ITEMS)[number]): Raw {
  const raw: Raw = { item };
  for (const f of ITEM_DEFS[item]) if (f.def !== undefined) raw[f.name] = f.def;
  return raw;
}

function convert(defs: FieldDef[], raw: Raw): Raw {
  const out: Raw = {};
  for (const f of defs) {
    const v = raw[f.name];
    if (v === undefined || v === '') continue;
    if (f.kind === 'num') out[f.name] = Number(v);
    else if (f.kind === 'bool') out[f.name] = v === true || v === 'true';
    else if (f.kind === 'list') out[f.name] = String(v).split(/[ ,]+/).filter(Boolean).map(Number);
    else out[f.name] = v;
  }
  return out;
}

/** Entwurf (Eingabetexte) in ein Prüfungsobjekt für die Engine umwandeln. */
export function build(raw: Raw, id: string): Raw {
  const type = raw.type as AuthorCheckType;
  const out: Raw = { id, type, ...convert(DEFS[type], raw) };
  if (type === 'config') {
    const spec = (raw.spec ?? {}) as Raw;
    const item = spec.item as (typeof ITEMS)[number];
    out.spec = { item, ...convert(ITEM_DEFS[item] ?? [], spec) };
  }
  const w = raw.weight;
  if (w !== undefined && w !== '') out.weight = Number(w);
  if (typeof raw.hint === 'string' && raw.hint.trim()) out.hint = raw.hint.trim();
  if (typeof raw.label === 'string' && raw.label.trim()) out.label = raw.label.trim();
  return out;
}

/** Prüfung aus der Engine (typisierte Werte) in Eingabetexte für das Formular. */
export function toRaw(c: Raw): Raw {
  const flat = (o: Raw): Raw => {
    const r: Raw = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === 'id') continue;
      if (k === 'spec' && v && typeof v === 'object') r.spec = flat(v as Raw);
      else if (Array.isArray(v)) r[k] = v.join(',');
      else if (typeof v === 'number') r[k] = String(v);
      else if (typeof v === 'object' && v !== null) {
        const l = v as { de?: string; en?: string };
        r[k] = l.de ?? l.en ?? '';
      } else r[k] = v;
    }
    return r;
  };
  return flat(c);
}
