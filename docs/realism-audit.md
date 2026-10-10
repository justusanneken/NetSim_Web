# Realismus-Audit gegen CCNA 200-301 / ENCOR

Stand: Branch `wip/wan`. Status: **ok** (IOS-nah vorhanden), **neu** (in diesem Pass umgesetzt), **Lücke** (fehlt, Befehl wird mit `% Invalid input` abgelehnt), **vereinfacht** (siehe `docs/simplifications.md`).

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
