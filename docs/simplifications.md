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
- **Nicht umgesetzt:** SPAN, UDLD, Private VLANs (Storm-Control, DHCP-Snooping und DAI siehe Phase 6).
- **DHCP:** kein BOOTP; Lease-Verlängerung bei T1 (50 %), Konflikterkennung per ARP-Probe (Option 82 siehe DHCP Snooping).
- **DHCP am Router als Client (`ip address dhcp`):** nur physische Schnittstellen und Subinterfaces; keine ARP-Probe, Verlängerung per Broadcast-REQUEST mit `ciaddr` (IOS: Unicast); Gateway aus dem Angebot wird als Default-Route mit AD 254 installiert. Keine Optionen `client-id`/`hostname` am Interface.
- **DHCP-Server:** manuelle Bindungen (`host` + `hardware-address`/`client-identifier`) gelten unbegrenzt; `show ip dhcp server statistics` zählt nur DISCOVER/REQUEST/DECLINE/RELEASE bzw. OFFER/ACK/NAK (BOOTP/INFORM immer 0, „Memory usage“ fest). `ip dhcp ping packets`, `ip dhcp conflict logging` und DHCP-Datenbank-Agenten fehlen. `debug ip dhcp server events|packet` mit IOS-ähnlichen Zeilen.
- **Server-Gerät (GUI):** Pools wie in Packet Tracer (Startadresse, Maske, maximale Anzahl, ein DNS-Server); Lease in ganzen bzw. Bruchteilen von Tagen.
- **TCP/HTTP:** vereinfachtes TCP (SYN/SYN-ACK, ein Request, Antwort + FIN, RST); keine Retransmission-Fenster, kein TLS
  (HTTPS ist nur ein Port-/Schemaflag). Seiten sind kurze Texte.
- **NAT:** Timeouts per `ip nat translation timeout` für UDP/TCP/IP gemeinsam (ICMP fest 60 s); ALG/FTP fehlt.
- **ACL:** `log`-Schlüsselwort wird akzeptiert, aber nicht gezählt; kein `object-group`, keine Zeitbereiche. Protokolle: `ip`, `icmp`, `tcp`, `udp`,
  `esp`, `ahp`, `gre`, `ospf`, `eigrp` (keine Protokollnummern); Portnamen u. a. `bgp`, `tacacs`, `isakmp`, `non500-isakmp`, `snmptrap`.

## Phase 4

- **Routing-Protokolle nutzen eigene PDU-Typen** (`RoutingPdu`); IP-Protokollnummern 89 (OSPF) und 88 (EIGRP) sind echt,
  **BGP läuft über das gemeinsame TCP** (Port 179, siehe „TCP/BGP/Telnet/IoT-Skripte“ unten) mit Keepalive/Hold-Timer und Connect-Retry alle 5 s.
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
  (keine 802.11-Frames/Beacons). Roaming: Wechsel erst, wenn der neue AP deutlich näher ist (< 70 % der Entfernung). Beim Wechsel auf einen anderen AP derselben SSID
  behält der Client IP, ARP-Cache und laufende Pings: er sendet ein Gratuitous ARP und – bei DHCP – einen INIT-REBOOT-REQUEST (Broadcast ohne Server-ID,
  Zustand `rebooting`); ACK ⇒ sofort `bound`, NAK oder 4 s ohne Antwort ⇒ voller DORA. Verloren gehen nur Frames, die während des Wechsels unterwegs sind.
  Ein Wechsel auf eine andere SSID (oder nach vollständigem Verbindungsverlust) startet weiterhin mit frischem Zustand und DORA.
  WPA2-Enterprise/802.1X siehe „Erweiterungen proto“.
- **Physical View:** Entfernung für die Funkreichweite = Canvas-Abstand; liegen beide Geräte in der Physical View, gilt:
  anderes Gebäude/andere Stadt = außer Reichweite, anderer Raum = + 120 px „Wandabschlag“. Keine Kabellängen/Dämpfung,
  keine maßstäbliche Darstellung.
- **WLC:** vereinfachtes CAPWAP (UDP 5246): der AP fragt den WLC periodisch (30 s) und übernimmt dessen WLANs; Roaming
  zwischen APs ohne Controller-Koordination. Kein Lightweight-Tunneling der Nutzerdaten (der AP bridged lokal).
- **Dienst-Transport:** Anwendungen (FTP, SMTP, POP3, Telnet, SSH) laufen über vereinfachte TCP-Verbindungen mit
  strukturierten `svc`-Nachrichten (SYN/SYN-ACK mit Banner, Anfrage/Antwort mit PSH/ACK, FIN); keine Fenster,
  Retransmission: siehe „Gemeinsames TCP“ unten (SYN 3 Versuche à 1 s; Daten mit RTO 1 s, verdoppelnd, 5 Wiederholungen). TFTP, NTP, Syslog, SNMP, RADIUS, IoT und
  CAPWAP sind UDP-Anfrage/Antwort (5 s Timeout, keine Wiederholung). Inhalte (Dateien, Mails) sind Textzeichenketten.
