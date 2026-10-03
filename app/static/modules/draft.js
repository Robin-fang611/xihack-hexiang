import { $, state, roles, toast } from './core.js';
import { resetCandidateView, renderStudio } from './studio.js';

export const DRAFT_PREFIX = 'hexiang:draft:v1:';
const SCHEMA_VERSION = 1;
let initialized = false;
let ready = false;
let restoring = false;
let activeOwner = null;
const rejectedOwners = new Set();

function owner() { return state.user ? `user:${state.user.id}` : 'anonymous'; }
function version() { return state.boot?.data_version; }
function fields() {
  return { components: state.components.map(part => ({ profile_id: part.profile_id, role: part.role })), preferred: [...state.preferred], deemphasized: [...state.deemphasized], excluded: [...state.excluded], scene: $('#design-scene').value, words: $('#design-words').value, locked: $('#lock-main').checked, name: state.draftName || '' };
}
function meaningful(draft) { return draft.components.length || draft.preferred.length || draft.deemphasized.length || draft.excluded.length || draft.scene || draft.words || draft.name; }
function status(text, warning = false) {
  const node = $('#draft-status');
  node.textContent = text; node.hidden = !text; node.classList.toggle('draft-warning', warning);
}
function storageProblem() { status('浏览器暂时没能留存草稿。当前案头还在，刷新前请先下载香笺。', true); }
function validArray(values, allowed) { return Array.isArray(values) && values.every(value => typeof value === 'string' && allowed.has(value)) && new Set(values).size === values.length; }
function valid(envelope, expectedOwner) {
  if (!envelope || envelope.schema_version !== SCHEMA_VERSION || envelope.owner !== expectedOwner || envelope.knowledge_version !== version()) return false;
  const draft = envelope.draft;
  if (!draft || !Array.isArray(draft.components) || draft.components.length > 3) return false;
  const ids = new Set(state.profiles.map(item => item.id));
  const facets = new Set(Object.keys(state.facets));
  if (!validArray(draft.preferred, facets) || !validArray(draft.deemphasized, facets) || !validArray(draft.excluded, ids) || draft.preferred.some(facet => draft.deemphasized.includes(facet))) return false;
  if (draft.components.some(part => !part || !ids.has(part.profile_id) || !Object.hasOwn(roles, part.role) || draft.excluded.includes(part.profile_id))) return false;
  if (new Set(draft.components.map(part => part.profile_id)).size !== draft.components.length || new Set(draft.components.map(part => part.role)).size !== draft.components.length) return false;
  return typeof draft.scene === 'string' && draft.scene.length <= 120 && typeof draft.words === 'string' && draft.words.length <= 600 && typeof draft.name === 'string' && draft.name.length <= 30 && typeof draft.locked === 'boolean';
}
function read(expectedOwner) {
  try {
    const raw = sessionStorage.getItem(DRAFT_PREFIX + expectedOwner);
    if (!raw) return null;
    let envelope;
    try { envelope = JSON.parse(raw); } catch { envelope = null; }
    if (!valid(envelope, expectedOwner)) {
      rejectedOwners.add(expectedOwner);
      status('这份草稿的版本或材料信息已不适用，未将它带入当前案头。', true);
      return null;
    }
    return envelope.draft;
  } catch { storageProblem(); return null; }
}
function persist(event) {
  if (!ready || restoring || activeOwner !== owner()) return false;
  if (rejectedOwners.has(activeOwner)) {
    if (!['design:changed', 'input', 'change'].includes(event?.type)) return false;
    rejectedOwners.delete(activeOwner);
  }
  const draft = fields();
  try {
    const key = DRAFT_PREFIX + activeOwner;
    if (!['design:changed', 'input', 'change'].includes(event?.type)) {
      const raw = sessionStorage.getItem(key);
      let stored;
      try { stored = raw ? JSON.parse(raw) : null; } catch { stored = null; }
      if (raw && !valid(stored, activeOwner)) {
        rejectedOwners.add(activeOwner);
        status('这份草稿的版本或材料信息已不适用，未将它带入当前案头。', true);
        return false;
      }
    }
    if (!meaningful(draft)) { sessionStorage.removeItem(key); return true; }
    sessionStorage.setItem(key, JSON.stringify({ schema_version: SCHEMA_VERSION, knowledge_version: version(), owner: activeOwner, saved_at: new Date().toISOString(), draft }));
    if (!$('#draft-status').classList.contains('draft-warning')) status('本标签页的草稿已留存，刷新可以接续。');
    return true;
  } catch { storageProblem(); return false; }
}
function restore(draft) {
  restoring = true;
  try {
    state.components = structuredClone(draft.components); state.preferred = [...draft.preferred]; state.deemphasized = [...draft.deemphasized]; state.excluded = [...draft.excluded];
    state.history = []; state.selectedMaterial = null; state.simulation = null; state.simulationConfirmed = false; state.logs = [];
    state.draftName = draft.name;
    $('#design-scene').value = draft.scene; $('#design-words').value = draft.words; $('#lock-main').checked = draft.locked; $('#card-name').value = draft.name;
    resetCandidateView(); renderStudio();
  } finally { restoring = false; }
}
function clearAll() {
  ready = false; activeOwner = owner();
  rejectedOwners.clear();
  try {
    const keys = [];
    for (let index = 0; index < sessionStorage.length; index += 1) { const key = sessionStorage.key(index); if (key?.startsWith(DRAFT_PREFIX)) keys.push(key); }
    keys.forEach(key => sessionStorage.removeItem(key));
    status('');
  } catch { storageProblem(); }
  ready = true;
}
function clearForeignOwners(expectedOwner) {
  try {
    const keep = DRAFT_PREFIX + expectedOwner;
    const stale = [];
    for (let index = 0; index < sessionStorage.length; index += 1) { const key = sessionStorage.key(index); if (key?.startsWith(DRAFT_PREFIX) && key !== keep) stale.push(key); }
    stale.forEach(key => sessionStorage.removeItem(key));
  } catch { storageProblem(); }
}
function accountChanged() {
  const previousOwner = activeOwner;
  const nextOwner = owner();
  if (previousOwner === nextOwner) return;
  ready = false;
  const current = fields();
  activeOwner = nextOwner;
  if (previousOwner === 'anonymous' && nextOwner !== 'anonymous' && meaningful(current)) {
    // The anonymous composition belongs to the person who just signed in.
    ready = true;
    if (persist()) {
      try { sessionStorage.removeItem(DRAFT_PREFIX + previousOwner); status('当前草稿已跟随你登录的账号留存。'); } catch { storageProblem(); }
    }
    return;
  }
  const stored = read(nextOwner);
  if (stored) { restore(stored); status('已恢复这个账号在本标签页的草稿。'); }
  ready = true;
}

export function restoreDraft() {
  if (!state.boot) return false;
  activeOwner = owner();
  clearForeignOwners(activeOwner);
  const stored = read(activeOwner);
  if (stored) { restore(stored); status('已恢复上次案头。候选与模拟空间等待重新确认。'); toast('已接续本标签页的草稿。'); }
  ready = true;
  return Boolean(stored);
}
export function setupDraft() {
  if (initialized) return;
  initialized = true;
  document.addEventListener('design:changed', persist);
  document.addEventListener('design:rendered', persist);
  document.addEventListener('account:cleared', clearAll);
  document.addEventListener('account:changed', accountChanged);
  document.addEventListener('input', event => { if (['design-scene', 'design-words'].includes(event.target.id) || (event.target.id === 'card-name' && state.cardOrigin === 'studio')) persist(event); });
  document.addEventListener('change', event => { if (event.target.id === 'lock-main') persist(event); });
  window.addEventListener('pagehide', persist);
}
