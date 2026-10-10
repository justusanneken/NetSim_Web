import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import de from './de.json';
import en from './en.json';
import de5 from './de.phase5.json';
import en5 from './en.phase5.json';
import deProto from './de.proto.json';
import enProto from './en.proto.json';
import deT from './de.tcp.json';
import enT from './en.tcp.json';
import deTeach from './de.teach.json';
import enTeach from './en.teach.json';
import deScript from './de.script.json';
import enScript from './en.script.json';
import dePersist from './de.persist.json';
import enPersist from './en.persist.json';
import deUx from './de.ux.json';
import enUx from './en.ux.json';
import deCcna from './de.ccna.json';
import enCcna from './en.ccna.json';

export type Lang = 'de' | 'en';

function storedLang(): Lang {
  try {
    const v = localStorage.getItem('netsim.lang');
    if (v === 'de' || v === 'en') return v;
  } catch {
    /* Speicher nicht verfügbar */
  }
  return 'de';
}

void i18next.use(initReactI18next).init({
  resources: {
    de: {
      translation: {
        ...de,
        ...de5,
        ...deT,
        ...deProto,
        ...dePersist,
        ...deUx,
        ...deCcna,
        ...deTeach,
        ...deScript,
      },
    },
    en: {
      translation: {
        ...en,
        ...en5,
        ...enT,
        ...enProto,
        ...enPersist,
        ...enUx,
        ...enCcna,
        ...enTeach,
        ...enScript,
      },
    },
  },
  lng: storedLang(),
  fallbackLng: 'de',
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
});

export function setLang(lang: Lang): void {
  void i18next.changeLanguage(lang);
  document.documentElement.lang = lang;
  try {
    localStorage.setItem('netsim.lang', lang);
  } catch {
    /* ignorieren */
  }
}

export default i18next;
