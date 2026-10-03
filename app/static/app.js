'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const list = value => Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
const roles = { main: '主调', support: '支撑', accent: '点缀' };
const forms = { essential_oil: '精油', resinoid_extract: '树脂提取物', raw_resin: '原树脂', oleo_gum_resin: '油胶树脂', wood: '木材', dried_flower_bud: '干燥花蕾', burning_fumes: '燃烧烟气', unidentified_material: '身份待核对', incense: '线香 / 燃香', scent_bead: '香珠 / 香牌', sachet: '香包', perfume: '香水', diffuser: '扩香液', candle: '香薰蜡烛', other: '其他', unknown: '形态待补充' };
const state = { boot: null, user: null, csrf: '', page: 'home', library: 'materials', authMode: 'login', profiles: [], facets: {}, sources: [], products: [], records: [], savedDesigns: [], selectedMaterial: null, components: [], preferred: [], deemphasized: [], excluded: [], history: [], candidates: [], cardDesign: null, simulation: null, simulationConfirmed: false, logs: [], loading: false };

function safeURL(value, allowRelative = true) {
  if (!value || typeof value !== 'string') return '';
  try {
    if (!allowRelative && !/^https?:\/\//i.test(value)) return '';
    const parsed = new URL(value, location.origin);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch { return ''; }
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
  let response;
  try { response = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new Error('暂时无法连接本地服务，请保留当前内容后重试。'); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof result.error === 'string' ? result.error : '这次操作没有完成，请重试。';
    const error = new Error(message);
    error.status = response.status; error.code = result.code;
    if (response.status === 401 && !['/api/login', '/api/register'].includes(path)) { state.user = null; clearPrivateState(); renderAccount(); renderAuthRequirements(); }
    throw error;
  }
  return result;
}

function toast(message) {
  const box = $('#toast'); box.textContent = message; box.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { box.hidden = true; }, 4200);
}
function message(selector, text, kind = '') {
  const node = $(selector); if (!node) return;
  node.textContent = text; node.className = `notice ${kind}`; node.hidden = !text;
}
async function busy(button, label, work) {
  const original = button.textContent; button.disabled = true; button.textContent = label;
  try { return await work(); } finally { button.disabled = false; button.textContent = original; }
}
function empty(title, description, action = '') { return `<div class="empty-state"><div class="empty-symbol" aria-hidden="true">香</div><h3>${escapeHTML(title)}</h3><p>${escapeHTML(description)}</p>${action}</div>`; }
function profile(id) { return state.profiles.find(item => item.id === id); }
function profileName(id) { return profile(id)?.name || id || '未选择'; }
function facetLabel(id) { return state.facets[id] || id; }
function source(id) { return state.sources.find(item => item.id === id); }
function tags(items) { return list(items).map(item => `<span class="tag">${escapeHTML(facetLabel(typeof item === 'object' ? item.label || item.tag_id || item.name : item))}</span>`).join(''); }
function niceText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return value.text || value.description || value.reason || value.name || value.label || value.note || value.value || value.raw || JSON.stringify(value);
}
function sourceLink(value, label = '查看出处') {
  const item = typeof value === 'object' ? value : source(value);
  const url = safeURL(item?.url || item?.source_url || (typeof value === 'string' && /^https?:/.test(value) ? value : ''));
  return url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(item?.title || label)}</a>` : `<span class="subtle">来源待补充</span>`;
}
function evidenceHTML(items) {
  return list(items).map(item => `<div class="evidence-list">${sourceLink(item.source_id || item)}${item.locator ? ` · ${escapeHTML(item.locator)}` : ''}${item.object_form ? ` · ${escapeHTML(forms[item.object_form] || item.object_form)}` : ''}</div>`).join('');
}

function navigate(page, moveFocus = false) {
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
function openDialog(id) { const node = $(id); if (!node.open) node.showModal(); }
function closeDialog(id) { $(id)?.close(); }

function renderAccount() {
  const node = $('#account-area');
  if (!state.user) node.innerHTML = '<button type="button" class="button quiet" data-action="login">登录 / 注册</button>';
  else node.innerHTML = `<div><span class="account-name">${escapeHTML(state.user.display_name || state.user.username)}</span><span class="role-label"> · ${state.user.role === 'manager' ? '管理者' : '普通账号'}</span></div><button type="button" class="button quiet" data-action="logout">退出</button>`;
  $$('.manager-only').forEach(node => { node.hidden = state.user?.role !== 'manager'; });
}
function renderAuthRequirements() {
  $$('[data-auth-required]').forEach(node => { node.hidden = Boolean(state.user); node.innerHTML = '<h2>先把这一案留给自己</h2><p>登录后可以上传香品、保存私人报告。资料不会进入首页推荐。</p><button type="button" class="button primary" data-action="login">登录 / 注册</button>'; });
  $$('[data-auth-content]').forEach(node => { node.hidden = !state.user; });
  $('#manager-content').hidden = state.user?.role !== 'manager';
  message('#manager-access-message', state.user?.role === 'manager' ? '' : '商品管理仅对管理者账号开放。');
}
function clearPrivateState() {
  state.records = []; state.savedDesigns = []; state.cardDesign = null;
  state.components = []; state.preferred = []; state.deemphasized = []; state.excluded = []; state.history = []; state.candidates = []; state.selectedMaterial = null;
  for (const selector of ['#private-records', '#manager-records', '#saved-designs', '#detail-content', '#card-preview']) { const node = $(selector); if (node) node.innerHTML = ''; }
  for (const selector of ['#design-scene', '#design-words', '#card-name']) { const node = $(selector); if (node) node.value = ''; }
  $$('.upload-form').forEach(form => { form.reset(); const files = form.querySelector('.file-selection'); if (files) files.textContent = ''; });
  for (const selector of ['#detail-dialog', '#card-dialog']) if ($(selector)?.open) $(selector).close();
  $('#candidates-section').hidden = true;
  if (state.boot) renderStudio();
}

function renderHome() {
  $('#home-products').innerHTML = state.products.length ? state.products.map(product => {
    const image = safeURL(product.image_url);
    const url = safeURL(product.purchase_url, false);
    const notes = product.analysis?.reported_notes || product.notes || [];
    return `<article class="product-card"><div class="product-art">${image ? `<img src="${escapeHTML(image)}" alt="${escapeHTML(product.name)}的公开产品图片" loading="lazy">` : '<span class="paper-vessel" aria-hidden="true"></span><span class="art-caption">未上传公开产品图</span>'}</div><div class="product-body"><p class="product-meta">${escapeHTML(product.brand || product.seller_name || '管理者提供')} · ${escapeHTML(forms[product.form] || product.form || '形态待补充')}</p><h2>${escapeHTML(product.name)}</h2>${product.spec ? `<p class="subtle">${escapeHTML(product.spec)}</p>` : ''}<div>${tags(list(notes).slice(0, 5).map(niceText))}</div>${product.description ? `<p>${escapeHTML(product.description)}</p>` : '<p>详细香气资料尚未公开。</p>'}<div class="product-actions"><button type="button" class="button secondary" data-action="product-detail" data-id="${escapeHTML(product.id)}">查看资料</button>${url ? `<a class="button primary" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">前往商家购买 ↗</a>` : '<span class="status-pill pending">购买入口待补充</span>'}</div><div class="source-note">${product.price ? `${escapeHTML(product.price)} · ` : '价格与库存以商家页为准 · '}${escapeHTML(product.seller_name || '管理者')}提供${product.source_url ? ` · ${sourceLink({ url: product.source_url, title: '资料来源' })}` : ''}</div></div></article>`;
  }).join('') : empty('首页还没有公开香品', '这里会展示管理者选择公开的已有商品。现在可以先到调香案，探索自己的设计。', `<button type="button" class="button primary" data-go="studio">去调香案</button>${state.user?.role === 'manager' ? '<button type="button" class="button quiet" data-go="manage">添加自己的商品</button>' : ''}`);
}
async function refreshPublic() { const boot = await api('/api/bootstrap'); state.products = boot.products || []; renderHome(); }

function pushHistory() {
  state.history.push({ components: structuredClone(state.components), preferred: [...state.preferred], deemphasized: [...state.deemphasized], excluded: [...state.excluded], scene: $('#design-scene').value, words: $('#design-words').value, locked: $('#lock-main').checked });
  if (state.history.length > 30) state.history.shift(); $('#undo-design').disabled = false;
}
function resetCandidateView() { state.candidates = []; $('#candidates-section').hidden = true; $('#candidate-comparison').hidden = true; state.simulationConfirmed = false; }
function setRole(role, id) {
  if (!profile(id) || !roles[role]) return;
  if (state.excluded.includes(id)) { message('#studio-message', '这份材料在你的排除项里。要加入它，请先由你取消排除。', 'danger'); return; }
  pushHistory(); state.components = state.components.filter(item => item.role !== role && item.profile_id !== id); state.components.push({ profile_id: id, role }); state.selectedMaterial = null; resetCandidateView(); renderStudio(); message('#studio-message', `${profileName(id)}已放入${roles[role]}。`);
}
function currentPayload(components = state.components) {
  return { components: components.map(item => ({ profile_id: item.profile_id, role: item.role })), name: $('#card-name').value.trim() || '未名', scenario: $('#design-scene').value.trim(), user_notes: $('#design-words').value.trim(), raw_preferences: [...state.preferred], raw_exclusions: state.excluded.map(profileName), preferred_facets: [...state.preferred], deemphasized_facets: [...state.deemphasized], excluded_ids: [...state.excluded] };
}
function renderStudio() {
  renderPalette();
  for (const role of Object.keys(roles)) {
    const component = state.components.find(item => item.role === role); const item = component && profile(component.profile_id);
    $('#slot-' + role).innerHTML = item ? `<div class="slot-material"><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(forms[item.form] || item.form)} · ${escapeHTML(facetLabel(item.primary_family))}</small></div><button type="button" class="remove-slot" data-action="remove-role" data-role="${role}" aria-label="移除${roles[role]}">×</button>` : `<span class="slot-placeholder">${state.selectedMaterial ? '点击这里加入已选材料' : '先选一张材料卡，或把它拖到这里'}</span>`;
  }
  const vocabulary = list(state.boot?.vocabulary || state.boot?.knowledge?.vocabulary);
  const keys = vocabulary.length ? vocabulary.map(item => ({ key: item.canonical_facet || item.term || item.id, label: item.term || item.id })) : Object.entries(state.facets).map(([key, label]) => ({ key, label }));
  const extra = ['balsamic', 'creamy', 'warm', 'powdery', 'green'].filter(key => state.facets[key]).map(key => ({ key, label: facetLabel(key) }));
  const choices = [...keys, ...extra].filter((item, index, all) => all.findIndex(other => other.label === item.label) === index);
  for (const [container, values, group] of [['#preferred-tags', state.preferred, 'preferred'], ['#deemphasized-tags', state.deemphasized, 'deemphasized']]) {
    $(container).innerHTML = choices.map(item => `<button type="button" class="chip-button ${group === 'deemphasized' ? 'negative' : ''} ${values.includes(item.key) ? 'active' : ''}" data-action="toggle-facet" data-group="${group}" data-key="${escapeHTML(item.key)}" aria-pressed="${values.includes(item.key)}">${escapeHTML(item.label)}</button>`).join('');
  }
  $('#excluded-materials').innerHTML = state.profiles.map(item => `<label><input type="checkbox" data-exclude="${escapeHTML(item.id)}" ${state.excluded.includes(item.id) ? 'checked' : ''}>${escapeHTML(item.name.replace(/ (Givaudan|IFF|dsm).*$/, ''))}</label>`).join('');
  $('#design-summary').innerHTML = `<div class="summary-row"><strong>当前主调</strong>${escapeHTML(profileName(state.components.find(item => item.role === 'main')?.profile_id))}</div><div class="summary-row"><strong>更喜欢</strong>${escapeHTML(state.preferred.map(facetLabel).join('、') || '还未选定')}</div><div class="summary-row"><strong>希望少一点</strong>${escapeHTML(state.deemphasized.map(facetLabel).join('、') || '还未选定')}</div><div class="summary-row"><strong>排除项</strong>${escapeHTML(state.excluded.map(profileName).join('、') || '未指定')}</div><div class="summary-row"><strong>结果状态</strong>数字设计；尚未制作或实闻</div>`;
  $('#undo-design').disabled = !state.history.length;
}
function renderPalette() {
  const previousScroll = $('#profile-palette').scrollLeft;
  $('#profile-palette').innerHTML = state.profiles.length ? state.profiles.map(item => `<article class="material-card ${state.selectedMaterial === item.id ? 'selected' : ''}" draggable="true" data-profile="${escapeHTML(item.id)}" tabindex="0" aria-label="选择${escapeHTML(item.name)}"><h3><span class="family-mark ${escapeHTML(item.primary_family)}" aria-hidden="true"></span>${escapeHTML(item.name.replace(/ (Givaudan|IFF|dsm).*$/, ''))}</h3><p class="material-form">${escapeHTML(forms[item.form] || item.form)} · ${escapeHTML(item.supplier || '')}</p><div>${tags(list(item.reported_facets).slice(0, 4))}</div><div class="material-footer"><span class="subtle">厂家资料参照</span><button type="button" class="text-button" data-action="profile-detail" data-id="${escapeHTML(item.id)}">看出处</button></div></article>`).join('') : empty('参照材料尚未载入', '请检查本地服务后重试。');
  $('#profile-palette').scrollLeft = previousScroll;
  updatePaletteControls();
  const presets = list(state.boot?.presets);
  $('#preset-list').innerHTML = presets.length ? presets.map((item, index) => `<div class="preset-card"><strong>${escapeHTML(item.name || item.title || `设计草案 ${index + 1}`)}</strong><p>${escapeHTML(item.description || item.intent || item.scenario || '项目拟定的数字构图，尚未实闻。')}</p><span class="subtle">设计意图 · 非古方复原</span><br><button type="button" class="text-button" data-action="use-preset" data-index="${index}">以此起稿 →</button></div>`).join('') : '<p class="fine-note">暂无已整理的设计草案。可以直接挑选材料开始。</p>';
}
function updatePaletteControls() {
  const palette = $('#profile-palette');
  $('#palette-prev').disabled = palette.scrollLeft < 2;
  $('#palette-next').disabled = palette.scrollLeft + palette.clientWidth >= palette.scrollWidth - 2;
}
function describeFailure(result) {
  const words = list(result.unknown_descriptors || result.unknown_facets || result.unmapped_project_terms).map(niceText);
  if (words.length) return `这些描述还没有对应资料：${words.join('、')}。你的原话会保留，可以换一个词或继续查图鉴。`;
  return result.reason || result.message || '当前资料池没有满足这些条件的候选。排除项保持不变，可以由你调整偏好。';
}
async function generateDesign(button) {
  message('#studio-message', '');
  await busy(button, '正在比较构图…', async () => {
    try {
      const main = state.components.find(item => item.role === 'main');
      const request = { preferred_facets: state.preferred, deemphasized_facets: state.deemphasized, excluded_ids: state.excluded, limit: 2 };
      if (main && $('#lock-main').checked) request.locked_main_id = main.profile_id;
      const result = await api('/api/compose', { method: 'POST', body: request });
      if (result.status !== 'ok' || !result.candidates?.length) { resetCandidateView(); message('#studio-message', describeFailure(result)); return; }
      state.candidates = result.candidates.map((item, index) => ({ ...item, name: item.name || `候选${index + 1}`, scenario: $('#design-scene').value.trim() }));
      renderCandidates();
      message('#studio-message', '已按资料标签和你的条件形成两份候选，比较的是设计构图，真实组合气味仍待实闻。', 'success');
      $('#candidates-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) { message('#studio-message', error.message, 'danger'); }
  });
}
function componentChanges(components) {
  const before = new Map(state.components.map(item => [item.profile_id, item.role]));
  const after = new Map(components.map(item => [item.profile_id, item.role]));
  const changes = [];
  for (const [id, role] of before) if (!after.has(id)) changes.push(`移出${profileName(id)}`); else if (after.get(id) !== role) changes.push(`${profileName(id)}从${roles[role]}移到${roles[after.get(id)]}`);
  for (const [id, role] of after) if (!before.has(id)) changes.push(`加入${profileName(id)}，放在${roles[role]}`);
  return changes.length ? changes : ['保留当前构图，以你的偏好继续比较。'];
}
function renderCandidates() {
  $('#candidates-section').hidden = false;
  $('#candidate-results').innerHTML = state.candidates.map((item, index) => `<article class="candidate-card"><p class="candidate-index">候选 ${index + 1}</p><h3>${escapeHTML(index === 0 ? '第一份构图' : '另一种表达')}</h3>${list(item.components).map(part => `<div class="candidate-role"><span class="role-name">${escapeHTML(roles[part.role] || part.role)}</span><div><strong>${escapeHTML(part.name || profileName(part.profile_id))}</strong><div class="subtle">${escapeHTML(forms[part.form || profile(part.profile_id)?.form] || part.form || '')}</div></div></div>`).join('')}<div>${tags(item.matched_preferences || [])}</div>${list(item.unmatched_preferences).length ? `<p class="fine-note">尚未匹配：${escapeHTML(item.unmatched_preferences.map(facetLabel).join('、'))}</p>` : ''}<div class="candidate-changes"><strong>相对当前案头</strong><ul>${componentChanges(item.components || []).map(text => `<li>${escapeHTML(text)}</li>`).join('')}</ul></div><div class="candidate-actions"><button type="button" class="button primary" data-action="choose-candidate" data-index="${index}">以此继续调整</button><button type="button" class="button quiet" data-action="candidate-card" data-index="${index}">命名留笺</button></div><p class="fine-note">数字设计 · 组合气味未经实闻，不含制作比例。</p></article>`).join('');
  if (state.candidates.length > 1) {
    $('#candidate-comparison').hidden = false;
    const [a, b] = state.candidates;
    const unique = item => list(item.components).filter(part => !list(item === a ? b.components : a.components).some(other => other.profile_id === part.profile_id && other.role === part.role));
    $('#candidate-comparison').innerHTML = `<h3>两份之间的差别</h3><div class="comparison-grid">${[a, b].map((item, i) => `<div><strong>候选 ${i + 1} 的不同处</strong><p>${escapeHTML(unique(item).map(part => `${roles[part.role]}：${part.name || profileName(part.profile_id)}`).join('；') || '材料与角色一致。')}</p></div>`).join('')}</div><p class="fine-note">标签没有报道，不等于气味不存在；“少一点甜香”是本轮设计意图，不是无甜、无刺激的保证。</p>`;
  }
  renderIntegrationOptions();
}

function analysisSource(value) {
  if (!value) return '';
  if (typeof value === 'string') return escapeHTML(value);
  const fieldLabels = { ingredients: '成分输入', notes: '香调输入', description: '商品描述', personal_notes: '个人实闻输入', extracted_text: '附件文字' };
  const label = value.label || fieldLabels[value.field] || '提供的资料';
  const url = safeURL(value.url, false);
  return `${escapeHTML(label)}${url ? ` · <a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">提供者标注的链接</a>` : ''}`;
}
function analysisItems(value) {
  if (value == null || value === '') return '<p>暂无可确认资料。</p>';
  if (typeof value === 'object' && !Array.isArray(value) && !value.text && !value.name) return `<ul>${Object.entries(value).map(([key, item]) => `<li>${escapeHTML(key)}：${escapeHTML(list(item).map(niceText).join('、'))}</li>`).join('')}</ul>`;
  return `<ul>${list(value).map(item => {
    if (typeof item !== 'object') return `<li>${escapeHTML(niceText(item))}</li>`;
    const basis = item.basis;
    const family = item.family ? `<strong>${escapeHTML(facetLabel(item.family))}</strong> · ` : '';
    return `<li>${family}${escapeHTML(niceText(item))}${basis?.text ? `<div class="evidence-line">依据原文：${escapeHTML(basis.text)}</div>` : ''}${item.source || basis?.source ? `<div class="evidence-line">来源：${analysisSource(item.source || basis.source)}</div>` : ''}${item.verification ? `<div class="evidence-line">${escapeHTML(item.verification)}</div>` : ''}</li>`;
  }).join('')}</ul>`;
}
function analysisHTML(analysis = {}) {
  const ingredients = analysis.declared_ingredients || analysis.ingredient_declarations || analysis.ingredients || [];
  const notes = analysis.reported_notes || analysis.brand_notes || analysis.declared_notes || [];
  const observations = analysis.personal_observations || analysis.personal_notes || [];
  const inferences = analysis.system_inferences || analysis.inferences || [];
  const families = list(analysis.families || analysis.fragrance_families).map(niceText);
  return `<div class="analysis-result"><div class="panel-heading"><h3>资料拆解</h3><span class="status-pill private">私人分析</span></div>${families.length ? `<p>可能的香气家族：${tags(families)}</p>` : '<p class="fine-note">现有资料不足以归类香气家族。</p>'}<div class="analysis-grid"><section class="analysis-section"><h4>成分声明</h4>${analysisItems(ingredients)}<p class="fine-note">资料明确声明的材料，不代表完整秘方。</p></section><section class="analysis-section"><h4>品牌 / 制作者香调</h4>${analysisItems(notes)}<p class="fine-note">气味描述与真实成分分开记录。</p></section><section class="analysis-section"><h4>个人实闻</h4>${analysisItems(observations)}<p class="fine-note">只记录你提供的观察，不由系统代闻。</p></section><section class="analysis-section inference"><h4>系统归纳与推测</h4>${analysisItems(inferences)}<p class="fine-note">依据上传资料推断，不是检测结果。</p></section></div><div class="detail-block"><h4>未知与资料限制</h4>${analysisItems(analysis.gaps || analysis.unknowns || ['未公开的配方比例保持未知，实际气味尚未由系统验证。'])}</div></div>`;
}
async function loadRecords() {
  if (!state.user) return;
  const [result, designs] = await Promise.all([api('/api/products'), api('/api/designs')]); state.records = result.products || []; state.savedDesigns = designs.designs || []; renderRecords(); renderSavedDesigns();
}
function renderSavedDesigns() {
  const container = $('#saved-designs'); if (!container) return;
  container.innerHTML = state.savedDesigns.length ? state.savedDesigns.map((item, index) => `<article class="record-card"><h3>${escapeHTML(item.name || item.design?.name || '未名')}</h3><p class="subtle">${escapeHTML(item.scenario || item.design?.scenario || '个人数字设计')} · 尚未实闻</p><button type="button" class="text-button" data-action="reopen-design" data-index="${index}">查看香笺 →</button></article>`).join('') : '<p class="fine-note">登录后下载的香笺会保存在这里。</p>';
}
function recordMarkup(product, manage = false) {
  const publicOptions = [['description', '产品描述'], ['notes', '品牌香调'], ['ingredients', '成分声明'], ['source_url', '来源链接'], ['image', '公开产品图'], ['price', '价格说明']];
  const existing = list(product.public_fields);
  const defaults = product.published ? existing : ['description', 'notes', 'source_url'];
  const asset = safeURL(product.asset_url);
  return `<article class="record-card" data-record="${escapeHTML(product.id)}"><div class="record-head"><div><h3>${escapeHTML(product.name)}</h3><p class="subtle">${escapeHTML(product.brand || '品牌未补充')} · ${escapeHTML(forms[product.form] || product.form || '形态待补充')}${product.spec ? ` · ${escapeHTML(product.spec)}` : ''}</p></div><span class="status-pill ${product.published ? '' : 'private'}">${product.published ? '已挂首页' : '仅本人可见'}</span></div>${product.description ? `<p>${escapeHTML(product.description)}</p>` : ''}${product.file_name ? `<p class="fine-note">附件：${escapeHTML(product.file_name)}${asset ? ` · <a href="${escapeHTML(asset)}" target="_blank" rel="noopener noreferrer">查看本人附件</a>` : ''} · ${escapeHTML(ocrLabel(product.ocr_status))}</p>` : ''}<div class="record-actions"><button type="button" class="button secondary" data-action="record-detail" data-id="${escapeHTML(product.id)}">查看拆解报告</button><button type="button" class="button quiet" data-action="edit-record" data-id="${escapeHTML(product.id)}">补充 / 修改</button><button type="button" class="text-button" data-action="record-reference" data-id="${escapeHTML(product.id)}">作为喜好参照 →</button></div>${manage ? `<form class="publish-form" data-product="${escapeHTML(product.id)}"><h4>${product.published ? '调整首页展示' : '选择公开的信息'}</h4><p class="publish-note">名称、品牌、形态与规格会作为商品身份公开。其他内容由你选择；私人咨询与原附件不公开。</p><div class="publish-field-row"><div class="field"><label>商家购买链接</label><input name="purchase_url" type="url" value="${escapeHTML(product.purchase_url || '')}" placeholder="https://"></div><div class="field"><label>价格说明 <span class="subtle">可选</span></label><input name="price" value="${escapeHTML(product.price || '')}" maxlength="80" placeholder="由商家页查看"></div></div><div class="exclude-list">${publicOptions.map(([key, label]) => `<label><input type="checkbox" name="public_fields" value="${key}" ${defaults.includes(key) ? 'checked' : ''} ${key === 'image' && !product.asset_url ? 'disabled' : ''}>${label}</label>`).join('')}</div>${asset && product.file_name && /\.(png|jpe?g|webp)$/i.test(product.file_name) ? `<p class="fine-note">选择“公开产品图”后，首页使用去除元数据的独立图片副本。</p>` : ''}<div class="record-actions"><button type="submit" class="button primary">${product.published ? '更新首页信息' : '挂到首页'}</button>${product.published ? `<button type="button" class="button quiet" data-action="unpublish" data-id="${escapeHTML(product.id)}">从首页撤下</button>` : ''}</div><div class="notice" hidden></div></form>` : ''}</article>`;
}
function ocrLabel(value) {
  if (!value) return '文字提取状态待确认';
  if (typeof value === 'object') return niceText(value.message || value.status || value);
  const labels = { recognized: '已识别照片文字，仍需核对', text_read: '已读取文字资料', pdf_text_read: '已读取PDF文字', pdf_no_text: 'PDF无可读取文字，可改传照片', document_text_read: '已读取Word文字', unavailable: '照片文字识别暂不可用，可补充文字', not_needed: '没有需要识别的附件', success: '已提取文字，仍需核对', extracted: '已提取文字，仍需核对', recognized: '已识别文字，仍需核对', text_read: '已读取文字资料', pdf_text_read: '已提取 PDF 文字', docx_text_read: '已提取 Word 文字', pdf_no_text: 'PDF 没有可读文字，可改传照片', unavailable: '文字识别暂不可用，可手动补充', not_needed: '无需文字识别', ok: '已提取文字，仍需核对', no_text: '未找到可读文字，可补充描述', not_requested: '没有需要提取的附件', pending: '等待文字提取', failed: '文字未提取成功，可补充文字', skipped: '未执行文字提取' };
  return labels[value] || value;
}
function renderRecords() {
  const privateRecords = state.records.filter(item => item.kind !== 'catalog');
  $('#private-records').innerHTML = privateRecords.length ? privateRecords.map(item => recordMarkup(item)).join('') : empty('还没有私人香品档案', '可以上传一张包装照片，或先记录标签上的文字。不需要提交秘密配方。');
  const catalogs = state.records.filter(item => item.kind === 'catalog');
  $('#manager-records').innerHTML = catalogs.length ? catalogs.map(item => recordMarkup(item, true)).join('') : empty('第一件商品，从资料开始', '添加你已有的香品，再自主选择首页展示字段与购买入口。保存档案不会自动挂首页。');
}
function addUploadFields() {
  for (const form of $$('.upload-form')) {
    const prefix = form.dataset.purpose === 'product' ? 'manager' : 'private';
    const nameField = form.querySelector('.field');
    nameField.insertAdjacentHTML('afterend', `<div class="publish-field-row"><div class="field"><label for="${prefix}-brand">品牌 / 制作者 <span class="subtle">可选</span></label><input id="${prefix}-brand" name="brand" maxlength="120"></div><div class="field"><label for="${prefix}-spec">产品规格 <span class="subtle">可选</span></label><input id="${prefix}-spec" name="spec" maxlength="120"></div></div>`);
    const descriptionField = form.querySelector('textarea[name=description]').closest('.field');
    descriptionField.insertAdjacentHTML('afterend', `<details><summary class="subtle">分别记录成分、香调与自己的实闻 <span aria-hidden="true">＋</span></summary><div class="field"><label for="${prefix}-ingredients">标签上的成分声明</label><textarea id="${prefix}-ingredients" name="ingredients" rows="2" maxlength="5000" placeholder="原文仅写香精时，保留这一声明，不猜比例。"></textarea></div><div class="field"><label for="${prefix}-notes">品牌 / 制作者的香调描述</label><textarea id="${prefix}-notes" name="notes" rows="2" maxlength="5000" placeholder="例如包装或详情页明确写出的木质、花香等。"></textarea></div><div class="field"><label for="${prefix}-personal-notes">自己的实闻记录</label><textarea id="${prefix}-personal-notes" name="personal_notes" rows="2" maxlength="5000" placeholder="可以写闻过哪个样品、如何使用、自己的感受。"></textarea></div></details>`);
    const files = form.querySelector('input[type=file]'); files.removeAttribute('multiple'); files.accept = '.png,.jpg,.jpeg,.webp,.pdf,.txt,.md,.docx';
    const label = form.querySelector(`label[for=${prefix}-files]`); label.innerHTML = `包装照片 / 标签 / 文档 <span class="subtle">每次一份，不超过 8 MB</span>`;
  }
}
function readFile(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('这份附件未能读取，请重新选择。')); reader.readAsDataURL(file); }); }
async function uploadProduct(form) {
  const prefix = form.dataset.purpose === 'product' ? 'manager' : 'private';
  const button = form.querySelector('button[type=submit]');
  message(`#${prefix}-upload-message`, '');
  if (!state.user) { openDialog('#auth-dialog'); return; }
  await busy(button, '保存与提取资料…', async () => {
    try {
      const values = new FormData(form); const file = form.querySelector('input[type=file]').files[0];
      if (file && file.size > 8 * 1024 * 1024) throw new Error('附件超过 8 MB，请选择较小的图片或文档。');
      if (file && !/\.(png|jpe?g|webp|pdf|txt|md|docx)$/i.test(file.name)) throw new Error('请上传 JPG、PNG、WEBP、TXT、Markdown、PDF 或 Word 文件。');
      const payload = { name: values.get('name')?.trim(), brand: values.get('brand')?.trim(), form: values.get('product_form'), spec: values.get('spec')?.trim(), description: values.get('description')?.trim(), source_url: values.get('source_url')?.trim(), notes: values.get('notes')?.trim(), ingredients: values.get('ingredients')?.trim(), personal_notes: values.get('personal_notes')?.trim(), kind: prefix === 'manager' ? 'catalog' : 'private' };
      if (file) payload.file = { name: file.name, type: file.type, data: await readFile(file) };
      const result = await api('/api/products', { method: 'POST', body: payload });
      await loadRecords(); form.reset(); form.querySelector('.file-selection').textContent = '';
      message(`#${prefix}-upload-message`, prefix === 'manager' ? '商品档案已保存。请核对分析，再在右侧选择公开字段与首页展示。' : '私人档案已保存，只有本人可查看。', 'success');
      if (result.product) showRecord(result.product);
    } catch (error) { message(`#${prefix}-upload-message`, error.message, 'danger'); }
  });
}
function showRecord(product) {
  $('#detail-content').innerHTML = `<p class="eyebrow">已有香品 · 私人咨询</p><h2 class="detail-heading">${escapeHTML(product.name)}</h2><p class="subtle">${escapeHTML(forms[product.form] || product.form || '形态待补充')} · 依据上传资料</p>${analysisHTML(product.analysis || {})}${product.description ? `<details><summary>查看保存的原始描述</summary><p>${escapeHTML(product.description)}</p></details>` : ''}${product.source_url ? `<p>${sourceLink({ url: product.source_url, title: '上传者提供的资料链接' })}</p>` : ''}`;
  openDialog('#detail-dialog');
}
function editRecord(product) {
  const fields = [['name', '产品名称'], ['brand', '品牌 / 制作者'], ['spec', '规格'], ['description', '产品说明'], ['ingredients', '标签成分声明'], ['notes', '品牌香调'], ['personal_notes', '个人实闻'], ['source_url', '公开资料链接']];
  $('#detail-content').innerHTML = `<p class="eyebrow">本人资料</p><h2>补充与核对</h2><form id="edit-product-form" data-id="${escapeHTML(product.id)}">${fields.map(([key, label]) => `<div class="field"><label for="edit-${key}">${label}</label>${['description', 'ingredients', 'notes', 'personal_notes'].includes(key) ? `<textarea id="edit-${key}" name="${key}" rows="3" maxlength="12000">${escapeHTML(Array.isArray(product[key]) ? product[key].join('、') : product[key] || '')}</textarea>` : `<input id="edit-${key}" name="${key}" value="${escapeHTML(product[key] || '')}" ${key === 'name' ? 'required' : ''} ${key === 'source_url' ? 'type="url"' : ''}>`}</div>`).join('')}<div class="notice" hidden></div><button type="submit" class="button primary">保存并更新分析</button><p class="fine-note">已选择公开的字段会同步首页；私人实闻与未选择字段仍然私有。</p></form>`;
  openDialog('#detail-dialog');
}
function showPublicProduct(product) {
  const analysis = product.analysis || {};
  $('#detail-content').innerHTML = `<p class="eyebrow">管理者公开的商品资料</p><h2>${escapeHTML(product.name)}</h2><p>${escapeHTML(product.brand || '')} · ${escapeHTML(forms[product.form] || product.form || '')}${product.spec ? ` · ${escapeHTML(product.spec)}` : ''}</p>${product.description ? `<p>${escapeHTML(product.description)}</p>` : ''}<div class="analysis-grid"><section class="analysis-section"><h4>公开香调</h4>${analysisItems(analysis.reported_notes || product.notes)}</section><section class="analysis-section inference"><h4>资料归纳与未知</h4>${analysisItems(analysis.system_inferences)}${analysisItems(analysis.gaps)}</section></div>${product.ingredients ? `<div class="detail-block"><h3>管理者公开的成分声明</h3>${analysisItems(product.ingredients)}</div>` : ''}<p class="fine-note">与个人设计相似，不代表同一配方。具体价格、库存与购买信息以商家页为准。</p><div class="inline-actions">${safeURL(product.purchase_url, false) ? `<a class="button primary" href="${escapeHTML(safeURL(product.purchase_url, false))}" target="_blank" rel="noopener noreferrer">前往商家购买 ↗</a>` : ''}${product.source_url ? sourceLink({ url: product.source_url, title: '资料来源' }) : ''}</div>`;
  openDialog('#detail-dialog');
}

