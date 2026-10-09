# CLI-Befehlsreferenz (Stand Phase 2)

Modi: User EXEC `R>` · Privileged EXEC `R#` · Global Config `R(config)#` · Interface `R(config-if)#` ·
Line `R(config-line)#`. `?` zeigt die Folgeoptionen, Tab vervollständigt, Befehle dürfen eindeutig
abgekürzt werden. `no`/`default` stehen bei allen als _negatable_ gekennzeichneten Befehlen zur Verfügung.
`do <exec-Befehl>` führt Privileged-Befehle im Konfigurationsmodus aus. Pipes: `| include|exclude|begin|section|count <regex>`.

## EXEC (User und Privileged)

| Befehl                                                                                     | Zweck                                                                              |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `enable` / `disable` / `exit` / `logout`                                                   | Modus wechseln, Sitzung beenden                                                    |
| `ping [A.B.C.D [repeat N] [size N] [df-bit]]`                                              | Echo; ohne Argument: erweiterter Dialog (Ziel, Anzahl, Größe, Timeout, Quelle, DF) |
| `traceroute A.B.C.D`                                                                       | Pfad (3 Sonden je Hop)                                                             |
| `terminal length N` · `terminal history size N` · `terminal monitor`                       | Terminal-Parameter                                                                 |
| `show version` · `show clock` · `show history`                                             | System                                                                             |
| `show ip interface brief` · `show interfaces [IF]` · `show interfaces status`              | Schnittstellen                                                                     |
| `show ip route [A.B.C.D]` · `show ip arp` (Router)                                         | Routing/ARP                                                                        |
| `show mac address-table` (Switch) · `clear mac address-table dynamic` (Switch, privileged) | MAC-Tabelle                                                                        |

## Privileged

| Befehl                                                                                         | Zweck                                   |
| ---------------------------------------------------------------------------------------------- | --------------------------------------- |
| `configure [terminal]`                                                                         | Konfigurationsmodus                     |
| `show running-config` · `show startup-config`                                                  | Konfiguration                           |
| `copy running-config startup-config` · `copy startup-config running-config` · `write [memory]` | Speichern/Laden                         |
| `erase startup-config` · `reload`                                                              | Löschen, Neustart (lädt Startup-Config) |

## Global Config

| Befehl                                          | negatable | Zweck                             |
| ----------------------------------------------- | --------- | --------------------------------- |
| `hostname NAME`                                 | ja        | Hostname                          |
| `enable secret PW` / `enable secret 5 HASH`     | ja        | Privileged-Passwort (gehasht)     |
| `enable password PW` / `… 7 ENC`                | ja        | Klartext-/Typ-7-Passwort          |
| `service password-encryption`                   | ja        | Typ-7-Verschleierung beim Rendern |
| `banner motd #text#` (auch mehrzeilig)          | ja        | Login-Banner                      |
| `ip domain-name NAME` · `ip domain-lookup`      | ja        | Namensdienst-Einstellungen        |
| `ip route NET MASK (NEXTHOP｜IF) [AD]` (Router) | ja        | statische Route / Floating Static |
| `interface IF`                                  |           | Interface-Modus                   |
| `line console 0` · `line vty A [B]`             |           | Line-Modus                        |
| `service timestamps …` · `version V`            | (ja)      | akzeptiert (ohne Wirkung)         |

## Interface

| Befehl                                                      | negatable | Zweck                                          |
| ----------------------------------------------------------- | --------- | ---------------------------------------------- |
| `ip address A.B.C.D MASK` (Router)                          | ja        | IPv4-Adresse (Überlappungs-/Netzadressprüfung) |
| `ip mtu N` (Router) · `mtu N`                               | ja        | MTU                                            |
| `shutdown`                                                  | ja        | administrativ aus/an (mit `%LINK`-Meldungen)   |
| `description TEXT`                                          | ja        | Beschreibung                                   |
| `speed (auto｜10｜100｜1000)` · `duplex (auto｜full｜half)` | ja        | Port-Einstellungen                             |

## Line

`password PW` (auch `7 ENC`), `login`, `exec-timeout`, `logging synchronous` (die letzten beiden ohne Wirkung).

