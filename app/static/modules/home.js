import { $, escapeHTML, list, forms, state, safeURL, api, empty, source, tags, niceText, sourceLink } from './core.js';

export function renderHome() {
  renderHomePresets();
  renderHomeWorks();
  $('#home-products').innerHTML = state.products.length ? state.products.map(product => {
    const image = safeURL(product.image_url);
    const url = safeURL(product.purchase_url, false);
    const notes = product.analysis?.reported_notes || product.notes || [];
    return `<article class="product-card"><div class="product-art">${image ? `<img src="${escapeHTML(image)}" alt="${escapeHTML(product.name)}的公开产品图片" loading="lazy">` : '<span class="paper-vessel" aria-hidden="true"></span><span class="art-caption">未上传公开产品图</span>'}</div><div class="product-body"><p class="product-meta">${escapeHTML(product.brand || product.seller_name || '管理者提供')} · ${escapeHTML(forms[product.form] || product.form || '形态待补充')}</p><h2>${escapeHTML(product.name)}</h2>${product.spec ? `<p class="subtle">${escapeHTML(product.spec)}</p>` : ''}<div>${tags(list(notes).slice(0, 5).map(niceText))}</div>${product.description ? `<p>${escapeHTML(product.description)}</p>` : '<p>详细香气资料尚未公开。</p>'}<div class="product-actions"><button type="button" class="button secondary" data-action="product-detail" data-id="${escapeHTML(product.id)}">查看资料</button>${url ? `<a class="button primary" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">前往商家购买 ↗</a>` : '<span class="status-pill pending">购买入口待补充</span>'}</div><div class="source-note">${product.price ? `${escapeHTML(product.price)} · ` : '价格与库存以商家页为准 · '}${escapeHTML(product.seller_name || '管理者')}提供${product.source_url ? ` · ${sourceLink({ url: product.source_url, title: '资料来源' })}` : ''}</div></div></article>`;
  }).join('') : empty('首页还没有公开香品', '这里会展示创作者（OPC）选择公开的已有商品。现在可以先到调香案，探索自己的设计。', `<button type="button" class="button primary" data-go="studio">去调香案</button>${state.user?.role === 'manager' ? '<button type="button" class="button quiet" data-go="manage">添加自己的商品</button>' : ''}`);
}
export function renderHomePresets() {
  const container = $('#home-presets'); if (!container) return;
  const illustrations = ['/static/assets/晨间草案.svg', '/static/assets/夜间草案.svg', '/static/assets/待客草案.svg'];
  container.innerHTML = list(state.boot?.presets).map((item, index) => `<article class="home-preset preset-card"><div class="preset-art" aria-hidden="true">${illustrations[index] ? `<img src="${illustrations[index]}" alt="" loading="lazy">` : ''}</div><div class="preset-copy"><p class="preset-number">${['壹', '贰', '叁'][index] || index + 1} · 设计草案</p><p class="preset-scene">${escapeHTML(item.scenario || '生活香气')}</p><h3>${escapeHTML(item.name)}</h3><p class="preset-intent">${escapeHTML(item.subtitle || item.intent || '')}</p><div class="preset-footer"><span>尚未制作、实闻</span><button type="button" class="text-button" data-action="use-preset" data-index="${index}">以此起稿 →</button></div></div></article>`).join('');
}
export function renderHomeWorks() {
  const section = $('#home-works-section'); const container = $('#home-works');
  if (!section || !container) return;
  const works = list(state.works);
  section.hidden = !works.length;
  container.innerHTML = works.map(item => `<article class="home-preset creator-work"><div class="preset-art work-art" aria-hidden="true"><span class="work-seal">作</span></div><div class="preset-copy"><p class="preset-number">OPC 作品 · ${escapeHTML(item.creator_name || '创作者')}</p><p class="preset-scene">${escapeHTML(item.scenario || '生活香气')}</p><h3>${escapeHTML(item.name)}</h3><p class="preset-intent">${escapeHTML(item.public_note || item.subtitle || item.intent || '')}</p><div>${tags(list(item.display_facets).slice(0, 4))}</div><div class="preset-footer"><span>数字设计 · 尚未实闻</span><button type="button" class="text-button" data-action="use-work" data-id="${escapeHTML(item.id)}">以此起稿 →</button></div></div></article>`).join('');
}
export async function refreshPublic() { const boot = await api('/api/bootstrap'); state.products = boot.products || []; state.works = boot.works || []; renderHome(); }
