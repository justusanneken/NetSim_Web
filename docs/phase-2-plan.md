# Aufgabenplan Phase 2 – L3 + CLI-Grundlage

| #   | Aufgabe                                                                              | Ergebnis                | Status |
| --- | ------------------------------------------------------------------------------------ | ----------------------- | ------ |
| 1   | Protokolle: IPv4-Fragmente (MF/Offset/dataLen), ICMP Unreachable/Time Exceeded       | `protocols`-Tests       | fertig |
| 2   | Gemeinsamer IP-Stack (ARP-Queue, Lookup, Fragmentierung, Reassembly, ICMP-Fehler)    | `engine/src/ip.ts`      | fertig |
| 3   | Router-Modell: Schnittstellen, Routing-Tabelle (C/L/S), TTL, Static/Floating/Default | `router.test`           | fertig |
| 4   | Ping/Traceroute-Sitzungen (Host + Router)                                            | `router.test`           | fertig |
| 5   | CLI-Framework: Parser, Modi, `?`, Tab, `no`/`default`, `do`, Pipes, Fehlermeldungen  | `cli.test`              | fertig |
| 6   | Konfigurationsmodell + `running-config`-Renderer, `copy`/`erase`/`reload` mit Replay | `cli.test`, Golden      | fertig |
| 7   | `show`-Befehle, `ping` (erweitert), `traceroute`                                     | Golden `router-session` | fertig |
| 8   | Terminal-Editor (Historie, Ctrl-Tasten, `--More--`) + Windows-Eingabeaufforderung    | `shell.test`            | fertig |
| 9   | UI: Geräte-Dialog (Config/CLI/Desktop), xterm.js, Router-GUI, Animation, Inspektor   | E2E                     | fertig |
| 10  | Docs: Entscheidungen, Vereinfachungen, CLI-Referenz, Erweiterungsanleitung           | `docs/`                 | fertig |

Nicht in Phase 2: VLAN/Trunk/Subinterfaces, DHCP/DNS/HTTP, ACL/NAT (Phase 3), dynamisches Routing,
`debug` (Phase 4).
