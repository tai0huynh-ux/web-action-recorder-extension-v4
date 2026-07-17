import en from './locales/en.js';
import vi from './locales/vi.js';

const locales = Object.freeze({ en, vi });
const listeners = new Set();
let currentLocale = 'vi';

export async function initLocale(settings = null) {
  const saved = settings || await getSavedSettings();
  currentLocale = normalizeLocale(saved?.locale);
  applyDocumentLocale();
  return currentLocale;
}

export function t(key, values = {}) {
  const template = lookup(locales[currentLocale], key) ?? lookup(locales.en, key) ?? key;
  return String(template).replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name) => values[name] ?? '');
}

export async function setLocale(locale) {
  currentLocale = normalizeLocale(locale);
  applyDocumentLocale();
  await window.warController?.settings?.update?.({ locale: currentLocale });
  for (const listener of listeners) listener(currentLocale);
  return currentLocale;
}

export function getLocale() {
  return currentLocale;
}

export function subscribeLocale(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function localeKeysMatch() {
  return flattenKeys(vi).join('\n') === flattenKeys(en).join('\n');
}

function lookup(source, key) {
  const value = key.split('.').reduce((node, part) => node?.[part], source);
  if (value === undefined && currentLocale !== 'en') console.warn(`Missing locale key: ${key}`);
  return value;
}

function normalizeLocale(locale) {
  return locale === 'en' ? 'en' : 'vi';
}

function applyDocumentLocale() {
  document.documentElement.lang = currentLocale;
}

async function getSavedSettings() {
  const result = await window.warController?.settings?.get?.();
  return result?.ok === true ? result.data : result;
}

function flattenKeys(value, prefix = '') {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object') return flattenKeys(child, path);
    return [path];
  }).sort();
}
