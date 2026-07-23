import { button, el } from './dom.js';
import { getLocale, initLocale, setLocale, t } from './i18n.js';
import { navLabel, refreshAll, store, views } from './state.js';
import { captureScrollState, restoreScrollState } from './scrollState.js';
import { clearPairingSecret, renderView } from './views.js';

const nav = document.querySelector('[data-nav]');
const main = document.querySelector('[data-main]');
const banner = document.querySelector('[data-banner]');
const title = document.querySelector('[data-title]');
const language = document.querySelector('[data-language]');

async function boot() {
  await refreshAll();
  await initLocale(store.settings);
  applyLaunchQuery();
  applyTheme(store.settings.theme);
  renderLanguageControl();
  render();
  window.warController.system.onInvalidation(async () => {
    await refreshAll();
    render();
  });
}

function render() {
  nav.replaceChildren(...views.map((view) => {
    const active = store.view === view;
    const item = button(navLabel(view), () => {
      if (store.view === 'pairing' && view !== 'pairing') clearPairingSecret();
      store.view = view;
      render();
    }, { className: active ? 'nav-button active' : 'nav-button' });
    if (active) item.setAttribute('aria-current', 'page');
    return item;
  }));
  const scrollSnapshot = captureScrollState(document, main);
  main.replaceChildren(renderView(refresh));
  const restoreScroll = () => restoreScrollState(scrollSnapshot, document, main);
  if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(restoreScroll);
  else globalThis.queueMicrotask?.(restoreScroll);
  title.textContent = t('app.title');
  banner.textContent = `${t('app.banner')} - ${store.runtime?.status || 'loading'}`;
}

async function refresh() {
  await refreshAll();
  render();
}

function renderLanguageControl() {
  const picker = el('select', { ariaLabel: t('app.language') }, [
    el('option', { value: 'vi', text: t('language.vi') }),
    el('option', { value: 'en', text: t('language.en') }),
  ]);
  picker.value = getLocale();
  picker.addEventListener('change', async () => {
    await setLocale(picker.value);
    store.settings.locale = picker.value;
    renderLanguageControl();
    render();
  });
  const theme = button(store.settings.theme === 'dark' ? t('app.lightMode') : t('app.darkMode'), async () => {
    const next = store.settings.theme === 'dark' ? 'light' : 'dark';
    const result = await window.warController.settings.update({ theme: next });
    if (result?.ok === false) return;
    store.settings.theme = next;
    applyTheme(next);
    renderLanguageControl();
  }, { className: 'button compact theme-toggle' });
  language.replaceChildren(
    el('label', { className: 'language-picker' }, [
      el('span', { text: t('app.language') }),
      picker,
    ]),
    theme,
  );
}

function applyTheme(value) {
  document.documentElement.dataset.theme = value === 'dark' ? 'dark' : 'light';
}

function applyLaunchQuery() {
  const params = new URL(globalThis.location.href).searchParams;
  if (params.get('view') !== 'remote') return;
  store.view = 'remote';
  const ids = String(params.get('devices') || '').split(',').map((value) => value.trim()).filter((value) => /^[A-Za-z0-9_.:-]{1,120}$/.test(value)).slice(0, 8);
  if (ids.length) {
    store.remote.selectedDeviceIds = ids;
    store.remote.activeDeviceId = ids[0];
    store.remote.selectionInitialized = true;
  }
  const layout = params.get('layout');
  if (['1', '2', '3', '4'].includes(layout)) store.remote.layout = layout;
  document.body.classList.add('remote-popout');
}

boot().catch((error) => {
  banner.textContent = error.message;
  main.replaceChildren(el('p', { className: 'status error', text: t('app.startupFailed') }));
});
