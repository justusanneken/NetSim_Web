import type { Ipv4Addr } from '@netsim/protocols';

/** `crypto isakmp policy N` (Defaults wie IOS: des, sha, rsa-sig, Gruppe 1, 86400 s). */
export interface IsakmpPolicy {
  prio: number;
  encr: 'des' | '3des' | 'aes';
  hash: 'md5' | 'sha';
  auth: 'pre-share' | 'rsa-sig';
  group: 1 | 2 | 5;
  lifetime: number;
}

export const newPolicy = (prio: number): IsakmpPolicy => ({
  prio,
  encr: 'des',
  hash: 'sha',
  auth: 'rsa-sig',
  group: 1,
  lifetime: 86400,
});

/** `crypto isakmp key K address A [M]`. */
export interface IsakmpKey {
  key: string;
  addr: Ipv4Addr;
  mask: string;
}

/** `crypto ipsec transform-set NAME esp-aes esp-sha-hmac`. */
export interface TransformSet {
  name: string;
  transforms: string[];
  mode: 'tunnel' | 'transport';
}

export interface CryptoMapEntry {
  seq: number;
  /** `set peer A`. */
  peer?: Ipv4Addr;
  transformSet?: string;
  /** `match address ACL`. */
  acl?: string;
  pfs?: string;
  lifetimeSec?: number;
}

export interface CryptoMap {
  name: string;
  entries: Record<number, CryptoMapEntry>;
}

/** Laufzeit: IKE-SA + IPsec-SA-Paar je Peer und Verkehrsauswahl (ACL-Zeile). */
export interface IpsecSa {
  key: string;
  peer: Ipv4Addr;
  local: Ipv4Addr;
  ifaceId: string;
  mapName: string;
  seq: number;
  /** Verkehrsauswahl aus Sicht dieses Geräts: Quelle (lokal) > Ziel (entfernt), als `ip/wildcard` bzw. `any`. */
  sel: { src: string; dst: string; proto?: number };
  role: 'initiator' | 'responder';
  state: 'connecting' | 'up' | 'failed';
  /** SPI für eingehenden bzw. ausgehenden ESP-Verkehr. */
  inSpi: number;
  outSpi: number;
  transform: string;
  encr: string;
  hash: string;
  connId: number;
  cookie: number;
  since: number;
  encaps: number;
  decaps: number;
  dropped: number;
  reason?: string;
  /** failed: frühester neuer Versuch (µs). */
  retryAt?: number;
}

export interface CryptoCfg {
  policies: Record<number, IsakmpPolicy>;
  keys: IsakmpKey[];
  transformSets: Record<string, TransformSet>;
  maps: Record<string, CryptoMap>;
  /** Laufzeit. */
  sas: Record<string, IpsecSa>;
  nextSpi: number;
  nextConn: number;
}

export const newCrypto = (): CryptoCfg => ({
  policies: {},
  keys: [],
  transformSets: {},
  maps: {},
  sas: {},
  nextSpi: 0x1000,
  nextConn: 1001,
});