function renderLibrary() {
  $$('.tab-button[data-library]').forEach(node => { const active = node.dataset.library === state.library; node.classList.toggle('active', active); node.setAttribute('aria-selected', String(active)); });
  const knowledge = state.boot?.knowledge || {};
  let items;
  if (state.library === 'profiles') items = state.profiles.map(item => `<article class="library-card"><p class="eyebrow">现代参照 · ${escapeHTML(forms[item.form] || item.form)}</p><h2>${escapeHTML(item.name)}</h2><p class="latin">${escapeHTML(item.source_plant_name || '')}</p><div>${tags(item.reported_facets)}</div><p class="fine-note">厂家描述已记录；团队尚未实闻，组合效果未验证。</p><div class="library-actions"><button type="button" class="text-button" data-action="profile-detail" data-id="${escapeHTML(item.id)}">完整资料 →</button><button type="button" class="text-button" data-action="use-profile" data-id="${escapeHTML(item.id)}">带到调香案 →</button></div></article>`);
  else if (state.library === 'materials') items = list(knowledge.materials).map(item => `<article class="library-card"><p class="eyebrow">传统香材资料</p><h2>${escapeHTML(item.name)}</h2><p class="latin">${escapeHTML(item.source_plant_candidate || '植物身份尚待核对')}</p><div>${list(item.forms).map(form => `<span class="tag">${escapeHTML(forms[form.object_form] || form.name || form.object_form)}</span>`).join('')}</div><p>${escapeHTML(list(item.gaps).slice(0, 2).join('；') || '请查阅具体记录的使用范围。')}</p><div class="source-note">资料陈述与实物验证分开 · 尚未实闻</div><button type="button" class="text-button" data-action="material-detail" data-id="${escapeHTML(item.id)}">查看来源与未知 →</button></article>`);
  else if (state.library === 'formulas') items = list(knowledge.historical_formulas).map(item => `<article class="library-card"><p class="eyebrow">历史参考 · 非制作香方</p><h2>${escapeHTML(item.name)}</h2><p>${escapeHTML(list(item.ingredients_original).join('、'))}</p><p>${escapeHTML(item.limitations || '')}</p><div class="source-note">数字转录已记录；现代身份、制作与气味仍待核对。</div><button type="button" class="text-button" data-action="formula-detail" data-id="${escapeHTML(item.id)}">查看书卷与原名 →</button></article>`);
  else items = [...list(knowledge.culture_claims).map(item => `<article class="library-card"><p class="eyebrow">文化与感知记录</p><p>${escapeHTML(item.text)}</p>${evidenceHTML(item.evidence)}${item.limitations ? `<p class="fine-note">${escapeHTML(item.limitations)}</p>` : ''}</article>`), ...list(knowledge.rules).map(item => `<article class="library-card"><p class="eyebrow">项目知识使用规则</p><h2>${escapeHTML(item.name)}</h2><p>${escapeHTML(item.policy)}</p><span class="status-pill pending">项目规则，不是古典事实</span></article>`)];
  $('#library-content').innerHTML = items.length ? items.join('') : empty('这一页资料尚未载入', '未知内容保持空缺，不由模型补写。');
}
function showProfile(id) {
  const item = profile(id); if (!item) return;
  $('#detail-content').innerHTML = `<p class="eyebrow">现代参照 · 具体材料档案</p><h2 class="detail-heading">${escapeHTML(item.name)}</h2><p class="latin">${escapeHTML(item.source_plant_name || '')}</p><p>${escapeHTML(forms[item.form] || item.form)} · ${escapeHTML(item.supplier || '')}</p><div>${tags(item.reported_facets)}</div><p class="fine-note">以上是厂家资料中的定性描述，不是本团队实闻或混合预测。</p><div class="detail-block"><h3>形态与条件</h3><p>加工记录：${escapeHTML(item.process || '未公开')}<br>使用部位：${escapeHTML(item.processed_part || '未确认')}<br>稀释情况：${escapeHTML(item.dilution ? niceText(item.dilution) : '未公开，不默认纯品')}</p></div>${item.temporal_note ? `<div class="detail-block"><h3>持久度资料的范围</h3><p>${escapeHTML(item.temporal_note)}</p></div>` : ''}<div class="detail-block"><h3>出处</h3>${sourceLink(item.source_id || item.source_url)}<p class="fine-note">精油、提取物、香粉与燃烧烟气分别记录，不自动继承描述。</p></div><button type="button" class="button secondary" data-action="use-profile" data-id="${escapeHTML(id)}">带到调香案</button>`;
  openDialog('#detail-dialog');
}
function showKnowledge(kind, id) {
  const knowledge = state.boot?.knowledge || {};
  const item = list(knowledge[kind]).find(record => record.id === id); if (!item) return;
  if (kind === 'materials') $('#detail-content').innerHTML = `<p class="eyebrow">香材资料 · 按字段核对</p><h2>${escapeHTML(item.name)}</h2><p class="latin">候选植物来源：${escapeHTML(item.source_plant_candidate || '待核对')}</p><ul class="fact-list">${list(item.facts).map(fact => `<li>${escapeHTML(fact.text)}${evidenceHTML(fact.evidence)}${fact.limitations ? `<p class="fine-note">${escapeHTML(fact.limitations)}</p>` : ''}</li>`).join('')}</ul><div class="detail-block"><h3>按具体形态阅读</h3>${list(item.forms).map(form => `<p><strong>${escapeHTML(form.name)}</strong><br>${form.sensory_tags?.length ? tags(form.sensory_tags) : '<span class="subtle">暂无可用的细嗅觉标签。</span>'}</p>`).join('')}</div><div class="detail-block"><h3>尚未知晓</h3><ul class="gap-list">${list(item.gaps).map(gap => `<li>${escapeHTML(gap)}</li>`).join('')}</ul></div><p class="fine-note">找到出处只验证资料陈述，不验证市售实物身份、制作安全或组合气味。</p>`;
  else $('#detail-content').innerHTML = `<p class="eyebrow">历史香方档案</p><h2>${escapeHTML(item.name)}</h2><p>原名材料：${escapeHTML(list(item.ingredients_original).join('、'))}</p><p>条目定位：${escapeHTML(item.locator || '')}</p>${sourceLink(item.source_id)}<div class="notice">数字转录已记录，尚未逐字校勘影印。原名不自动替换成现代原料，本版不导出克数、比例或制作工艺。</div><p>${escapeHTML(item.limitations || '')}</p>`;
  openDialog('#detail-dialog');
}