## Windows-Eingabeaufforderung (Hosts)

`ping [-n N] [-l SIZE] [-f] ZIEL`, `tracert [-h N] ZIEL`, `ipconfig [/all]`, `arp -a`, `cls`, `help`.
`ipconfig /release|/renew` (DHCP-Client), `nslookup NAME`, `ping NAME`.
`netstat`, `telnet`, `ssh`, `ftp`, `tftp` sind nicht verfügbar.

## Phase 3 – Switching, Dienste, Filter

**Global (Switch):** `vlan N` (+ `name`), `vtp mode|domain`, `spanning-tree mode (pvst|rapid-pvst)`,
`spanning-tree vlan N priority P`, `spanning-tree portfast default`, `errdisable recovery cause psecure-violation`,
`errdisable recovery interval S`, `mac address-table aging-time S`, `ip routing` (L3-Switch).

**Interface / `interface range A - B`:** `interface vlan N`, `interface port-channel N`, `switchport mode
(access|trunk|dynamic auto|dynamic desirable)`, `switchport access vlan N`, `switchport trunk native vlan N`,
`switchport trunk allowed vlan LIST|add|remove|all|none`, `switchport port-security [maximum|violation|mac-address
sticky|mac-address MAC]`, `spanning-tree portfast|bpduguard enable|guard root`, `channel-group N mode
(on|active|passive|desirable|auto)`, `no switchport` (L3-Switch), `encapsulation dot1Q N` (Subinterface),
`ip helper-address A`, `ip access-group NAME|N (in|out)`, `ip nat (inside|outside)`.

**Global (L3):** `ip dhcp pool/excluded-address`, `network`, `default-router`, `dns-server`, `lease`,
`access-list N (permit|deny) …`, `ip access-list (standard|extended) NAME` (+ Einträge, `no SEQ`), `ip nat pool`,
`ip nat inside source (list|static) …`, `ip nat translation timeout S`.

**Show:** `vlan [brief|id N]`, `interfaces trunk|switchport|status`, `spanning-tree [vlan N|summary]`,
`etherchannel summary`, `port-security [interface X]`, `vtp status`, `ip dhcp binding|pool|conflict`,
`access-lists [NAME]`, `ip nat translations|statistics`, `ip interface [brief]`, `ip route`. `clear ip nat translation *`.

## Phase 4 – Routing, HSRP, GRE, IPv6, Debug

**Prozesse:** `router rip|ospf N|eigrp N|bgp N`, `ipv6 router ospf N` (Untermodi mit `(config-router)#`).

- RIP: `version 2`, `network A`, `passive-interface IF|default`, `[no] auto-summary`, `default-information originate`, `default-metric N`, `timers basic u i h f`, `redistribute SRC [ID] [metric M]`.
- OSPF: `router-id`, `network A WILDCARD area N`, `passive-interface`, `auto-cost reference-bandwidth M`, `default-information originate [always] [metric M] [metric-type T]`, `redistribute … [metric M] [metric-type T] [subnets]`, `area N range A MASK [not-advertise]`.
- EIGRP: `network A [WILDCARD]`, `eigrp router-id`, `passive-interface`, `[no] auto-summary`, `variance`, `redistribute … metric BW DLY REL LOAD MTU`.
- BGP: `bgp router-id`, `neighbor A remote-as N|update-source IF|ebgp-multihop [N]|next-hop-self|shutdown|description|weight`, `network A mask M`, `redistribute …`, `bgp default local-preference`.

**Schnittstelle:** `interface loopback N`, `interface tunnel N` (`tunnel source|destination|mode gre ip`), `bandwidth`, `delay`, `ip ospf PID area A`, `ip ospf cost|priority|hello-interval|dead-interval|network`, `ipv6 ospf …`, `standby G ip|priority|preempt|timers|track|name`, `ipv6 enable|address X/L [eui-64]|address autoconfig|nd ra suppress`.
**Global:** `ipv6 unicast-routing`, `ipv6 route PREFIX/L NEXTHOP|IF [IF] [AD]`.

