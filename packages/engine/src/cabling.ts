import { CATALOG } from './catalog';
import type { CableType, Device, EngineConfig, Port } from './types';

export interface CableCheck {
  /** Verbindung darf überhaupt hergestellt werden (Stecker passt). */
  allowed: boolean;
  /** Fehlertext (i18n-Schlüssel) bei `allowed=false`. */
  rejectKey?: string;
  /** Link ist elektrisch/optisch betriebsbereit. */
  operUp: boolean;
  /** i18n-Schlüssel für den Grund, falls `operUp=false`. */
  problemKey?: string;
}

const COPPER: ReadonlySet<Port['kind']> = new Set(['fe', 'ge', 'tengig']);

const isEthernetCopper = (p: Port): boolean => COPPER.has(p.kind);

/**
 * Prüft Kabeltyp gegen Portarten (Auto-MDIX-Regeln, Fiber, Console, Serial, Länge).
 * Falscher Kabeltyp bei passendem Stecker ⇒ erlaubt, aber Link down (roter Punkt).
 */
export function validateCable(
  cable: CableType,
  devA: Device,
  portA: Port,
  devB: Device,
  portB: Port,
  lengthM: number | undefined,
  cfg: EngineConfig,
): CableCheck {
  const reject = (rejectKey: string): CableCheck => ({ allowed: false, rejectKey, operUp: false });
  const down = (problemKey: string): CableCheck => ({ allowed: true, operUp: false, problemKey });
  const up: CableCheck = { allowed: true, operUp: true };

  // Phase 5: WLAN (nur von der Engine gelegt), Telefon-/Koaxkabel
  if (cable === 'wireless')
    return portA.kind === 'wifi' && portB.kind === 'wifi' ? up : reject('cable.reject.plug');
  if (portA.kind === 'wifi' || portB.kind === 'wifi') return reject('cable.reject.plug');
  if (cable === 'phone' || cable === 'coax') {
    const plug = cable === 'phone' ? 'dsl' : 'coax';
    return portA.kind === plug && portB.kind === plug ? up : reject('cable.reject.plug');
  }
  const wan = (k: Port['kind']): boolean => k === 'dsl' || k === 'coax';
  if (wan(portA.kind) || wan(portB.kind)) return reject('cable.reject.plug');

  // Console / Rollover
  if (cable === 'rollover') {
    const ok =
      (portA.kind === 'console' && ['console', 'aux'].includes(portB.kind)) ||
      (portB.kind === 'console' && ['console', 'aux'].includes(portA.kind));
    // Rollover passt nur auf Console-Ports; sonst ist der Stecker zwar RJ45, aber ohne Funktion.
    if (!isEthernetCopper(portA) && portA.kind !== 'console') return reject('cable.reject.plug');
    if (!isEthernetCopper(portB) && portB.kind !== 'console') return reject('cable.reject.plug');
    return ok ? up : down('cable.problem.rollover');
  }
  if (portA.kind === 'console' || portB.kind === 'console') {
    return cable === 'straight' || cable === 'crossover'
      ? down('cable.problem.console')
      : reject('cable.reject.plug');
  }

  // Serial
  if (cable === 'serial-dce' || cable === 'serial-dte') {
    if (portA.kind !== 'serial' || portB.kind !== 'serial') return reject('cable.reject.plug');
    // Das Kabel hat ein DCE-Ende (Port A) und ein DTE-Ende (Port B).
    return up;
  }
  if (portA.kind === 'serial' || portB.kind === 'serial') return reject('cable.reject.plug');

  // Fiber
  if (cable === 'fiber') {
    return portA.kind === 'fiber-sfp' && portB.kind === 'fiber-sfp'
      ? up
      : reject('cable.reject.fiber');
  }
  if (portA.kind === 'fiber-sfp' || portB.kind === 'fiber-sfp') return reject('cable.reject.plug');

  // Kupfer-Ethernet
  if (cable === 'straight' || cable === 'crossover') {
    if (!isEthernetCopper(portA) || !isEthernetCopper(portB)) return reject('cable.reject.plug');
    if (cfg.maxCopperLengthM > 0 && (lengthM ?? 0) > cfg.maxCopperLengthM) {
      return down('cable.problem.length');
    }
    const specA = CATALOG[devA.type];
    const specB = CATALOG[devB.type];
    if (specA?.autoMdix || specB?.autoMdix) return up;
    const sameClass = (specA?.mdi ?? 'mdi') === (specB?.mdi ?? 'mdi');
    const needsCrossover = sameClass;
    return (cable === 'crossover') === needsCrossover ? up : down('cable.problem.mdi');
  }

  return reject('cable.reject.unsupported');
}

/** Wählt für zwei Geräte automatisch den passenden Kabeltyp („Automatisch wählen“). */
export function pickCable(devA: Device, portA: Port, devB: Device, portB: Port): CableType {
  if (portA.kind === 'dsl' && portB.kind === 'dsl') return 'phone';
  if (portA.kind === 'coax' && portB.kind === 'coax') return 'coax';
  if (portA.kind === 'console' || portB.kind === 'console') return 'rollover';
  if (portA.kind === 'serial' && portB.kind === 'serial') return 'serial-dce';
  if (portA.kind === 'fiber-sfp' && portB.kind === 'fiber-sfp') return 'fiber';
  const sa = CATALOG[devA.type];
  const sb = CATALOG[devB.type];
  if (sa?.autoMdix || sb?.autoMdix) return 'straight';
  return (sa?.mdi ?? 'mdi') === (sb?.mdi ?? 'mdi') ? 'crossover' : 'straight';
}
