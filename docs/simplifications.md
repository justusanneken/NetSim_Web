# Verbindliche Vereinfachungen (Stand Phase 1)

## Physik / Layer 1

- **Serialisierungszeit** = `ceil(Framegröße·8 / Mbit/s)` µs. Präambel und Inter-Frame-Gap werden nicht
  mitgezählt. Propagation konstant 5 µs je Link, Gerätebearbeitung 50 µs (alle konfigurierbar).
- **Kein Signalmodell:** Links sind digital up/down. Kabelfehler (falscher Typ, > 100 m) = down.
- **Geschwindigkeit:** `min(max. Portgeschwindigkeit, konfigurierte Geschwindigkeit)` beider Enden.
  Abweichende feste Einstellungen führen nicht zu einem Mismatch-Fehler, sondern zum Minimum.
  Fa = 100, Gi = 1000 Mbit/s. **Hub-Ports sind Fast-Ethernet (100 Mbit/s, Halbduplex)** statt echter 10 Mbit/s.
- **Duplex:** Halbduplex, sobald ein Ende `half` konfiguriert hat oder ein Hub beteiligt ist; sonst Vollduplex.

## Hub / CSMA/CD

- Der Hub wiederholt einen Frame **nach vollständigem Empfang** (nicht bitweise).
- Kollision = zeitliche Überlappung der Empfangsfenster am Hub (oder Eingang während der Wiederholung).
  Der Hub meldet sie als Jam an alle beteiligten Sender (nach einer Propagationszeit).
- Sender: 1-persistent Carrier Sense, Backoff nach _truncated binary exponential_ (Slot = 512 Bit-Zeiten,
  Jam = 32 Bit-Zeiten), maximal 16 Versuche, danach wird der Frame verworfen (`csma.excessive`).
- Eine beschädigte Wiederholung (Kollision während der Wiederholung) wird bei den Empfängern als Runt
  verworfen; der ursprüngliche Sender wird zum erneuten Senden veranlasst.
- Die Kollisionsdomäne wird als Zusammenhangskomponente über Hubs bestimmt (`Engine.collisionDomains()`).
  Kollisionen zwischen Punkt-zu-Punkt-Halbduplex-Partnern ohne Hub werden nicht modelliert.

## Ethernet / Switch

- Mindestframe 64 Byte inkl. FCS; kein Jumbo-/Baby-Giant-Modell, keine MTU-Prüfung (kommt mit Phase 2).
- MAC-Aging wird **lazy** beim Zugriff geprüft (kein Timer je Eintrag). Das beobachtbare Verhalten
  (Eintrag nach `agingSec` Sekunden ohne Quellverkehr ungültig) ist identisch.
- Switch arbeitet Store-and-Forward mit fester Verarbeitungszeit; alle Ports gehören zu VLAN 1
  (VLANs, STP etc. ab Phase 3).
- Link-Down eines Ports löscht seine dynamischen MAC-Einträge.

## ARP / IPv4 / ICMP (Host)

- ARP-Request/Reply, Gratuitous ARP (beim Setzen der IP), Duplicate-IP-Meldung; Cache-Timeout Host 2 min
  (lazy). Request für fremde IP wird verworfen (kein Proxy-ARP).
- ARP-Auflösung mit Warteschlange: 3 Anfragen im Sekundentakt, danach werden wartende Pakete verworfen.
- Der Echo-Request lehrt dem Empfänger die MAC des Senders (Antwort ohne eigenes ARP); echte Stacks
  verhalten sich ähnlich, weil der Absender vorher per ARP-Request gelernt wurde.
- Broadcast-Echo wird nicht beantwortet (wie Windows). TTL-Default 128. Keine Fragmentierung (Phase 2).
- Ein Gateway wird per ARP aufgelöst; es gibt noch keine Router (Phase 2) – ohne Antwort endet der Ping
  mit „Zielhost nicht erreichbar“.

## Phase 2 – IPv4, Router, ICMP

- **Fragmente tragen die Nutzlast-Referenz mit:** Jedes Fragment enthält (vereinfachend) eine Kopie des
  ICMP-Objekts, die Größe wird über `dataLen` bestimmt. Reassembly prüft die Abdeckung `[0, total)` über
  Offset/Länge; Fragmente werden 15 s lang gehalten (lazy beim nächsten Fragment bereinigt), dafür gibt es
  kein ICMP „Fragment Reassembly Time Exceeded“.
