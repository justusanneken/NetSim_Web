import { isValidIpv4 } from '@netsim/protocols';
import {
  newCrypto,
  newPolicy,
  type CryptoCfg,
  type CryptoMapEntry,
  type IsakmpPolicy,
} from '@netsim/engine';
import { targets } from './commands';
import { l3c, touch } from './commandsGaps';
import { IFM } from './ifnames';
import { K, P, R, choice, opt, type ModeId, type Registry } from './parser';
import { CliError, type CliSession } from './session';
import * as showProto from './showIpsec';

const CF: ModeId[] = ['config'];
const PO: ModeId[] = ['config-isakmp'];
const TS: ModeId[] = ['config-trans'];
const CM: ModeId[] = ['config-crypto-map'];
const U: ModeId[] = ['user', 'priv'];
const CRYPTO = K('crypto', 'Encryption module');

const crypto = (s: CliSession): CryptoCfg => (l3c(s).crypto ??= newCrypto());
const policy = (s: CliSession): IsakmpPolicy => {
  const p = crypto(s).policies[s.procId];
  if (!p) throw new CliError('% ISAKMP policy does not exist');
  return p;
};
const mapEntry = (s: CliSession): CryptoMapEntry => {
  const e = crypto(s).maps[s.poolName]?.entries[s.procId];
  if (!e) throw new CliError('% Crypto map entry does not exist');
  return e;
};

