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
- **RIP:** nur v2, Metrik der Redistribution Default 1 (IOS: unendlich), Hold-down wird nicht erzwungen (nur Invalid/Flush).
- **OSPF:** DBD in einem Paket je Richtung; DR/BDR werden über Router-IDs statt Schnittstellenadressen angezeigt; Network-LSA-ID = DR-Schnittstellenadresse; LSA-Alterung mit 30-min-Refresh; kein ECMP, keine Stub/NSSA-Areas, keine Authentifizierung. SPF-Verzögerung ≈ 1 ms.
- **EIGRP:** Successor-Wahl mit Feasibility Condition; Reliable Transport mit einem unbestätigten Paket je Nachbar (RTO 2 s, 16 Versuche); `variance` wird gespeichert, aber nicht ausgewertet.
- **HSRP:** vereinfachte Zustandsmaschine (Listen → Speak → Standby/Active), Hello 3 s/Hold 10 s, keine Coup/Resign-Pakete.
- **BGP:** Bestpath ohne Weight-/Community-Politik, keine Route-Maps/Filter, iBGP nur Full Mesh; eBGP ohne Multihop nur direkt verbunden (Fast-External-Fallover).
- **IPv6:** keine Duplicate Address Detection, kein DHCPv6, keine Fragmentierung (zu große Pakete werden verworfen), kein Traceroute; Redistribution und EIGRP/RIPng/BGP für IPv6 fehlen. OSPFv3 nutzt dieselbe LSDB-Struktur wie v2 (Präfixe in Router-LSAs).
- **Debug-Ausgabe:** Zeitstempel aus virtueller Zeit (`*Mar  1 …`); Meldungstexte sind englisch, nicht übersetzt.

## Phase 5

- **WLAN:** kein Funkphysikmodell. Ein Client wird assoziiert, wenn SSID und Schlüssel passen, das Band unterstützt wird
  und der Canvas-Abstand die Reichweite nicht überschreitet (2,4 GHz 260 px, 5 GHz 170 px; 5 GHz wird bevorzugt). Je Radio
  ein SSID; Kanäle beeinflussen sich nicht. Assoziation = ein dynamisch gelegter Link (`wireless`, 54 Mbit/s) zwischen
  einem Funk-Steckplatz des AP (8 Stück) und der WLAN-Karte; Authentifizierung/Assoziation erscheinen als Log-Einträge
  (keine 802.11-Frames/Beacons). Roaming: Wechsel erst, wenn der neue AP deutlich näher ist (< 70 % der Entfernung).
  WPA2-Enterprise/802.1X fehlt.
- **Physical View:** Entfernung für die Funkreichweite = Canvas-Abstand; liegen beide Geräte in der Physical View, gilt:
  anderes Gebäude/andere Stadt = außer Reichweite, anderer Raum = + 120 px „Wandabschlag“. Keine Kabellängen/Dämpfung,
  keine maßstäbliche Darstellung.
- **WLC:** vereinfachtes CAPWAP (UDP 5246): der AP fragt den WLC periodisch (30 s) und übernimmt dessen WLANs; Roaming
  zwischen APs ohne Controller-Koordination. Kein Lightweight-Tunneling der Nutzerdaten (der AP bridged lokal).
- **Dienst-Transport:** Anwendungen (FTP, SMTP, POP3, Telnet, SSH) laufen über vereinfachte TCP-Verbindungen mit
  strukturierten `svc`-Nachrichten (SYN/SYN-ACK mit Banner, Anfrage/Antwort mit PSH/ACK, FIN); keine Fenster,
  Retransmission nur für das SYN (3 Versuche à 1 s) und ein 8-s-Anfrage-Timeout. TFTP, NTP, Syslog, SNMP, RADIUS, IoT und
  CAPWAP sind UDP-Anfrage/Antwort (5 s Timeout, keine Wiederholung). Inhalte (Dateien, Mails) sind Textzeichenketten.
