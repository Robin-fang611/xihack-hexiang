import { $, escapeHTML, list, state, empty, tags } from './core.js';

function publishedCount() {
  const works = list(state.savedDesigns).filter(item => (item.design || item).published).length;
  const products = list(state.records).filter(item => item.kind === 'catalog' && item.published).length;
  return { works, products, total: works + products };
}

export function renderWorkbench() {
  const designs = list(state.savedDesigns);
  const catalogs = list(state.records).filter(item => item.kind === 'catalog');
  const counts = publishedCount();
  const set = (selector, value) => { const node = $(selector); if (node) node.textContent = value; };
  set('#workbench-works', String(designs.length));
  set('#workbench-products', String(catalogs.length));
  set('#workbench-published', String(counts.total));
  const worksNote = $('#workbench-works-note');
  if (worksNote) worksNote.textContent = designs.length ? `其中 ${counts.works} 份已发布为设计起点` : '调香案保存的构图，可发布为设计起点';
}

export function renderWorks() {
  const container = $('#works-list'); if (!container) return;
  const designs = list(state.savedDesigns);
  container.innerHTML = designs.length ? designs.map(item => {
    const design = item.design || item;
    const id = item.id || design.id;
    const published = Boolean(design.published);
    const materials = list(design.components).map(part => part.name).filter(Boolean).join(' / ') || '无材料记录';
    return `<article class="record-card work-card"><div class="record-head"><div><h3>${escapeHTML(design.name || '未名')}</h3><p class="subtle">${escapeHTML(design.scenario || '未填场景')} · ${escapeHTML(materials)}</p></div><span class="status-pill ${published ? '' : 'private'}">${published ? '已在首页' : '仅本人可见'}</span></div><div class="work-facts">${tags(list(design.display_facets || design.families).slice(0, 5))}</div><p class="fine-note">公开内容：名称、场景、构图、方向与署名；你的原话、原始偏好与私人附件不公开。</p><form class="work-publish-form" data-work="${escapeHTML(id || '')}"><div class="field"><label>创作说明 <span class="subtle">公开，可选，500 字内</span></label><textarea name="public_note" rows="2" maxlength="500" placeholder="比如：为深夜书房设计的一炉木质香。">${escapeHTML(design.public_note || '')}</textarea></div><div class="record-actions"><button type="submit" class="button primary">${published ? '更新首页信息' : '发布到首页'}</button>${published ? `<button type="button" class="button quiet" data-action="unpublish-work" data-id="${escapeHTML(id || '')}">从首页撤下</button>` : ''}</div><div class="notice" hidden></div></form></article>`;
  }).join('') : empty('还没有作品', '到调香案挑材构图，为当前构图留笺并保存，作品便会留在这里。', '<button type="button" class="button primary" data-go="studio">去调香案 →</button>');
}

export function renderCreatorPages() {
  renderWorkbench();
  renderWorks();
}
document.addEventListener('records:updated', renderCreatorPages);
