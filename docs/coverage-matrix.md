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
| ECMP (OSPF, EIGRP, RIP, statisch; `maximum-paths`, Pro-Flow-Hash, mehrere `via`-Zeilen)                                              | 4     | fertig                                               | `engine › ecmp › *`, `cli › Lücken: ECMP`                             |
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
| Debug-Befehle, `show ip protocols`                                                                                                   | 4     | fertig                                               | `cli › Phase 4 › *`                                                   |
| `clock set` + `show clock`, `debug`-Zeitstempel folgen der gesetzten Uhr                                                             | 4     | fertig                                               | `cli › Lücken: clock set`, `web e2e › gaps`                           |
| Mehrfach-Sessions (Telnet/SSH)                                                                                                       | 5     | offen (Phase 5)                                      | –                                                                     |

## Phase 3 – Switching, Dienste, Filter

| Feature                                                                                                                                                             | Phase     | Status                                        | Test                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------- | ------------------------------------------------ |
| VLANs (Access/Trunk, 802.1Q, Native-VLAN, Allowed-Liste, DTP-Aushandlung), VLAN-DB                                                                                  | 3         | fertig                                        | `engine › vlan › *`, `cli › Phase 3 › VLAN…`     |
| VTP (Server/Client/Transparent, Revision, Domäne)                                                                                                                   | 3         | fertig (kein VTPv3, kein Passwort/Pruning)    | `engine › vlan › VTP…`                           |
| STP/PVST+ (802.1D-Timer), Rapid-PVST (Proposal/Agreement), PortFast, BPDU-Guard, Root-Guard, Root-Wahl/Priorität                                                    | 3         | fertig (kein MST)                             | `engine › stp › *`                               |
| Abnahme: Ring blockiert genau einen Port, Failover bei Linkausfall                                                                                                  | 3         | fertig                                        | `engine › stp › Ring…`                           |
| EtherChannel (on/LACP/PAgP-Konfig-Abgleich, Hash auf MAC-Paar, Port-Channel-Interface)                                                                              | 3         | teilweise (keine PDUs)                        | `engine › vlan › EtherChannel…`                  |
| Port-Security (max, sticky, protect/restrict/shutdown, err-disable + Recovery)                                                                                      | 3         | fertig                                        | `engine › vlan › Port-Security…`                 |
| Router-on-a-Stick (Subinterfaces `dot1Q`)                                                                                                                           | 3         | fertig                                        | `engine › l3svc › Inter-VLAN…`                   |
| L3-Switch: SVIs, `ip routing`, Management-SVI                                                                                                                       | 3         | fertig                                        | `engine › l3svc › SVI…`                          |
| DHCP-Server (Router/Server-Gerät), Pools, Excluded, Relay (`ip helper-address`), Client (DORA, Renew, Konflikterkennung)                                            | 3         | fertig (kein Option 82; DHCPv6 siehe Phase 4) | `engine › l3svc › DHCP…`                         |
| DNS (Server/Resolver/Cache), HTTP/HTTPS (ohne TLS), Webbrowser im PC                                                                                                | 3         | fertig                                        | `engine › l3svc › DNS/HTTP…`, `web e2e › phase3` |
| ACL (standard/extended/benannt, established, Portoperatoren, ICMP-admin-prohibited)                                                                                 | 3         | fertig                                        | `engine › l3svc › ACL…`                          |
| NAT (statisch, Port-Forwarding, Pool, PAT/Overload, Timeouts)                                                                                                       | 3         | fertig                                        | `engine › l3svc › NAT/PAT…`                      |
| Abnahme: Inter-VLAN, DHCP über Relay, PAT mit 3 Clients, ACL blockt HTTP selektiv                                                                                   | 3         | fertig                                        | `engine › l3svc › Abnahme Phase 3`               |
| CLI: `interface range`, `vlan`, `switchport …`, `spanning-tree …`, `channel-group`, `ip dhcp …`, `access-list`, `ip nat …`, `show` für alles; running-config-Replay | 3         | fertig                                        | `cli › Phase 3 › *`                              |
| Host-Shell: `nslookup`, Ping per Name, `ipconfig /renew                                                                                                             | /release` | 3                                             | fertig                                           | `cli › Phase 3 › Host-Shell…` |
| GUI: VLAN-/Switchport-Panel, SVI/Subinterface, Server-Dienste, DHCP/DNS am Host, Browser, STP-Linklicht orange                                                      | 3         | fertig                                        | `web e2e › phase3`                               |
| SPAN, Storm-Control, DHCP-Snooping, DAI, UDLD, MST                                                                                                                  | –         | nicht geplant                                 | –                                                |

## Phase 4 – Routing-Protokolle und IPv6

