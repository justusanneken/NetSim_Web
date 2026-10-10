# Entscheidungen und Annahmen

Es werden keine Rückfragen gestellt; unklare Stellen der Spezifikation sind hier mit einem Default
festgelegt. Jede Entscheidung ist umkehrbar und wird bei Bedarf in der jeweiligen Phase angepasst.

## Annahmen (max. 10)

1. **PDUs sind reine Datenobjekte.** Die Spezifikation verlangt je PDU `layers[]`, `describe()`, `size()`,
   `clone()`. Damit der Engine-Zustand ohne Closures serialisierbar bleibt (Snapshot, `.nsim`,
   `structuredClone` über die Worker-Grenze), sind PDUs Plain Objects; die Operationen sind freie Funktionen
   in `@netsim/protocols` (`layersOf`, `describePdu`/`describeFrame`, `pduSize`, `clonePdu`).
2. **Engine-Meldungen sind i18n-Schlüssel + Parameter** (`{ key, params }`), keine Texte. Die UI übersetzt
   (`de` Default, `en`). Ein Test stellt sicher, dass jeder Engine-Schlüssel in beiden Sprachen existiert.
3. **Default-Seed = 1.** Gleiche Topologie + Seed + Eingaben ⇒ identisches Event-Log (Golden-File-Test).
   Ein Seed-Selektor in der UI folgt in Phase 6 (Szenarien).
4. **Pakete werden als TypeScript-Quellen konsumiert** (`main: src/index.ts`); kein separater Build-Schritt
   für Bibliotheken. Vite/Vitest/tsc lösen die Workspace-Pakete direkt auf.
5. **Das Event-Log liegt außerhalb des Snapshots.** Ein Snapshot enthält den Zustand und die Log-Länge;
   `restore()` kürzt das Log. So bleiben Step-Back-Snapshots klein.
6. **Phase-1-Katalog:** PC, Switch (2960-24-ähnlich: 24×Fa + 2×Gi) und Hub (8 Ports). Laptop/Server/Tablet
   teilen sich später den Host-Stack, werden aber erst mit ihren Phasen freigeschaltet. Nicht unterstützte
   `DeviceType`-Werte sind im Typ vorhanden, `addDevice` lehnt sie ab.
7. **Zeitmodi:** Start im Modus _Echtzeit_ (1×). _Simulation_ = manuelles Schrittfahren; „Schritt“ läuft bis zum
   nächsten sichtbaren Log-Eintrag (nicht nur ein internes Ereignis). Step Back stellt den Snapshot vor dem
   letzten Schritt wieder her (max. 200 Schritte).
8. **Timeouts:** ARP 3 Versuche im Sekundentakt, Ping-Timeout 4 s (Windows-Verhalten: ARP-Fehler → „Zielhost
   nicht erreichbar“ nach ~3 s, sonst „Zeitüberschreitung“).
9. **CSP:** Im Produktions-Build wird eine strikte Content-Security-Policy per `<meta>` eingefügt (kein
   Inline-Script, Worker nur `self`/`blob:`, keine externen Verbindungen). Als HTTP-Header ist dieselbe Policy
   beim Hosting zu setzen (siehe README). Im Dev-Server ist die CSP aus (HMR braucht Inline-Skripte).
10. **MAC-Format** intern `aa:bb:cc:dd:ee:ff`; die Cisco-Schreibweise (`aabb.ccdd.eeff`) wird erst im
    CLI-Renderer (Phase 2) erzeugt. MACs werden deterministisch aus einem Zähler vergeben
    (`02:00:…`, lokal administriert).

## Architekturentscheidungen

- **Engine = reine Zustandsmaschine.** `EngineState` (JSON-kompatibel) + Min-Heap-Queue im Zustand;
  Gerätehandler sind Funktionen `(ctx, config, …)`. `ctx` (`DeviceCtx`) wird je Ereignis erzeugt und ist
  die einzige Schnittstelle zu Zeit, RNG, Senden, Timern und Log.
- **Fehlerisolierung:** Exceptions in einem Gerätehandler setzen nur dieses Gerät auf `crashed`; die Simulation
  läuft weiter, die UI zeigt ⚠ und die Meldung.
- **Sicherheit:** Es gibt keinen `eval`, keine externen Requests zur Laufzeit; die Engine läuft im Worker.

## Phase 2 – zusätzliche Entscheidungen

