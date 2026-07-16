import { button, el } from './dom.js';
import { navLabel, refreshAll, store, views } from './state.js';
import { clearPairingSecret, renderView } from './views.js';

const nav = document.querySelector('[data-nav]');
const main = document.querySelector('[data-main]');
const banner = document.querySelector('[data-banner]');

async function boot() {
  await refreshAll();
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
  main.replaceChildren(renderView(render));
  banner.textContent = `Secure Electron Controller Shell - ${store.runtime?.status || 'loading'}`;
}

boot().catch((error) => {
  banner.textContent = error.message;
  main.replaceChildren(el('p', { className: 'status error', text: 'Renderer startup failed.' }));
});
