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
