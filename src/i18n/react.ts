import { useSyncExternalStore } from 'react';
import { getLocale, subscribeLocale, translate, type Locale } from './index';

/** Re-renders the calling component when the interface language changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

const languages = {
  en: { locale: 'en', t: translate.bind(null, 'en') },
  tr: { locale: 'tr', t: translate.bind(null, 'tr') },
} as const;

export function useTranslation() {
  return languages[useLocale()];
}
