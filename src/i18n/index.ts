// The interface language. Turkish is the default, as in VEAcom 1.x; English is the alternative.
// This module has no React or DOM dependency of its own, so workers and tests can use it.
import { en } from './en';
import { tr } from './tr';

export type Locale = 'tr' | 'en';
export type MessageKey = keyof typeof en;
export type MessageParams = Record<string, string | number>;

export const LOCALES: readonly Locale[] = ['tr', 'en'];
export const DEFAULT_LOCALE: Locale = 'tr';
export const LOCALE_STORAGE_KEY = 'veacom:locale';
// Read as partial: a key that reached `t` through a cast (a place name from the main process) may be missing, and
// shows as itself. No English fallback: tr.ts is typed to carry every key.
const dictionaries: Record<Locale, Partial<Record<string, string>>> = { tr, en };
const listeners = new Set<() => void>();

export const isLocale = (value: unknown): value is Locale => value === 'tr' || value === 'en';
export const isMessageKey = (value: unknown): value is MessageKey => typeof value === 'string' && Object.hasOwn(en, value);

function initialLocale(): Locale {
  if (typeof window !== 'undefined') {
    // The desktop app passes the saved choice through its preload; a plain browser keeps it locally.
    const desktop = (window as { veacom?: { locale?: unknown } }).veacom?.locale;
    if (isLocale(desktop)) return desktop;
    try {
      const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
      if (isLocale(stored)) return stored;
    } catch { /* Storage may be disabled by the host. */ }
  }
  // Node (tests, tools) can choose with VEACOM_LOCALE, as the Electron main process does.
  const environment = typeof process === 'undefined' ? undefined : process.env.VEACOM_LOCALE;
  return isLocale(environment) ? environment : DEFAULT_LOCALE;
}

let current: Locale = initialLocale();
if (typeof document !== 'undefined') document.documentElement.lang = current;

export function getLocale(): Locale { return current; }

/** Switches the language for this context (window, worker or test) and notifies subscribers. */
export function setLocale(next: Locale): void {
  if (!isLocale(next) || next === current) return;
  current = next;
  // Uppercase headings (CSS text-transform) need the document language to give "İ" for "i".
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  for (const listener of [...listeners]) listener();
}

/** The user's choice: switches, then remembers it locally and in the desktop app's settings. */
export function chooseLocale(next: Locale): void {
  setLocale(next);
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(LOCALE_STORAGE_KEY, next); } catch { /* Storage may be disabled by the host. */ }
  const desktop = (window as { veacom?: { setLocale?: (locale: Locale) => Promise<void> } }).veacom;
  void desktop?.setLocale?.(next).catch(() => { /* The interface still switches; the next start uses the default. */ });
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The message for `key` in the current language, with each {name} replaced from `params`. */
export function t(key: MessageKey, params?: MessageParams): string {
  return format(dictionaries[current][key] ?? key, params);
}

export type Translator = typeof t;

/** The message in a given language, whatever the current one is. */
export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  return format(dictionaries[locale][key] ?? key, params);
}

function format(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => Object.hasOwn(params, name) ? String(params[name]) : placeholder);
}

/** An error that knows its message key, so the interface can show it in the current language. */
export class LocalizedError extends Error {
  readonly messageKey: MessageKey;
  readonly messageParams?: MessageParams;
  constructor(key: MessageKey, params?: MessageParams) {
    super(t(key, params));
    this.messageKey = key;
    this.messageParams = params;
  }
}

/** The text to show for a caught error: re-translated when it carries a message key. */
export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const { messageKey, messageParams } = error as { messageKey?: unknown; messageParams?: MessageParams };
    if (isMessageKey(messageKey)) return t(messageKey, messageParams);
  }
  return error instanceof Error ? error.message : String(error);
}