**Show:** `ip protocols`, `ip route [rip|ospf|eigrp|bgp|static|connected]`, `ip rip database`, `ip ospf [neighbor|interface [brief]|database [router|network|summary|asbr-summary|external]]`, `ip eigrp neighbors|topology|interfaces`, `standby [brief]`, `ip bgp [summary|neighbors]`, `ipv6 route|interface [brief]|neighbors|protocols|ospf …`, `debugging`.
**Clear:** `clear ip ospf process`, `clear ip bgp *`, `clear ip route *`.
**Debug:** `debug ip rip`, `debug ip ospf events|adj|hello|packet|spf|lsa-generation`, `debug eigrp packets|fsm|neighbors`, `debug standby`, `debug ip bgp`, `debug ip routing`, `debug tunnel`, `debug all`, `undebug all`, `no debug …`. Ausgaben erscheinen asynchron im Terminal.
**Ping:** `ping ipv6 X`, `ping X` mit IPv6-Adresse; Host-Shell: `ping <IPv6>`, `ipconfig` zeigt Link-Local und IPv6.

## Phase 5 – Management, Fernzugriff, Firewall

**Global:** `username N [privilege L] (secret|password) PW`, `ip domain-name D`, `crypto key generate rsa [modulus B]` /
`crypto key zeroize rsa`, `ip ssh version 1|2`, `ntp server A`, `ntp master [N]`, `logging host A`, `logging trap LEVEL`,
`logging buffered`, `snmp-server community C ro|rw`, `snmp-server location|contact TEXT`, `aaa new-model`,
`aaa authentication login LIST group radius [local] | local`, `radius-server host A key K`, `line vty 0 N` (Anzahl der Leitungen).
**Line (vty):** `transport input all|none|ssh|telnet [ssh|telnet]`, `login local`, `login authentication LIST`, `login`, `password`.
**Exec:** `telnet A`, `ssh -l USER A` (öffnet eine Remote-CLI-Sitzung, `exit` kehrt zurück), `clock set hh:mm:ss D Mon YYYY`,
`terminal monitor` (Debug-Ausgabe auch auf vty), `copy running-config|startup-config tftp:[//HOST/DATEI]`,
`copy tftp:[//HOST/DATEI] running-config|startup-config`.
**Show:** `clock`, `ntp status|associations`, `users`, `ssh`, `ip ssh`, `logging`, `snmp`, `aaa`, `crypto key mypubkey rsa`.
**Host-Shell:** `telnet H`, `ssh -l U H`, `ftp H` (`dir`, `get`, `put`, `delete`, `quit`), `tftp -i H GET|PUT DATEI`, `time`, `w32tm /resync`,
`echo TEXT > DATEI`, `type`, `dir`, `del`.

**Firewall (nur Gerätetyp Firewall):** Schnittstelle: `nameif NAME`, `security-level N`. Global:
`access-list NAME extended permit|deny PROTO SRC [PORT] DST [PORT]` (`any`, `host A`, `A MASK`, `eq|neq|lt|gt|range`),
`access-group NAME in interface NAMEIF`, `same-security-traffic permit inter-interface`,
`object network NAME` → `subnet A M` | `host A`, `nat (A,B) dynamic interface | static MAPPED`.
**Show:** `conn`, `xlate`, `nameif`.

## Lücken-Erweiterungen (Phasen 1–4)

**ECMP:** `maximum-paths N` in `router rip|ospf|eigrp|bgp` (IGPs Default 4, BGP 1); `show ip route` zeigt gleichwertige Pfade als weitere `via`-Zeilen, `show ip route A.B.C.D` mehrere Descriptor Blocks mit `traffic share count`.

**Prefix-Lists / Route-Maps:** `ip prefix-list NAME [seq N] (permit|deny) A.B.C.D/L [ge N] [le N]` (auch `ipv6 prefix-list`), `ip community-list standard NAME (permit|deny) AA:NN …`,
`route-map NAME [permit|deny] [SEQ]` mit `match ip address [prefix-list] NAME…`, `match ip next-hop prefix-list`, `match tag|metric|community`,
`set local-preference|metric [BW DLY REL LOAD MTU]|metric-type type-1|type-2|tag|weight|as-path prepend ASNs|community VALUES [additive|none]|ip next-hop A|origin`.
`redistribute … route-map NAME` (RIP/OSPF/EIGRP/BGP/RIPng/OSPFv3), `distribute-list (ACL|prefix NAME) (in|out) [IF]` in RIP/EIGRP/OSPF (nur `in`)/RIPng.
**Show:** `show ip prefix-list [NAME]`, `show ipv6 prefix-list`, `show route-map [NAME]`, `show ip community-list`.

