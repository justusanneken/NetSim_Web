import type { DeviceType } from '@netsim/engine';

/** Endgeräte mit Desktop (Apps) und Host-Stack. */
export const END_TYPES: DeviceType[] = [
  'pc',
  'laptop',
  'server',
  'tablet',
  'smartphone',
  'printer',
  'iot-sensor',
  'iot-actuator',
  'sbc',
];
/** Geräte mit IOS-ähnlicher Kommandozeile. */
export const CLI_TYPES: DeviceType[] = ['router', 'switch-l2', 'switch-l3', 'firewall'];
/** Geräte, die einen Host-Stack (IP-Konfiguration) besitzen, aber keinen Desktop (Verwaltungsadresse). */
export const MGMT_HOST_TYPES: DeviceType[] = ['ap', 'wlc'];

export const isEndDevice = (d: { type: DeviceType }): boolean => END_TYPES.includes(d.type);
export const hasCli = (d: { type: DeviceType }): boolean => CLI_TYPES.includes(d.type);
export const hasHostStack = (d: { type: DeviceType }): boolean =>
  END_TYPES.includes(d.type) || MGMT_HOST_TYPES.includes(d.type);
export const isL3Device = (d: { type: DeviceType }): boolean =>
  d.type === 'router' || d.type === 'switch-l3' || d.type === 'firewall';