- **Telnet/SSH:** Erreichbarkeit, Port (23/22), `transport input`, Login (Passwort/lokal/AAA) laufen über das simulierte Netz
  und damit durch ACLs/Firewalls/NAT. Die Sitzung selbst (Tastatur/Ausgabe) wird nicht paketiert, sondern als CLI-Sitzung des
  Zielgeräts im Worker an das Terminal gehängt; bricht der Pfad während der Sitzung ab, läuft sie weiter. SSH-Schlüssel sind
  simuliert (Modulgröße wird gespeichert; Voraussetzung: `ip domain-name` + `crypto key generate rsa`). Maximal `line vty 0 N`
  Sitzungen (Standard 5); alle vty-Leitungen teilen sich eine Konfiguration (`transport`, `login`, Passwort).
- **Benutzer-Geheimnisse:** `username X secret Y` wird im Konfigurationsbaum im Klartext gehalten und als `secret 5 <Typ-7>`
  gerendert (umkehrbar, damit Replay/`reload` funktionieren); RSA-Schlüssel überstehen `reload` (NVRAM).
- **AAA:** nur Anmeldung an den vty-Leitungen (kein Console-/Enable-/Accounting-AAA, kein TACACS+). Methodenliste
  `group radius`/`local`; bei RADIUS-Timeout (3 s) wird die nächste Methode genutzt, bei explizitem Reject nicht.
- **NTP:** Anfrage/Antwort mit Zeitstempel (kein Offset-/Delay-Algorithmus, kein Stratum-Auswahlverfahren, keine Authentifizierung);
  Abfrage 2 s nach Konfiguration, dann alle 64 s. Gerätezeit = Epoch-Basis + virtuelle Zeit; Router starten am 1.3.1993,
  Hosts am 1.1.2026 12:00 UTC (deterministisch statt Wanduhr). Keine Zeitzonen/Sommerzeit (immer UTC).
- **Syslog:** Meldungen für Link-/Leitungsstatus, Konfigurationsänderung (`%SYS-5-CONFIG_I`) und Logins; Schweregrad-Filter
  (`logging trap`), Puffer 100 Zeilen. Keine Facility-Auswahl, kein `logging source-interface`.
- **SNMP:** v2c-ähnlich mit Community (kein v1/v3, keine Traps/Informs); MIB: system-Gruppe und ifTable-Spalten (Index, Descr, Type,
  Mtu, Speed, PhysAddress, Admin/Oper-Status, Zähler); `set` nur für `sysName.0` und `ifAdminStatus`.
- **Mail:** SMTP mit Absender-Authentifizierung gegen die Konten des Servers, nur lokale Zustellung (eine Domäne); POP3 liefert
  den gesamten Posteingang (kein Löschen, kein IMAP, kein TLS).
- **FTP/TFTP:** Dateien sind kurze Texte; Hosts besitzen lokale Dateien (`echo text > datei`, Desktop → Dateien). FTP ohne
  separaten Datenkanal, ohne passiven Modus; TFTP als ein Request/Response (keine Blöcke).
- **Firewall:** zustandsbehaftete Prüfung nach dem Routing-Lookup (Ein-/Ausgangsschnittstelle): bestehende Verbindungen beider
  Richtungen erlaubt; neue Verbindungen nur per ACL der Eingangsschnittstelle (`access-group`, implizites Deny) oder – ohne ACL –
  von höherem zu niedrigerem Security-Level (`same-security-traffic permit inter-interface` für gleiche Level). TCP nur mit SYN
  eröffnet; ICMP-Echo mit Typ-Unterscheidung; ICMP-Fehler nur zu bestehenden Verbindungen; Timeouts TCP 1 h, UDP 2 min, ICMP 1 min.
  Verworfene Pakete erzeugen keine ICMP-Antwort. Objekt-NAT (`object network` + `nat (a,b) dynamic interface|static IP`) wird
  auf den Router-NAT abgebildet; Proxy-ARP für statische globale Adressen. Rückverkehr einer von außen aufgebauten Verbindung wird
  nicht dynamisch übersetzt. Verkehr **zur** Firewall (Ping auf eine Schnittstelle) ist nicht gefiltert; kein Failover, kein `inspect`,
  keine Zonen/Class-Maps, kein `object-group`, kein Twice-NAT.
