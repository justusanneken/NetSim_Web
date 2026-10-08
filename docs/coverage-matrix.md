# Coverage-Matrix: Feature → Phase → Status → Test

Status: **offen** · **teilweise** · **fertig**. Tests: `engine` = `packages/engine/test`, `protocols` =
`packages/protocols/test`, `web` = `apps/web/test|e2e`.

## Phase 1 – Fundament + L2

| Feature                                                           | Phase | Status                      | Test                                                         |
| ----------------------------------------------------------------- | ----- | --------------------------- | ------------------------------------------------------------ |
| Monorepo, TS strict, `pnpm check`, CI                             | 1     | fertig                      | CI-Workflow                                                  |
| Virtuelle Zeit (µs), Min-Heap `(t, seq)`                          | 1     | fertig                      | `engine › Scheduler › Heap ordnet nach (t, seq)`             |
| Seedbarer RNG (mulberry32)                                        | 1     | fertig                      | `engine › Scheduler › RNG ist seedbar…`                      |
| Timer-API (`setTimer`/`cancelTimer`, repeat)                      | 1     | fertig                      | `engine › Scheduler › Timer: wiederholt, abbrechbar…`        |
| Verzögerungsmodell (Serialisierung + Propagation + Verarbeitung)  | 1     | fertig                      | `engine › Scheduler › Verzögerung = …`                       |
| Modi realtime / simulation / paused, Step, Step Back              | 1     | fertig                      | `engine › SimController › *`                                 |
| Snapshot/Restore (serialisierbar)                                 | 1     | fertig                      | `engine › Snapshot / Restore › *`                            |
| Device/Port/Link-Modell, Katalog PC/Switch/Hub                    | 1     | teilweise (Katalog Phase 1) | `engine › Topologie › *`                                     |
| Kabelvalidierung (Auto-MDIX, Fiber, Console, Serial, Länge)       | 1     | fertig                      | `engine › Topologie › Auto-MDIX…`, `Fiber…`, `Spezialports…` |
| Abnahme (b): PC↔PC Straight = down, Crossover = up                | 1     | fertig                      | `Abnahme Phase 1 (b)`                                        |
| Ethernet II, ARP, IPv4, ICMP-Echo (PDU, Größe, describe, clone)   | 1     | fertig                      | `protocols › pdu › *`                                        |
| ARP Host↔Host (Cache 2 min, Queue, Retry, Gratuitous)             | 1     | fertig                      | `engine › Host / ARP / Ping › *`                             |
| MAC-Learning, Aging (300 s), Flooding, Unicast, Filter            | 1     | fertig                      | `engine › Switch › *`                                        |
| Abnahme (a): 3 PCs/1 Switch, Flooding → Unicast, 3 MAC-Einträge   | 1     | fertig                      | `Abnahme Phase 1 (a)`                                        |
| Hub-Repeater, CSMA/CD (Kollision, Jam, Backoff), Kollisionsdomäne | 1     | fertig                      | `engine › Hub / CSMA-CD › *`                                 |
| Fehlerisolierung (`crashed`)                                      | 1     | fertig                      | `engine › Fehlerrobustheit`                                  |
| Abnahme (c): Golden-File/Determinismus                            | 1     | fertig                      | `Abnahme Phase 1 (c)`                                        |
| Link-Lights (up/down/Blinken), Port-Beschriftungen                | 1     | fertig                      | `web e2e › phase1` (sichtbar), manuell                       |
| Event-Liste (virtualisiert, Filter, CSV-Export)                   | 1     | teilweise (kein Pcap/JSON)  | `web e2e › phase1`                                           |
| i18n de/en, Vollständigkeit                                       | 1     | fertig                      | `web › i18n › *`                                             |
| Worker + typisiertes Protokoll                                    | 1     | fertig                      | `web e2e › phase1`                                           |

## Phase 2 – L3 + CLI-Grundlage

