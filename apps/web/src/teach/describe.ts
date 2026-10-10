import type { Check } from '@netsim/engine';
import type { TFunction } from 'i18next';
import { translateMsg } from '../format';

type LText = string | { de?: string; en?: string } | undefined;

/** Sprachfassung eines mehrsprachigen Texts (Fallback: andere Sprache). */
export function pickText(t: LText, lang: string): string {
  if (t === undefined) return '';
  if (typeof t === 'string') return t;
  return (lang === 'en' ? (t.en ?? t.de) : (t.de ?? t.en)) ?? '';
}

/** Beschriftung einer Prüfung: eigener Text des Autors, sonst aus Typ und Parametern abgeleitet. */
export function checkLabel(t: TFunction, lang: string, c: Check): string {
  const own = pickText(c.label, lang);
  if (own) return own;
  switch (c.type) {
    case 'deviceExists':
      return t(c.deviceType ? 'check.label.deviceExistsTyped' : 'check.label.deviceExists', {
        device: c.device,
        type: c.deviceType,
      });
    case 'hostIp':
      return t('check.label.hostIp', {
        device: c.device,
        ip: [c.ip, c.mask ? `/ ${c.mask}` : '', c.gateway ? `gw ${c.gateway}` : '']
          .filter(Boolean)
          .join(' '),
      });
    case 'ifaceIp':
      return t('check.label.ifaceIp', {
        device: c.device,
        iface: c.iface,
        ip: c.mask ? `${c.ip} ${c.mask}` : c.ip,
      });
    case 'ifaceState':
      return t(c.up ? 'check.label.ifaceUp' : 'check.label.ifaceDown', {
        device: c.device,
        iface: c.iface,
      });
    case 'vlanExists':
      return t(c.name ? 'check.label.vlanNamed' : 'check.label.vlan', {
        device: c.device,
        vlan: c.vlan,
        name: c.name,
      });
    case 'vlanMember':
      return t('check.label.vlanMember', { device: c.device, port: c.port, vlan: c.vlan });
    case 'trunk':
      return t('check.label.trunk', { device: c.device, port: c.port });
    case 'route':
      return t('check.label.route', {
        device: c.device,
        prefix: `${c.prefix}/${typeof c.plen === 'number' ? c.plen : c.plen}`,
        source: t(`check.source.${c.source}`),
      });
    case 'config':
      return t(`check.label.config.${c.spec.item}`, {
        device: c.device,
        ...(c.spec as unknown as Record<string, unknown>),
        allowed: undefined,
      });
    case 'ping':
      return t(c.expect === 'success' ? 'check.label.ping' : 'check.label.pingFail', {
        from: c.from,
        to: c.to,
      });
    case 'service':
      return t(c.expect === 'success' ? 'check.label.service' : 'check.label.serviceFail', {
        from: c.from,
        to: c.to,
        protocol: c.protocol.toUpperCase(),
      });
    case 'ospfNeighbors':
      return t('check.label.ospfNeighbors', { device: c.device, min: c.min });
    case 'dhcpLease':
      return t('check.label.dhcpLease', { device: c.device });
    case 'natTranslations':
      return t('check.label.natTranslations', { device: c.device, min: c.min });
  }
}

/** Grund eines Fehlschlags in der Oberflächensprache. */
export function failReason(
  t: TFunction,
  reason: { key: string; params?: Record<string, string | number> } | undefined,
): string {
  return reason ? translateMsg(t, reason) : '';
}
