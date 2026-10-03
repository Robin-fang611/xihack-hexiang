import { $, $$, list, state, api, toast, message, busy, empty, profile, facetLabel, openDialog, closeDialog, onUnauthorized } from './modules/core.js';
import { renderAccount, renderAuthRequirements, clearPrivateState } from './modules/account.js';
import { renderHome, refreshPublic } from './modules/home.js';
import { designSnapshot, pushHistory, resetCandidateView, setRole, renderStudio, renderStudioProgress, toggleFacet, updatePaletteControls, generateDesign } from './modules/studio.js';
import { loadRecords, addUploadFields, uploadProduct, showRecord, editRecord, showPublicProduct, showProductConflict, reloadConflict } from './modules/products.js';
import { renderLibrary, showProfile, showKnowledge, setupLibrary, selectLibraryProfile } from './modules/library.js';
import { openCard, renderCard, findMatches, downloadCard, saveCard, continueCard } from './modules/card.js';
import { renderIntegrationOptions, handoff, renderSimulation, controlSimulation, confirmSimulation, setupSimulation } from './modules/integration.js';
import { navigate } from './modules/navigation.js';
import { setupIntent } from './modules/intent.js';
import { setupDraft, restoreDraft } from './modules/draft.js';

function forgetActiveAccount() {
  state.user = null; clearPrivateState(); renderAccount(); renderAuthRequirements(); renderSimulation(); renderHome();
  if (state.world === 'creator') navigate('hall');
}
onUnauthorized(forgetActiveAccount);

let sessionCheck = 0;
async function verifyVisibleSession() {
  if (!state.boot || !state.user || document.hidden) return;
  const check = ++sessionCheck; const version = state.accountVersion;
  try {
    const current = await api('/api/session');
    if (check !== sessionCheck || version !== state.accountVersion) return;
    if (current.user?.id !== state.user?.id) {
      forgetActiveAccount(); toast('浏览器账号已在另一页更改，当前页的私人内容已清除。请刷新后继续。');
    } else state.csrf = current.csrf_token || state.csrf;
  } catch { /* 私有接口仍独立校验身份；失联不猜测新账号。 */ }
}
window.addEventListener('focus', verifyVisibleSession);
document.addEventListener('visibilitychange', verifyVisibleSession);
document.addEventListener('account:cleared', () => { sessionCheck += 1; });
document.addEventListener('account:changed', () => { sessionCheck += 1; });

function setAuthMode(mode) {
  state.authMode = mode;
  $$('.tab-button[data-auth-mode]').forEach(item => item.classList.toggle('active', item.dataset.authMode === mode));
  const registering = ['register', 'register-creator'].includes(mode);
  $('#auth-submit').textContent = mode === 'register-creator' ? '入驻并登录' : registering ? '注册并登录' : '登录';
  $('#auth-password').autocomplete = registering ? 'new-password' : 'current-password';
  message('#auth-message', '');
}

