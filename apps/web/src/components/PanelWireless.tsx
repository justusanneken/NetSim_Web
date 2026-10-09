import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CHANNELS, type DeviceView, type WifiBand } from '@netsim/engine';
import { api } from '../engine/client';
import { useCall } from './util5';

type Sec = 'open' | 'wpa2-psk' | 'wpa2-enterprise';
const secLabel = (s: Sec, open: string): string =>
  s === 'open' ? open : s === 'wpa2-psk' ? 'WPA2-PSK' : 'WPA2-Enterprise';

/** RADIUS-Server (Adresse + Shared Secret) für WPA2-Enterprise. */
function RadiusFields(props: {
  suffix: string;
  host: string;
  secret: string;
  disabled?: boolean;
  onHost(v: string): void;
  onSecret(v: string): void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <label>
        {t('ap.radiusHost')}
        <input
          aria-label={`${t('ap.radiusHost')} ${props.suffix}`}
          value={props.host}
          disabled={props.disabled}
          placeholder="10.0.0.10"
          onChange={(e) => props.onHost(e.target.value)}
        />
      </label>
      <label>
        {t('ap.radiusSecret')}
        <input
          aria-label={`${t('ap.radiusSecret')} ${props.suffix}`}
          type="password"
          value={props.secret}
          disabled={props.disabled}
          onChange={(e) => props.onSecret(e.target.value)}
        />
      </label>
    </>
  );
}