async function openCard(components = state.components, name = '') {
  if (!components.some(item => item.role === 'main')) { message('#studio-message', '请先挑一份主调，再为构图留笺。'); navigate('studio'); return; }
  try {
    const payload = currentPayload(components); payload.name = name || '未名';
    const result = await api('/api/evaluate', { method: 'POST', body: payload });
    if (!result.design || !['ok', 'untested_composite_design'].includes(result.status)) { message('#studio-message', describeFailure(result)); navigate('studio'); return; }
    state.cardDesign = { ...result.design, components: result.design.components || components, name: payload.name, scenario: payload.scenario, preferred_facets: [...state.preferred], deemphasized_facets: [...state.deemphasized], excluded_ids: [...state.excluded], user_words: $('#design-words').value.trim(), evaluation_payload: payload };
    $('#card-name').value = name || ''; renderCard(); $('#card-matches').innerHTML = '<p class="fine-note">仅匹配管理者公开的商品；相似方向不代表同一配方。</p>'; openDialog('#card-dialog');
  } catch (error) { message('#studio-message', error.message, 'danger'); navigate('studio'); }
}
function cardSources(design) {
  const components = list(design.components);
  return components.map(part => ({ name: part.name || profileName(part.profile_id), url: part.source_url || source(profile(part.profile_id)?.source_id)?.url || '', supplier: profile(part.profile_id)?.supplier || '' }));
}
function renderCard() {
  const design = state.cardDesign; if (!design) return;
  design.name = $('#card-name').value.trim() || '未名';
  $('#card-preview').innerHTML = `<p class="card-kicker">合香 · 个人香笺</p><h3 class="card-title">${escapeHTML(design.name)}</h3><p class="card-scene">${escapeHTML(design.scenario || '给自己的生活，留一份香气设计。')}</p><div class="card-composition">${Object.keys(roles).map(role => { const part = list(design.components).find(item => item.role === role); return part ? `<div class="card-role-line ${role}"><span>${roles[role]}</span><strong>${escapeHTML(part.name || profileName(part.profile_id))}</strong></div>` : ''; }).join('')}</div>${design.user_words ? `<p class="card-original">「${escapeHTML(design.user_words)}」</p>` : ''}<p class="card-original">更喜欢：${escapeHTML(list(design.preferred_facets).map(facetLabel).join('、') || '以当前构图表达')}<br>希望少一点：${escapeHTML(list(design.deemphasized_facets).map(facetLabel).join('、') || '未指定')}<br>排除：${escapeHTML(list(design.excluded_ids).map(profileName).join('、') || '未指定')}</p><div class="card-provenance">材料形态：${escapeHTML([...new Set(list(design.components).map(part => forms[part.form || profile(part.profile_id)?.form] || part.form || '参照材料'))].join('、'))}<br>来源：${escapeHTML([...new Set(cardSources(design).map(item => item.supplier).filter(Boolean))].join('、') || '参照材料档案')}<br>主次是设计位置，不是投料比例。</div><div class="card-stamp"><span>数字设计 · 尚未制作、实闻</span><span class="seal" aria-hidden="true">意</span></div>`;
}
function wrapCanvasText(context, text, maxWidth) {
  const lines = []; let line = '';
  for (const char of String(text)) { if (char === '\n') { lines.push(line); line = ''; continue; } const next = line + char; if (context.measureText(next).width > maxWidth && line) { lines.push(line); line = char; } else line = next; }
  lines.push(line); return lines;
}
async function findMatches(button) {
  if (!state.cardDesign) return;
  await busy(button, '正在查找…', async () => {
    try {
      const result = await api('/api/match', { method: 'POST', body: { design: state.cardDesign } });
      const matches = list(result.matches);
      $('#card-matches').innerHTML = matches.length ? matches.slice(0, 4).map(match => {
        const product = match.product || {};
        return `<article class="matched-product"><div class="panel-heading"><strong>${escapeHTML(product.name || '未命名香品')}</strong><span class="subtle">${escapeHTML(forms[product.form] || product.form || '形态待补充')}</span></div><div>${tags(match.matched_families || match.display_families)}</div><p>${escapeHTML(list(match.reasons).map(niceText).join(' '))}</p><p class="fine-note">${escapeHTML(list(match.unknowns).map(niceText).join('；'))}</p>${safeURL(product.purchase_url, false) ? `<a class="button secondary" href="${escapeHTML(safeURL(product.purchase_url, false))}" target="_blank" rel="noopener noreferrer">前往商家查看 ↗</a>` : '<span class="status-pill pending">购买入口待补充</span>'}</article>`;
      }).join('') : '<p class="fine-note">目前首页没有资料方向相近的公开商品。你的设计可以继续保存，不会为匹配而取消排除项。</p>';
    } catch (error) { $('#card-matches').innerHTML = `<div class="notice danger">${escapeHTML(error.message)}</div>`; }
  });
}
async function downloadCard(button) {
  if (!state.cardDesign) return;
  await busy(button, '正在留笺…', async () => {
    try {
      const design = state.cardDesign; design.name = $('#card-name').value.trim() || '未名';
      if (state.user) {
        const payload = { ...design.evaluation_payload, name: design.name, scenario: design.scenario };
        await api('/api/designs', { method: 'POST', body: payload });
        const saved = await api('/api/designs'); state.savedDesigns = saved.designs || []; renderSavedDesigns();
      }
      const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1700; let context = canvas.getContext('2d');
      if (!context) throw new Error('浏览器暂时无法生成图片，请尝试另一浏览器。');
      const blocks = []; let y = 90;
      const add = (text, size = 27, color = '#666c62', font = 'sans-serif', after = 24) => {
        context.font = `${size}px ${font === 'serif' ? '"Songti SC", "STSong", serif' : '"PingFang SC", sans-serif'}`;
        const lines = wrapCanvasText(context, text, 896);
        blocks.push({ type: 'text', lines, size, color, font, y }); y += lines.length * size * 1.65 + after;
      };
      add('合 香  ·  个 人 香 笺', 24, '#666c62', 'serif', 36);
      add(design.name, 60, '#a93f35', 'serif', 30);
      add(design.scenario || '给自己的生活，留一份香气设计。', 32, '#282b26', 'serif', 34);
      blocks.push({ type: 'line', y }); y += 38;
      for (const role of Object.keys(roles)) { const part = list(design.components).find(item => item.role === role); if (part) { add(roles[role], 23, '#666c62', 'sans-serif', 1); add(part.name || profileName(part.profile_id), role === 'main' ? 36 : role === 'support' ? 32 : 29, '#282b26', 'serif', 20); } }
      blocks.push({ type: 'line', y }); y += 38;
      if (design.user_words) add(`「${design.user_words}」`, 26, '#666c62', 'serif', 20);
      add(`更喜欢：${list(design.preferred_facets).map(facetLabel).join('、') || '以当前构图表达'}\n希望少一点：${list(design.deemphasized_facets).map(facetLabel).join('、') || '未指定'}\n排除：${list(design.excluded_ids).map(profileName).join('、') || '未指定'}`, 25, '#666c62', 'sans-serif', 24);
      add('来源按具体材料与形态记录：', 24, '#666c62', 'sans-serif', 6);
      cardSources(design).forEach(item => { add(`${item.name} · ${item.supplier}`, 22, '#666c62', 'sans-serif', 2); if (item.url) add(item.url, 18, '#666c62', 'sans-serif', 12); });
      add('主次是设计位置，不是投料比例。', 22, '#666c62', 'sans-serif', 14);
      add('数字设计 · 尚未制作、实闻', 22, '#666c62', 'sans-serif', 26);
      const height = Math.max(1200, Math.ceil(y + 120)); canvas.height = height; context = canvas.getContext('2d');
      context.fillStyle = '#f6f3eb'; context.fillRect(0, 0, canvas.width, height); context.strokeStyle = '#c4c8b7'; context.lineWidth = 2; context.strokeRect(45, 40, 990, height - 80);
      for (const block of blocks) {
        if (block.type === 'line') { context.strokeStyle = '#d2d5c7'; context.beginPath(); context.moveTo(92, block.y); context.lineTo(988, block.y); context.stroke(); continue; }
        context.fillStyle = block.color; context.font = `${block.size}px ${block.font === 'serif' ? '"Songti SC", "STSong", serif' : '"PingFang SC", sans-serif'}`; context.textBaseline = 'top';
        block.lines.forEach((line, i) => context.fillText(line, 92, block.y + i * block.size * 1.65));
      }
      context.strokeStyle = '#a93f35'; context.strokeRect(918, height - 111, 55, 60); context.fillStyle = '#a93f35'; context.font = '40px "Songti SC", serif'; context.fillText('意', 925, height - 104);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); if (!blob) throw new Error('图片导出未完成，请重试。');
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `合香-${design.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}.png`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); toast(state.user ? '香笺已保存，并导出为 PNG。' : '香笺已导出为 PNG。登录后可保存到自己的档案。');
    } catch (error) { toast(error.message); }
  });
}

