import { $, $$, escapeHTML, list, forms, state, safeURL, api, message, busy, empty, facetLabel, source, tags, niceText, sourceLink, openDialog } from './core.js';

function markPublishDirty(event) {
  const form = event.target?.closest?.('.publish-form');
  const card = form?.closest('.record-card');
  if (!form || !card || !state.user || card.dataset.owner !== String(state.user.id)) return;
  form.dataset.dirty = 'true'; card.dataset.dirty = 'true';
  const hint = form.querySelector('.publish-unsaved'); if (hint) hint.hidden = false;
}
document.addEventListener('input', markPublishDirty);
document.addEventListener('change', markPublishDirty);

export function analysisSource(value) {
  if (!value) return '';
  if (typeof value === 'string') return escapeHTML(value);
  const fieldLabels = { ingredients: '成分输入', notes: '香调输入', description: '商品描述', personal_notes: '个人实闻输入', extracted_text: '附件文字' };
  const label = value.label || fieldLabels[value.field] || '提供的资料';
  const url = safeURL(value.url, false);
  return `${escapeHTML(label)}${url ? ` · <a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">提供者标注的链接</a>` : ''}`;
}
export function analysisItems(value) {
  if (value == null || value === '') return '<p>暂无可确认资料。</p>';
  if (typeof value === 'object' && !Array.isArray(value) && !value.text && !value.name) return `<ul>${Object.entries(value).map(([key, item]) => `<li>${escapeHTML(key)}：${escapeHTML(list(item).map(niceText).join('、'))}</li>`).join('')}</ul>`;
  return `<ul>${list(value).map(item => {
    if (typeof item !== 'object') return `<li>${escapeHTML(niceText(item))}</li>`;
    const basis = item.basis;
    const family = item.family ? `<strong>${escapeHTML(facetLabel(item.family))}</strong> · ` : '';
    return `<li>${family}${escapeHTML(niceText(item))}${basis?.text ? `<div class="evidence-line">依据原文：${escapeHTML(basis.text)}</div>` : ''}${item.source || basis?.source ? `<div class="evidence-line">来源：${analysisSource(item.source || basis.source)}</div>` : ''}${item.verification ? `<div class="evidence-line">${escapeHTML(item.verification)}</div>` : ''}</li>`;
  }).join('')}</ul>`;
}
export function analysisHTML(analysis = {}) {
  const ingredients = analysis.declared_ingredients || analysis.ingredient_declarations || analysis.ingredients || [];
  const notes = analysis.reported_notes || analysis.brand_notes || analysis.declared_notes || [];
  const observations = analysis.personal_observations || analysis.personal_notes || [];
  const inferences = analysis.system_inferences || analysis.inferences || [];
  const families = list(analysis.families || analysis.fragrance_families).map(niceText);
  return `<div class="analysis-result"><div class="panel-heading"><h3>资料拆解</h3><span class="status-pill private">私人分析</span></div>${families.length ? `<p>可能的香气家族：${tags(families)}</p>` : '<p class="fine-note">现有资料不足以归类香气家族。</p>'}<div class="analysis-grid"><section class="analysis-section"><h4>成分声明</h4>${analysisItems(ingredients)}<p class="fine-note">资料明确声明的材料，不代表完整秘方。</p></section><section class="analysis-section"><h4>品牌 / 制作者香调</h4>${analysisItems(notes)}<p class="fine-note">气味描述与真实成分分开记录。</p></section><section class="analysis-section"><h4>个人实闻</h4>${analysisItems(observations)}<p class="fine-note">只记录你提供的观察，不由系统代闻。</p></section><section class="analysis-section inference"><h4>系统归纳与推测</h4>${analysisItems(inferences)}<p class="fine-note">依据上传资料推断，不是检测结果。</p></section></div><div class="detail-block"><h4>未知与资料限制</h4>${analysisItems(analysis.gaps || analysis.unknowns || ['未公开的配方比例保持未知，实际气味尚未由系统验证。'])}</div></div>`;
}
export async function loadRecords() {
  if (!state.user) return;
  const accountVersion = state.accountVersion; const ownerId = state.user.id;
  const request = ++state.recordsRequest;
  const [result, designs] = await Promise.all([api('/api/products'), api('/api/designs')]);
  if (accountVersion !== state.accountVersion || ownerId !== state.user?.id || request !== state.recordsRequest) return;
  state.records = result.products || []; state.savedDesigns = designs.designs || []; renderRecords(); renderSavedDesigns();
  document.dispatchEvent(new Event('records:updated'));
}
export function renderSavedDesigns() {
  const container = $('#saved-designs'); if (!container) return;
  container.innerHTML = state.savedDesigns.length ? state.savedDesigns.map((item, index) => { const design = item.design || item; return `<article class="record-card"><div class="record-head"><h3>${escapeHTML(item.name || design.name || '未名')}</h3><span class="status-pill ${design.published ? '' : 'private'}">${design.published ? '已在首页' : '仅本人可见'}</span></div><p class="subtle">${escapeHTML(item.scenario || design.scenario || '个人数字设计')} · 尚未实闻</p><button type="button" class="text-button" data-action="reopen-design" data-index="${index}">查看香笺 →</button></article>`; }).join('') : '<p class="fine-note">点“保存到我的香笺”，作品便会留在这里。</p>';
}
export function recordMarkup(product, manage = false) {
  const publicOptions = [['description', '产品描述'], ['notes', '品牌香调'], ['ingredients', '成分声明'], ['source_url', '来源链接'], ['image', '公开产品图'], ['price', '价格说明']];
  const existing = list(product.public_fields);
  const defaults = product.published ? existing : ['description', 'notes', 'source_url'];
  const asset = safeURL(product.asset_url);
  return `<article class="record-card" data-record="${escapeHTML(product.id)}" data-owner="${escapeHTML(state.user?.id || '')}"><div class="record-head"><div><h3>${escapeHTML(product.name)}</h3><p class="subtle">${escapeHTML(product.brand || '品牌未补充')} · ${escapeHTML(forms[product.form] || product.form || '形态待补充')}${product.spec ? ` · ${escapeHTML(product.spec)}` : ''}</p></div><span class="status-pill ${product.published ? '' : 'private'}">${product.published ? '已挂首页' : '仅本人可见'}</span></div>${product.description ? `<p>${escapeHTML(product.description)}</p>` : ''}${product.file_name ? `<p class="fine-note">附件：${escapeHTML(product.file_name)}${asset ? ` · <a href="${escapeHTML(asset)}" target="_blank" rel="noopener noreferrer">查看本人附件</a>` : ''} · ${escapeHTML(ocrLabel(product.ocr_status))}</p>` : ''}<div class="record-actions"><button type="button" class="button secondary" data-action="record-detail" data-id="${escapeHTML(product.id)}">查看拆解报告</button><button type="button" class="button quiet" data-action="edit-record" data-id="${escapeHTML(product.id)}">补充 / 修改</button><button type="button" class="text-button" data-action="record-reference" data-id="${escapeHTML(product.id)}">作为喜好参照 →</button></div>${manage ? `<form class="publish-form" data-product="${escapeHTML(product.id)}" data-revision="${Number.isInteger(product.revision) ? product.revision : 0}"><h4>${product.published ? '调整首页展示' : '选择公开的信息'}</h4><p class="publish-unsaved" role="status" hidden>填写尚未保存，已为你保留。</p><p class="publish-note">名称、品牌、形态与规格会作为商品身份公开。其他内容由你选择；私人咨询与原附件不公开。</p><div class="publish-field-row"><div class="field"><label>商家购买链接</label><input name="purchase_url" type="url" value="${escapeHTML(product.purchase_url || '')}" placeholder="https://"></div><div class="field"><label>价格说明 <span class="subtle">可选</span></label><input name="price" value="${escapeHTML(product.price || '')}" maxlength="80" placeholder="由商家页查看"></div></div><div class="exclude-list">${publicOptions.map(([key, label]) => `<label><input type="checkbox" name="public_fields" value="${key}" ${defaults.includes(key) ? 'checked' : ''} ${key === 'image' && !product.asset_url ? 'disabled' : ''}>${label}</label>`).join('')}</div>${asset && product.file_name && /\.(png|jpe?g|webp)$/i.test(product.file_name) ? `<p class="fine-note">选择“公开产品图”后，首页使用去除元数据的独立图片副本。</p>` : ''}<div class="record-actions"><button type="submit" class="button primary">${product.published ? '更新首页信息' : '挂到首页'}</button>${product.published ? `<button type="button" class="button quiet" data-action="unpublish" data-id="${escapeHTML(product.id)}" data-revision="${Number.isInteger(product.revision) ? product.revision : 0}">从首页撤下</button>` : ''}</div><div class="notice" hidden></div></form>` : ''}</article>`;
}
export function ocrLabel(value) {
  if (!value) return '文字提取状态待确认';
  if (typeof value === 'object') return niceText(value.message || value.status || value);
  const labels = { recognized: '已识别照片文字，仍需核对', text_read: '已读取文字资料', pdf_text_read: '已读取PDF文字', pdf_no_text: 'PDF无可读取文字，可改传照片', document_text_read: '已读取Word文字', unavailable: '照片文字识别暂不可用，可补充文字', not_needed: '没有需要识别的附件', success: '已提取文字，仍需核对', extracted: '已提取文字，仍需核对', recognized: '已识别文字，仍需核对', text_read: '已读取文字资料', pdf_text_read: '已提取 PDF 文字', docx_text_read: '已提取 Word 文字', pdf_no_text: 'PDF 没有可读文字，可改传照片', unavailable: '文字识别暂不可用，可手动补充', not_needed: '无需文字识别', ok: '已提取文字，仍需核对', no_text: '未找到可读文字，可补充描述', not_requested: '没有需要提取的附件', pending: '等待文字提取', failed: '文字未提取成功，可补充文字', skipped: '未执行文字提取' };
  return labels[value] || value;
}
export function renderRecords() {
  const preserved = new Map($$('.record-card').filter(node => state.user && node.dataset.owner === String(state.user.id) && node.querySelector('.publish-form[data-dirty="true"], .publish-form[data-conflicted="true"]')).map(node => [node.dataset.record, node]));
  const privateRecords = state.records.filter(item => item.kind !== 'catalog');
  $('#private-records').innerHTML = privateRecords.length ? privateRecords.map(item => recordMarkup(item)).join('') : empty('还没有私人香品档案', '可以上传一张包装照片，或先记录标签上的文字。不需要提交秘密配方。');
  const catalogs = state.records.filter(item => item.kind === 'catalog');
  $('#manager-records').innerHTML = catalogs.length ? catalogs.map(item => recordMarkup(item, true)).join('') : empty('第一件商品，从资料开始', '添加你已有的香品，再自主选择首页展示字段与购买入口。保存档案不会自动挂首页。');
  for (const [id, previous] of preserved) {
    const replacement = $$('#manager-records .record-card').find(node => node.dataset.record === id);
    if (replacement) replacement.replaceWith(previous);
  }
}
function conflictForm(target) { return target?.matches?.('form') ? target : target?.closest?.('.publish-form, #edit-product-form'); }
export function showProductConflict(target) {
  const form = conflictForm(target); if (!form) return;
  form.dataset.conflicted = 'true';
  const notice = form.querySelector('.notice'); if (notice) notice.hidden = true;
  let panel = form.querySelector('.record-conflict');
  if (!panel) {
    const context = form.id === 'edit-product-form' ? 'edit' : target?.dataset?.action === 'unpublish' ? 'unpublish' : 'publish';
    panel = document.createElement('section'); panel.className = 'record-conflict'; panel.setAttribute('role', 'status');
    panel.innerHTML = `<p class="record-conflict-text"></p><button type="button" class="button quiet" data-action="reload-conflict" data-id="${escapeHTML(form.dataset.id || form.dataset.product)}" data-context="${context}">重新加载核对</button><div class="conflict-latest"></div>`;
    form.append(panel);
  }
  panel.querySelector('.record-conflict-text').textContent = '商品已在另一处更新，你的填写还在这里；重新加载核对后再保存';
  panel.querySelector('.conflict-latest').replaceChildren();
  panel.scrollIntoView({ block: 'nearest', behavior: 'auto' });
}
export async function reloadConflict(button) {
  const form = conflictForm(button); if (!form || !state.user) return;
  const accountVersion = state.accountVersion; const ownerId = state.user.id; const id = form.dataset.id || form.dataset.product;
  const request = ++state.recordsRequest;
  const panel = button.closest('.record-conflict');
  await busy(button, '正在读取最新资料…', async () => {
    try {
      const result = await api('/api/products');
      if (accountVersion !== state.accountVersion || ownerId !== state.user?.id || request !== state.recordsRequest || !form.isConnected) return;
      const product = list(result.products).find(item => item.id === id);
      if (!product) throw new Error('这件香品暂时无法重新读取，你的填写仍保留在这里。');
      state.records = result.products || [];
      form.dataset.revision = String(Number.isInteger(product.revision) ? product.revision : 0);
      form.querySelectorAll('[data-action="unpublish"]').forEach(node => { node.dataset.revision = form.dataset.revision; });
      const fields = form.id === 'edit-product-form' ? [['name', '产品名称'], ['brand', '品牌 / 制作者'], ['spec', '规格'], ['description', '产品说明'], ['ingredients', '标签成分声明'], ['notes', '品牌香调'], ['personal_notes', '个人实闻'], ['source_url', '公开资料链接']] : [['name', '产品名称'], ['purchase_url', '商家链接'], ['price', '价格说明'], ['public_fields', '已公开字段'], ['published', '首页状态']];
      const publicLabels = { description: '产品描述', notes: '品牌香调', ingredients: '成分声明', source_url: '来源链接', image: '产品图', price: '价格说明' };
      const value = key => key === 'published' ? product.published ? '已挂首页' : '未挂首页' : key === 'public_fields' ? list(product.public_fields).map(item => publicLabels[item] || item).join('、') || '未选公开字段' : Array.isArray(product[key]) ? product[key].join('、') : product[key] || '未填写';
      panel.querySelector('.record-conflict-text').textContent = '已读取最新内容，你的填写仍保留；请按下方对照核对，再保存。';
      panel.querySelector('.conflict-latest').innerHTML = `<h4>当前已保存的资料</h4><dl>${fields.map(([key, label]) => `<dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value(key))}</dd>`).join('')}</dl>`;
    } catch (error) { if (accountVersion === state.accountVersion && ownerId === state.user?.id && form.isConnected) panel.querySelector('.record-conflict-text').textContent = `${error.message} 你的填写仍保留，未覆盖服务器资料。`; }
  });
}
export function addUploadFields() {
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
export function readFile(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('这份附件未能读取，请重新选择。')); reader.readAsDataURL(file); }); }
export async function uploadProduct(form) {
  const prefix = form.dataset.purpose === 'product' ? 'manager' : 'private';
  const button = form.querySelector('button[type=submit]');
  message(`#${prefix}-upload-message`, '');
  if (!state.user) { openDialog('#auth-dialog'); return; }
  const accountVersion = state.accountVersion;
  await busy(button, '保存与提取资料…', async () => {
    try {
      const values = new FormData(form); const file = form.querySelector('input[type=file]').files[0];
      if (file && file.size > 8 * 1024 * 1024) throw new Error('附件超过 8 MB，请选择较小的图片或文档。');
      if (file && !/\.(png|jpe?g|webp|pdf|txt|md|docx)$/i.test(file.name)) throw new Error('请上传 JPG、PNG、WEBP、TXT、Markdown、PDF 或 Word 文件。');
      const payload = { name: values.get('name')?.trim(), brand: values.get('brand')?.trim(), form: values.get('product_form'), spec: values.get('spec')?.trim(), description: values.get('description')?.trim(), source_url: values.get('source_url')?.trim(), notes: values.get('notes')?.trim(), ingredients: values.get('ingredients')?.trim(), personal_notes: values.get('personal_notes')?.trim(), kind: prefix === 'manager' ? 'catalog' : 'private' };
      if (file) payload.file = { name: file.name, type: file.type, data: await readFile(file) };
      const result = await api('/api/products', { method: 'POST', body: payload });
      await loadRecords(); form.reset(); form.querySelector('.file-selection').textContent = '';
      if (accountVersion !== state.accountVersion) return;
      message(`#${prefix}-upload-message`, prefix === 'manager' ? '商品档案已保存。请核对分析，再在右侧选择公开字段与首页展示。' : '私人档案已保存，只有本人可查看。', 'success');
      if (result.product) showRecord(result.product);
    } catch (error) { message(`#${prefix}-upload-message`, error.message, 'danger'); }
  });
}
export function showRecord(product) {
  $('#detail-content').innerHTML = `<p class="eyebrow">已有香品 · 私人咨询</p><h2 class="detail-heading">${escapeHTML(product.name)}</h2><p class="subtle">${escapeHTML(forms[product.form] || product.form || '形态待补充')} · 依据上传资料</p>${analysisHTML(product.analysis || {})}${product.description ? `<details><summary>查看保存的原始描述</summary><p>${escapeHTML(product.description)}</p></details>` : ''}${product.source_url ? `<p>${sourceLink({ url: product.source_url, title: '上传者提供的资料链接' })}</p>` : ''}`;
  openDialog('#detail-dialog');
}
export function editRecord(product) {
  const fields = [['name', '产品名称'], ['brand', '品牌 / 制作者'], ['spec', '规格'], ['description', '产品说明'], ['ingredients', '标签成分声明'], ['notes', '品牌香调'], ['personal_notes', '个人实闻'], ['source_url', '公开资料链接']];
  $('#detail-content').innerHTML = `<p class="eyebrow">本人资料</p><h2>补充与核对</h2><form id="edit-product-form" data-id="${escapeHTML(product.id)}" data-revision="${Number.isInteger(product.revision) ? product.revision : 0}">${fields.map(([key, label]) => `<div class="field"><label for="edit-${key}">${label}</label>${['description', 'ingredients', 'notes', 'personal_notes'].includes(key) ? `<textarea id="edit-${key}" name="${key}" rows="3" maxlength="12000">${escapeHTML(Array.isArray(product[key]) ? product[key].join('、') : product[key] || '')}</textarea>` : `<input id="edit-${key}" name="${key}" value="${escapeHTML(product[key] || '')}" ${key === 'name' ? 'required' : ''} ${key === 'source_url' ? 'type="url"' : ''}>`}</div>`).join('')}<div class="notice" hidden></div><button type="submit" class="button primary">保存并更新分析</button><p class="fine-note">已选择公开的字段会同步首页；私人实闻与未选择字段仍然私有。</p></form>`;
  openDialog('#detail-dialog');
}
export function showPublicProduct(product) {
  const analysis = product.analysis || {};
  $('#detail-content').innerHTML = `<p class="eyebrow">管理者公开的商品资料</p><h2>${escapeHTML(product.name)}</h2><p>${escapeHTML(product.brand || '')} · ${escapeHTML(forms[product.form] || product.form || '')}${product.spec ? ` · ${escapeHTML(product.spec)}` : ''}</p>${product.description ? `<p>${escapeHTML(product.description)}</p>` : ''}<div class="analysis-grid"><section class="analysis-section"><h4>公开香调</h4>${analysisItems(analysis.reported_notes || product.notes)}</section><section class="analysis-section inference"><h4>资料归纳与未知</h4>${analysisItems(analysis.system_inferences)}${analysisItems(analysis.gaps)}</section></div>${product.ingredients ? `<div class="detail-block"><h3>管理者公开的成分声明</h3>${analysisItems(product.ingredients)}</div>` : ''}<p class="fine-note">与个人设计相似，不代表同一配方。具体价格、库存与购买信息以商家页为准。</p><div class="inline-actions">${safeURL(product.purchase_url, false) ? `<a class="button primary" href="${escapeHTML(safeURL(product.purchase_url, false))}" target="_blank" rel="noopener noreferrer">前往商家购买 ↗</a>` : ''}${product.source_url ? sourceLink({ url: product.source_url, title: '资料来源' }) : ''}</div>`;
  openDialog('#detail-dialog');
}
