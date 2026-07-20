import { button, el } from './dom.js';
import { getLocale, initLocale, setLocale, t } from './i18n.js';
import { navLabel, refreshAll, store, views } from './state.js';
import { clearPairingSecret, renderView } from './views.js';

const nav = document.querySelector('[data-nav]');
const main = document.querySelector('[data-main]');
const banner = document.querySelector('[data-banner]');
const title = document.querySelector('[data-title]');
const language = document.querySelector('[data-language]');

async function boot() {
  await refreshAll();
  await initLocale(store.settings);
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
  const scrollRoot = document.scrollingElement || document.documentElement || document.body;
  const scrollTop = Number(scrollRoot?.scrollTop) || 0;
  const scrollLeft = Number(scrollRoot?.scrollLeft) || 0;
  main.replaceChildren(renderView(refresh));
  if (scrollRoot && (scrollTop || scrollLeft)) {
    const restoreScroll = () => scrollRoot.scrollTo?.({ top: scrollTop, left: scrollLeft, behavior: 'auto' });
    if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(restoreScroll);
    else globalThis.queueMicrotask?.(restoreScroll);
  }
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
  language.replaceChildren(el('label', { className: 'language-picker' }, [
    el('span', { text: t('app.language') }),
    picker,
  ]));
}

boot().catch((error) => {
  banner.textContent = error.message;
  main.replaceChildren(el('p', { className: 'status error', text: t('app.startupFailed') }));
});