function renderIntegrationOptions() {
  const options = [{ value: 'current', label: '当前调香案' }, ...state.candidates.map((item, i) => ({ value: String(i), label: `候选 ${i + 1}` })), ...(state.cardDesign ? [{ value: 'card', label: `香笺：${state.cardDesign.name || '未名'}` }] : [])];
  $('#integration-design').innerHTML = options.map(item => `<option value="${item.value}">${escapeHTML(item.label)}</option>`).join('');
  $('#integration-scene').innerHTML = '<option value="reading">书房 · 仅接受木质主调（模拟假设）</option><option value="lobby">民宿公共区 · 木质 / 香脂主调（模拟假设）</option>';
}
function logCall(request, response) {
  state.logs.unshift({ time: new Date().toLocaleTimeString('zh-CN'), request, response }); if (state.logs.length > 12) state.logs.pop(); $('#integration-log').textContent = JSON.stringify(state.logs, null, 2);
}
async function handoff(button) {
  await busy(button, '正在交接…', async () => {
    try {
      let design = state.cardDesign;
      const choice = $('#integration-design').value;
      const components = choice === 'current' ? state.components : choice === 'card' ? [] : state.candidates[Number(choice)]?.components || [];
      if (choice === 'card' && design) { /* 使用明确选择的已核对香笺。 */ }
      else { const result = await api('/api/evaluate', { method: 'POST', body: currentPayload(components) }); if (!result.design) throw new Error(describeFailure(result)); design = result.design; }
      if (!design) throw new Error('请先在调香案选择主调，形成一份设计。');
      const request = { action: 'handoff', design, space_id: $('#integration-scene').value };
      const result = await api('/api/simulation', { method: 'POST', body: request }); logCall(request, result); state.simulation = result.simulation || null; state.simulationConfirmed = false;
      const accepted = result.status === 'accepted';
      $('#handoff-result').innerHTML = `<div class="handoff-status ${accepted ? '' : 'rejected'}"><h3>${accepted ? '模拟空间接受这份设计' : '模拟空间暂不接受'}</h3><p>${escapeHTML(result.reason || (accepted ? '符合本演示的模拟兼容规则。' : '请查看场景支持的主家族。'))}</p>${accepted ? '<button type="button" class="button secondary" data-action="confirm-simulation">确认这次模拟使用</button>' : '<button type="button" class="text-button" data-go="studio">返回案头调整 →</button>'}<p class="fine-note">接受只说明符合模拟规则，不验证真实耗材或设备兼容。</p></div>`;
      renderSimulation();
    } catch (error) { message('#simulation-message', error.message, 'danger'); }
  });
}
function renderSimulation() {
  const item = state.simulation;
  $('#simulation-state').innerHTML = `<span class="device-dot ${item?.running ? 'on' : ''}"></span><span>${!item ? '等待方案交接' : !state.simulationConfirmed ? '等待你确认本次模拟' : item.running ? '模拟运行中' : '模拟已关闭'}${item?.timer_minutes ? `<br><small>定时 ${escapeHTML(item.timer_minutes)} 分钟</small>` : ''}</span>`;
  for (const id of ['#simulation-on', '#simulation-off', '#simulation-timer']) $(id).disabled = !item || !state.simulationConfirmed;
}
async function controlSimulation(action, button) {
  if (!state.simulationConfirmed || !state.simulation) return;
  await busy(button, '操作中…', async () => {
    try {
      const request = { action, simulation_id: state.simulation.id };
      if (action === 'set_timer') { const minutes = Number($('#simulation-duration').value); if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw new Error('请填写 1 至 120 之间的整数分钟数。'); request.timer_minutes = minutes; }
      const result = await api('/api/simulation', { method: 'POST', body: request }); logCall(request, result); state.simulation = result.simulation || state.simulation; renderSimulation(); message('#simulation-message', '模拟状态已更新，调用记录可在下方查看。', 'success');
    } catch (error) { message('#simulation-message', error.message, 'danger'); }
  });
}

