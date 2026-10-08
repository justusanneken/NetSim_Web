# Phase 4 – Plan und Abnahme

Umfang: RIPv2, OSPF (Einzel-/Multi-Area), EIGRP, HSRP, GRE, Redistribution, IPv6 (statisch, ND, SLAAC, OSPFv3), BGP-Grundlagen, `debug`.

Reihenfolge: PDUs/Adress-Helfer → Routing-Kern (`routing/`) mit RIP → OSPF → EIGRP → HSRP/GRE → BGP → IPv6-Stack + OSPFv3 → CLI (Befehle, show, render/Replay, debug) → GUI → Doku.

Abnahme: `engine/test/ospf.test.ts` (4-Router-Ring, Failover), `eigrp.test.ts` (Feasible Successor, Query/Reply), `hsrp_gre.test.ts`, `bgp.test.ts`, `ipv6.test.ts`, `redistribute.test.ts`; `cli/test/phase4.test.ts` (inkl. debug-Ausgabe und running-config-Replay); `web/e2e/phase4.spec.ts`.