**OSPF:** `area N stub [no-summary]`, `area N nssa [no-summary] [default-information-originate]`, `area N default-cost C`, `area N authentication [message-digest]`,
`area N virtual-link RID`; Schnittstelle: `ip ospf authentication [message-digest|null]`, `ip ospf authentication-key KEY`, `ip ospf message-digest-key ID md5 KEY`.
**Show:** `show ip ospf` (Bereichstypen), `show ip ospf virtual-links`. Routen: `O IA`, `O E1/E2`, `O N1/N2`, Default als `O*IA`/`O*E2`.

**EIGRP:** `variance N` wirkt (ungleiche Lastverteilung), `maximum-paths`, Stuck-in-Active nach 3 min (Meldung `eigrp.sia`).

**HSRP:** `standby version 1|2`, Gruppen 0–4095 (> 255 nur mit Version 2), `standby G authentication KEY`, `standby G ipv6 autoconfig|X:X::X` (nur Version 2).
`show standby [brief]` zeigt Version, virtuelle MAC, Authentifizierung und IPv6-Gruppen.

**BGP:** `neighbor A prefix-list NAME in|out`, `neighbor A route-map NAME in|out`, `neighbor A send-community`, `neighbor A route-reflector-client`,
`neighbor A soft-reconfiguration inbound` (ohne Wirkung nötig), `bgp cluster-id A.B.C.D`, `address-family ipv6` (`neighbor A activate`, `network X::/L`, `exit-address-family`).
**Show:** `show ip bgp A.B.C.D` (Pfaddetails mit Communities, Originator/Cluster-List), `show bgp ipv6 unicast [summary]`.

**IPv6:** `ipv6 dhcp pool NAME` (`address prefix P/L [lifetime A B]`, `dns-server`, `domain-name`), Schnittstelle: `ipv6 dhcp server NAME`, `ipv6 nd managed-config-flag|other-config-flag`;
`ipv6 router rip NAME` (`default-information originate`, `default-metric`, `poison-reverse`, `timers u i h f`, `passive-interface`, `redistribute`, `distribute-list`, `maximum-paths`),
Schnittstelle `ipv6 rip NAME enable`; `redistribute connected|static|rip|ospf|bgp …` in `ipv6 router ospf`; `traceroute ipv6 X` bzw. `traceroute X::`.
**Show:** `show ipv6 dhcp pool|binding`, `show ipv6 rip [NAME]`, `show ipv6 interface` (Adressen in DAD als `[TEN]`, Duplikate als `[DUP]`).
**Host-Shell:** `tracert <IPv6>`, `ipconfig /all` (DHCPv6, IPv6-DNS, `(Preferred)/(Tentative)/(Duplicate)`), `ipconfig /renew6`, `ipconfig /release6`.

**Uhr:** `clock set HH:MM:SS DAY MONTH YEAR` (auch `MONTH DAY`) im privilegierten Modus; `show clock` und `debug`-Zeitstempel folgen der gesetzten Uhr.

## TCP-Anzeige und BGP-Änderungen

**Show (Router/Switch/Firewall):** `show tcp brief` (TCB, lokale/entfernte Adresse.Port, Zustand `ESTAB`/`SYNSENT`/`CLOSEWAIT`/`CLOSED`; Telnet 23, SSH 22, BGP 179 …).
**BGP:** `no neighbor A` und `neighbor A shutdown` senden eine Cease-NOTIFICATION; `show ip bgp summary` zeigt `Idle`, `Active` (TCP-Verbindung scheitert/wartet) oder `Connect`.
`show ip route` zeigt BGP-Routen mit dem BGP-Next-Hop (`B 10.4.0.0/24 [200/0] via 3.3.3.3, 00:02:19`).
Telnet/SSH: fällt der Pfad während der Sitzung aus, endet sie nach ≈ 31 s mit `% Connection timed out; remote host not responding`.