document.addEventListener('click', async event => {
  const button = event.target.closest('button, a[data-go]');
  if (button?.disabled) return;
  if (button?.dataset.page || button?.dataset.go) { navigate(button.dataset.page || button.dataset.go, true); return; }
  if (button?.classList.contains('close-dialog')) { button.closest('dialog').close(); return; }
  if (button?.dataset.scene) {
    pushHistory(); $('#design-scene').value = button.dataset.scene; resetCandidateView(); renderStudio();
    message('#studio-message', `已选择「${button.dataset.scene}」，再挑一份主调开始。`); return;
  }
  const action = button?.dataset.action;
  if (action === 'login') { setAuthMode('login'); openDialog('#auth-dialog'); }
  else if (action === 'logout') {
    await busy(button, '退出中…', async () => { try { await api('/api/logout', { method: 'POST' }); const session = await api('/api/session'); state.user = session.user; state.csrf = session.csrf_token || ''; clearPrivateState(); state.simulation = null; state.simulationConfirmed = false; state.logs = []; $('#integration-log').textContent = '尚未调用。'; renderAccount(); renderAuthRequirements(); renderSimulation(); renderHome(); if (state.world === 'creator') navigate('hall'); toast('已退出，私人资料与当前浏览器草稿已清空。'); } catch (error) { toast(error.message); } });
  }
  else if (action === 'profile-detail') showProfile(button.dataset.id);
  else if (action === 'assign-material') setRole(button.dataset.role, button.dataset.id);
  else if (action === 'use-profile') selectLibraryProfile(button.dataset.id);
  else if (action === 'remove-role') { pushHistory(); state.components = state.components.filter(item => item.role !== button.dataset.role); resetCandidateView(); renderStudio(); }
  else if (action === 'toggle-facet') toggleFacet(button.dataset.group, button.dataset.key);
  else if (action === 'use-preset' || action === 'use-work') {
    const design = action === 'use-preset' ? list(state.boot?.presets)[Number(button.dataset.index)] : state.works.find(item => item.id === button.dataset.id);
    if (!design) return;
    pushHistory();
    const retainedExclusions = [...new Set([...state.excluded, ...list(design.excluded_ids)])];
    state.components = list(design.components || design.design?.components).map(item => ({ profile_id: item.profile_id || item.id, role: item.role })).filter(item => profile(item.profile_id) && !retainedExclusions.includes(item.profile_id));
    state.preferred = list(design.preferred_facets || design.request?.preferred_facets); state.deemphasized = list(design.deemphasized_facets || design.request?.deemphasized_facets); state.excluded = retainedExclusions; $('#design-scene').value = design.scenario || design.scene || ''; $('#design-words').value = ''; state.draftName = design.name || ''; $('#card-name').value = state.draftName; resetCandidateView(); renderStudio(); $('.preset-drawer').open = false; navigate('studio', true);
    const sourceLabel = action === 'use-work' ? `「${design.name}」（${design.creator_name || '创作者'}的作品）` : '设计草案';
    message('#studio-message', retainedExclusions.some(id => list(design.components).some(part => part.profile_id === id)) ? `${sourceLabel}里与你的排除项冲突的材料已移出，排除条件保持不变。你可以另选主调；如要加入，需自己取消排除。` : `已将${sourceLabel}放到案头。自己的话留给你填写，草案不代表你的原话。`);
    if (matchMedia('(max-width: 760px)').matches) $('.composition-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  else if (action === 'choose-candidate') { const item = state.candidates[Number(button.dataset.index)]; if (!item) return; pushHistory(); state.components = list(item.components).map(part => ({ profile_id: part.profile_id, role: part.role })); resetCandidateView(); renderStudio(); message('#studio-message', '已把候选带回案头。你可以继续调整，或命名留笺。', 'success'); $('#role-slots').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  else if (action === 'candidate-card') { const item = state.candidates[Number(button.dataset.index)]; if (item) await openCard(item.components); }
  else if (action === 'product-detail') { const product = state.products.find(item => item.id === button.dataset.id); if (product) showPublicProduct(product); }
  else if (action === 'record-detail') { const product = state.records.find(item => item.id === button.dataset.id); if (product) showRecord(product); }
  else if (action === 'edit-record') { const product = state.records.find(item => item.id === button.dataset.id); if (product) editRecord(product); }
  else if (action === 'record-reference') { const product = state.records.find(item => item.id === button.dataset.id); if (!product) return; pushHistory(); const referenceFacets = list(product.analysis?.families).filter(family => typeof family === 'string' && state.facets[family]); state.preferred = [...new Set([...state.preferred, ...referenceFacets])]; state.deemphasized = state.deemphasized.filter(facet => !referenceFacets.includes(facet)); resetCandidateView(); renderStudio(); navigate('studio', true); message('#studio-message', referenceFacets.length ? `已把「${product.name}」资料归类中的${referenceFacets.map(facetLabel).join('、')}加入偏好参照，你可以继续改选。自己的话由你填写，成品不会变成混配原料。` : `已选择「${product.name}」作喜好参照，目前没有可对应的资料方向。你可以自己记录想保留的感觉；系统不替你填写原话，也不把成品拆成混配原料。`); }
  else if (action === 'reopen-design') {
    const saved = state.savedDesigns[Number(button.dataset.index)]; if (!saved) return; const design = saved.design || saved;
    state.cardOrigin = 'saved';
    state.cardDesign = { ...design, user_words: design.user_notes || '', evaluation_payload: { ...design, components: list(design.components).map(part => ({ profile_id: part.profile_id, role: part.role })), name: design.name, scenario: design.scenario, preferred_facets: design.preferred_facets || [], deemphasized_facets: design.deemphasized_facets || [], excluded_ids: design.excluded_ids || [], user_notes: design.user_notes || '' } };
    $('#card-matches').innerHTML = '<p class="fine-note">仅匹配创作者公开的商品；相似方向不代表同一配方。</p>';
    $('#card-name').value = design.name || ''; renderCard(); openDialog('#card-dialog');
  }
  else if (action === 'reload-conflict') await reloadConflict(button);
  else if (action === 'unpublish') {
    await busy(button, '正在撤下…', async () => {
      try {
        await api(`/api/products/${encodeURIComponent(button.dataset.id)}/unpublish`, { method: 'POST', body: { expected_revision: Number(button.dataset.revision || 0) } });
        const card = button.closest('[data-record]'); if (card) { card.dataset.conflicted = 'false'; card.dataset.dirty = 'false'; const form = card.querySelector('.publish-form'); if (form) { form.dataset.conflicted = 'false'; form.dataset.dirty = 'false'; } }
        await loadRecords(); await refreshPublic(); toast('商品已从首页撤下，私人档案仍保留。');
      } catch (error) { if (error.status === 409 && error.code === 'product_conflict') showProductConflict(button); else toast(error.message); }
    });
  }
  else if (action === 'unpublish-work') {
    await busy(button, '正在撤下…', async () => {
      try {
        await api(`/api/designs/${encodeURIComponent(button.dataset.id)}/unpublish`, { method: 'POST', body: {} });
        await loadRecords(); await refreshPublic(); toast('作品已从首页撤下，仍保留在你的作品列表。');
      } catch (error) { toast(error.message); }
    });
  }
  else if (action === 'material-detail') showKnowledge('materials', button.dataset.id);
  else if (action === 'formula-detail') showKnowledge('historical_formulas', button.dataset.id);
  else if (action === 'confirm-simulation') await confirmSimulation(button);
  if (button?.dataset.library) { state.library = button.dataset.library; renderLibrary(); }
  if (button?.dataset.authMode) setAuthMode(button.dataset.authMode);
  const material = event.target.closest('.material-card');
  if (material && !button) { state.selectedMaterial = material.dataset.profile; renderStudio(); message('#studio-message', '已选中参照。点击主调、支撑或点缀的位置加入。'); }
  const slot = event.target.closest('.role-slot'); if (slot && !button && state.selectedMaterial) setRole(slot.dataset.role, state.selectedMaterial);
});
document.addEventListener('submit', async event => {
  const form = event.target;
  if (form.id === 'auth-form') {
    event.preventDefault(); const values = new FormData(form); const button = $('#auth-submit');
    const registering = ['register', 'register-creator'].includes(state.authMode);
    await busy(button, registering ? '正在创建账号…' : '正在登录…', async () => {
      try { const payload = { username: String(values.get('username')).trim(), password: values.get('password') }; if (state.authMode === 'register') payload.display_name = payload.username;
        if (state.authMode === 'register-creator') { payload.account_kind = 'creator'; payload.display_name = payload.username; }
        const result = await api(state.authMode === 'register' || state.authMode === 'register-creator' ? '/api/register' : '/api/login', { method: 'POST', body: payload }); const session = result.user && result.csrf_token ? result : await api('/api/session');
        if (state.user && state.user.id !== session.user?.id) clearPrivateState(); else state.accountVersion += 1;
        state.user = session.user; state.csrf = session.csrf_token || ''; document.dispatchEvent(new Event('account:changed')); form.reset(); closeDialog('#auth-dialog'); renderAccount(); renderAuthRequirements(); renderHome(); await loadRecords();
        if (state.user?.role === 'manager' && ['hall', 'creator-gate'].includes(state.page)) navigate('workbench');
        toast(state.user?.role === 'manager' ? '已登录创作者账号，作品与商品都可以在工作台发布。' : '已进入自己的案头。');
      } catch (error) { message('#auth-message', error.message, 'danger'); }
    });
  } else if (form.classList.contains('work-publish-form')) {
    event.preventDefault(); const values = new FormData(form); const button = form.querySelector('button[type=submit]'); const notice = form.querySelector('.notice');
    await busy(button, '正在更新首页…', async () => {
      try {
        await api(`/api/designs/${encodeURIComponent(form.dataset.work)}/publish`, { method: 'POST', body: { public_note: String(values.get('public_note') || '').trim() } });
        await loadRecords(); await refreshPublic(); toast('作品已发布到首页「设计起点」，公开内容只含设计事实与署名。');
      } catch (error) { notice.textContent = error.message; notice.className = 'notice danger'; notice.hidden = false; }
    });
  } else if (form.classList.contains('upload-form')) { event.preventDefault(); await uploadProduct(form); }
  else if (form.classList.contains('publish-form')) {
    event.preventDefault(); const values = new FormData(form); const button = form.querySelector('button[type=submit]'); const notice = form.querySelector('.notice');
    await busy(button, '正在更新首页…', async () => {
      try {
        await api(`/api/products/${encodeURIComponent(form.dataset.product)}/publish`, { method: 'POST', body: { purchase_url: String(values.get('purchase_url') || '').trim(), price: String(values.get('price') || '').trim(), public_fields: values.getAll('public_fields'), expected_revision: Number(form.dataset.revision || 0) } });
        form.dataset.conflicted = 'false'; form.dataset.dirty = 'false'; const card = form.closest('[data-record]'); if (card) card.dataset.conflicted = 'false'; card.dataset.dirty = 'false';
        await loadRecords(); await refreshPublic(); toast('首页展示已更新，只公开你选择的字段。');
      } catch (error) {
        if (error.status === 409 && error.code === 'product_conflict') showProductConflict(form);
        else { notice.textContent = error.message; notice.className = 'notice danger'; notice.hidden = false; }
      }
    });
  } else if (form.id === 'edit-product-form') {
    event.preventDefault(); const values = new FormData(form); const body = Object.fromEntries(values); const notice = form.querySelector('.notice');
    body.expected_revision = Number(form.dataset.revision || 0);
    await busy(form.querySelector('button[type=submit]'), '保存中…', async () => {
      try {
        await api(`/api/products/${encodeURIComponent(form.dataset.id)}`, { method: 'PATCH', body });
        form.dataset.conflicted = 'false'; form.dataset.dirty = 'false'; closeDialog('#detail-dialog'); await loadRecords(); await refreshPublic(); toast('资料与分析已更新。');
      } catch (error) {
        if (error.status === 409 && error.code === 'product_conflict') showProductConflict(form);
        else { notice.textContent = error.message; notice.className = 'notice danger'; notice.hidden = false; }
      }
    });
  }
});
document.addEventListener('change', event => {
  const node = event.target;
  if (node.dataset.exclude) { pushHistory(); const id = node.dataset.exclude; state.excluded = node.checked ? [...new Set([...state.excluded, id])] : state.excluded.filter(item => item !== id); if (node.checked) state.components = state.components.filter(item => item.profile_id !== id); resetCandidateView(); renderStudio(); }
  if (node.id === 'lock-main') { pushHistory({ ...designSnapshot(), locked: !node.checked }); resetCandidateView(); renderStudio(); }
  if (node.type === 'file') { const selected = node.files[0]; node.closest('.field').querySelector('.file-selection').textContent = selected ? `${selected.name} · ${(selected.size / 1024 / 1024).toFixed(2)} MB` : ''; }
});
const inputSnapshots = new WeakMap();
document.addEventListener('focusin', event => {
  if (['design-scene', 'design-words'].includes(event.target.id)) inputSnapshots.set(event.target, { snapshot: designSnapshot(), tracked: false });
});
document.addEventListener('input', event => {
  const node = event.target; if (!['design-scene', 'design-words'].includes(node.id)) return;
  const edit = inputSnapshots.get(node);
  if (edit && !edit.tracked) { pushHistory(edit.snapshot); edit.tracked = true; }
  resetCandidateView(); renderStudioProgress();
  $$('[data-scene]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.scene === $('#design-scene').value)));
});
window.addEventListener('hashchange', () => navigate(location.hash.slice(1), true));
document.addEventListener('dragstart', event => { const card = event.target.closest('.material-card'); if (card) { event.dataTransfer.setData('text/plain', card.dataset.profile); event.dataTransfer.effectAllowed = 'copy'; } });
document.addEventListener('dragover', event => { const slot = event.target.closest('.role-slot'); if (slot) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; slot.classList.add('drop-over'); } });
document.addEventListener('dragleave', event => { const slot = event.target.closest('.role-slot'); if (slot && !slot.contains(event.relatedTarget)) slot.classList.remove('drop-over'); });
document.addEventListener('drop', event => { const slot = event.target.closest('.role-slot'); if (slot) { event.preventDefault(); slot.classList.remove('drop-over'); const id = event.dataTransfer.getData('text/plain'); if (profile(id)) setRole(slot.dataset.role, id); } });
document.addEventListener('keydown', event => { if (!['Enter', ' '].includes(event.key) || event.target.tagName === 'BUTTON') return; const card = event.target.closest('.material-card'); if (card) { event.preventDefault(); state.selectedMaterial = card.dataset.profile; renderStudio(); toast('已选中。聚焦构图位置后按回车即可加入。'); } const slot = event.target.closest('.role-slot'); if (slot && state.selectedMaterial) { event.preventDefault(); setRole(slot.dataset.role, state.selectedMaterial); } });
$('#generate-design').addEventListener('click', event => generateDesign(event.currentTarget));
$('#save-current-card').addEventListener('click', () => openCard());
$('#undo-design').addEventListener('click', () => { const old = state.history.pop(); if (!old) return; Object.assign(state, { components: old.components, preferred: old.preferred, deemphasized: old.deemphasized, excluded: old.excluded }); $('#design-scene').value = old.scene; $('#design-words').value = old.words; $('#lock-main').checked = old.locked; state.draftName = old.name || ''; $('#card-name').value = state.draftName; resetCandidateView(); renderStudio(); message('#studio-message', '已撤回上一次构图或偏好改动。'); });
$('#clear-design').addEventListener('click', () => { pushHistory(); state.components = []; state.preferred = []; state.deemphasized = []; state.excluded = []; $('#design-scene').value = ''; $('#design-words').value = ''; state.draftName = ''; $('#card-name').value = ''; resetCandidateView(); renderStudio(); message('#studio-message', '案头已清空，上一次设计可以撤回。'); });
$('#card-name').addEventListener('input', renderCard);
$('#download-card').addEventListener('click', event => downloadCard(event.currentTarget));
$('#save-card').addEventListener('click', event => saveCard(event.currentTarget));
$('#card-to-studio').addEventListener('click', continueCard);
$('#card-to-integration').addEventListener('click', () => { closeDialog('#card-dialog'); navigate('integration', true); $('#integration-design').value = 'card'; $('#integration-design').dispatchEvent(new Event('change', { bubbles: true })); });
$('#handoff-design').addEventListener('click', event => handoff(event.currentTarget));
$('#simulation-on').addEventListener('click', event => controlSimulation('start', event.currentTarget));
$('#simulation-off').addEventListener('click', event => controlSimulation('stop', event.currentTarget));
$('#simulation-timer').addEventListener('click', event => controlSimulation('set_timer', event.currentTarget));
$('#refresh-private').addEventListener('click', () => loadRecords().catch(error => toast(error.message)));
$('#refresh-products').addEventListener('click', () => loadRecords().catch(error => toast(error.message)));
$('#palette-prev').addEventListener('click', () => { const palette = $('#profile-palette'); palette.scrollBy({ left: -Math.max(200, palette.clientWidth - 28), behavior: 'smooth' }); });
$('#palette-next').addEventListener('click', () => { const palette = $('#profile-palette'); palette.scrollBy({ left: Math.max(200, palette.clientWidth - 28), behavior: 'smooth' }); });
$('#profile-palette').addEventListener('scroll', updatePaletteControls, { passive: true });
window.addEventListener('resize', updatePaletteControls);
$('#open-auth')?.addEventListener('click', () => openDialog('#auth-dialog'));
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));