- **Telnet/SSH:** Erreichbarkeit, Port (23/22), `transport input`, Login (Passwort/lokal/AAA) laufen über das simulierte Netz
  und damit durch ACLs/Firewalls/NAT. Die Sitzung selbst (Tastatur/Ausgabe) wird nicht paketiert, sondern als CLI-Sitzung des
  Zielgeräts im Worker an das Terminal gehängt; die Zeilen/Ausgaben selbst laufen als TCP-Segmente (siehe unten). SSH-Schlüssel sind
  simuliert (Modulgröße wird gespeichert; Voraussetzung: `ip domain-name` + `crypto key generate rsa`). Maximal `line vty 0 N`
  Sitzungen (Standard 5; `line vty F L` legt wie bei IOS höchstens Leitungen bis L an, entfernt aber keine); alle vty-Leitungen teilen sich eine Konfiguration (`transport`, `login`, Passwort).
- **Benutzer-Geheimnisse:** `username X secret Y` wird im Konfigurationsbaum im Klartext gehalten und als `secret 5 <Typ-7>`
  gerendert (umkehrbar, damit Replay/`reload` funktionieren); RSA-Schlüssel überstehen `reload` (NVRAM).
- **AAA:** nur Anmeldung an den vty-Leitungen (kein Console-/Enable-/Accounting-AAA, TACACS+ siehe „Erweiterungen proto“). Methodenliste
  `group radius`/`local`; bei RADIUS-Timeout (3 s) wird die nächste Methode genutzt, bei explizitem Reject nicht.
- **NTP:** Anfrage/Antwort mit Zeitstempel (kein Offset-/Delay-Algorithmus, kein Stratum-Auswahlverfahren, keine Authentifizierung);
  Abfrage 2 s nach Konfiguration, dann alle 64 s. **Verlust:** nach 4 aufeinanderfolgenden unbeantworteten Abfragen (≈ 4 min; IOS wertet ein 8-Bit-Reach-Register,
  hier zur schnelleren Rückmeldung 4) wird der Client unsynchronisiert (Stratum 16, `show ntp status`: „Clock is unsynchronized“, Log `svc.ntp.lost`); `no ntp server`
  hebt die Synchronisation sofort auf. **Server:** wie bei IOS bedient ein synchronisierter Router/Switch auch ohne `ntp master` andere Clients (mit seinem eigenen Stratum);
  `ntp master N` gilt als Rückfall, solange das Gerät nicht synchronisiert ist; ein Server wird dabei nur gewählt, wenn er ein besseres Stratum als die eigene
  Uhr liefert (Stratum + 1 < N), und Server mit Stratum ≥ 15 werden ignoriert – gegenseitig konfigurierte Server bilden so keine Zählschleife. Hosts bedienen nur mit aktivem NTP-Dienst (Stratum 1). Gerätezeit = Epoch-Basis + virtuelle Zeit; Router starten am 1.3.1993,
  Hosts am 1.1.2026 12:00 UTC (deterministisch statt Wanduhr). Keine Zeitzonen/Sommerzeit (immer UTC).
- **Syslog:** Meldungen für Link-/Leitungsstatus, Konfigurationsänderung (`%SYS-5-CONFIG_I`) und Logins; Schweregrad-Filter
  (`logging trap`), Puffer 100 Zeilen. Keine Facility-Auswahl, kein `logging source-interface`.
