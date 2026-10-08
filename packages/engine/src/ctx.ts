import type { Frame, ProtoTag } from '@netsim/protocols';
import type { DebugInfo, Device, LogEntry, Msg, Port, PortRef, Transmission } from './types';

export interface LogInput {
  kind: LogEntry['kind'];
  proto: ProtoTag;
  status: LogEntry['status'];
  msg: Msg;
  /** Gerät, von dem der Frame direkt kam. */
  from?: string;
  port?: Port;
  summary?: string;
  frame?: Frame;
  debug?: DebugInfo;
}

/**
 * Schmale Schnittstelle, über die Geräteverhalten mit der Engine spricht.
 * Wird pro Ereignis erzeugt und gehört NICHT zum serialisierbaren Zustand.
 */
export interface DeviceCtx {
  readonly now: number;
  readonly device: Device;
  readonly processingUs: number;
  readonly propagationUs: number;
  /** Zufallszahl im Bereich [0, max) aus dem seedbaren RNG. */
  rand(max: number): number;
  port(portId: string): Port;
  /** Anzeigename einer L3-Schnittstelle des Geräts (`Gi0/0.10`, `Vlan10`). */
  deviceIfaceName(ifaceId: string): string;
  /** Port-/Link-Status neu berechnen (nach dem aktuellen Ereignis). */
  requestRefresh(): void;
  /** Phase 5: WLAN-Assoziationen nach diesem Ereignis neu berechnen (z. B. AP hat WLC-Konfiguration erhalten). */
  requestWifiSync(): void;
  send(portId: string, frame: Frame, delayUs?: number, origin?: number): void;
  log(entry: LogInput): void;
  setTimer(name: string, delayUs: number, repeatUs?: number): void;
  cancelTimer(name: string): void;
  peerOf(portId: string): PortRef | undefined;
  transmission(txId: number): Transmission | undefined;
  /** Andere Übertragungen zu diesem Gerät, die zeitlich mit `txId` überlappen. */
  overlappingIncoming(txId: number): Transmission[];
  /** Markiert Übertragungen als kollidiert und benachrichtigt die Sender (Jam). */
  signalCollision(txs: Transmission[]): void;
  /** Eigene, noch laufende Wiederholungen eines Hubs zerstören. */
  corruptOutgoing(): Transmission[];
}
