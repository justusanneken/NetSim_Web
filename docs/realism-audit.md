# Realismus-Audit (IOS-Nähe)

Abgleich des Simulators mit den Cisco-CCNA-200-301-Themen und üblicher Laborpraxis. Status je Thema:
**vorhanden** · **teilweise** · **fehlt**. „neu“ = in dieser Runde (Branch `wip/ccna`) ergänzt.

## CCNA: Switching/Security/Services

### LAN-Switching (Domäne 2: Network Access)

| Thema                                             | Status                          | Befund                                                                                                                                                                                                     |
| ------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VLANs (Normalbereich), `show vlan brief`, VTP     | vorhanden                       | `vlan N`/`name`, VTP server/client/transparent. Erweiterter Bereich, `vlan.dat` fehlt.                                                                                                                     |
| Access-/Trunk-Ports, 802.1Q, Allowed-/Native-VLAN | vorhanden                       | `show interfaces trunk` zeigt jetzt `on`/`desirable`/`auto` wie IOS.                                                                                                                                       |
| Native-VLAN-Mismatch-Meldung                      | teilweise (neu)                 | `%CDP-4-NATIVE_VLAN_MISMATCH` über CDP-Native-VLAN; die STP-Meldung `%SPANTREE-2-RECV_PVID_ERR` fehlt.                                                                                                     |
| DTP (`dynamic auto/desirable`)                    | vorhanden                       | Aushandlung in `refreshSwitches`.                                                                                                                                                                          |
| `switchport nonegotiate`                          | vorhanden (neu)                 | Wirkt (Nachbar im Modus `dynamic` bleibt Access); mit `dynamic`-Modus abgelehnt wie IOS („Conflict between 'nonegotiate' and 'dynamic' status“).                                                           |
| Voice-VLAN                                        | teilweise (neu)                 | `switchport voice vlan N`: getaggte Voice-Frames auf Access-Ports, Weiterleitung getaggt. `dot1p`/`untagged` nur Konfiguration; keine IP-Phone-Geräte, kein CDP-Phone-Handshake, kein PoE.                 |
| Spanning Tree PVST+/Rapid PVST+                   | vorhanden                       | Root primary/secondary, Priority, Rollen/Zustände, `show spanning-tree`.                                                                                                                                   |
| PortFast, BPDU Guard, Root Guard                  | vorhanden                       | Neu: `spanning-tree portfast default`, `portfast bpduguard default`, `portfast disable`, `bpduguard disable`, Syslog `%SPANTREE-2-BLOCK_BPDUGUARD`. Loop Guard/„root-inconsistent“-Zustand nur angenommen. |
| EtherChannel (LACP, PAgP, `on`)                   | teilweise                       | Bündelung nur bei kompatiblen Modi (`on/on`, `active/passive`, `desirable/auto`); Fehlkonfiguration bündelt nicht. Kein err-disable durch EtherChannel-Guard, kein `port-channel load-balance`.            |
| CDP                                               | vorhanden (neu)                 | `cdp run/timer/holdtime`, `cdp enable`, `show cdp [neighbors [detail]                                                                                                                                      | entry                                                                                                                                                                                     | interface          | traffic]`, `clear cdp`. Router und Switches, Hold-Time-Ablauf. |
| LLDP                                              | vorhanden (neu)                 | `lldp run/timer/holdtime/reinit`, `lldp transmit/receive`, `show lldp [neighbors [detail]                                                                                                                  | entry                                                                                                                                                                                     | interface          | traffic]`; Standard aus wie IOS.                               |
| Port Security                                     | vorhanden (neu vervollständigt) | max, sticky, Verletzungsmodi, Aging (`aging time/type`), Syslog `%PORT_SECURITY-2-PSECURE_VIOLATION`, `show port-security [interface                                                                       | address]`, `clear port-security`.                                                                                                                                                         |
| err-disable / `errdisable recovery`               | vorhanden (neu)                 | Ursachen `psecure-violation`, `bpduguard`, `storm-control`, `dhcp-rate-limit`, `arp-inspection`, `all`; Intervall, `%PM-4-ERR_DISABLE`/`ERR_RECOVER`, `show errdisable recovery                            | detect`, `show interfaces status err-disabled`.                                                                                                                                           |
| DHCP Snooping                                     | vorhanden (neu)                 | Global/VLAN, `trust`, `limit rate`, Bindungstabelle (`show ip dhcp snooping [binding                                                                                                                       | statistics]`), `verify mac-address`, Option 82 (Standard an) mit IOS-Stolperstein: Server/Relay verwirft Option 82 ohne giaddr, außer `ip dhcp relay information trust-all`bzw.`trusted`. |
| Dynamic ARP Inspection                            | vorhanden (neu)                 | `ip arp inspection vlan/trust/limit rate/validate/filter`, `arp access-list`, `show ip arp inspection [interfaces]`, Syslog `%SW_DAI-4-*`, Rate-Limit mit err-disable. IP Source Guard fehlt.              |
| Storm Control                                     | teilweise (neu)                 | `storm-control broadcast                                                                                                                                                                                   | multicast                                                                                                                                                                                 | unicast level [pps | bps] …`, `action shutdown                                      | trap`, `show storm-control`; vereinfachtes 1-s-Fenster (siehe simplifications). |
| 802.1X / Port-based Auth                          | fehlt                           |                                                                                                                                                                                                            |
| Wireless (AP/WLC, CAPWAP, WPA2-PSK/Enterprise)    | teilweise                       | Funktional vorhanden (Phase 5); keine WLC-GUI/-CLI (`show wlan`, `config wlan …`) und kein Roaming.                                                                                                        |

