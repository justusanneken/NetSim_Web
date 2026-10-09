import type { Ipv4Addr, Mac } from '@netsim/protocols';

/** PPPoE-Konfiguration einer Schnittstelle (Dialer, Virtual-Template, physischer Port). */
export interface DialerCfg {
  /** `dialer pool N` (verbindet den Dialer mit dem Port per `pppoe-client dial-pool-number N`). */
  pool: number;
  /** `ppp chap hostname`/`ppp chap password`. */
  chapUser?: string;
  chapPass?: string;
  /** `ppp ipcp route default`: Default-Route über den Dialer, sobald die Sitzung steht. */
  ipcpRoute?: boolean;
  /** `ip address negotiated`. */
  negotiated?: boolean;
}

export interface VTemplateCfg {
  /** `ip unnumbered IF` (Schnittstellen-ID) – die Adresse wird dem Peer als Gegenstelle mitgeteilt. */
  unnumbered?: string;
  /** `peer default ip address pool NAME`. */
  pool?: string;
  /** `ppp authentication chap`. */
  chap: boolean;
}

export interface BbaGroup {
  name: string;
  /** `virtual-template N`. */
  template?: number;
}

export interface LocalPool {
  name: string;
  start: Ipv4Addr;
  end: Ipv4Addr;
}

export type PppState = 'discovery' | 'padr' | 'lcp' | 'auth' | 'ipcp' | 'up';

/** Laufzeit: eine PPPoE-Sitzung (Client am Dialer bzw. Server je Virtual-Access). */
export interface PppSession {
  key: string;
  role: 'client' | 'server';
  /** Physischer Port (Schnittstellen-ID). */
  portId: string;
  /** Dialer-ID (`di1`) bzw. Virtual-Access-ID (`va1`). */
  ifaceId: string;
  peerMac: Mac;
  sessionId: number;
  state: PppState;
  /** LCP: eigene Anfrage wurde bestätigt / Anfrage des Peers wurde bestätigt. */
  lcpOwn: boolean;
  lcpPeer: boolean;
  chapId: number;
  challenge?: string;
  user?: string;
  localIp?: Ipv4Addr;
  peerIp?: Ipv4Addr;
  since: number;
  inPkts: number;
  outPkts: number;
  /** Letzter Fehlergrund (Client: für `show pppoe session`/Wiederholung). */
  lastError?: string;
}

export interface PppRuntime {
  sessions: Record<string, PppSession>;
  nextSession: number;
  nextVa: number;
  nextChap: number;
  /** Client: letzter Fehler je Dialer. */
  errors?: Record<string, string>;
  /** Client: frühester Zeitpunkt (µs) des nächsten Einwahlversuchs je Dialer. */
  holdoff?: Record<string, number>;
}

export const newPppRuntime = (): PppRuntime => ({
  sessions: {},
  nextSession: 1,
  nextVa: 1,
  nextChap: 1,
});
