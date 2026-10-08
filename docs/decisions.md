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

## Phase 2 – zusätzliche Entscheidungen

11. **CLI läuft im Worker.** Terminals (`@netsim/cli` `Terminal` + `CliSession`/`HostShell`) leben im Engine-
    Worker; xterm.js im Hauptthread schickt Tastatureingaben (`termData`) und schreibt die Antwort. Ein
    Transkript (max. 60 kB) wird beim erneuten Öffnen des Dialogs wiedergegeben.
12. **Gemeinsamer IP-Stack** (`engine/src/ip.ts`) für Host und Router; die Gerätehandler liefern nur eine
    `IpNode`-Sicht (Schnittstellen, Lookup, Forwarding-Flag, TTL, ARP-Lebensdauer).
13. **Config-Modell:** `SysConfig` (Hostname, Passwörter, Banner, Lines, Beschreibungen, Startup-Text) ist
    für Router und Switch gemeinsam; der Router hält zusätzlich `ifaces` und `staticRoutes`. Die GUI und die
    CLI ändern denselben Baum über Engine-Methoden (`setInterfaceIp`, `addStaticRoute`, …) – GUI-Änderungen
    erscheinen deshalb in der `running-config` und umgekehrt.
14. **Deklarative Befehle:** `CommandDef { modes, slots, run, negatable, only }` mit Slots `K` (Schlüsselwort),
    `choice`, `P` (Parameter), `R` (Zeilenrest), `opt`. `no`/`default` werden aus `negatable` abgeleitet
    (Parameter dann optional). Neue Befehle brauchen keinen Parser-Umbau.
15. **Golden-Tests für die CLI:** `packages/cli/test/golden/*.txt` (Terminalausgabe ganzer Sitzungen);
    `UPDATE_GOLDEN=1` erzeugt sie neu.
16. **Switch-Datenebene pro VLAN:** MAC-Tabelle `vlan|mac`; logische Ports (`po1`) bündeln EtherChannel-Mitglieder.
    STP-Zustand gated Lernen und Weiterleiten je VLAN.
17. **Standard-Switchport-Modus `dynamic auto`** (wie bei Cisco); zwei `dynamic auto`-Ports bleiben Access.
18. **L3-Schnittstellen als `Iface`:** physisch `p0`, Subinterface `p0.10`, SVI `vlan10`; ein gemeinsamer IP-Stack für Host,
    Router und L3-Switch (Weiterleitungsreihenfolge: ACL-in → NAT außen→innen → Route/TTL → NAT innen→außen → ACL-out → ARP).
19. **Hintergrund-Timer (`bg:`)** (STP-Hello, VTP) zählen nicht als „Vordergrundarbeit“; `waitFor` der CLI endet damit
    sinnvoll, obwohl STP dauerhaft Ereignisse erzeugt.
20. **Neue Engine-Meldungen** nur als i18n-Schlüssel mit Parametern; `apps/web/test/i18n.test.ts` erzwingt Vollständigkeit.
21. **Routing-Zustand lebt im Konfigurationsbaum** (`L3Cfg.routing`, `dynRoutes`/`dynRoutes6`): Nachbarn, LSDB, Topologie sind JSON-serialisierbar (Snapshots/Schritt-zurück funktionieren). Pro Prozess `src` (`ospf:1`, `eigrp:100`, `rip`, `bgp`) für Neuberechnung und Redistribution.
22. **Zentrale Neuberechnung** (`rt:recompute`, 1 ms): SPF, Redistribution, BGP-Bestpath laufen gebündelt bis zum Fixpunkt (max. 5 Durchläufe).
23. **`debug`-Meldungen** sind Log-Einträge mit `debug`-Feld, nur bei aktivem Schalter erzeugt; die CLI-Sitzung holt sie per `poll()`, der Worker pusht sie per Polling an xterm. Periodische Routing-Protokolle sind im Ereignisfilter standardmäßig aus.
24. **IPv6 als paralleler Stack** (`l3v6.ts`) neben IPv4; Router/Host-Knoten tragen optional `v6`. Protokolle (OSPFv3) nutzen Pseudo-Schnittstellen mit Link-Local-Adresse.
