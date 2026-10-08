/** Gemeinsame Schnittstelle für CLI-Sitzungen (IOS-Stil) und Host-Eingabeaufforderung. */
export interface Shell {
  /** Aktueller Prompt (leer bei mehrzeiligen Eingaben wie Bannern). */
  prompt(): string;
  /** Eingabe wird nicht angezeigt (Passwörter). */
  secret(): boolean;
  /** Führt eine Zeile aus bzw. beantwortet eine Rückfrage; liefert die Ausgabe. */
  input(line: string): string;
  /** `?` – Hilfe zum aktuellen Zeilenpuffer (nur IOS-Sitzungen). */
  help(line: string): string | undefined;
  /** Tab – liefert die vervollständigte Zeile. */
  complete(line: string): string;
  /** Ctrl+C */
  interrupt(): string;
  /** Ctrl+Z (verlässt den Konfigurationsmodus) */
  end(): string;
  /** Initialausgabe beim Öffnen (Banner, Setup-Dialog). */
  start(): string;
  readonly history: readonly string[];
  /** Zeilen je Seite für `--More--` (0 = aus). */
  readonly terminalLength: number;
}