### Netzwerkdienste (Domäne 4: IP Services)

| Thema                                                                      | Status                          | Befund                                                                                                                                                          |
| -------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NAT: statisch, dynamisch (Pool), Overload (Interface/Pool), statisches PAT | vorhanden                       | `show ip nat translations/statistics`.                                                                                                                          |
| DHCP-Server, Relay (`ip helper-address`), Exclusions                       | vorhanden                       | Konflikterkennung, Lease; neu: `ip address dhcp`, manuelle Bindungen, Statistik, `debug ip dhcp server`.                                                        |
| DHCPv6 (zustandslos/zustandsbehaftet, Server, Client)                      | vorhanden                       | `ipv6 dhcp pool`, RA-Flags M/O. `ipv6 dhcp relay destination` fehlt.                                                                                            |
| NTP (Client, Server, `ntp master`)                                         | vorhanden                       | Neu: `ntp authenticate`, `authentication-key … md5`, `trusted-key`, `ntp server … key N` (unauthentifizierte/falsch authentifizierte Quellen werden abgelehnt). |
| Syslog                                                                     | vorhanden (neu vervollständigt) | `logging buffered [size] [level]`, `logging console                                                                                                             | monitor [level]`, Pufferfilter nach Schweregrad, `show logging` im IOS-15-Layout; neue Meldungen (PM, SPANTREE, PORT_SECURITY, DHCP_SNOOPING, SW_DAI, STORM_CONTROL, CDP). |
| SNMP v2c                                                                   | vorhanden                       | Communities, Traps.                                                                                                                                             |
| SNMP v3                                                                    | teilweise (neu)                 | `snmp-server group/user … v3`, `show snmp group                                                                                                                 | user`; Konfiguration und Anzeige, keine v3-Nachrichtenauthentifizierung im Simulator.                                                                                      |
| QoS                                                                        | teilweise (neu)                 | `class-map` (`match dscp                                                                                                                                        | access-group                                                                                                                                                               | protocol | any`), `policy-map` (`set dscp`, `bandwidth`, `priority`, `police`, …), `service-policy input | output`, DSCP im IP-Header (Inspektor), `show class-map | policy-map [interface]` mit Zählern. Keine Warteschlangen/Scheduling, kein Policing. |
| HSRP/FHRP, IPsec, GRE                                                      | wan                             | siehe Abschnitt Routing/WAN.                                                                                                                                    |

