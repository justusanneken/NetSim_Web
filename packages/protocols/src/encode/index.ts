/**
 * Byte-Encoder: erzeugt aus den strukturierten PDUs reale Wire-Bytes (für PCAP-Export und Hex-Ansicht).
 * Siehe docs/simplifications.md („PCAP-Export“) für Protokolle ohne echtes Wire-Format.
 */
export { encodeFrame, encodeArp, encodeBpdu, encodeVtp, encodePppoe } from './l2';
export { encodeIpv4, encodeIpv6, encodeIcmp, encodeIcmp6, encodeUdp, encodeTcp } from './ip';
export { encodeOspf, encodeEigrp, encodeBgp, encodeLsa, lsaChecksum } from './routing';
export { encodeDhcp, encodeDhcp6, encodeDns, encodeRip, encodeHsrp, encodeSvc } from './apps';
export { writePcap, hexDump, PCAP_EPOCH_SEC, type PcapRecord } from './pcap';
export { inetChecksum } from './bytes';
