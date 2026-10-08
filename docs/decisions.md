# Entscheidungen und Annahmen

Es werden keine Rückfragen gestellt; unklare Stellen der Spezifikation sind hier mit einem Default
festgelegt. Jede Entscheidung ist umkehrbar und wird bei Bedarf in der jeweiligen Phase angepasst.

## Annahmen (max. 10)

1. **PDUs sind reine Datenobjekte.** Die Spezifikation verlangt je PDU `layers[]`, `describe()`, `size()`,
   `clone()`. Damit der Engine-Zustand ohne Closures serialisierbar bleibt (Snapshot, `.nsim`,
   `structuredClone` über die Worker-Grenze), sind PDUs Plain Objects; die Operationen sind freie Funktionen
   in `@netsim/protocols` (`layersOf`, `describePdu`/`describeFrame`, `pduSize`, `clonePdu`).
2. **Engine-Meldungen sind i18n-Schlüssel + Parameter** (`{ key, params }`), keine Texte. Die UI übersetzt
   (`de` Default, `en`). Ein Test stellt sicher, dass jeder Engine-Schlüssel in beiden Sprachen existiert.
3. **Default-Seed = 1.** Gleiche Topologie + Seed + Eingaben ⇒ identisches Event-Log (Golden-File-Test).
   Ein Seed-Selektor in der UI folgt in Phase 6 (Szenarien).
4. **Pakete werden als TypeScript-Quellen konsumiert** (`main: src/index.ts`); kein separater Build-Schritt
   für Bibliotheken. Vite/Vitest/tsc lösen die Workspace-Pakete direkt auf.
5. **Das Event-Log liegt außerhalb des Snapshots.** Ein Snapshot enthält den Zustand und die Log-Länge;
   `restore()` kürzt das Log. So bleiben Step-Back-Snapshots klein.
6. **Phase-1-Katalog:** PC, Switch (2960-24-ähnlich: 24×Fa + 2×Gi) und Hub (8 Ports). Laptop/Server/Tablet
   teilen sich später den Host-Stack, werden aber erst mit ihren Phasen freigeschaltet. Nicht unterstützte
   `DeviceType`-Werte sind im Typ vorhanden, `addDevice` lehnt sie ab.
7. **Zeitmodi:** Start im Modus _Echtzeit_ (1×). _Simulation_ = manuelles Schrittfahren; „Schritt“ läuft bis zum
   nächsten sichtbaren Log-Eintrag (nicht nur ein internes Ereignis). Step Back stellt den Snapshot vor dem
   letzten Schritt wieder her (max. 200 Schritte).
8. **Timeouts:** ARP 3 Versuche im Sekundentakt, Ping-Timeout 4 s (Windows-Verhalten: ARP-Fehler → „Zielhost
   nicht erreichbar“ nach ~3 s, sonst „Zeitüberschreitung“).
9. **CSP:** Im Produktions-Build wird eine strikte Content-Security-Policy per `<meta>` eingefügt (kein
   Inline-Script, Worker nur `self`/`blob:`, keine externen Verbindungen). Als HTTP-Header ist dieselbe Policy
   beim Hosting zu setzen (siehe README). Im Dev-Server ist die CSP aus (HMR braucht Inline-Skripte).
10. **MAC-Format** intern `aa:bb:cc:dd:ee:ff`; die Cisco-Schreibweise (`aabb.ccdd.eeff`) wird erst im
    CLI-Renderer (Phase 2) erzeugt. MACs werden deterministisch aus einem Zähler vergeben
    (`02:00:…`, lokal administriert).

## Architekturentscheidungen

- **Engine = reine Zustandsmaschine.** `EngineState` (JSON-kompatibel) + Min-Heap-Queue im Zustand;
  Gerätehandler sind Funktionen `(ctx, config, …)`. `ctx` (`DeviceCtx`) wird je Ereignis erzeugt und ist
  die einzige Schnittstelle zu Zeit, RNG, Senden, Timern und Log.
- **Fehlerisolierung:** Exceptions in einem Gerätehandler setzen nur dieses Gerät auf `crashed`; die Simulation
  läuft weiter, die UI zeigt ⚠ und die Meldung.
- **Sicherheit:** Es gibt keinen `eval`, keine externen Requests zur Laufzeit; die Engine läuft im Worker.