11. **CLI läuft im Worker.** Terminals (`@netsim/cli` `Terminal` + `CliSession`/`HostShell`) leben im Engine-
    Worker; xterm.js im Hauptthread schickt Tastatureingaben (`termData`) und schreibt die Antwort. Ein
    Transkript (max. 60 kB) wird beim erneuten Öffnen des Dialogs wiedergegeben.
12. **Gemeinsamer IP-Stack** (`engine/src/ip.ts`) für Host und Router; die Gerätehandler liefern nur eine
    `IpNode`-Sicht (Schnittstellen, Lookup, Forwarding-Flag, TTL, ARP-Lebensdauer).
13. **Config-Modell:** `SysConfig` (Hostname, Passwörter, Banner, Lines, Beschreibungen, Startup-Text) ist
    für Router und Switch gemeinsam; der Router hält zusätzlich `ifaces` und `staticRoutes`. Die GUI und die
    CLI ändern denselben Baum über Engine-Methoden (`setInterfaceIp`, `addStaticRoute`, …) – GUI-Änderungen
    erscheinen deshalb in der `running-config` und umgekehrt.
14. **Deklarative Befehle:** `CommandDef { modes, slots, run, negatable, only }` mit Slots `K` (Schlüsselwort),
    `choice`, `P` (Parameter), `R` (Zeilenrest), `opt`. `no`/`default` werden aus `negatable` abgeleitet
    (Parameter dann optional). Neue Befehle brauchen keinen Parser-Umbau.
15. **Golden-Tests für die CLI:** `packages/cli/test/golden/*.txt` (Terminalausgabe ganzer Sitzungen);
    `UPDATE_GOLDEN=1` erzeugt sie neu.
16. **Switch-Datenebene pro VLAN:** MAC-Tabelle `vlan|mac`; logische Ports (`po1`) bündeln EtherChannel-Mitglieder.
    STP-Zustand gated Lernen und Weiterleiten je VLAN.
17. **Standard-Switchport-Modus `dynamic auto`** (wie bei Cisco); zwei `dynamic auto`-Ports bleiben Access.
18. **L3-Schnittstellen als `Iface`:** physisch `p0`, Subinterface `p0.10`, SVI `vlan10`; ein gemeinsamer IP-Stack für Host,
    Router und L3-Switch (Weiterleitungsreihenfolge: ACL-in → NAT außen→innen → Route/TTL → NAT innen→außen → ACL-out → ARP).
19. **Hintergrund-Timer (`bg:`)** (STP-Hello, VTP) zählen nicht als „Vordergrundarbeit“; `waitFor` der CLI endet damit
    sinnvoll, obwohl STP dauerhaft Ereignisse erzeugt.
20. **Neue Engine-Meldungen** nur als i18n-Schlüssel mit Parametern; `apps/web/test/i18n.test.ts` erzwingt Vollständigkeit.
21. **Routing-Zustand lebt im Konfigurationsbaum** (`L3Cfg.routing`, `dynRoutes`/`dynRoutes6`): Nachbarn, LSDB, Topologie sind JSON-serialisierbar (Snapshots/Schritt-zurück funktionieren). Pro Prozess `src` (`ospf:1`, `eigrp:100`, `rip`, `bgp`) für Neuberechnung und Redistribution.
22. **Zentrale Neuberechnung** (`rt:recompute`, 1 ms): SPF, Redistribution, BGP-Bestpath laufen gebündelt bis zum Fixpunkt (max. 5 Durchläufe).
23. **`debug`-Meldungen** sind Log-Einträge mit `debug`-Feld, nur bei aktivem Schalter erzeugt; die CLI-Sitzung holt sie per `poll()`, der Worker pusht sie per Polling an xterm. Periodische Routing-Protokolle sind im Ereignisfilter standardmäßig aus.
24. **IPv6 als paralleler Stack** (`l3v6.ts`) neben IPv4; Router/Host-Knoten tragen optional `v6`. Protokolle (OSPFv3) nutzen Pseudo-Schnittstellen mit Link-Local-Adresse.

## Phase 5 – zusätzliche Entscheidungen

25. **Neue Geräte nutzen vorhandene Zustandsarten:** AP, WLC, Tablet, Smartphone, Drucker, IoT-Geräte und SBC sind `host`-Konfigurationen
    mit optionalen Erweiterungen (`wifi`, `ap`, `wlc`, `iot`, `mail`, …); die Firewall ist eine `router`-Konfiguration mit `fw`;
    Cloud und Modems sind eine neue Art `bridge`. So bleiben IP-Stack, CLI, Replay und Snapshots unverändert nutzbar.
