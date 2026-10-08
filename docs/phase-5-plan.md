# Phase 5 – Plan und Abnahme

Umfang: Wireless (AP/WLC), Server-Dienste (Mail, FTP, TFTP, NTP, Syslog, SNMP, AAA), SSH/Telnet mit mehreren
CLI-Sitzungen, Firewall (ASA-ähnlich), IoT, Cloud/Modem, Physical View, neue Gerätetypen (Tablet, Smartphone,
Drucker, AP, WLC, Firewall, Cloud, DSL-/Kabelmodem, IoT-Sensor/-Aktor, SBC).

Reihenfolge (test-first): Protokoll-PDU `svc` → Gerätekatalog/Kabel → WLAN (Assoziation, AP-Bridge, WLC) →
Dienst-Transport (`p5/conn.ts` TCP-Sitzungen, `p5/udputil.ts` UDP-Anfragen) und Dienste → Firewall → IoT →
Cloud/Modem/Module/Physical → CLI (Befehle, Render/Replay, Shell-Stapel für Telnet/SSH) → GUI → Doku.

Code-Organisation: neuer Code lebt in `packages/engine/src/p5/*` (Zugriff über `engine.p5`), `p5types.ts`,
`p5defaults.ts`, `service5.ts` sowie `packages/cli/src/{commands5,show5,render5,remote,shellstack,ftpshell}.ts`
und `apps/web/src/components/Panel{Wireless,Services5,Mgmt,Physical}.tsx`. Gemeinsame Dateien wurden nur
minimal und additiv geändert (siehe Übergabeprotokoll in `decisions.md`).

## Abnahmetests

| Kriterium                                                                                   | Test                                                                                                                       |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| WLAN-Client assoziiert, DHCP über den AP, Ping zum kabelgebundenen Server                   | `engine/test/wifi.test.ts › Client verbindet sich per WPA2…`                                                               |
| SSH nur mit korrekten Zugangsdaten und `transport input ssh`                                | `engine/test/svc5.test.ts › SSH nur mit Domain + Schlüssel…`, `cli/test/phase5.test.ts › SSH nur mit transport input ssh…` |
| TFTP-Backup/Restore (Round Trip)                                                            | `engine/test/svc5.test.ts › TFTP`, `cli/test/phase5.test.ts › TFTP-Backup`                                                 |
| NTP synchronisiert Uhren (Router, Host)                                                     | `engine/test/svc5.test.ts › NTP / Uhr`, `cli/test/phase5.test.ts › clock set…`                                             |
| Syslog-Server empfängt Link-down-Meldungen                                                  | `engine/test/svc5.test.ts › Syslog`                                                                                        |
| Firewall: inside→outside erlaubt, Rückverkehr erlaubt, outside→inside blockiert (außer ACL) | `engine/test/fw.test.ts › Firewall`, `cli/test/phase5.test.ts › Firewall`                                                  |
| IoT-Regel schaltet einen Aktor                                                              | `engine/test/svc5.test.ts › IoT`                                                                                           |
| Mehrere vty-Sitzungen parallel, `terminal monitor`                                          | `cli/test/phase5.test.ts › Mehrere vty-Sitzungen…`                                                                         |
| End-to-End (Browser)                                                                        | `apps/web/e2e/phase5.spec.ts` (WLAN-Ping, Telnet/SSH, TFTP-Backup, Firewall, Physical View)                                |

Bekannte Lücken: siehe `simplifications.md` (Abschnitt Phase 5) und `coverage-matrix.md`.
