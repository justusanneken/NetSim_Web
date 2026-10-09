/** Dynamischer Portbereich (IANA): lokale Client-Ports laufen darin um, statt über 65535 hinaus zu wachsen. */
export const EPHEMERAL_MIN = 49152;
export const EPHEMERAL_MAX = 65535;

/**
 * Nächster freier lokaler Port aus `holder.nextPort` (danach weitergezählt). Nach 65535 beginnt die Zählung
 * wieder bei 49152; `inUse` überspringt noch belegte Ports (z. B. offene TCP-Verbindungen).
 */
export function nextEphemeral(
  holder: { nextPort: number },
  inUse: (port: number) => boolean = () => false,
): number {
  for (let i = 0; i <= EPHEMERAL_MAX - EPHEMERAL_MIN; i++) {
    if (holder.nextPort > EPHEMERAL_MAX) holder.nextPort = EPHEMERAL_MIN;
    const p = holder.nextPort++;
    if (!inUse(p)) return p;
  }
  return holder.nextPort++;
}