### Sicherheitsgrundlagen (Domäne 5)

| Thema                                                                                | Status                          | Befund                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACLs: standard/extended, nummeriert/benannt, Trefferzähler                           | vorhanden                       | `show access-lists` mit „(N matches)“. ICMP-Typen werden beim Parsen ignoriert (teilweise).                                                                                                 |
| ACL-`remark`                                                                         | vorhanden (neu)                 | Speicherung, Rendering vor dem Eintrag, Replay; nummeriert und benannt.                                                                                                                     |
| `ip access-list resequence`                                                          | vorhanden (neu)                 |                                                                                                                                                                                             |
| IPv6-ACLs (`ipv6 access-list`, `ipv6 traffic-filter`)                                | vorhanden (neu)                 | Implizites Erlauben von ND (wie IOS), implizites `deny`, Sequenz am Zeilenende, `show ipv6 access-list`, ICMPv6 „administratively prohibited“.                                              |
| AAA (RADIUS, TACACS+, lokale Benutzer)                                               | vorhanden                       |                                                                                                                                                                                             |
| SSH-Einrichtung                                                                      | vorhanden (neu vervollständigt) | `ip domain-name` Pflicht vor `crypto key generate rsa modulus N` (Meldung mit korrekter Bitzahl), Standard-SSH-Version **1.99** bis `ip ssh version 2`, `ip ssh time-out                    | authentication-retries`, `login local`, `transport input ssh`, `exec-timeout`. |
| Kennwörter: `enable secret`, `service password-encryption`, `banner motd`            | teilweise                       | Typ 7 echt (umkehrbar); `enable secret 5` ist ein deterministischer Pseudo-MD5-Hash (fester Salt `mERr`), `username … secret` wird als Typ 7 hinter „secret 5“ gerendert (nicht IOS-genau). |
| Standard-Härtung (`no ip http server`, `login block-for`, `ip access-class` auf vty) | fehlt                           |                                                                                                                                                                                             |

### IPv6 (Domäne 1: Network Fundamentals)

| Thema                                                        | Status          | Befund                    |
| ------------------------------------------------------------ | --------------- | ------------------------- |
| Link-Local, EUI-64, `ipv6 enable`, Autokonfiguration (SLAAC) | vorhanden       |                           |
| Statische Routen (Default, Floating mit AD)                  | vorhanden       | `ipv6 route ::/0 NH 200`. |
| IPv6-ACLs                                                    | vorhanden (neu) | s. o.                     |
| DHCPv6-Relay                                                 | fehlt           |                           |

## Routing/WAN/VPN/Troubleshooting

Methode: jede Funktion der Liste wurde gegen die Befehlsdefinitionen (`packages/cli/src`) und die Engine (`packages/engine/src/routing`, `l3.ts`) geprüft; die Befehle wurden in einem Router-Lauf einzeln eingegeben.

### Serial-WAN

| Thema                                                                                                            | Status                                                    |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Serial-Ports (HWIC-2T), Namen `Serial0/<slot>/<n>`, `interface serial`                                           | neu (vorher hießen sie `Serial1/0`, CLI kannte sie nicht) |
| HDLC als Default, `encapsulation ppp`, Kapselungs-Mismatch hält Line-Protocol down                               | neu                                                       |
| `clock rate` nur am DCE, Fehlermeldung am DTE, fehlender Takt ⇒ up/down                                          | neu                                                       |
| PPP mit PAP/CHAP (`ppp authentication`, `ppp chap hostname/password`, `ppp pap sent-username`)                   | neu                                                       |
| `show interfaces serial`, `show controllers [serial]` (DCE V.35 / DTE clocks), `show ip interface brief` up/down | neu                                                       |
| `debug ppp negotiation/authentication`                                                                           | neu (verkürzte Sequenz)                                   |
| Serial-Bandbreite 1544 kbit/s (OSPF-Kosten 64, EIGRP-Delay 20000 µs), OSPF-Default `POINT_TO_POINT`              | neu                                                       |
| Frame Relay, Multilink PPP, PPP-Keepalive/Echo, `ppp quality`, T1/E1-Controller, `loopback`                      | Lücke                                                     |
| PPPoE (Dialer, Virtual-Template)                                                                                 | ok, `show interfaces dialer N` neu                        |

