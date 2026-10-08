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