26. **Phase-5-Code in eigenen Dateien:** `engine/src/p5/*`, `p5types.ts`, `p5defaults.ts`, `service5.ts` (`EngineService5` erweitert
    `EngineService`), CLI `commands5/show5/render5/remote/shellstack/ftpshell`, Web `Panel{Wireless,Services5,Mgmt,Physical}.tsx`,
    `phase5.css`, `i18n/{de,en}.phase5.json`. Zugriff auf die Engine-Funktionen über `engine.p5` (`Phase5`-Klasse).
27. **WLAN-Assoziation = dynamischer Link:** Die Engine legt/entfernt bei jeder relevanten Änderung (`wirelessSync`: Verschieben,
    Strom, Konfiguration) Links der Art `wireless`; dadurch laufen Frames unverändert über den normalen Sende-/Empfangspfad,
    und der Canvas zeichnet gestrichelte Funklinks. Manuelle Funkkabel sind nicht möglich.
28. **Generische Dienstnachricht `svc`:** ein PDU-Typ (`proto`, `op`, `args`, `body`) für alle Phase-5-Anwendungen; Passwörter
    erscheinen im Inspektor maskiert. Transport: `p5/conn.ts` (TCP-ähnlich) und `p5/udputil.ts` (UDP-Anfrage/Antwort).
29. **Shell-Stapel statt verschachtelter Terminals:** Ein Terminal-Eintrag im Worker besteht aus einem `ShellStack`; `telnet`,
    `ssh` und `ftp` legen eine Anmelde-/Sitzungs-Shell obenauf, `exit` fällt zurück. Der Stapel wird nicht serialisiert.
30. **GUI → CLI-Äquivalent:** Firewall- und Verwaltungs-Panels führen IOS-Zeilen über `cliExec` im Worker aus und zeigen sie
    als „Equivalent IOS Commands“; dadurch erscheinen GUI-Änderungen in der `running-config`.
31. **Uhr:** deterministisch (Epoch-Basis + virtuelle Zeit), nie `Date.now()`; `Date.UTC` nur für feste Basiswerte.
32. **Firewall-Vorrang im Parser:** Befehle mit `only: 'firewall'` werden vor gleichlautenden Router-Befehlen ausgewertet
    (z. B. `access-list NAME extended …`); Router-Befehle bleiben auf der Firewall verfügbar (`Family` `firewall` ⊃ `router`).

### Übergabe an den Manager (gemeinsame Dateien)

