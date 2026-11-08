// Messages from the imaging engine (native/src/message.rs): a stable code, its parameters and the
// English text. The Turkish templates live in electron/core-messages.json, which the main process
// shares for the errors it relays; English is the engine's own text.
import messages from '../../electron/core-messages.json';
import { getLocale, type Locale } from './index';

export type CoreParam = string | CoreNote | CoreNote[];
export interface CoreNote { code?: string; params?: Record<string, CoreParam>; text: string; }

const templates: Partial<Record<Locale, Record<string, string>>> = messages;

const isNote = (value: unknown): value is CoreNote =>
  Boolean(value) && typeof value === 'object' && typeof (value as CoreNote).text === 'string';

function render(note: CoreNote, locale: Locale): string {
  const template = note.code ? templates[locale]?.[note.code] : undefined;
  if (template === undefined) return note.text;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = note.params?.[name];
    if (value === undefined) return placeholder;
    if (Array.isArray(value)) return value.map(item => render(item, locale)).join('; ');
    return typeof value === 'string' ? value : render(value, locale);
  });
}

/** An engine message in the interface language; unknown codes and older engines show the English text. */
export function coreText(note: CoreNote, locale: Locale = getLocale()): string {
  const text = render(note, locale);
  // A reason worded to follow "…: " still starts with a capital when it stands alone.
  const template = note.code ? templates[locale]?.[note.code] : undefined;
  return template && /^\p{Ll}/u.test(template) ? text.charAt(0).toLocaleUpperCase(locale) + text.slice(1) : text;
}

/** Warnings as shown: the engine's messages translated, then any plain ones a client added after them. */
export function warningTexts(source: { warnings: string[]; warningNotes?: unknown }, locale: Locale = getLocale()): string[] {
  const notes = Array.isArray(source.warningNotes) && source.warningNotes.length <= source.warnings.length
    && source.warningNotes.every(isNote) ? source.warningNotes : [];
  return [...notes.map(note => coreText(note, locale)), ...source.warnings.slice(notes.length)];
}

/** The text of an engine error body (`{ error, note }`), translated when it carries a note. */
export function coreErrorText(body: string, locale: Locale = getLocale()): string {
  try {
    const value = JSON.parse(body) as { error?: unknown; note?: unknown };
    if (isNote(value.note)) return coreText(value.note, locale);
    if (typeof value.error === 'string') return value.error;
  } catch { /* A plain-text body. */ }
  return body;
}
