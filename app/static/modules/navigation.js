import { $, $$, state, toast } from './core.js';
import { renderAuthRequirements, renderWorld } from './account.js';
import { loadRecords } from './products.js';
import { renderIntegrationOptions } from './integration.js';
import { updatePaletteControls } from './studio.js';
import { renderCreatorPages } from './creator.js';

export const CREATOR_PAGES = ['workbench', 'works', 'manage'];

export function navigate(page, moveFocus = false) {
  if (!$('#page-' + page)) page = 'hall';
  if (CREATOR_PAGES.includes(page) && state.user?.role !== 'manager') page = 'creator-gate';
  state.world = CREATOR_PAGES.includes(page) ? 'creator' : 'experience';
  state.page = page;
  $$('.page').forEach(node => { const active = node.id === 'page-' + page; node.hidden = !active; node.classList.toggle('active', active); });
  $$('.nav-button').forEach(node => { node.classList.toggle('active', node.dataset.page === page); if (node.dataset.page === page) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
  renderWorld();
  history.replaceState(null, '', '#' + page);
  if (moveFocus) { window.scrollTo({ top: 0, behavior: 'instant' }); $('#main').focus({ preventScroll: true }); }
  renderAuthRequirements();
  if (['collection', 'manage', 'works', 'workbench'].includes(page) && state.user) loadRecords().catch(error => toast(error.message));
  if (page === 'workbench' || page === 'works') renderCreatorPages();
  if (page === 'integration') renderIntegrationOptions();
  if (page === 'studio') updatePaletteControls();
}