Geändert (jeweils additiv): `engine/src/{types,catalog,engine,ctx,l3,l3v6,view,controller,cabling,index}.ts`, `svc/{tcp,dhcpclient}.ts`,
`devices/host.ts`, `protocols/src/{types,pdu}.ts`, `cli/src/{parser,session,commands,render,shell,hostshell,ifnames,index}.ts`,
`apps/web/src/{store,icons,App,main}.tsx`, `components/{DevicePanel,DeviceDialog,Palette,Canvas,MenuBar,PortPicker}.tsx`,
`engine/engine.worker.ts`, `apps/web/test/i18n.test.ts` (lädt zusätzlich `*.phase5.json`), Docs. 25. **ECMP:** `DynRoute`/`RibEntry` dürfen je Präfix mehrere gleichwertige Einträge haben; `lookupRibPaths` liefert alle Pfade mit gleichem Präfix/AD und gleicher Metrik (oder gesetztem `share`),
`pickPath` wählt je Fluss per FNV-Hash über Quelle/Ziel (deterministisch, gewichtet bei `share`). `IpNode.lookup(dst, src?)` bekommt dafür die Quelladresse.
`Engine.routingTable` liefert nur installierte Routen (`installedRoutes`: niedrigste AD je Präfix). 26. **Policies zentral:** Prefix-Lists, Community-Listen und Route-Maps liegen im `RoutingCfg` (`routing/routemap.ts`); BGP wendet Eingangs-Policy erst beim Neuberechnen auf die unveränderte Adj-RIB-In an,
Redistribution ruft `evalRouteMap` in `redistSource(6)` auf. `distribute-list` filtert beim Installieren/Ankündigen und stößt bei Konfigurationsänderung eine Neuberechnung an. 27. **OSPF-Bereichstypen:** Hello-Pakete tragen den Bereichstyp (Stub/NSSA-Mismatch verwirft Hellos); Typ-5-LSAs werden nicht in Stub/NSSA geflutet, Typ 7 nur im Bereich; die Übersetzung (7→5)
macht der ABR mit der höchsten Router-ID im NSSA-Bereich und setzt dafür das ASBR-Bit. Ein Fehler im Flooding (Typ 5 wurde in gemischten LSUs nicht in andere Bereiche weitergegeben) wurde dabei behoben. 28. **Virtual Links** sind Pseudo-Schnittstellen `vl-<RID>` (Area 0, Point-to-Point) mit Unicast-Verkehr durch die Transit-Area; Next Hops zum Peer stammen aus dem SPF der Transit-Area (Backbone wird zuletzt berechnet). 29. **HSRP-Modell:** Gruppen sind `Slot`s (Schnittstelle + Gruppe + Familie); IPv6-Gruppen liegen in `IfaceCfg.hsrp6`, die Version in `IfaceCfg.hsrpVersion`. Die virtuelle IPv6-Adresse wird über `Node6.vips`
lokal zugestellt und per NA mit der virtuellen MAC beantwortet. 30. **DAD:** Adressen sind `tentative` (nicht in `Iface6.addrs`), bis der 1-s-Timer ohne Konflikt abläuft; der Zustand liegt in `IpCore.dad`. Router stoßen DAD in `routingSync`, Hosts in `hostV6` und bei RA an. 31. **Uhr:** `SysConfig.clock` speichert Basiszeit + virtuellen Zeitpunkt des Setzens; Anzeige und `debug`-Stempel rechnen daraus (`packages/cli/src/clock.ts`). 33. **Fixes-Runde:** Event-Log begrenzt mit monotonen Ids (`logOffset`), Firewall-NAT je Regel mit Schnittstellenpaar (`NatRule/NatEntry.fromIf/toIf`; `natSide` bleibt nur für Router-NAT),
WLAN-Roaming im selben SSID behält das DHCP-Lease (INIT-REBOOT, Zustand `rebooting`), NTP-Verlust nach 4 verpassten Abfragen (Details in `simplifications.md`).

## TCP / BGP / Telnet / IoT-Skripte

33. **Ein TCP für alle Dienste:** statt eines zweiten Stacks wurde der Phase-5-Dienst-Transport (`p5/conn.ts`) zu einem zuverlässigen Nachrichtenstrom ausgebaut
    (Retransmission, Duplikaterkennung, RST/FIN). BGP, Telnet, SSH, FTP, SMTP, POP3 nutzen ihn; neue Dienste registrieren nur `TcpServer` + Port.
34. **BGP-Nachrichten im `SvcPdu`** (`proto: 'bgp'`, Feld `bgp`) statt eines eigenen TCP-Anwendungstyps; der `RoutingPdu`-Typ `bgp` bleibt nur als Typ erhalten.
35. **Eingehende ACL für lokal zugestellten Unicast-Verkehr** (BGP/Telnet/SSH, IKE/ESP, Ping zum Router): die ACL-Auswertung ist dazu in `aclInPermits` (l3.ts) ausgelagert.
36. **Telnet/SSH-Ausführung bleibt lokal:** die Ziel-CLI läuft weiter als `CliSession` im Worker; über das Netz gehen Zeile (`line`) und Ausgabe (`out`) – so bleiben
    vty-Limits, AAA, `terminal monitor` und Session-Abbau unverändert (siehe `simplifications.md`).
37. **IoT-Skripte ohne `eval`:** eigener Interpreter statt `new Function` (Prototyp-Ausbrüche), Zustand als JSON (Variablen des Hauptteils) und stille Neuauswertung
    pro Aktivierung, damit Snapshots/Step-Back/`.nsim` ohne Closures funktionieren.

## Erweiterungen proto