### Statische Routen und Routing-Tabelle

| Thema                                                                                                          | Status                       |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `ip route` mit Next-Hop, Interface, AD (Floating Static)                                                       | ok                           |
| `Null0`, Interface + Next-Hop, `name`, `tag`, `permanent`, Ersetzen bei erneuter Eingabe                       | neu                          |
| `show ip route` Legende, `S*`, Subnetted-Kopfzeilen, ECMP-Zeilen                                               | ok                           |
| `show ip route <addr>` mit `Known via`, `Last update from`, Descriptor Blocks, OSPF/EIGRP-Typ                  | neu                          |
| `show ip route <addr> <mask>` (`% Subnet not in table`)                                                        | neu                          |
| Longest-Prefix-Match, Default-Route, `Gateway of last resort`                                                  | ok                           |
| `show ip route summary`, `longer-prefixes`, `ip classless`, `ip default-network`, `track` an statischen Routen | Lücke                        |
| `show ip cef`, `show adjacency`                                                                                | Lücke (CEF nicht modelliert) |

### OSPF

| Thema                                                                                                                                                                                        | Status                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Nachbarschaft, DR/BDR, Prioritäten, `ip ospf priority 0`, Hello/Dead-Intervalle (Mismatch verhindert Adjazenz), Kosten, `auto-cost reference-bandwidth`                                      | ok                                                |
| `ip ospf network broadcast/point-to-point`, passive-interface (auch `default`), `default-information originate [always]`, MD5/Klartext-Authentifizierung, Virtual Links, Stub/NSSA           | ok                                                |
| `show ip ospf interface [brief\|IF]` mit Kosten, Network Type, Timer, Hello due, Nachbarn                                                                                                    | neu (vorher fehlten Argument und echte Kosten)    |
| `show ip ospf neighbor`: `FULL/  -`, Priorität 0 auf p2p, Dead Time nach Dead-Intervall                                                                                                      | neu (korrigiert)                                  |
| MTU-Mismatch ⇒ EXSTART, `ip ospf mtu-ignore`                                                                                                                                                 | neu                                               |
| `no area N stub no-summary` nimmt nur `no-summary` zurück                                                                                                                                    | neu                                               |
| `show ip ospf database` je LSA-Typ (router, network, summary, external)                                                                                                                      | ok; `nssa-external`, `asbr-summary` Detail: Lücke |
| `show ip ospf neighbor detail`, `border-routers`, `traffic`, `statistics`                                                                                                                    | Lücke                                             |
| `ip ospf network non-broadcast/point-to-multipoint`, `retransmit-interval`, `transmit-delay`, `summary-address`, `timers throttle spf`, `distance ospf`, `default-metric`, `max-metric`, BFD | Lücke                                             |

### EIGRP

| Thema                                                                                                                                                                                                                                                                  | Status |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Klassischer Modus, `network`, `no auto-summary`, `variance`, ECMP, passive-interface, Redistribution, `show ip eigrp neighbors/topology/interfaces`                                                                                                                    | ok     |
| `eigrp stub`, `ip hello-interval/hold-time eigrp`, `ip summary-address eigrp`, `ip authentication mode/key-chain`, `metric weights`, `distance eigrp`, `offset-list`, `eigrp log-neighbor-changes`, `show ip eigrp topology all-links`, `neighbors detail`, Named Mode | Lücke  |

