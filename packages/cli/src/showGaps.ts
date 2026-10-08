import type { PrefixList, RouteMap, RouteMapClause, RouteMapSet, RoutingCfg } from '@netsim/engine';

/** `show ip prefix-list`, `show route-map`, `show ip community-list` und die running-config-Zeilen dazu. */

const plenText = (e: PrefixList['entries'][number]): string =>
  `${e.prefix}/${e.plen}${e.ge !== undefined ? ` ge ${e.ge}` : ''}${e.le !== undefined ? ` le ${e.le}` : ''}`;

export function showPrefixLists(
  lists: Record<string, PrefixList>,
  name: string | undefined,
  v6: boolean,
): string[] {
  const out: string[] = [];
  const pick = name ? [lists[name]].filter((x): x is PrefixList => !!x) : Object.values(lists);
  if (name && pick.length === 0) return [`% Prefix-list ${name} not found`];
  for (const pl of pick) {
    out.push(`${v6 ? 'ipv6' : 'ip'} prefix-list ${pl.name}: ${pl.entries.length} entries`);
    for (const e of pl.entries) out.push(`   seq ${e.seq} ${e.action} ${plenText(e)}`);
  }
  return out;
}

export const setLines = (st: RouteMapSet): string[] => {
  const out: string[] = [];
  if (st.localPref !== undefined) out.push(`set local-preference ${st.localPref}`);
  if (st.metric !== undefined) out.push(`set metric ${st.metric}`);
  if (st.eigrpMetric)
    out.push(`set metric ${st.eigrpMetric.bw} ${st.eigrpMetric.delay} 255 1 1500`);
  if (st.metricType !== undefined) out.push(`set metric-type type-${st.metricType}`);
  if (st.tag !== undefined) out.push(`set tag ${st.tag}`);
  if (st.weight !== undefined) out.push(`set weight ${st.weight}`);
  if (st.asPathPrepend?.length) out.push(`set as-path prepend ${st.asPathPrepend.join(' ')}`);
  if (st.community)
    out.push(
      st.community.none
        ? 'set community none'
        : `set community ${st.community.values.join(' ')}${st.community.additive ? ' additive' : ''}`,
    );
  if (st.nextHop) out.push(`set ip next-hop ${st.nextHop}`);
  if (st.origin) out.push(`set origin ${st.origin}`);
  return out;
};

export const matchLines = (c: RouteMapClause): string[] => {
  const out: string[] = [];
  if (c.matchPrefixLists.length)
    out.push(`match ip address prefix-list ${c.matchPrefixLists.join(' ')}`);
  if (c.matchAcls.length) out.push(`match ip address ${c.matchAcls.join(' ')}`);
  if (c.matchNextHopPrefixLists.length)
    out.push(`match ip next-hop prefix-list ${c.matchNextHopPrefixLists.join(' ')}`);
  if (c.matchTags.length) out.push(`match tag ${c.matchTags.join(' ')}`);
  if (c.matchMetrics.length) out.push(`match metric ${c.matchMetrics.join(' ')}`);
  if (c.matchCommunities.length) out.push(`match community ${c.matchCommunities.join(' ')}`);
  return out;
};

export function showRouteMaps(maps: Record<string, RouteMap>, name?: string): string[] {
  const pick = name ? [maps[name]].filter((x): x is RouteMap => !!x) : Object.values(maps);
  if (name && pick.length === 0) return [`% Route-map ${name} not found`];
  const out: string[] = [];
  for (const rm of pick) {
    for (const c of rm.clauses) {
      out.push(`route-map ${rm.name}, ${c.action}, sequence ${c.seq}`);
      out.push('  Match clauses:');
      for (const l of matchLines(c)) out.push(`    ${l.replace(/^match /, '')}`);
      out.push('  Set clauses:');
      for (const l of setLines(c.set)) out.push(`    ${l.replace(/^set /, '')}`);
      out.push('  Policy routing matches: 0 packets, 0 bytes');
    }
  }
  return out;
}

export function showCommunityLists(r: RoutingCfg, name?: string): string[] {
  const out: string[] = [];
  for (const cl of Object.values(r.communityLists)) {
    if (name && cl.name !== name) continue;
    out.push(`Community standard list ${cl.name}`);
    for (const e of cl.entries) out.push(`    ${e.action} ${e.values.join(' ')}`);
  }
  return out;
}

/** Zeilen für die running-config (Prefix-Lists, Community-Listen, Route-Maps). */
export function renderPolicyConfig(r: RoutingCfg): string[] {
  const L: string[] = [];
  for (const [lists, kw] of [
    [r.prefixLists, 'ip'],
    [r.prefixLists6, 'ipv6'],
  ] as const) {
    for (const pl of Object.values(lists))
      for (const e of pl.entries)
        L.push(`${kw} prefix-list ${pl.name} seq ${e.seq} ${e.action} ${plenText(e)}`);
  }
  for (const cl of Object.values(r.communityLists))
    for (const e of cl.entries)
      L.push(`ip community-list standard ${cl.name} ${e.action} ${e.values.join(' ')}`);
  if (L.length) L.push('!');
  for (const rm of Object.values(r.routeMaps)) {
    for (const c of rm.clauses) {
      L.push(`route-map ${rm.name} ${c.action} ${c.seq}`);
      for (const l of [...matchLines(c), ...setLines(c.set)]) L.push(` ${l}`);
      L.push('!');
    }
  }
  return L;
}