| Feature                                                                                                                              | Phase | Status                                               | Test                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| IPv4-Stack (Host + Router), ARP-Queue mit Retry                                                                                      | 2     | fertig                                               | `engine › router.test › Abnahme Phase 2`                              |
| Router: Connected/Local/Static, Longest-Prefix-Match, Default-Route, Floating Static (AD)                                            | 2     | fertig                                               | `engine › Routing-Tabelle › *`                                        |
| TTL, ICMP Time Exceeded / Destination Net+Host Unreachable                                                                           | 2     | fertig                                               | `engine › Abnahme Phase 2 › TTL…`, `Router ohne Route…`               |
| Fragmentierung, Reassembly, DF → Fragmentation Needed (PMTUD-Grundlage)                                                              | 2     | fertig                                               | `engine › Fragmentierung, DF und PMTUD › *`                           |
| Traceroute (Engine)                                                                                                                  | 2     | fertig                                               | `engine › Traceroute über zwei Router…`                               |
| Abnahme: falsches Gateway → korrekte ICMP-Meldung                                                                                    | 2     | fertig                                               | `engine › kein Gateway → noRoute…`, `cli › shell › falsches Gateway…` |
| Router-Schnittstellen default down, Überlappungsprüfung                                                                              | 2     | fertig                                               | `engine › Validierung…`                                               |
| Subinterfaces/Router-on-a-Stick, ECMP, Redistribution                                                                                | 3/4   | offen                                                | –                                                                     |
| CLI-Framework: Modi, Abkürzungen, `?`, Tab, `no`/`default`, `do`, Pipes                                                              | 2     | fertig                                               | `cli › Parser › *`, `Modi und Konfiguration › *`                      |
| IOS-Fehlermeldungen (Caret, Incomplete, Ambiguous)                                                                                   | 2     | fertig                                               | `cli › Parser › Fehlermeldungen…`                                     |
| Basisbefehle + `show` (version, run/startup, ip int brief, ip route, ip arp, interfaces [status], mac address-table, history, clock) | 2     | fertig                                               | `cli › Abnahme Phase 2: CLI-Golden-Tests`                             |
| `running-config`-Renderer aus Objektbaum + Replay (startup-config, reload)                                                           | 2     | fertig                                               | `cli › Dateien: copy, erase, reload, Replay`                          |
| Passwörter (enable secret/password, Typ 7, Console-Login), Banner, Setup-Dialog                                                      | 2     | teilweise (kein Telnet/SSH-Login)                    | `cli › Passwörter…`, `Banner…`                                        |
| Terminal: Historie, Ctrl+A/E/U/W/C/Z, `--More--`, `terminal length`                                                                  | 2     | fertig                                               | `cli › shell › Terminal (Zeileneditor)`                               |
| ping (inkl. erweiterter Dialog), traceroute (IOS)                                                                                    | 2     | fertig                                               | `cli › Ping-Dialog…`, Golden `router-session`                         |
| Desktop: IP-Konfiguration, Command Prompt (`ping`, `tracert`, `ipconfig [/all]`, `arp -a`)                                           | 2     | teilweise (kein DHCP/DNS/Web)                        | `cli › shell › Host-Eingabeaufforderung`, `web e2e › phase2`          |
| Geräte-Dialog (Config / CLI / Desktop), xterm.js                                                                                     | 2     | teilweise (Physical/Attributes folgen)               | `web e2e › phase2`                                                    |
| Simulationsmodus mit Animation (Umschläge), PDU-Inspektor (OSI-Schichten, Felder)                                                    | 2     | teilweise (Inbound-Ansicht, kein Outbound/Challenge) | `web e2e › phase2` (Inspektor), manuell (Animation)                   |
| Debug-Befehle, `show ip protocols`, Mehrfach-Sessions, `clock set`                                                                   | 3/4   | offen                                                | –                                                                     |

## Spätere Phasen (Auszug)

| Feature                                                                     | Phase | Status | Test |
| --------------------------------------------------------------------------- | ----- | ------ | ---- |
| IPv4-Routing, Router, statische Routen, TTL, Fragmentierung                 | 2     | offen  | –    |
| CLI-Framework (Modi, `?`, Tab, Abkürzungen), `running-config`-Renderer      | 2     | offen  | –    |
| Desktop (IP-Config, Command Prompt), Animation, PDU-Inspektor (voll)        | 2     | offen  | –    |
| VLAN/Trunk/VTP/STP/EtherChannel/Port-Security                               | 3     | offen  | –    |
| DHCP/DNS/HTTP/ACL/NAT                                                       | 3     | offen  | –    |
| RIP/OSPF/EIGRP/BGP/HSRP/GRE/IPv6                                            | 4     | offen  | –    |
| Wireless, Server-Dienste, Firewall, IoT, Physical View                      | 5     | offen  | –    |
| `.nsim`, Autosave, Undo/Redo, Vorlagen, Scripting, Aufgabenmodus, Multiuser | 6     | offen  | –    |