### BGP

| Thema                                                                                                                                                                                                                                                                          | Status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| eBGP/iBGP, `network … mask`, `next-hop-self`, `update-source`, `ebgp-multihop`, Route-Maps (weight, local-pref, MED, prepend), Communities, Route Reflector, `show ip bgp` mit `*>`, `show ip bgp summary/neighbors`                                                           | ok     |
| `neighbor password`, `timers`, `default-originate`, `filter-list`/AS-Path-ACL, `maximum-prefix`, `remove-private-as`, Peer-Groups, `aggregate-address`, `bgp always-compare-med`/`deterministic-med`/`bestpath …`, `advertised-routes`/`received-routes`, `show ip bgp regexp` | Lücke  |

### FHRP

| Thema                                                                                                       | Status |
| ----------------------------------------------------------------------------------------------------------- | ------ |
| HSRP v1/v2, Priorität, Preempt, Tracking, Timer, Authentifizierung (Klartext), IPv6, `show standby [brief]` | ok     |
| `standby preempt delay`, MD5-Authentifizierung, `standby mac-address`, `follow`                             | Lücke  |
| VRRP, GLBP (`show vrrp`, `show glbp`)                                                                       | Lücke  |

### VPN

| Thema                                                                                                                                                                                            | Status |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| GRE-Tunnel, IPsec Site-to-Site mit Crypto Map, `show crypto isakmp/ipsec/map`                                                                                                                    | ok     |
| IPsec-VTI (`tunnel mode ipsec ipv4`, `crypto ipsec profile`, `tunnel protection`), SA-Lifetime/Rekey, DPD (`crypto isakmp keepalive`), IKEv2, `debug crypto isakmp/ipsec`, `show crypto session` | Lücke  |
| TACACS+: nur der erste Server wird befragt, kein Fallback auf den nächsten, keine Server-Gruppen                                                                                                 | Lücke  |

### Troubleshooting-Werkzeuge

| Thema                                                                                              | Status                                                                                     |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `ping` (Dialog, `repeat`, `size`, `df-bit`, Quelle), Symbole `! . U M &`, `traceroute` mit `* * *` | ok                                                                                         |
| `ping` ohne aktive Schnittstelle: `.....` und `Success rate is 0 percent` statt Roh-Schlüssel      | neu                                                                                        |
| `traceroute … source`, `!H`/`!N`-Symbole, `clear counters`, `show interfaces counters`             | Lücke                                                                                      |
| `show ip protocols`, `show ip interface` (kurz), `show interfaces` (Ethernet: Zähler, Duplex)      | vereinfacht; Ethernet-Ausgabe gehört zum Abschnitt L2                                      |
| `debug ip packet/icmp/tcp`, `debug ip eigrp`, `debug tacacs`, `debug aaa`, `debug standby`         | teils Lücke (`debug ip ospf …`, `debug ip rip`, `debug standby`, `debug ip bgp` vorhanden) |

### TCP

| Thema                                                                                                            | Status                                            |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Dreiwege-Handshake, ACKs, Retransmission, RST/FIN                                                                | ok (vereinfacht, siehe `docs/simplifications.md`) |
| Fenster/Slow Start, MSS-Option, TIME_WAIT, `show tcp brief [all]`, `show tcp` je Verbindung, `ip tcp adjust-mss` | Lücke                                             |

### Weitere Lücken aus `docs/simplifications.md`

SA-Lifetime/Rekey, DPD, VTI, PPP-Echo, TACACS+-Fallback, `debug crypto …`, `debug tacacs`, `show tcp brief all`, 16 vty-Leitungen auf Switches (Zeilenzahl ist konfigurierbar, aber `line vty 0 15` wird erst mit der ersten Eingabe angelegt) bleiben offen.
