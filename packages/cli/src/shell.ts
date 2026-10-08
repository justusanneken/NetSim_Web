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
  /** Asynchrone Ausgabe seit dem letzten Aufruf (z. B. `debug`-Meldungen); leer, wenn nichts anfiel. */
  poll?(): string;
  /** Sitzung beendet (z. B. `exit` in einer Telnet-/SSH-Sitzung): die Terminal-Schicht fällt auf die darunterliegende Shell zurück. */
  closed?: boolean;
  /** Fortsetzung: ersetzt diese Shell (z. B. Anmeldung → Remote-CLI). */
  next?: Shell;
  readonly history: readonly string[];
  /** Zeilen je Seite für `--More--` (0 = aus). */
  readonly terminalLength: number;
}

/** Erlaubt Shells, eine untergeordnete Shell zu öffnen (Telnet/SSH/FTP-Sitzung). */
export interface ShellNest {
  push(shell: Shell, onClose?: () => string): void;
}