/** Access Point: SSID, Sicherheit, Band/Kanal je Funkmodul, WLC-Adresse, assoziierte Clients. */
export function ApPanel({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const call = useCall();
  const ap = dev.p5?.ap;
  const [wlc, setWlc] = useState(ap?.wlc ?? '');
  if (!ap) return null;
  return (
    <>
      <h4>{t('ap.title')}</h4>
      {ap.radios.map((r) => (
        <RadioForm key={r.band} dev={dev} band={r.band} />
      ))}
      <label>
        {t('ap.wlc')}
        <div className="form inline">
          <input
            aria-label={t('ap.wlc')}
            value={wlc}
            placeholder="10.0.0.5"
            onChange={(e) => setWlc(e.target.value)}
          />
          <button onClick={() => void call(api.setApController(dev.id, wlc.trim()))}>
            {t('common.apply')}
          </button>
        </div>
      </label>
      {ap.wlc && (
        <p className="muted small">
          {ap.managed ? t('ap.managed', { wlc: ap.wlc }) : t('ap.joining', { wlc: ap.wlc })}
        </p>
      )}
      <h4>{t('ap.clients')}</h4>
      {ap.clients.length === 0 ? (
        <p className="muted small">{t('panel.empty')}</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>MAC</th>
              <th>SSID</th>
              <th>{t('ap.band')}</th>
            </tr>
          </thead>
          <tbody>
            {ap.clients.map((c) => (
              <tr key={c.port}>
                <td className="mono">{c.mac}</td>
                <td>{c.ssid}</td>
                <td>
                  {c.band} GHz / {c.channel}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">
        {t('ap.range', { r24: ap.range['2.4'] ?? 0, r5: ap.range['5'] ?? 0 })}
      </p>
    </>
  );
}

function RadioForm({ dev, band }: { dev: DeviceView; band: WifiBand }) {
  const { t } = useTranslation();
  const call = useCall();
  const r = dev.p5?.ap?.radios.find((x) => x.band === band);
  const [ssid, setSsid] = useState(r?.ssid ?? '');
  const [sec, setSec] = useState(r?.security ?? 'open');
  const [key, setKey] = useState(r?.key ?? '');
  const [rHost, setRHost] = useState(r?.radius?.host ?? '');
  const [rSecret, setRSecret] = useState(r?.radius?.secret ?? '');
  const [ch, setCh] = useState(r?.channel ?? CHANNELS[band][0]);
  const [on, setOn] = useState(r?.enabled ?? true);
  const managed = dev.p5?.ap?.managed === true;
  if (!r) return null;
  return (
    <fieldset className="radio-box">
      <legend>{band} GHz</legend>
      <div className="form">
        <label className="inline-check">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
          {t('ap.enabled')}
        </label>
        <label>
          SSID
          <input
            aria-label={`SSID ${band}`}
            value={ssid}
            disabled={managed}
            onChange={(e) => setSsid(e.target.value)}
          />
        </label>
        <label>
          {t('ap.security')}
          <select
            aria-label={`${t('ap.security')} ${band}`}
            value={sec}
            disabled={managed}
            onChange={(e) => setSec(e.target.value as Sec)}
          >
            <option value="open">{t('ap.open')}</option>
            <option value="wpa2-psk">WPA2-PSK</option>
            <option value="wpa2-enterprise">WPA2-Enterprise</option>
          </select>
        </label>
        {sec === 'wpa2-psk' && (
          <label>
            {t('ap.key')}
            <input
              aria-label={`${t('ap.key')} ${band}`}
              value={key}
              disabled={managed}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
        )}
        {sec === 'wpa2-enterprise' && (
          <RadiusFields
            suffix={band}
            host={rHost}
            secret={rSecret}
            disabled={managed}
            onHost={setRHost}
            onSecret={setRSecret}
          />
        )}
        <label>
          {t('ap.channel')}
          <select
            aria-label={`${t('ap.channel')} ${band}`}
            value={ch}
            onChange={(e) => setCh(Number(e.target.value))}
          >
            {CHANNELS[band].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={() =>
            void call(
              api.setApRadio(dev.id, band, {
                enabled: on,
                ssid: managed ? r.ssid : ssid.trim(),
                security: managed ? r.security : sec,
                key: sec === 'wpa2-psk' ? key : undefined,
                radius:
                  sec === 'wpa2-enterprise' ? { host: rHost.trim(), secret: rSecret } : undefined,
                channel: ch,
              }),
              'toast.saved',
            )
          }
        >
          {t('common.apply')}
        </button>
      </div>
    </fieldset>
  );
}

/** WLC: zentrale WLANs und beigetretene Lightweight-APs. */
export function WlcPanel({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const call = useCall();
  const wlc = dev.p5?.wlc;
  const [ssid, setSsid] = useState('');
  const [sec, setSec] = useState<Sec>('wpa2-psk');
  const [key, setKey] = useState('');
  const [rHost, setRHost] = useState('');
  const [rSecret, setRSecret] = useState('');
  const [band, setBand] = useState<'both' | WifiBand>('both');
  if (!wlc) return null;
  return (
    <>
      <h4>{t('wlc.wlans')}</h4>
      {wlc.wlans.length === 0 ? (
        <p className="muted small">{t('panel.empty')}</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>SSID</th>
              <th>{t('ap.security')}</th>
              <th>{t('ap.band')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {wlc.wlans.map((w) => (
              <tr key={w.id}>
                <td>{w.ssid}</td>
                <td>{secLabel(w.security, t('ap.open'))}</td>
                <td>{w.band === 'both' ? t('wlc.both') : `${w.band} GHz`}</td>
                <td>
                  <button
                    aria-label={`${t('common.remove')} ${w.ssid}`}
                    onClick={() => void call(api.wlcRemoveWlan(dev.id, w.id))}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="form">
        <label>
          SSID
          <input aria-label="WLAN SSID" value={ssid} onChange={(e) => setSsid(e.target.value)} />
        </label>
        <label>
          {t('ap.security')}
          <select
            aria-label={`WLAN ${t('ap.security')}`}
            value={sec}
            onChange={(e) => setSec(e.target.value as Sec)}
          >
            <option value="open">{t('ap.open')}</option>
            <option value="wpa2-psk">WPA2-PSK</option>
            <option value="wpa2-enterprise">WPA2-Enterprise</option>
          </select>
        </label>
        {sec === 'wpa2-psk' && (
          <label>
            {t('ap.key')}
            <input
              aria-label={`WLAN ${t('ap.key')}`}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
        )}
        {sec === 'wpa2-enterprise' && (
          <RadiusFields
            suffix="WLAN"
            host={rHost}
            secret={rSecret}
            onHost={setRHost}
            onSecret={setRSecret}
          />
        )}
        <label>
          {t('ap.band')}
          <select value={band} onChange={(e) => setBand(e.target.value as 'both' | WifiBand)}>
            <option value="both">{t('wlc.both')}</option>
            <option value="2.4">2.4 GHz</option>
            <option value="5">5 GHz</option>
          </select>
        </label>
        <button
          onClick={() =>
            void call(
              api.wlcSetWlan(dev.id, {
                ssid: ssid.trim(),
                security: sec,
                key: sec === 'wpa2-psk' ? key : undefined,
                radius:
                  sec === 'wpa2-enterprise' ? { host: rHost.trim(), secret: rSecret } : undefined,
                band,
                enabled: true,
              }),
            ).then((ok) => ok && setSsid(''))
          }
        >
          {t('common.add')}
        </button>
      </div>
      <h4>{t('wlc.aps')}</h4>
      {wlc.aps.length === 0 ? (
        <p className="muted small">{t('panel.empty')}</p>
      ) : (
        <table className="grid">
          <tbody>
            {wlc.aps.map((a) => (
              <tr key={a.mac}>
                <td>{a.name}</td>
                <td>{a.ip}</td>
                <td className="mono">{a.mac}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** WLAN-Client (Desktop-App „PC Wireless“ / Wi-Fi-Profil). */
export function WifiClient({ dev }: { dev: DeviceView }) {
  const { t } = useTranslation();
  const call = useCall();
  const w = dev.p5?.wifi;
  const [ssid, setSsid] = useState('');
  const [key, setKey] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  if (!w) return <p className="muted pad">{t('wifi.noWifi')}</p>;
  return (
    <div className="pad scroll">
      <h4>{t('wifi.title')}</h4>
      <label className="inline-check">
        <input
          type="checkbox"
          checked={w.enabled}
          onChange={(e) => void call(api.wifiEnable(dev.id, e.target.checked))}
        />
        {t('wifi.enabled')}
      </label>
      <p aria-live="polite" className={`wifi-status ${w.status}`} data-testid="wifi-status">
        {w.status === 'connected' && w.assoc
          ? t('wifi.status.connected', {
              ssid: w.assoc.ssid,
              ap: w.assoc.ap,
              band: w.assoc.band,
              channel: w.assoc.channel,
            })
          : t(`wifi.status.${w.status}`)}
      </p>
      <h4>{t('wifi.profiles')}</h4>
      {w.profiles.length === 0 ? (
        <p className="muted small">{t('panel.empty')}</p>
      ) : (
        <ul className="ping-list">
          {w.profiles.map((p) => (
            <li key={p.ssid}>
              {p.ssid} {p.key ? '🔒' : ''}
              {p.username ? ` 802.1X (${p.username})` : ''}{' '}
              <button
                aria-label={`${t('common.remove')} ${p.ssid}`}
                onClick={() => void call(api.wifiRemoveProfile(dev.id, p.ssid))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="form">
        <label>
          SSID
          <input aria-label="SSID" value={ssid} onChange={(e) => setSsid(e.target.value)} />
        </label>
        <label>
          {t('wifi.key')}
          <input
            aria-label={t('wifi.key')}
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <label>
          {t('wifi.username')}
          <input
            aria-label={t('wifi.username')}
            value={user}
            onChange={(e) => setUser(e.target.value)}
          />
        </label>
        <label>
          {t('wifi.password')}
          <input
            aria-label={t('wifi.password')}
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
        </label>
        <button
          onClick={() =>
            void call(
              api.wifiAddProfile(
                dev.id,
                ssid.trim(),
                key || undefined,
                user.trim() ? { username: user.trim(), password: pass } : undefined,
              ),
            )
          }
        >
          {t('wifi.connect')}
        </button>
      </div>
      <p className="muted small">{t('wifi.bands', { bands: w.bands.join(' / ') })}</p>
    </div>
  );
}