/** IPsec Site-to-Site (Crypto Maps): ISAKMP-Policy, Schlüssel, Transform-Sets, Crypto Maps, show/clear. */
export function addIpsec(r: Registry<CliSession>): void {
  // ------------------------------------------------------------ ISAKMP
  r.add({
    modes: CF,
    only: 'router',
    negatable: true,
    slots: [
      CRYPTO,
      K('isakmp', 'Configure ISAKMP policy'),
      K('policy', 'Set policy for an ISAKMP protection suite'),
      P('n', 'int', '<1-10000>', 'Priority of protection suite', [1, 10000]),
    ],
    run: (s, a) => {
      const n = Number(a.n);
      if (s.negated) {
        delete crypto(s).policies[n];
        touch(s);
        return;
      }
      crypto(s).policies[n] ??= newPolicy(n);
      s.procId = n;
      s.mode = 'config-isakmp';
    },
  });
  r.add({
    modes: PO,
    only: 'router',
    negatable: true,
    slots: [
      K('encryption', 'Set encryption algorithm for protection suite'),
      choice(
        'e',
        ['des', 'DES-CBC'],
        ['3des', 'Three key triple DES'],
        ['aes', 'AES - Advanced Encryption Standard'],
      ),
      opt(P('bits', 'int', '<128|192|256>', 'Key size')),
    ],
    run: (s, a) => {
      policy(s).encr = s.negated ? 'des' : (a.e as 'des' | '3des' | 'aes');
    },
  });
  r.add({
    modes: PO,
    only: 'router',
    negatable: true,
    slots: [
      K('hash', 'Set hash algorithm for protection suite'),
      choice('h', ['md5', 'Message Digest 5'], ['sha', 'Secure Hash Standard']),
    ],
    run: (s, a) => {
      policy(s).hash = s.negated ? 'sha' : (a.h as 'md5' | 'sha');
    },
  });
  r.add({
    modes: PO,
    only: 'router',
    negatable: true,
    slots: [
      K('authentication', 'Set authentication method for protection suite'),
      choice('m', ['pre-share', 'Pre-Shared Key'], ['rsa-sig', 'Rivest-Shamir-Adleman Signature']),
    ],
    run: (s, a) => {
      policy(s).auth = s.negated ? 'rsa-sig' : (a.m as 'pre-share' | 'rsa-sig');
    },
  });
  r.add({
    modes: PO,
    only: 'router',
    negatable: true,
    slots: [
      K('group', 'Set the Diffie-Hellman group'),
      choice(
        'g',
        ['1', '768 bit Diffie-Hellman'],
        ['2', '1024 bit Diffie-Hellman'],
        ['5', '1536 bit Diffie-Hellman'],
      ),
    ],
    run: (s, a) => {
      policy(s).group = s.negated ? 1 : (Number(a.g) as 1 | 2 | 5);
    },
  });
  r.add({
    modes: PO,
    only: 'router',
    negatable: true,
    slots: [
      K('lifetime', 'Set lifetime for ISAKMP security association'),
      P('sec', 'int', '<60-86400>', 'lifetime in seconds', [60, 86400]),
    ],
    run: (s, a) => {
      policy(s).lifetime = s.negated ? 86400 : Number(a.sec);
    },
  });
  r.add({
    modes: CF,
    only: 'router',
    negatable: true,
    slots: [
      CRYPTO,
      K('isakmp', 'Configure ISAKMP policy'),
      K('key', 'Set pre-shared key for remote peer'),
      P('key', 'word', 'WORD', 'pre-shared key'),
      K('address', 'define shared key with IP address'),
      P('addr', 'ip', 'A.B.C.D', 'Peer address'),
      opt(P('mask', 'mask', 'A.B.C.D', 'Peer mask')),
    ],
    run: (s, a) => {
      const c = crypto(s);
      const addr = a.addr as string;
      c.keys = c.keys.filter((k) => k.addr !== addr);
      if (!s.negated)
        c.keys.push({ key: a.key as string, addr, mask: a.mask ?? '255.255.255.255' });
    },
  });

  // ------------------------------------------------------------ Transform-Set
  r.add({
    modes: CF,
    only: 'router',
    negatable: true,
    slots: [
      CRYPTO,
      K('ipsec', 'Configure IPSEC policy'),
      K('transform-set', 'Define transform and settings'),
      P('name', 'word', 'WORD', 'Transform set tag'),
      opt(
        R(
          't',
          'TRANSFORM',
          'ESP transforms (esp-aes, esp-3des, esp-des, esp-sha-hmac, esp-md5-hmac)',
        ),
      ),
    ],
    run: (s, a) => {
      const name = a.name as string;
      const c = crypto(s);
      if (s.negated) {
        delete c.transformSets[name];
        touch(s);
        return;
      }
      if (a.t) {
        const ts = (a.t as string).split(/\s+/).filter(Boolean);
        if (!ts.every((x) => /^esp-/.test(x))) throw new CliError('% Invalid transform');
        c.transformSets[name] = {
          name,
          transforms: ts,
          mode: c.transformSets[name]?.mode ?? 'tunnel',
        };
      } else if (!c.transformSets[name]) throw new CliError('% Incomplete command.');
      s.poolName = name;
      s.mode = 'config-trans';
    },
  });
  r.add({
    modes: TS,
    only: 'router',
    negatable: true,
    slots: [
      K('mode', 'encapsulation mode (transport/tunnel)'),
      choice('m', ['tunnel', 'IPSEC tunneling mode'], ['transport', 'IPSEC transport mode']),
    ],
    run: (s, a) => {
      const ts = crypto(s).transformSets[s.poolName];
      if (ts) ts.mode = s.negated ? 'tunnel' : (a.m as 'tunnel' | 'transport');
    },
  });

  // ------------------------------------------------------------ Crypto Map
  r.add({
    modes: CF,
    only: 'router',
    negatable: true,
    slots: [
      CRYPTO,
      K('map', 'Enter a crypto map'),
      P('name', 'word', 'WORD', 'Crypto map tag'),
      opt(P('seq', 'int', '<1-65535>', 'Sequence to insert into crypto map entry', [1, 65535])),
      opt(choice('t', ['ipsec-isakmp', 'IPSEC w/ISAKMP'])),
    ],
    run: (s, a) => {
      const c = crypto(s);
      const name = a.name as string;
      if (s.negated) {
        if (a.seq) delete c.maps[name]?.entries[Number(a.seq)];
        else delete c.maps[name];
        touch(s);
        return;
      }
      if (!a.seq || !a.t) throw new CliError('% Incomplete command.');
      const seq = Number(a.seq);
      const m = (c.maps[name] ??= { name, entries: {} });
      m.entries[seq] ??= { seq };
      s.poolName = name;
      s.procId = seq;
      s.mode = 'config-crypto-map';
    },
  });
  r.add({
    modes: CM,
    only: 'router',
    negatable: true,
    slots: [
      K('set', 'Set values for encryption/decryption'),
      K('peer', 'Allowed Encryption/Decryption peer address'),
      P('ip', 'ip', 'A.B.C.D', 'IP address of peer'),
    ],
    run: (s, a) => {
      if (!isValidIpv4(a.ip as string)) throw new CliError('% Invalid IP address');
      mapEntry(s).peer = s.negated ? undefined : (a.ip as string);
      touch(s);
    },
  });
  r.add({
    modes: CM,
    only: 'router',
    negatable: true,
    slots: [
      K('set', 'Set values for encryption/decryption'),
      K('transform-set', 'Specify list of transform sets in priority order'),
      P('name', 'word', 'WORD', 'Transform set tag'),
    ],
    run: (s, a) => {
      mapEntry(s).transformSet = s.negated ? undefined : (a.name as string);
    },
  });
  r.add({
    modes: CM,
    only: 'router',
    negatable: true,
    slots: [
      K('match', 'Match values for encryption/decryption'),
      K('address', 'Match address of packets to encrypt'),
      P('acl', 'word', 'WORD', 'IP access-list number or name'),
    ],
    run: (s, a) => {
      mapEntry(s).acl = s.negated ? undefined : (a.acl as string);
    },
  });
  r.add({
    modes: CM,
    only: 'router',
    negatable: true,
    slots: [
      K('set', 'Set values for encryption/decryption'),
      K('pfs', 'Specify pfs settings'),
      opt(
        choice('g', ['group1', 'D-H Group1'], ['group2', 'D-H Group2'], ['group5', 'D-H Group5']),
      ),
    ],
    run: (s, a) => {
      mapEntry(s).pfs = s.negated ? undefined : (a.g ?? 'group1');
    },
  });
  r.add({
    modes: CM,
    only: 'router',
    negatable: true,
    slots: [
      K('set', 'Set values for encryption/decryption'),
      K('security-association', 'Security association parameters'),
      K('lifetime', 'Security association lifetime'),
      K('seconds', 'Security association lifetime in seconds'),
      P('sec', 'int', '<120-86400>', 'Seconds', [120, 86400]),
    ],
    run: (s, a) => {
      mapEntry(s).lifetimeSec = s.negated ? undefined : Number(a.sec);
    },
  });

  // ------------------------------------------------------------ Schnittstelle
  r.add({
    modes: IFM,
    only: 'router',
    negatable: true,
    slots: [
      CRYPTO,
      K('map', 'Assign a crypto map set'),
      P('name', 'word', 'WORD', 'Crypto map tag'),
    ],
    run: (s, a) => {
      for (const id of targets(s)) {
        s.engine.ensureIface(s.deviceId, id);
        const ic = l3c(s).ifaces[id];
        if (ic) ic.cryptoMap = s.negated ? undefined : (a.name as string);
      }
      touch(s);
    },
  });

  // ------------------------------------------------------------ show / clear
  const sh = (words: [string, string][], run: (s: CliSession) => string[]): void => {
    r.add({
      modes: U,
      only: 'router',
      slots: [
        K('show', 'Show running system information'),
        CRYPTO,
        ...words.map(([w, h]) => K(w, h)),
      ],
      run: (s) => s.outLines(run(s)),
    });
  };
  sh(
    [
      ['isakmp', 'Show ISAKMP information'],
      ['sa', 'Show ISAKMP security associations'],
    ],
    (s) => showProto.showIsakmpSa(s.device),
  );
  sh(
    [
      ['isakmp', 'Show ISAKMP information'],
      ['policy', 'Show ISAKMP protection suite policy'],
    ],
    (s) => showProto.showIsakmpPolicy(s.device),
  );
  sh(
    [
      ['ipsec', 'Show IPSEC policy'],
      ['sa', 'IPSEC security associations'],
    ],
    (s) => showProto.showIpsecSa(s.device),
  );
  sh(
    [
      ['ipsec', 'Show IPSEC policy'],
      ['transform-set', 'Crypto transform sets'],
    ],
    (s) => showProto.showTransformSets(s.device),
  );
  sh([['map', 'Crypto maps']], (s) => showProto.showCryptoMap(s.device));
  r.add({
    modes: ['priv'],
    only: 'router',
    slots: [
      K('clear', 'Reset functions'),
      CRYPTO,
      choice(
        'what',
        ['sa', 'Clear IPSEC security associations'],
        ['isakmp', 'Clear ISAKMP connections'],
      ),
    ],
    run: (s) => s.engine.clearCrypto(s.deviceId),
  });
}