- **ICMP-Fehler** enthalten nur die Original-Adressen und ID/Seq des Echos (kein Byte-Auszug); es gibt keine
  Fehlermeldungen auf Fehlermeldungen oder auf Nicht-Erst-Fragmente. Keine ICMP-Redirects, kein Rate-Limit.
- **Routing:** Connected (`C`), Local (`L`, /32) und Static (`S`). Static-Routen mit Next-Hop werden nur
  installiert, wenn der Next-Hop in einem direkt verbundenen Netz liegt (keine rekursive Auflösung über
  andere Statics). Eine Route gleichen Präfixes und Next-Hops mit anderer AD ersetzt/ergänzt nicht (nur
  eindeutige Einträge). Connected-Routen verschwinden mit dem Link (operUp).
- **ARP-Cache Router:** 4 h (lazy), Host 2 min. Ein Paket ohne ARP-Antwort erzeugt am Router _Host
  Unreachable_ (Code 1) an den Absender, am Host die lokale Meldung „Destination host unreachable“ mit der
  eigenen Adresse (wie Windows).
- **TTL:** Host 128, Router 255 (ICMP-Fehler am Router ebenfalls 255).
- **Traceroute:** 3 Sonden je Hop nacheinander (Timeout 2 s je Sonde); Abbruch bei Ziel oder _Unreachable_.
- **Keine Wirkung auf Broadcast-Adressen:** Directed-Broadcast-Pings werden nicht beantwortet.

## Phase 2 – CLI

- **Befehle laufen im Vorlauf:** `ping`/`traceroute` (CLI und Command Prompt) simulieren synchron bis zum
  Ergebnis und schieben die virtuelle Zeit entsprechend vor. **Im Simulationsmodus** werden die Pakete nur
  eingereiht; die Ausgabe weist darauf hin, die Ereignisse im Simulationspanel durchzuschalten.
- **Passwörter:** `enable secret` speichert einen deterministischen Pseudo-Hash im Stil von `5 $1$mERr$…`
  (kein echtes MD5-crypt). Typ 7 (`service password-encryption`) ist die echte Vigenère-ähnliche Cisco-Typ-7-
  Verschleierung, aber mit festem Seed 8 statt zufälligem Seed. Passwörter von Lines/`enable password` liegen
  im Klartext im Konfigurationsbaum und werden nur beim Rendern verschleiert.
- **Startup-Config = Text:** `copy running-config startup-config` speichert den gerenderten Text.
  `reload` setzt Werkseinstellungen und spielt den Text durch einen unsichtbaren CLI-Parser ein (wie IOS).
  Ein Interface-Block ohne `shutdown` bedeutet beim Replay „aktiv“.
- **Router-Schnittstellen sind (wie bei IOS) standardmäßig `shutdown`.** Der Hostname des CLI ist von der
  Beschriftung des Icons getrennt (Standard: Name des Geräts).
- **Setup-Dialog:** wird bei Geräten ohne Startup-Config einmal angeboten und lässt sich mit `no`
  überspringen; `yes` wird mit einem Hinweis übersprungen (kein Assistent).
- **`--More--`** zeigt `terminalLength − 1` Zeilen je Seite (Default 24, `terminal length 0` = aus).
- **Nicht umgesetzt (Phase 3+):** `interface range`, Subinterfaces, `debug`, Mehrfach-Sessions, Telnet/SSH,
  `clock set`, `show ip protocols`, Tab-Completion für Schnittstellennamen.

## Phase 2 – UI

- **Animation:** Pro neuem Log-Eintrag (Empfang/Verwurf) läuft ein Umschlag mit fester Dauer (700 ms) vom
  letzten zum aktuellen Gerät – nur im Simulationsmodus und nicht proportional zur virtuellen Zeit
  (erlaubte „sichtbare Skalierung“). Ein Klick auf den Umschlag wählt den Eintrag im Inspektor.
- **PDU-Inspektor:** zeigt die eingehende PDU je OSI-Schicht mit Feldtabellen und der erklärenden Meldung;
  Outbound-Ansicht und „Challenge Me“ folgen in Phase 6.

## Phase 3