- **Host-Firewall:** ein Schalter, blockiert eingehendes Echo (Ping); keine Regeln je Port.
- **IoT:** Registrierung/Bericht per UDP 5683 an den IoT-Server (Berichtsintervall 10 s, Hintergrund-Timer), Regelauswertung
  beim Eintreffen eines Berichts, Schaltbefehl per UDP; Wertverlauf manuell, Welle oder Rampe (deterministisch aus der virtuellen
  Zeit). Kein JS-/Python-Scripting (spätere Phase).
- **Cloud/Modem:** transparente lernende Bridge je Portgruppe; keine PPPoE-/DSL-Synchronisation, kein Frame-Relay/WAN-Emulation,
  keine Bandbreitenprofile über die Port-Geschwindigkeit hinaus (DSL 24 Mbit/s, Koax 100 Mbit/s).
- **Module:** Modul-Steckplätze nur bei Routern (HWIC-2T, HWIC-1GE) und Hosts (NIC-FE/-GE/-WIFI), Einsetzen/Entfernen nur
  bei ausgeschaltetem Gerät; ein Host nutzt den ersten aktiven Datenport (kabelgebunden vor WLAN).
- **Access Point/WLC als Host-Gerät:** AP und WLC besitzen einen IP-Stack für Verwaltung (DHCP/statisch, Ping), aber keine CLI.
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
  EIGRP für IPv6 siehe unten (Abschnitt „Erweiterungen proto“). Redistribution aus OSPF/RIP/BGP ohne `metric` (bzw. Route-Map-`set metric`) kündigt wie bei IOS nichts an;
  `default-metric` gibt es für EIGRP nicht. connected/static ohne Metrik erhalten 100 000 kbit/s / 10 µs.
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
  (connected/static/andere IPv6-Protokolle). Keine Fragmentierung (zu große Pakete werden verworfen); EIGRP für IPv6 siehe „Erweiterungen proto“. OSPFv3 nutzt dieselbe LSDB-Struktur wie v2 (Präfixe in Router-LSAs).
- **Uhr:** `clock set` setzt die Gerätezeit; `show clock` und `debug`-Zeitstempel folgen ihr (ohne gesetzte Uhr `*Mar  1 1993` wie bei IOS). Zeitangaben in `show ip dhcp binding` nutzen weiterhin eine feste Basis.
- **Debug-Ausgabe:** Zeitstempel aus virtueller Zeit; Meldungstexte sind englisch, nicht übersetzt.

## Erweiterungen proto

- **EIGRP für IPv6:** `routing/eigrp.ts` ist über die Adressfamilie verallgemeinert (wie OSPFv3 über `ospf.ts`): derselbe DUAL-/Metrik-/Reliable-Transport-Code, Nachbarn über
  Link-Local-Adressen und die Gruppe `ff02::a` (IP-Protokoll 88 / Next Header 88, Nutzlast `routing/eigrp` mit `v: 6`), Prozesse in `RoutingCfg.eigrp6`, Schnittstellenzuordnung
  `ipv6 eigrp ASN` (`V6IfCfg.eigrp`) statt `network`-Anweisungen. Wie bei IOS startet ein Prozess im Zustand `shutdown` und braucht eine Router-ID (`eigrp router-id` oder eine
  IPv4-Adresse am Gerät). Kein Auto-Summary, kein `distribute-list`/`route-map` für IPv6-EIGRP, keine `metric weights`; Routen erscheinen als `D`/`EX` in `show ipv6 route`.