- **SNMP:** v2c-ähnlich mit Community (kein v3, keine Informs; Traps siehe „Erweiterungen proto“); MIB: system-Gruppe und ifTable-Spalten (Index, Descr, Type,
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
  auf den Router-NAT abgebildet, und zwar je Regel mit dem Paar (reale, gemappte Schnittstelle): Eine Schnittstelle darf in einer Regel Quelle und in einer anderen Ziel
  sein (`nat (inside,outside)`, `nat (dmz,outside)`, `nat (inside,dmz)` …); Übersetzungseinträge merken sich das Paar, Rückverkehr wird nur auf der gemappten Schnittstelle zurückübersetzt; Proxy-ARP für statische globale Adressen. Rückverkehr einer von außen aufgebauten Verbindung wird
  nicht dynamisch übersetzt. Verkehr **zur** Firewall (Ping auf eine Schnittstelle) ist nicht gefiltert; kein Failover, kein `inspect`,
  keine Zonen/Class-Maps, kein `object-group`, kein Twice-NAT.
- **Host-Firewall:** ein Schalter, blockiert eingehendes Echo (Ping); keine Regeln je Port.
- **IoT:** Registrierung/Bericht per UDP 5683 an den IoT-Server (Berichtsintervall 10 s, Hintergrund-Timer), Regelauswertung
  beim Eintreffen eines Berichts, Schaltbefehl per UDP; Wertverlauf manuell, Welle oder Rampe (deterministisch aus der virtuellen
  Zeit). Scripting: siehe „IoT-Skripte“ unten (JavaScript-Teilmenge, kein Python).
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
- **Event-Log:** auf `EngineConfig.maxLogEntries` (Default 50 000, 0 = unbegrenzt) begrenzt; beim Überlauf fallen die ältesten ≈ 10 % weg. Log-Ids bleiben monoton (`Engine.logOffset` = Id des ersten
  Eintrags); `getLog(from)`, `ViewModel.logLength`/`logStart`, Snapshots (`logLength`) und der CLI-Debug-Cursor rechnen mit absoluten Ids. Ein Step-Back-Snapshot, dessen Einträge bereits getrimmt wurden,
  stellt den Zustand wieder her und lässt das Log leer (Ids setzen bei der Snapshot-Länge fort). Der Web-Store hält nur das noch vorhandene Fenster (`logBase`).
- **OSPF `no area N`:** entfernt alle Einstellungen des Bereichs (stub/nssa/`default-cost`/`authentication`, `area N range …`, Virtual Links mit Transit-Area N); `network … area N` und
  `ip ospf … area` bleiben bestehen (wie bei IOS, wo die Zuordnung der Schnittstellen eigene Konfiguration ist). Kein Fehler bei unbekannter Area.

## TCP, BGP über TCP, Telnet/SSH über TCP, IoT-Skripte

- **Gemeinsames TCP** (`engine/src/p5/conn.ts`, Verbindungstabelle `appc.conns` je Host/Router/Switch/Firewall): Dreiwege-Handshake mit echten
  Sequenz-/Bestätigungsnummern (Anwendungsnachricht = ein Segment, Länge = Nachrichtengröße), kumulative ACKs, Duplikat-/Lückenerkennung
  (nur die erwartete Sequenznummer wird angenommen), Retransmission mit RTO 1 s (verdoppelt bis 8 s) und 5 Wiederholungen (≈ 31 s) bis zum Abbruch
  (`conn.timeout`), Abbau per FIN bzw. RST (Daten auf unbekannter Verbindung zu/von einem Dienst-Port werden mit RST beantwortet). Kein
  Fenster/Slow Start, keine Segmentierung großer Nachrichten (IP-Fragmentierung übernimmt), keine TIME_WAIT/Half-Close-Zustände, keine
  Selective-ACKs. Lokale Client-Ports laufen im Bereich 49152–65535 um; ein neuer SYN (andere Sequenznummer) auf dem Tupel einer noch bestehenden
  Serververbindung ersetzt diese (Gegenstelle ohne FIN neu gestartet). Der HTTP-Pfad der Hosts (`svc/tcp.ts`) bleibt das einfache Modell. Ports: FTP 21, SSH 22, Telnet 23, SMTP 25, POP3 110, BGP 179.
- **Segmente laufen durch den IP-Stack:** ausgehende ACL, NAT, Firewall (Zustandsverfolgung) sehen sie. Die **eingehende ACL** gilt wie bei IOS auch
  für Unicast an das Gerät selbst (BGP/Telnet/SSH/TACACS+-Antworten, IKE, ESP, Ping, TFTP …), nicht nur für Durchgangsverkehr; Broadcast und
  Multicast (Routing-Protokoll-Hellos, DHCP, HSRP) bleiben – abweichend von IOS – ungefiltert.
- **BGP über TCP:** Zustände Idle → Connect (SYN in Arbeit) → Active (Verbindung gescheitert/passiv wartend) → OpenSent → OpenConfirm → Established.
  Der Aufbau läuft alle 5 s (Tick) nach Konfiguration; die Gegenseite nimmt nur Verbindungen von konfigurierten, nicht abgeschalteten Nachbarn an
  (sonst RST). **Collision-Detection vereinfacht:** baut ein Router gleichzeitig auf, gewinnt die Verbindung der Seite mit der höheren Quelladresse
  (statt Router-ID aus dem OPEN); eine Sitzung in OpenConfirm/Established wird nie ersetzt. Pfadverlust endet per TCP-Abbruch (≈ 31 s nach der
  ersten unbestätigten Nachricht), RST/FIN oder Hold-Timer (180 s). TTL ist 64/255-ähnlich wie bisher (kein TTL-Security), eBGP ohne Multihop
  bleibt auf direkt verbundene Nachbarn beschränkt. Timer der BGP-Verbindung sind Hintergrund-Timer.
- **Cease:** `no neighbor X` (und `no router bgp`, `neighbor X shutdown`) senden eine NOTIFICATION (Cease); die Gegenstelle verwirft Sitzung und
  Routen sofort. `clear ip bgp *` wirkt beim nächsten Tick (≤ 5 s) mit „Administrative Reset“.
- **`show ip route`:** BGP-Routen zeigen den BGP-Next-Hop (`via 3.3.3.3`, ohne Schnittstelle, wie IOS); die Weiterleitung nutzt unverändert die rekursive
  IGP-Auflösung (`DynRoute.bgpNextHop` nur Anzeige).
- **Telnet/SSH-Sitzung:** nach der Anmeldung wird jede Eingabezeile als ein TCP-Segment (`line`) zum Zielgerät gesendet, die Ausgabe der Ziel-CLI als ein Segment
  (`out`) zurück. SSH-Segmente sind im Inspektor als verschlüsselt markiert (`SvcPdu.encrypted`). Die Ziel-CLI wird nach der Bestätigung der Zeile lokal im
  Worker ausgeführt (die Ausgabe entsteht dort, wird aber erst als Segment dem Anwender gezeigt). Fällt der Pfad aus, steht die Sitzung still
  (Terminal blockiert in virtueller Zeit), bis TCP aufgibt: `% Connection timed out; remote host not responding` und
  `[Connection to X closed by foreign host]`; die vty-Leitung des Ziels wird dann freigegeben (vereinfachter exec-timeout). `debug`-/`terminal monitor`-Meldungen
  der Sitzung werden nicht paketiert. Passwörter (Login) laufen weiter als `login`-Nachricht.
- **IoT-Skripte:** JavaScript-Teilmenge mit eigenem Interpreter (`engine/src/p5/script/interp.ts`): var/let/const, Funktionen/Pfeilfunktionen/Closures,
  if/while/for/for…of, Zahlen/Strings/Template-Strings/Arrays/Objekte, `Math`, `Number`, `String`, `parseFloat`, `parseInt`, `JSON.stringify`, einfache
  String-/Array-Methoden. Kein `eval`, `new`, `this`, Klassen, Getter, `try/catch`, Promises, Module, Regex, Datum; kein Zugriff auf Globals, Prototypen
  oder `constructor`. API: `readSensor(name)` (`'self'`/eigene Sensorart/ dem IoT-Server bekannte Geräte, sonst `null`), `setActuator(name, on)` (eigener
  Aktor oder per `set` an ein registriertes Gerät), `log(…)`, `every(ms, fn)` (min. 100 ms, max. 16 Handler), `onReport(fn)` (`fn(name, value)` bei eigenem Bericht
  oder wenn ein Bericht am IoT-Server eintrifft). Grenzen: 100 000 Schritte und Tiefe 40 je Aktivierung, Strings ≤ 20 000 Zeichen (auch bei `join`, `padStart`, `JSON.stringify`, Array-zu-String), Arrays und Objekte ≤ 10 000 Einträge, gespeicherter Zustand ≤ 100 000 Zeichen JSON. **Zustand:** nur Text,
  `running`, Konsole (200 Zeilen) und die JSON-fähigen Variablen des Hauptteils sind Teil der Konfiguration; bei jeder Aktivierung wird der Hauptteil still neu
  ausgewertet und die gespeicherten Variablen eingesetzt (Funktionswerte werden nicht gespeichert; Variablen, die Funktionen halten, und Closure-Zustand
  außerhalb des Hauptteils gehen zwischen Aktivierungen verloren). Ein Fehler (Syntax, Laufzeit, Schrittgrenze) hält nur dieses Gerät an (`crashed`) und
  schreibt einen Log-Eintrag; Run startet es neu. Kein Python.

## Erweiterungen proto

- **EIGRP für IPv6:** `routing/eigrp.ts` ist über die Adressfamilie verallgemeinert (wie OSPFv3 über `ospf.ts`): derselbe DUAL-/Metrik-/Reliable-Transport-Code, Nachbarn über
  Link-Local-Adressen und die Gruppe `ff02::a` (IP-Protokoll 88 / Next Header 88, Nutzlast `routing/eigrp` mit `v: 6`), Prozesse in `RoutingCfg.eigrp6`, Schnittstellenzuordnung
  `ipv6 eigrp ASN` (`V6IfCfg.eigrp`) statt `network`-Anweisungen. Wie bei IOS startet ein Prozess im Zustand `shutdown` und braucht eine Router-ID (`eigrp router-id` oder eine
  IPv4-Adresse am Gerät). Kein Auto-Summary, kein `distribute-list`/`route-map` für IPv6-EIGRP, keine `metric weights`; Routen erscheinen als `D`/`EX` in `show ipv6 route`.
- **WPA2-Enterprise / 802.1X:** WLAN-Sicherheit `wpa2-enterprise` (Funkmodul des autonomen AP oder WLAN am WLC) mit RADIUS-Server (Adresse + Shared Secret, Dienst `aaa` des Servers aus Phase 5).
  Das Verfahren ist vereinfacht: kein EAPOL/EAP-Frame-Austausch, kein TLS-Tunnel. Der AP agiert immer als Authenticator (auch Lightweight-AP: die WLAN-Konfiguration
  einschließlich RADIUS-Server kommt per CAPWAP vom WLC, die Anfrage geht aber direkt vom AP – IP-Adresse des APs muss als RADIUS-Client am Server stehen) und sendet ein
  `access-request` (UDP 1812, Benutzer + Passwort aus dem Wi-Fi-Profil; Passwort/Secret werden im Inspektor maskiert). `access-accept` ⇒ Assoziation, `access-reject`/Timeout (3 s) ⇒
  Status `auth-failed`, kein Link. Die Assoziation ist dadurch asynchron (Status `authenticating`). Ein abgewiesenes Verfahren wird nicht wiederholt, bis Zugangsdaten oder die
  Server-Dienste (`aaa`) geändert werden; nach einem Timeout (Server nicht erreichbar, z. B. vor der STP-Konvergenz) versucht es der AP nach 60 s erneut (held period); nach Trennung (Reichweite, Aus) authentifiziert sich der Client erneut. Roaming zwischen Enterprise-APs authentifiziert den Ziel-AP vorab.
  Keine Zertifikate, keine Schlüsselableitung, keine Gruppen-/Rollenzuweisung, kein Accounting.
- **TACACS+:** eigener Dienst über die bestehende Dienst-Transportschicht (`p5/conn.ts`, vereinfachtes TCP auf Port 49): Anfrage `authen` (Benutzer, Passwort, Schlüssel) →
  `authen-pass` | `authen-fail` | `authen-error`. Der gemeinsame Schlüssel wird nur verglichen (kein Header-/Body-Verschleiern); falscher Schlüssel oder unbekannter Client-IP ⇒ Fehler
  bzw. abgelehnte Verbindung und damit Weiterfallen auf die nächste Methode (`local`), `fail` ⇒ harte Ablehnung ohne Fallback (wie bei IOS). Nur Authentifizierung der vty-Anmeldung
  (kein Authorization/Accounting, keine Console-/Enable-Authentifizierung), nur der erste konfigurierte Server wird befragt, Server-Gruppen (`aaa group server`) gibt es nicht.
  Zähler für `show tacacs` (Verbindungen, pass/fail/errors) sind Laufzeitwerte. Der Client-Aufruf sitzt in `p5/remote.ts` (`aaaStep`) und `p5/tacacs.ts`; der Server-Dienst hat
  eigene Clients und Benutzer (getrennt von RADIUS).
- **SNMP-Traps:** `snmp-server host A [version 1|2c] COMMUNITY` und `snmp-server enable traps [snmp] [linkdown] [linkup] [coldstart]` (ohne Angabe alle drei). Gesendet werden
  `linkDown`/`linkUp` (bei Änderung des Link-Status eines Ports, mit ifIndex/ifDescr) und `coldStart` (12 s nach Einschalten/`reload`, Hintergrund-Timer) als `svc`-Nachricht
  `snmp/trap` an UDP 162, ohne Bestätigung (keine Informs, kein Retry, kein v3, keine Varbind-Liste/OIDs – Typ und Schnittstelle als Felder). Empfänger ist ein Server mit
  aktivem SNMP-Dienst; Traps mit unbekannter Community werden verworfen (`svc.snmp.badCommunity`), gültige in `services.snmp.traps` abgelegt (max. 200) und im Services-Tab sowie in der
  MIB-Browser-App angezeigt. `authentication`/`warmstart` werden akzeptiert, aber nie ausgelöst.
- **PPPoE/PPP:** Client am `Dialer N` (`dialer pool N` ↔ `pppoe-client dial-pool-number N` am physischen Port), Server/BRAS über `bba-group pppoe` → `virtual-template N` →
  `interface Virtual-Template N` (`ip unnumbered`, `peer default ip address pool`, `ppp authentication chap`) und `ip local pool`. Discovery (PADI → PADO → PADR → PADS, PADT) und PPP laufen als echte
  Frames (EtherType 0x8863/0x8864), die PPP-Aushandlung ist verkürzt: LCP nur Configure-Request/-Ack in beide Richtungen (MRU 1492, Authentifizierung CHAP), CHAP mit
  Challenge/Response/Success|Failure (Digest ist ein deterministischer Pseudo-Hash, kein MD5; das Server-Passwort stammt aus `username X password Y`), IPCP als Request(0.0.0.0) →
  Nak(zugewiesene Adresse) → Request → Ack. Keine Echo-/Keepalive-Pakete, kein MP/PFC/ACFC, keine IPv6CP-Aushandlung, kein RADIUS für PPP, keine Service-Namen-Filter. Nach einem
  Fehler (falsches Passwort) versucht der Client es nach 10 s erneut. `Dialer`/`Virtual-Access` erscheinen als IP-Schnittstelle (/32, MTU 1492, Host-Route zur Gegenstelle) nur bei
  stehender Sitzung; die Default-Route kommt per `ip route 0.0.0.0 0.0.0.0 Dialer1` oder `ppp ipcp route default`. IP-Verkehr in der Sitzung wird in der Ereignisliste als IP-Paket
  der Dialer-Schnittstelle gezeigt (die PPPoE-Kapselung zeigen nur Discovery-/PPP-Frames). Virtual-Access-Schnittstellen sind nicht konfigurierbar (nur über die Vorlage). Cloud/DSL-Modem
  reichen die Frames transparent weiter.
- **IPsec (Crypto Maps):** Site-to-Site über `crypto map` an der WAN-Schnittstelle. IKE ist **ein** Austausch (Anfrage → Accept/Reject, UDP 500) für IKE- und IPsec-SA gemeinsam:
  der Initiator sendet seine beste ISAKMP-Policy (niedrigste Nummer: Verschlüsselung, Hash, DH-Gruppe), einen Digest des Pre-Shared Keys (kein Klartext), das Transform-Set und die
  Verkehrsauswahl (die passende ACL-Zeile) sowie seinen SPI. Der Responder lehnt mit Grund ab bei: unbekanntem Peer, keiner passenden Policy (Policy-Authentifizierung muss `pre-share`
  sein – Default ist wie bei IOS `rsa-sig`), abweichendem Schlüssel (`authentication failed`), anderem Transform-Set oder fehlender gespiegelter ACL-Zeile (`proxy identities not
supported`). Ohne Antwort nach 3 s: `failed (timeout)`; ein neuer Versuch erfolgt frühestens nach 8 s beim nächsten passenden Paket. Während des Aufbaus (und bei fehlgeschlagener SA)
  werden passende Pakete verworfen (die ersten Pings gehen verloren, wie in der Praxis). Je ACL-Zeile entsteht ein SA-Paar; bauen beide Seiten gleichzeitig auf, gewinnt der Austausch der Seite mit der höheren Adresse. ESP (IP-Protokoll 50, Tunnelmodus) kapselt das ganze
  Originalpaket; die Nutzlast ist im Inspektor und in Ereignislisten nur als „verschlüsselt“ sichtbar (Transitgeräte sehen nur äußere Adressen, SPI, Sequenz), an den Endpunkten steht
  „decrypted …“ im Log. Keine echte Kryptografie, kein Lifetime-/Rekey-Ablauf (SAs bleiben bis `clear crypto sa`, Reload oder Link-/Strom-Aus), kein Replay-Fenster, kein NAT-T, kein
  IKEv2, keine Transport-Mode-Wirkung (wird gespeichert), kein DPD, **keine VTI** (`tunnel mode ipsec`) und keine IPsec-Profile; Crypto Maps sind an physischen/Sub-Schnittstellen und am Dialer
  einer PPPoE-Einwahl möglich, nicht am Virtual-Template. Nach einem Neustart der Gegenstelle bleibt die alte SA der anderen Seite bestehen (kein DPD, keine
  Lebensdauer): erst ein von der neu gestarteten Seite aufgebautes IKE oder `clear crypto sa` stellt das VPN wieder her. Entschlüsselte Pakete laufen danach durch die normale Eingangsverarbeitung der Schnittstelle (ACL-in, Weiterleitung).

## Scripting-API und PCAP-Export (script)

- **Nur JavaScript.** Python via Pyodide ist nicht eingebaut: ~10 MB Laufzeit, WebAssembly-Download beim ersten Start (verträgt sich nicht mit „keine externen Requests“ und Offline-Betrieb ohne
  mitgelieferte Pyodide-Dateien) und ein zweiter, nicht deterministisch begrenzbarer Interpreter. Die JS-Teilmenge deckt Labor-Automatisierung ab: Variablen, Funktionen, Schleifen,
  Arrays/Objekte, `Math`, `JSON.stringify`, `Object.keys/values/entries` – aber **kein** `try/catch`, keine Klassen, kein `async`, keine regulären Ausdrücke, kein `JSON.parse`, kein `Date`.
- Skripte sind Stapelprogramme: Ereignisse werden nur während der skriptgetriebenen Simulation zugestellt; nach Ende des Skripts laufen keine Handler weiter. Ein Lauf arbeitet auf einer Kopie
  des Netzes (siehe decisions 40), Terminal-Sitzungen der GUI sind davon unabhängig.
- **PCAP – Wire-Format:** Frames sind synthetisch aus den strukturierten PDUs erzeugt (Ethernet II, 802.1Q, 802.3/LLC für STP, SNAP für PVST+/VTP, ARP, IPv4 inkl. Fragmente und Header-Prüfsumme,
  ICMP, IPv6/ICMPv6 (ND, RA, Fehler), UDP/TCP mit Pseudo-Header-Prüfsummen, DHCPv4/DHCPv6, DNS inkl. Namenskompression, RIPv2/RIPng, OSPFv2/OSPFv3 inkl. LSA-Fletcher-Prüfsumme, EIGRP/EIGRPv6,
  BGP-4, HSRP v1/v2, GRE, ESP, PPPoE/PPP (LCP/CHAP/IPCP), TFTP, NTP, Syslog, SNMP (BER), RADIUS, TACACS+-Rahmen, HTTP/FTP/SMTP/POP3/Telnet als Text). Wireshark dissect-Gegenprobe mit Scapy.
- Ohne echtes Wire-Format bzw. vereinfacht: **IKE** (korrekter ISAKMP-Kopf, deterministischer Platzhalter-Rumpf), **ESP** (SPI/Seq/IV korrekt, Nutzlast mit festem Schlüsselstrom maskiert, ICV Zufallsbytes),
  **SSH** (Banner echt, Rest Zufallsbytes), **CAPWAP/IoT** (JSON-Text), **TACACS+** (Kopf echt, Rumpf nicht verschleiert), **VTP** (nur Subset-Advertisement), **BGP** ohne MP-BGP-IPv6-Felder und mit
  Seq/Ack = 1 in einem Einzelsegment ohne TCP-Handshake, **OSPFv3-LSAs** nur in Grundform (Router, Network, Inter-Area, AS-External; keine Link-/Intra-Area-Prefix-LSAs), **OSPF-MD5** mit
  Platzhalter-Digest, **IPv6-Erweiterungsheader** entfallen. Keine FCS in der Datei (wie bei den meisten Captures), Frames < 60 Byte werden aufgefüllt.
- **PCAP – Serial-Links (QA3):** Die Datei hat nur LINKTYPE_ETHERNET; Pakete über Serial-Links (HDLC/PPP) erscheinen daher mit Ethernet-Kopf statt Cisco-HDLC/PPP-Rahmen (eigenes Linktype bräuchte pcapng mit mehreren Schnittstellen). CDP/LLDP (SNAP 0x2000 bzw. 0x88cc, TLV-Formate) und DSCP im ToS-Byte sind geprüft korrekt.
- Die Datei enthält jede Frame-**Ankunft** (also ein Frame, der über mehrere Links läuft, mehrfach) – ein Capture „auf allen Leitungen“. Zeitstempel: Simulationszeit ab 2025-01-01 00:00:00 UTC.
  Frames, die ein Gerät still verwirft, ohne einen Log-Eintrag zu erzeugen, fehlen.
- Multiuser (WebSocket-Relay, Link-Tunnel) ist **nicht** umgesetzt.

## UX (Phase 6)

- **Gruppen/Cluster** sind ein beschrifteter Rahmen um Geräte (ein Gerät gehört zu höchstens einer Gruppe); Ziehen am Rahmen verschiebt die Mitglieder. Kein Einklappen zu einem Symbol.
- **Hintergrundbild:** ein Bild, links oben bei (0, 0), wird auf höchstens 2000 px Kantenlänge verkleinert, Deckkraft einstellbar; keine Skalierung/Verschiebung.
- **Notizen:** feste Breite, einfacher Text, keine Formatierung oder Pfeile.
- **Equivalent IOS Commands:** Diff-Heuristik der running-config; Ersetzungen bekannter Befehle (`ip address`, `hostname`, …) erzeugen kein `no`, bei Sonderfällen kann die Folge von der handgeschriebenen IOS-Reihenfolge abweichen.
- **Touch:** Tippen, langer Druck (Kontextmenü), Pinch/Zwei-Finger-Pan; Rubberband per Ein-Finger-Ziehen im Auswahlwerkzeug.
- **Axe-Prüfung** schließt `color-contrast` aus dem dynamischen Lauf aus (Canvas nicht prüfbar); Kontraste der Tokens sind in `theme.test.ts` abgesichert.

## Realismus-Runde CCNA – Vereinfachungen

- **CDP/LLDP:** nur Ethernet-Ports; keine CDPv1, keine TLVs für VTP-Domäne/PoE/Power; `no cdp run` leitet CDP-Frames nicht als Multicast weiter (echte Switches fluten sie). Duplex-Mismatch-Meldung (`%CDP-4-DUPLEX_MISMATCH`) entfällt, weil das Linkmodell ein gemeinsames Duplex ableitet. LLDP: Pflicht-TLVs plus Management-Adresse, kein LLDP-MED.
- **DHCP Snooping:** keine Datenbank-Datei (`ip dhcp snooping database`), Bindungen gehen beim Reload verloren; Circuit-ID im Format `VLAN:Port` (IOS: Modul-/Port-Kodierung), `remote-id` ist die Basis-MAC; statische Bindungen per exec-Befehl, nicht in der running-config.
- **DAI:** Validierung `ip` prüft nur ungültige Absender-/Zieladressen (0.0.0.0, 255.255.255.255, Multicast); Rate-Limit-Fenster 1 s unabhängig vom `burst interval`; Logging-Parameter (`ip arp inspection log-buffer`) fehlen; keine Wirkung auf Trunk-Port-Vertrauen außer `trust`.
- **Storm Control:** 1-s-Fenster pro Port; Prozentwerte beziehen sich auf die ausgehandelte Geschwindigkeit; `falling`-Schwelle wird gespeichert, aber nicht ausgewertet; Unicast = unbekanntes Unicast.
- **Voice VLAN:** keine CDP-/LLDP-MED-Aushandlung mit Telefonen, kein PoE; `dot1p`/`untagged` ohne Wirkung.
- **Port Security Aging:** wirksam nur für dynamisch gelernte Adressen (absolute/inactivity), Zeitprüfung beim nächsten Frame; `aging static` fehlt.
- **errdisable:** Wiederherstellung wird beim err-disable geplant; wird die Ursache erst danach in `errdisable recovery cause` aufgenommen, bleibt der Port bis `shutdown`/`no shutdown`.
- **IPv6-ACL:** nur Durchgangsverkehr (nicht an das Gerät gerichtet); ICMPv6-Typen und `log` werden geparst, aber nicht unterschieden; kein `ipv6 access-class` für vty.
- **QoS:** Klassifizierung und Markierung (`set dscp`) wirken; `bandwidth`, `priority`, `police`, `shape`, `queue-limit` werden gespeichert und angezeigt, haben aber keine Warteschlangen-/Policing-Wirkung. Zähler zählen Pakete/Bytes je Klasse (keine 5-Minuten-Raten). `match protocol` nutzt eine feste Liste (http, https, dns, telnet, ssh, ftp, smtp, tftp, ntp, snmp, syslog, icmp), kein NBAR.
- **SNMPv3:** Benutzer/Gruppen werden konfiguriert und angezeigt; SNMP-Abfragen des Simulators nutzen weiterhin v2c-Communities. Benutzer erscheinen (anders als in IOS) in der running-config, damit Reload sie erhält; Passwörter im Klartext.
- **NTP-Authentifizierung:** Digest wird als Zeichenkette verglichen (kein echtes MD5); `ntp authentication-key` wird als Typ 7 gerendert.
- **SSH:** Standardversion nach Schlüsselerzeugung ist „1.99“, funktional wird immer SSHv2 gesprochen.
- **Syslog:** Console-/Monitor-Level werden gespeichert und angezeigt, filtern die auf das Terminal ausgegebenen Meldungen aber nicht.

## Persistenz (Phase 6, persist)

- `.nsim` speichert den Entwurf, nicht den Laufzeitzustand: Nach dem Öffnen (und nach Undo) beginnt die virtuelle Zeit bei 0, Log, ARP-/MAC-Tabellen, DHCP-Leases und Routing-Nachbarschaften werden neu aufgebaut (Konvergenzzeit wie nach einem Neustart).
- Undo setzt die Laufzeit zurück (siehe oben) und verwirft den Simulations-Schritt-zurück-Verlauf. Es gibt keine Gruppierung mehrerer Aktionen zu einem Schritt außer innerhalb einer Dienstmethode.
- Terminal-Eingaben in Host-Shells (z. B. `ipconfig`) sind nicht rückgängig machbar; für Router/Switch zählt die `running-config`-Änderung.
- Kopieren/Einfügen arbeitet mit der Auswahl der Oberfläche (aktuell ein Gerät; Mehrfachauswahl über `setSelectionProvider`), nicht mit der System-Zwischenablage. HSRP-Virtuell-IPs und statische NAT-Adressen kopierter Router werden nicht umgeschrieben.
- Importvalidierung der Gerätekonfiguration prüft Struktur und Grundtypen gegen die Standardkonfiguration, nicht jeden Wertebereich; inhaltlich unsinnige Werte fängt der Gerätefehlerschutz der Engine ab (Gerät „crashed“).
- Autosave und zuletzt verwendete Dateien liegen im Browser (IndexedDB); ohne Speicherzugriff (privates Fenster) entfallen sie ohne Fehlermeldung.

## Szenarien, Aufgabenmodus, Challenge Me (teach)

- **Complex PDU:** Protokolle ICMP, UDP, TCP, HTTP/HTTPS, DNS, Telnet, SSH, FTP, SMTP, POP3. UDP ohne Anwendung gilt als erfolgreich, wenn der Empfang im Log steht und binnen 1 s keine ICMP-Fehlermeldung zurückkommt; ein geschlossener Port ergibt (wie bei echten Systemen) Port Unreachable und damit „Failed“ (Packet Tracer wertet bloße Zustellung als Erfolg). TCP-Versuche zu Port 80/443/8080 prüfen nur die Erreichbarkeit (jede HTTP-Antwort), das Protokoll `http` erwartet einen Status < 400. Eine erfolgreiche TCP-Probeverbindung wird sofort geschlossen. Bei Wiederholungen ist „Successful“ nur, wenn alle Versuche gelingen. Die Paketgröße ergibt sich aus der Länge der Nutzlast.
- **PDU-Ergebnisse** überleben Step Back/Reset nicht (die Ausführung wird verworfen, der Eintrag gilt wieder als „nicht gesendet“); gespeichert wird das zuletzt bekannte Ergebnis.
- **Prüfungen:** 60 s virtuelle Einschwingzeit für dynamische Prüfungen (Spanning Tree, OSPF-Adjazenz inkl. DR-Wahl, DHCP). Es gibt keine Prüfung auf EIGRP/BGP-Nachbarn, Syslog/SNMP-Details oder Textzeilen der `running-config` (bewusst: Zustand statt Text).
- **Zeitlimit** der Aufgabe läuft in Wanduhrzeit der Oberfläche (nicht in virtueller Zeit) und wird nicht gespeichert; die Sperren (CLI/GUI/Geräte hinzufügen) sind Oberflächenregeln, keine Sicherheitsgrenze.
- **Ableiten aus dem Antwortnetz** liefert Kandidaten (Konfiguration, Routen, Ping zwischen Hosts, HTTP zu Webservern); übernommen wird, was im Antwortnetz gilt und im Startnetz nicht (Verkehr, der nur im Antwortnetz scheitert, mit Erwartung `fail`). Die Liste ist ein Ausgangspunkt für den Autor, kein Ersatz für Hinweise und Gewichtung.
- **Challenge Me:** Fragen gibt es für Switch (Weiterleiten/Fluten/Verwerfen, Port, Lernen), Hub, Host (NIC, ARP, Echo, geschlossener Port), Router (Gateway-MAC, Weiterleiten, TTL, Schnittstelle, Next Hop, ARP, ACL, NAT, MTU/DF) und eine Schichtfrage; keine Fragen zu Routing-Protokollen, WLAN, VPN oder IPv6-Ereignissen. Die ARP-Folgefrage braucht spätere Log-Einträge; ist der Eintrag der letzte, entfällt sie.

## Realismus-Pass Routing/WAN (wan)

- **Serial:** Das Line-Protocol wird sofort bei jeder Konfigurationsänderung berechnet (kein 10-s-Keepalive, keine 3 verpassten Keepalives). Takt am DCE-Ende, gleiche Kapselung und – bei PPP – passende CHAP/PAP-Zugangsdaten sind die einzigen Bedingungen;
  die LCP/IPCP-Aushandlung ist nur als Debug-Ausgabe (`debug ppp negotiation|authentication`) nachgestellt. Kein Frame Relay, kein Multilink, kein `loopback`, keine Bitfehler/CRC. Serialisierung nutzt mindestens 1 Mbit/s (Mindestrate der Engine);
  IP läuft über Ethernet-Frames mit ARP (in `show ip arp` sichtbar, anders als bei echtem HDLC). Ein abgeschaltetes Gegenende zeigt „up, line protocol down“.
- **Statische Routen:** `track` und `ip route vrf` fehlen, `permanent` wird nur gespeichert. Null0 sendet immer ICMP net unreachable.
- **OSPF-Anzeige:** `Hello due in` stammt aus dem Hintergrund-Timer; Flood-Queue-/Scan-Zeilen sind feste Werte. MTU-Prüfung nur im DBD-Paket (`ip ospf mtu-ignore`).