- **STP:** 802.1D-Timer (Listening/Learning je 15 s, Max-Age 20 s) und vereinfachtes RSTP (Proposal/Agreement mit
  6-s-Rückfall); PVST je aktivem VLAN, kein MST, kein UplinkFast/BackboneFast (RSTP deckt das ab). Hello 2 s und
  1-s-Tick laufen als Hintergrund-Timer (`bg:`) und blockieren `runAll` nicht.
- **DTP/EtherChannel:** Aushandlung erfolgt durch Konfigurationsvergleich beider Enden, nicht durch DTP-/LACP-/PAgP-PDUs.
  Der Port-Channel-Hash nutzt Quell- und Ziel-MAC.
- **VTP:** nur v1/v2-Verhalten (Revision, Domäne, Server/Client/Transparent), ohne Pruning und Passwort.
- **Port-Security:** Verstöße zählen pro Frame; Sticky-Adressen erscheinen in der `running-config`.
- **Nicht umgesetzt:** SPAN, Storm-Control, DHCP-Snooping, DAI, UDLD, Private VLANs.
- **DHCP:** keine Option 82, kein BOOTP (DHCPv6 siehe Phase 4); Lease-Verlängerung bei T1 (50 %), Konflikterkennung per ARP-Probe.
- **TCP/HTTP:** vereinfachtes TCP (SYN/SYN-ACK, ein Request, Antwort + FIN, RST); keine Retransmission-Fenster, kein TLS
  (HTTPS ist nur ein Port-/Schemaflag). Seiten sind kurze Texte.
- **NAT:** Timeouts per `ip nat translation timeout` für UDP/TCP/IP gemeinsam (ICMP fest 60 s); ALG/FTP fehlt.
- **ACL:** `log`-Schlüsselwort wird akzeptiert, aber nicht gezählt; kein `object-group`, keine Zeitbereiche.

## Phase 4

- **Routing-Protokolle nutzen eigene PDU-Typen** (`RoutingPdu`); IP-Protokollnummern 89 (OSPF) und 88 (EIGRP) sind echt,
  **BGP läuft ohne TCP** direkt in IP-Paketen (Protokoll 6/Port 179 nur zur Anzeige) mit Keepalive/Hold-Timer und Retry alle 5 s.
- **Hintergrund-Timer:** Hello/Update/Keepalive laufen als `bg:`-Timer. Ohne Zeitfortschritt konvergiert nichts; die CLI wartet nur auf Vordergrundereignisse.
- **ECMP:** Lastverteilung je Fluss über einen deterministischen Hash (Quelle/Ziel); keine Per-Packet-Verteilung. `maximum-paths` gilt je Protokoll
  (IGPs 4, BGP 1), statische Routen mit gleicher AD bilden unbegrenzt ECMP. Ungleiche Lastverteilung (EIGRP-`variance`) verteilt gewichtet nach inverser Metrik.
  Die Routing-Tabelle (`show ip route`, GUI) zeigt nur die installierten Routen (niedrigste AD je Präfix); Floating Statics erscheinen erst bei Ausfall der besseren Route.
- **RIP:** nur v2. Redistribution ohne `metric`/`default-metric` ergibt wie bei IOS Metrik „unendlich“ (nichts wird angekündigt). Hold-down wird erzwungen
  (Updates mit gleicher/schlechterer Metrik anderer Nachbarn werden ignoriert); Ausnahme: derselbe Nachbar darf das Ziel mit unveränderter Metrik wieder anbieten.
  Ein weggefallenes lokales Ziel (z. B. LAN-Port down) wird mit Metrik 16 vergiftet angekündigt.
- **OSPF:** DBD in einem Paket je Richtung; DR/BDR werden über Router-IDs statt Schnittstellenadressen angezeigt; Network-LSA-ID = DR-Schnittstellenadresse;
  LSA-Alterung mit 30-min-Refresh; SPF-Verzögerung ≈ 1 ms. **Stub/Totally Stubby/NSSA** (Typ 7 mit P-Bit, Übersetzung durch den ABR mit der höchsten Router-ID,
  `no-summary`, `default-cost`, `default-information-originate`) sind umgesetzt; Forwarding-Adressen und Typ-7-Aggregation am ABR fehlen.
  **Virtual Links** laufen über Unicast-Pakete durch die Transit-Area (Kosten = SPF-Kosten zum Peer, feste Timer 10/40 s, keine eigenen Timer/Authentifizierung).
  **Authentifizierung** (`simple`/`md5`) ist ein Schlüsselvergleich: bei MD5 wird kein echter Hash berechnet, sondern ein Digest über den gemeinsamen Schlüssel
  verglichen; Nachrichten mit falschem/fehlendem Schlüssel werden mit `ospf.authFail` verworfen. Nur ein MD5-Schlüssel je Schnittstelle wird gesendet (der mit der kleinsten ID).
