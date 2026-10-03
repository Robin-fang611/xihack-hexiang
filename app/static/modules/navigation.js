import { $, $$, state, toast, message } from './core.js';
import { renderAuthRequirements } from './account.js';
import { loadRecords } from './products.js';
import { renderIntegrationOptions } from './integration.js';
import { updatePaletteControls } from './studio.js';

export function navigate(page, moveFocus = false) {
  if (!$('#page-' + page)) page = 'home';
  if (page === 'manage' && state.user?.role !== 'manager') { page = 'collection'; toast('商品管理仅对管理者账号开放。'); }
  state.page = page;
  $$('.page').forEach(node => { const active = node.id === 'page-' + page; node.hidden = !active; node.classList.toggle('active', active); });
  $$('.nav-button').forEach(node => { node.classList.toggle('active', node.dataset.page === page); if (node.dataset.page === page) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
  history.replaceState(null, '', '#' + page);
  if (moveFocus) { window.scrollTo({ top: 0, behavior: 'instant' }); $('#main').focus({ preventScroll: true }); }
  renderAuthRequirements();
  if (['collection', 'manage'].includes(page) && state.user) loadRecords().catch(error => toast(error.message));
  if (page === 'integration') renderIntegrationOptions();
  if (page === 'studio') updatePaletteControls();
}