async function initialize() {
  addUploadFields();
  setupIntent();
  setupDraft();
  setupSimulation();
  setupLibrary();
  $('#page-collection').insertAdjacentHTML('beforeend', '<section class="saved-design-section" data-auth-content><div class="panel-heading"><h2>我的香笺</h2><span class="subtle">登录后保存的数字设计</span></div><div id="saved-designs" class="candidate-grid"></div></section>');
  $('#card-dialog').insertAdjacentHTML('beforeend', '<section class="matched-product-section"><div class="panel-heading"><h3>接近这份设计的现成香</h3><button type="button" class="text-button" id="find-matches">查找现成香 →</button></div><div id="card-matches"><p class="fine-note">仅匹配创作者公开的商品；相似方向不代表同一配方。</p></div></section>');
  $('#find-matches').addEventListener('click', event => findMatches(event.currentTarget));
  renderAuthRequirements(); $('#home-products').innerHTML = '<div class="loading">正在读取公开香品与材料资料…</div>';
  try {
    const [boot, session] = await Promise.all([api('/api/bootstrap'), api('/api/session')]); state.boot = boot; state.profiles = boot.profiles || []; state.facets = boot.facets || {}; state.products = boot.products || []; state.works = boot.works || [];
    state.sources = [...list(boot.sources), ...list(boot.knowledge?.sources)].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
    state.user = session.user; state.csrf = session.csrf_token || ''; restoreDraft(); renderAccount(); renderHome(); renderStudio(); renderLibrary(); renderIntegrationOptions(); renderSimulation(); renderAuthRequirements(); $('#data-version').textContent = '资料更新于 2026 年 10 月 3 日';
    navigate(location.hash.slice(1) || 'hall');
  } catch (error) { message('#connection-error', error.message, 'danger'); $('#home-products').innerHTML = empty('本地资料尚未连接', '请确认服务已启动，再刷新页面。当前不会展示虚构商品或伪造分析结果。'); }
}
initialize();