- **EIGRP:** Successor-Wahl mit Feasibility Condition; `variance` (Feasible Successors mit RD < FD und Distanz ≤ variance·FD) und ECMP; Stuck-in-Active nach 3 min
  (säumige Nachbarn werden zurückgesetzt, keine SIA-Query/-Reply-Phase). Reliable Transport mit einem unbestätigten Paket je Nachbar (RTO 2 s, 16 Versuche).
  EIGRP für IPv6 fehlt.
- **HSRP:** vereinfachte Zustandsmaschine (Listen → Speak → Standby/Active), Hello 3 s/Hold 10 s, keine Coup/Resign-Pakete. Version 2 (Gruppen 0–4095, `0000.0c9f.fXXX`,
  224.0.0.102), Klartext-Authentifizierung (Default `cisco`, kein MD5) und HSRP für IPv6 (vMAC `0005.73a0.0XXX`, `ff02::66`, ND-Antworten der virtuellen Adresse) sind vorhanden.
  IPv4- und IPv6-Gruppen gleicher Nummer teilen Priorität/Preempt/Timer/Tracking in der CLI, haben aber getrennte Zustände.
- **BGP:** Prefix-Lists, Route-Maps (`match` Prefix-List/ACL/Community/Tag/Metrik, `set` local-preference/metric/weight/as-path prepend/community/next-hop), Communities (inkl. `no-export`,
  `no-advertise`), Route Reflector (Originator-ID, Cluster-List, Cluster-ID) und IPv6-Adressfamilie (MP-BGP vereinfacht im selben Update über IPv4-Sitzungen) sind vorhanden.
  Nicht umgesetzt: AS-Path-Regex-Listen (`ip as-path access-list`), Peer-Groups, Confederations, Aggregation, Dampening; Eingangs-Policy wird bei jeder Neuberechnung auf die unveränderte Adj-RIB-In angewandt
  (wirkt sofort, wie mit `soft-reconfiguration inbound`). Unbekannte Route-Map-/Prefix-List-Namen erlauben alles. eBGP ohne Multihop nur direkt verbunden (Fast-External-Fallover).
- **Route-Maps/Filter:** `redistribute … route-map` (alle Protokolle), `distribute-list` (ACL/Prefix-List, in/out für RIP, EIGRP, RIPng, in für OSPF); keine `match interface`/`match ip route-source`,
  kein `set ip next-hop` bei Redistribution.
- **IPv6:** Duplicate Address Detection (eine Probe, 1 s) mit Zustand `tentative/ok/dup` je Adresse; tentative Adressen sind nicht nutzbar. DHCPv6 (Solicit/Advertise/Request/Reply,
  Information-Request, IA_NA mit Sequenzvergabe aus `address prefix`; DUID = MAC; keine Renew/Rebind-Timer, keine Präfixdelegation, kein Relay). DNS-Server aus DHCPv6 werden gespeichert
  und angezeigt, die Namensauflösung nutzt weiterhin IPv4-DNS. Traceroute (Router `traceroute ipv6`, Host `tracert`). RIPng (ohne ECMP-Zusatzpfade) und OSPFv3-Redistribution
  (connected/static/andere IPv6-Protokolle). Keine Fragmentierung (zu große Pakete werden verworfen); EIGRP für IPv6 fehlt. OSPFv3 nutzt dieselbe LSDB-Struktur wie v2 (Präfixe in Router-LSAs).
- **Uhr:** `clock set` setzt die Gerätezeit; `show clock` und `debug`-Zeitstempel folgen ihr (ohne gesetzte Uhr `*Mar  1 1993` wie bei IOS). Zeitangaben in `show ip dhcp binding` nutzen weiterhin eine feste Basis.
- **Debug-Ausgabe:** Zeitstempel aus virtueller Zeit; Meldungstexte sind englisch, nicht übersetzt.