| Feature                                                                                                                                                                  | Phase | Status                                      | Test                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------------------------------------------- | ------------------------------------------------------- |
| RIPv2 (Updates 30 s, Triggered Updates, Split Horizon, Auto-Summary, Invalid/Flush, Hold-down, `timers basic`, Redistribution ohne Metrik = unendlich, `default-metric`) | 4     | fertig (kein RIPv1)                         | `engine › rip › *`, `engine › rip_gaps › *`             |
| OSPFv2 Einzel- und Multi-Area (Hello/DBD/LSR/LSU/LSAck, DR/BDR, LSA 1–5, SPF, ABR-Summaries, `area range`, Kosten/Referenzbandbreite, ECMP)                              | 4     | fertig                                      | `engine › ospf › *`, `engine › ecmp › *`                |
| OSPF Stub, Totally Stubby, NSSA (Typ 7 + Übersetzung), Virtual Links, Authentifizierung (simple/MD5 als Schlüsselvergleich)                                              | 4     | fertig                                      | `engine › ospf_areas › *`, `engine › ospf_vlink › *`    |
| Abnahme: OSPF konvergiert im 4-Router-Ring, Linkausfall führt zum Umschalten                                                                                             | 4     | fertig                                      | `engine › ospf › Abnahme…`                              |
| EIGRP (Hello/Hold, Update/Query/Reply mit Ack/Retransmit, DUAL mit Feasible Successor, klassische Metrik, Auto-Summary, `variance`, ECMP, Stuck-in-Active)               | 4     | fertig (EIGRP für IPv6 fehlt)               | `engine › eigrp › *`, `engine › eigrp_gaps › *`         |
| HSRP v1/v2 (Active/Standby/Preempt, virtuelle MAC, Tracking, Failover, Gruppen bis 4095, Klartext-Authentifizierung, HSRP für IPv6)                                      | 4     | fertig (kein MD5, keine Coup/Resign-Pakete) | `engine › hsrp_gre › HSRP`, `engine › hsrp_v2 › *`      |
| GRE-Tunnel (Loopback als Quelle, OSPF über Tunnel)                                                                                                                       | 4     | fertig                                      | `engine › hsrp_gre › GRE…`                              |
| Redistribution (connected/static/RIP/OSPF/EIGRP/BGP → RIP/OSPF/EIGRP/BGP; IPv6: OSPFv3/RIPng), `default-information originate`, `route-map`, `distribute-list`           | 4     | fertig                                      | `engine › redistribute › *`, `engine › routemap › *`    |
| Prefix-Lists, Community-Listen, Route-Maps (match/set)                                                                                                                   | 4     | fertig (keine AS-Path-Regex-Listen)         | `engine › routemap › *`, `cli › Lücken: Prefix-Lists…`  |
| BGP (eBGP/iBGP, Sitzungs-FSM, Pfadattribute, Bestpath-Auswahl, next-hop-self, update-source, Multihop, Policies, Communities, Route Reflector, IPv6-Adressfamilie, ECMP) | 4     | fertig (BGP ohne TCP)                       | `engine › bgp › *`, `engine › bgp_policy › *`           |
| IPv6: Link-Local, Neighbor Discovery, DAD, ICMPv6-Ping/Traceroute, statische Routen, Router Advertisements + SLAAC, DHCPv6 (zustandsbehaftet/-los), Hop Limit            | 4     | fertig (keine Fragmentierung)               | `engine › ipv6 › *`, `ipv6_gaps`, `ipv6_trace`, `dhcp6` |
| OSPFv3 (IPv6) inkl. Redistribution (connected/static)                                                                                                                    | 4     | fertig (einfachere LSA-Struktur)            | `engine › ipv6 › OSPFv3`, `engine › ripng › OSPFv3…`    |
| RIPng (`ipv6 router rip`, `ipv6 rip NAME enable`)                                                                                                                        | 4     | fertig                                      | `engine › ripng › *`                                    |
| `debug`-Ausgaben mit asynchroner Terminalausgabe (RIP, OSPF, EIGRP, HSRP, BGP, Routing, Tunnel)                                                                          | 4     | fertig                                      | `cli › Phase 4 › debug…`, `web e2e › phase4`            |
| CLI: `router …`, `network`, `redistribute`, `neighbor`, `standby`, `ip ospf`, `tunnel`, `ipv6 …`, `route-map`, `ip prefix-list`, `show …`; running-config-Replay         | 4     | fertig                                      | `cli › Phase 4 › *`, `cli › Lücken: *`                  |
| GUI: Routing-Übersicht (Bereichstypen, Virtual Links, HSRP-Version, BGP-Policy-Hinweis), ECMP-Routentabelle, Loopback, IPv6 an Router/Host, SLAAC/DHCPv6/DAD-Anzeige     | 4     | fertig                                      | `web e2e › phase4`, `web e2e › gaps`                    |

## Spätere Phasen (Auszug)

| Feature                                                                     | Phase | Status | Test |
| --------------------------------------------------------------------------- | ----- | ------ | ---- |
| IPv4-Routing, Router, statische Routen, TTL, Fragmentierung                 | 2     | offen  | –    |
| CLI-Framework (Modi, `?`, Tab, Abkürzungen), `running-config`-Renderer      | 2     | offen  | –    |
| Desktop (IP-Config, Command Prompt), Animation, PDU-Inspektor (voll)        | 2     | offen  | –    |
| Wireless, Server-Dienste, Firewall, IoT, Physical View                      | 5     | offen  | –    |
| `.nsim`, Autosave, Undo/Redo, Vorlagen, Scripting, Aufgabenmodus, Multiuser | 6     | offen  | –    |
