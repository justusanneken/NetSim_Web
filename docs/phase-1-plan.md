# Aufgabenplan Phase 1 – Fundament + L2

| #   | Aufgabe                                                                                                         | Ergebnis                | Status |
| --- | --------------------------------------------------------------------------------------------------------------- | ----------------------- | ------ |
| 1   | Monorepo (pnpm), TS strict, ESLint/Prettier, Vitest, CI                                                         | `pnpm check` grün       | fertig |
| 2   | `protocols`: Ethernet, ARP, IPv4, ICMP-Echo, Adress-Helfer, `describe/size/clone`                               | 8 Tests, 100 % Coverage | fertig |
| 3   | `engine`: Scheduler (Min-Heap, (t, seq)), RNG, Snapshot/Restore, Timer-API                                      | Heap-/Snapshot-Tests    | fertig |
| 4   | Topologie: Device/Port/Link, Gerätekatalog, Kabelvalidierung (Auto-MDIX, Fiber, Console, Serial, Länge)         | Abnahme (b)             | fertig |
| 5   | Host-Stack: ARP (Cache, Queue, Retry), Ping (ICMP-Echo)                                                         | Abnahme (a)             | fertig |
| 6   | Switch: MAC-Learning, Aging, Flooding/Unicast/Filter                                                            | Abnahme (a)             | fertig |
| 7   | Hub: Repeater + CSMA/CD (Kollision, Jam, Backoff), Kollisionsdomänen                                            | Hub-Tests               | fertig |
| 8   | Zeitmodi `realtime`/`simulation`/`paused`, Step/Step-Back                                                       | Controller-Tests        | fertig |
| 9   | Worker + typisiertes Protokoll (Comlink), Web-UI: Platzieren, Verkabeln, Link-Lights, Event-Liste, Geräte-Panel | E2E                     | fertig |
| 10  | Golden-File-Test (Determinismus)                                                                                | Abnahme (c)             | fertig |
| 11  | Docs: Architektur, Entscheidungen, Vereinfachungen, Coverage-Matrix, Erweiterungsanleitung                      | `docs/`                 | fertig |

Nicht in Phase 1: VLAN/STP (3), Router/CLI/Desktop/Animation (2), Wireless/Server (5), Dateiformat/Undo (6).