document.addEventListener('click', async event => {
  const button = event.target.closest('button, a[data-go]');
  if (button?.disabled) return;
  if (button?.dataset.page || button?.dataset.go) { navigate(button.dataset.page || button.dataset.go, true); return; }
  if (button?.classList.contains('close-dialog')) { button.closest('dialog').close(); return; }
  const action = button?.dataset.action;
  if (action === 'login') { message('#auth-message', ''); openDialog('#auth-dialog'); }
  else if (action === 'logout') {
    await busy(button, '退出中…', async () => { try { await api('/api/logout', { method: 'POST' }); const session = await api('/api/session'); state.user = session.user; state.csrf = session.csrf_token || ''; clearPrivateState(); state.simulation = null; state.simulationConfirmed = false; state.logs = []; $('#integration-log').textContent = '尚未调用。'; renderAccount(); renderAuthRequirements(); renderSimulation(); renderHome(); if (state.page === 'manage') navigate('home'); toast('已退出，私人资料与当前浏览器草稿已清空。'); } catch (error) { toast(error.message); } });
  }
  else if (action === 'profile-detail') showProfile(button.dataset.id);
  else if (action === 'use-profile') { state.selectedMaterial = button.dataset.id; closeDialog('#detail-dialog'); navigate('studio', true); renderStudio(); toast('已选中这份参照。点击一个构图位置加入。'); }
  else if (action === 'remove-role') { pushHistory(); state.components = state.components.filter(item => item.role !== button.dataset.role); resetCandidateView(); renderStudio(); }
  else if (action === 'toggle-facet') { pushHistory(); const group = button.dataset.group; const key = button.dataset.key; state[group] = state[group].includes(key) ? state[group].filter(item => item !== key) : [...state[group], key]; resetCandidateView(); renderStudio(); }
  else if (action === 'use-preset') {
    const preset = list(state.boot?.presets)[Number(button.dataset.index)]; if (!preset) return; pushHistory();
    state.components = list(preset.components || preset.design?.components).map(item => ({ profile_id: item.profile_id || item.id, role: item.role })).filter(item => profile(item.profile_id));
    state.preferred = list(preset.preferred_facets || preset.request?.preferred_facets); state.deemphasized = list(preset.deemphasized_facets || preset.request?.deemphasized_facets); state.excluded = list(preset.excluded_ids); $('#design-scene').value = preset.scenario || preset.scene || ''; $('#design-words').value = ''; $('#card-name').value = preset.name || ''; resetCandidateView(); renderStudio(); $('.preset-drawer').open = false; message('#studio-message', '已将设计草案放到案头。自己的话留给你填写，草案不代表你的原话。');
    if (matchMedia('(max-width: 760px)').matches) $('.composition-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  else if (action === 'choose-candidate') { const item = state.candidates[Number(button.dataset.index)]; if (!item) return; pushHistory(); state.components = list(item.components).map(part => ({ profile_id: part.profile_id, role: part.role })); resetCandidateView(); renderStudio(); message('#studio-message', '已把候选带回案头。你可以继续调整，或命名留笺。', 'success'); $('#role-slots').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  else if (action === 'candidate-card') { const item = state.candidates[Number(button.dataset.index)]; if (item) await openCard(item.components); }
  else if (action === 'product-detail') { const product = state.products.find(item => item.id === button.dataset.id); if (product) showPublicProduct(product); }
  else if (action === 'record-detail') { const product = state.records.find(item => item.id === button.dataset.id); if (product) showRecord(product); }
  else if (action === 'edit-record') { const product = state.records.find(item => item.id === button.dataset.id); if (product) editRecord(product); }
  else if (action === 'record-reference') { const product = state.records.find(item => item.id === button.dataset.id); if (!product) return; pushHistory(); const referenceFacets = list(product.analysis?.families).filter(family => typeof family === 'string' && state.facets[family]); state.preferred = [...new Set([...state.preferred, ...referenceFacets])]; resetCandidateView(); renderStudio(); navigate('studio', true); message('#studio-message', referenceFacets.length ? `已把「${product.name}」资料归类中的${referenceFacets.map(facetLabel).join('、')}加入偏好参照，你可以继续改选。自己的话由你填写，成品不会变成混配原料。` : `已选择「${product.name}」作喜好参照，目前没有可对应的资料方向。你可以自己记录想保留的感觉；系统不替你填写原话，也不把成品拆成混配原料。`); }
  else if (action === 'reopen-design') {
    const saved = state.savedDesigns[Number(button.dataset.index)]; if (!saved) return; const design = saved.design || saved;
    state.cardDesign = { ...design, user_words: design.user_notes || '', evaluation_payload: { components: list(design.components).map(part => ({ profile_id: part.profile_id, role: part.role })), name: design.name, scenario: design.scenario, preferred_facets: design.preferred_facets || [], deemphasized_facets: design.deemphasized_facets || [], excluded_ids: design.excluded_ids || [], user_notes: design.user_notes || '' } };
    $('#card-name').value = design.name || ''; renderCard(); openDialog('#card-dialog');
  }
  else if (action === 'unpublish') { await busy(button, '正在撤下…', async () => { try { await api(`/api/products/${encodeURIComponent(button.dataset.id)}/unpublish`, { method: 'POST' }); await loadRecords(); await refreshPublic(); toast('商品已从首页撤下，私人档案仍保留。'); } catch (error) { toast(error.message); } }); }
  else if (action === 'material-detail') showKnowledge('materials', button.dataset.id);
  else if (action === 'formula-detail') showKnowledge('historical_formulas', button.dataset.id);
  else if (action === 'confirm-simulation') { state.simulationConfirmed = true; renderSimulation(); button.disabled = true; button.textContent = '已确认模拟使用'; }
  if (button?.dataset.library) { state.library = button.dataset.library; renderLibrary(); }
  if (button?.dataset.authMode) { state.authMode = button.dataset.authMode; $$('.tab-button[data-auth-mode]').forEach(item => item.classList.toggle('active', item === button)); $('#auth-submit').textContent = state.authMode === 'register' ? '注册并登录' : '登录'; $('#auth-password').autocomplete = state.authMode === 'register' ? 'new-password' : 'current-password'; message('#auth-message', ''); }
  const material = event.target.closest('.material-card');
  if (material && !button) { state.selectedMaterial = material.dataset.profile; renderStudio(); message('#studio-message', '已选中参照。点击主调、支撑或点缀的位置加入。'); }
  const slot = event.target.closest('.role-slot'); if (slot && !button && state.selectedMaterial) setRole(slot.dataset.role, state.selectedMaterial);
});
document.addEventListener('submit', async event => {
  const form = event.target;
  if (form.id === 'auth-form') {
    event.preventDefault(); const values = new FormData(form); const button = $('#auth-submit');
    await busy(button, state.authMode === 'register' ? '正在创建账号…' : '正在登录…', async () => {
      try { const payload = { username: String(values.get('username')).trim(), password: values.get('password') }; if (state.authMode === 'register') payload.display_name = payload.username;
        const result = await api(state.authMode === 'register' ? '/api/register' : '/api/login', { method: 'POST', body: payload }); const session = result.user && result.csrf_token ? result : await api('/api/session'); state.user = session.user; state.csrf = session.csrf_token || ''; form.reset(); closeDialog('#auth-dialog'); renderAccount(); renderAuthRequirements(); renderHome(); await loadRecords(); toast('已进入自己的案头。');
      } catch (error) { message('#auth-message', error.message, 'danger'); }
    });
  } else if (form.classList.contains('upload-form')) { event.preventDefault(); await uploadProduct(form); }
  else if (form.classList.contains('publish-form')) {
    event.preventDefault(); const values = new FormData(form); const button = form.querySelector('button[type=submit]'); const notice = form.querySelector('.notice');
    await busy(button, '正在更新首页…', async () => { try { await api(`/api/products/${encodeURIComponent(form.dataset.product)}/publish`, { method: 'POST', body: { purchase_url: String(values.get('purchase_url') || '').trim(), price: String(values.get('price') || '').trim(), public_fields: values.getAll('public_fields') } }); await loadRecords(); await refreshPublic(); toast('首页展示已更新，只公开你选择的字段。'); } catch (error) { notice.textContent = error.message; notice.className = 'notice danger'; notice.hidden = false; } });
  } else if (form.id === 'edit-product-form') {
    event.preventDefault(); const values = new FormData(form); const body = Object.fromEntries(values); const notice = form.querySelector('.notice');
    await busy(form.querySelector('button[type=submit]'), '保存中…', async () => { try { await api(`/api/products/${encodeURIComponent(form.dataset.id)}`, { method: 'PATCH', body }); closeDialog('#detail-dialog'); await loadRecords(); await refreshPublic(); toast('资料与分析已更新。'); } catch (error) { notice.textContent = error.message; notice.className = 'notice danger'; notice.hidden = false; } });
  }
});
document.addEventListener('change', event => {
  const node = event.target;
  if (node.dataset.exclude) { pushHistory(); const id = node.dataset.exclude; state.excluded = node.checked ? [...new Set([...state.excluded, id])] : state.excluded.filter(item => item !== id); if (node.checked) state.components = state.components.filter(item => item.profile_id !== id); resetCandidateView(); renderStudio(); }
  if (node.type === 'file') { const selected = node.files[0]; node.closest('.field').querySelector('.file-selection').textContent = selected ? `${selected.name} · ${(selected.size / 1024 / 1024).toFixed(2)} MB` : ''; }
});
document.addEventListener('dragstart', event => { const card = event.target.closest('.material-card'); if (card) { event.dataTransfer.setData('text/plain', card.dataset.profile); event.dataTransfer.effectAllowed = 'copy'; } });
document.addEventListener('dragover', event => { const slot = event.target.closest('.role-slot'); if (slot) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; slot.classList.add('drop-over'); } });
document.addEventListener('dragleave', event => { const slot = event.target.closest('.role-slot'); if (slot && !slot.contains(event.relatedTarget)) slot.classList.remove('drop-over'); });
document.addEventListener('drop', event => { const slot = event.target.closest('.role-slot'); if (slot) { event.preventDefault(); slot.classList.remove('drop-over'); const id = event.dataTransfer.getData('text/plain'); if (profile(id)) setRole(slot.dataset.role, id); } });
document.addEventListener('keydown', event => { if (!['Enter', ' '].includes(event.key) || event.target.tagName === 'BUTTON') return; const card = event.target.closest('.material-card'); if (card) { event.preventDefault(); state.selectedMaterial = card.dataset.profile; renderStudio(); toast('已选中。聚焦构图位置后按回车即可加入。'); } const slot = event.target.closest('.role-slot'); if (slot && state.selectedMaterial) { event.preventDefault(); setRole(slot.dataset.role, state.selectedMaterial); } });
$('#generate-design').addEventListener('click', event => generateDesign(event.currentTarget));
$('#save-current-card').addEventListener('click', () => openCard());
$('#undo-design').addEventListener('click', () => { const old = state.history.pop(); if (!old) return; Object.assign(state, { components: old.components, preferred: old.preferred, deemphasized: old.deemphasized, excluded: old.excluded }); $('#design-scene').value = old.scene; $('#design-words').value = old.words; $('#lock-main').checked = old.locked; resetCandidateView(); renderStudio(); message('#studio-message', '已撤回上一次构图或偏好改动。'); });
$('#clear-design').addEventListener('click', () => { pushHistory(); state.components = []; state.preferred = []; state.deemphasized = []; state.excluded = []; $('#design-scene').value = ''; $('#design-words').value = ''; $('#card-name').value = ''; resetCandidateView(); renderStudio(); message('#studio-message', '案头已清空，上一次设计可以撤回。'); });
$('#card-name').addEventListener('input', renderCard);
$('#download-card').addEventListener('click', event => downloadCard(event.currentTarget));
$('#card-to-integration').addEventListener('click', () => { closeDialog('#card-dialog'); navigate('integration', true); $('#integration-design').value = 'card'; });
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
  $('#page-collection').insertAdjacentHTML('beforeend', '<section class="saved-design-section" data-auth-content><div class="panel-heading"><h2>我的香笺</h2><span class="subtle">登录后保存的数字设计</span></div><div id="saved-designs" class="candidate-grid"></div></section>');
  $('#card-dialog').insertAdjacentHTML('beforeend', '<section class="matched-product-section"><div class="panel-heading"><h3>接近这份设计的现成香</h3><button type="button" class="text-button" id="find-matches">查找现成香 →</button></div><div id="card-matches"><p class="fine-note">仅匹配管理者公开的商品；相似方向不代表同一配方。</p></div></section>');
  $('#find-matches').addEventListener('click', event => findMatches(event.currentTarget));
  renderAuthRequirements(); $('#home-products').innerHTML = '<div class="loading">正在读取公开香品与材料资料…</div>';
  try {
    const [boot, session] = await Promise.all([api('/api/bootstrap'), api('/api/session')]); state.boot = boot; state.profiles = boot.profiles || []; state.facets = boot.facets || {}; state.products = boot.products || [];
    state.sources = [...list(boot.sources), ...list(boot.knowledge?.sources)].filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
    state.user = session.user; state.csrf = session.csrf_token || ''; renderAccount(); renderHome(); renderStudio(); renderLibrary(); renderIntegrationOptions(); renderSimulation(); renderAuthRequirements(); $('#data-version').textContent = '资料更新于 2026 年 10 月 3 日';
    navigate(location.hash.slice(1) || 'home');
  } catch (error) { message('#connection-error', error.message, 'danger'); $('#home-products').innerHTML = empty('本地资料尚未连接', '请确认服务已启动，再刷新页面。当前不会展示虚构商品或伪造分析结果。'); }
}
initialize();