32. **EIGRP für IPv6 verallgemeinert `eigrp.ts`** statt Kopie: Prozesse in `RoutingCfg.eigrp6`, IPv6-Schnittstellen als Pseudo-Schnittstellen (wie OSPFv3), `v: 6` im Routing-PDU, Timer-Präfix `rt:eigrp6`. Neue Prozesse starten wie bei IOS im Zustand `shutdown`.
33. **WPA2-Enterprise asynchron:** Die Assoziation wartet auf das RADIUS-Ergebnis des APs (`ap.eap`, Status `authenticating`); wirelessSync wird nach Access-Accept/-Reject/Timeout neu ausgelöst. Der AP ist immer Authenticator.
34. **TACACS+ über die gemeinsame TCP-Schicht** (`p5/conn.ts`, Port 49) mit Client-Hook `tacacsClientHook` und Server `tacacsServer`; die Anmeldung nutzt dieselbe Warteliste (`aaaWait`) wie RADIUS.
35. **SNMP-Traps:** eigene `svc`-Nachricht `snmp/trap` (UDP 162), Trap-Typen als Konfigurationsmenge; Empfang in `services.snmp.traps`.
36. **PPPoE/PPP:** neue Schnittstellenarten `dialer`, `vtemplate`, `vaccess`; Sitzungen als Laufzeitzustand `L3Cfg.ppp`, IP-Schnittstellen erscheinen nur bei stehender Sitzung (`pppIfaces`). PPPoE-Frames werden vor der Schnittstellenzuordnung in `routerRx` abgefangen.
37. **IPsec:** Crypto-Map-Prüfung im `xmit` der Schnittstelle (`cryptoXmit`), ESP als IP-Nutzlast mit verborgenem `inner`, IKE als ein Austausch; SAs sind Laufzeitzustand in `L3Cfg.crypto.sas`. Kein VTI.
38. **Neue Protokoll-Tags** `TACACS`, `PPPOE`, `PPP`, `IKE`, `ESP`; Farben in `apps/web/src/proto.css` (Tokens), Übersetzungen in `i18n/{de,en}.proto.json`.

## Realismus-Runde CCNA (Branch `wip/ccna`)

39. **CDP/LLDP als eigene PDUs** (`cdp`, `lldp`) mit Ziel-MAC `01:00:0c:cc:cc:cc` bzw. `01:80:c2:00:00:0e`; sie werden in `Engine.onRx` vor der Gerätelogik verbraucht (`discRx`), also nie weitergeleitet (anders als echte Switches bei `no cdp run`). Timer laufen als `bg:`-Timer (zählen nicht als „Arbeit“ für `runAll`), erster Advertisement-Versand 2 s nach Start bzw. 1 s nach Link-Up. Nachbartabellen liegen im Konfigurationsbaum (`L3Cfg.disc`) und werden bei Hold-Time-Ablauf beim Lesen gefiltert.
40. **Switch-Sicherheit in `devices/swsec.ts`:** ein Eingangs-Hook `securityIngress` (Storm Control → DHCP Snooping → DAI) nach der Port-Security-Prüfung und vor dem MAC-Lernen. DHCP-Snooping fügt Option 82 in einen geklonten Frame ein; der Original-Frame im Log bleibt unverändert.
41. **Option-82-Verhalten wie IOS:** DHCP-Server/Relay (Router) verwirft Anfragen mit Option 82 und giaddr 0, solange `ip dhcp relay information trust-all` (global) bzw. `… trusted` (Schnittstelle) fehlt.
42. **errdisable generalisiert:** `errdisableRecovery.causes` (neben dem alten Flag `psecure`), gemeinsame Funktion `errdisable()` schreibt `%PM-4-ERR_DISABLE` und plant die Wiederherstellung (`%PM-4-ERR_RECOVER`).
43. **IPv6-ACLs** in `L3Cfg.acls6`, Auswertung in `forward6` (nur Durchgangsverkehr, wie die v4-ACLs); `deny` antwortet mit ICMPv6 Code 1.
44. **QoS** in `L3Cfg.qos` (class-map/policy-map) mit Anwendung in `forward()` (Eingang nach der ACL, Ausgang vor der ACL); DSCP als optionales Feld `Ipv4Pdu.dscp`.
45. **Neue CLI-Modi** `config-arp-nacl`, `config-ipv6-acl`, `config-cmap`, `config-pmap`, `config-pmap-c`; Klassen-/Policy-Namen laufen über die Sitzungsfelder `aclName`/`poolName`.
46. **NTP-Authentifizierung** über die vorhandenen `svc`-Argumente (`keyId`, `digest`, Antwort `auth`); Der Server antwortet authentifiziert, wenn Key-ID und Schlüssel übereinstimmen; der Client akzeptiert Server mit `key N` nur bei `ntp authenticate`, `trusted-key N` und authentifizierter Antwort.
