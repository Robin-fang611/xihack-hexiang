import { $, escapeHTML, list, roles, forms, state, safeURL, api, toast, message, busy, profile, profileName, facetLabel, source, tags, niceText, openDialog } from './core.js';
import { currentPayload, describeFailure, renderStudioProgress, pushHistory, resetCandidateView, renderStudio } from './studio.js';
import { renderSavedDesigns } from './products.js';
import { navigate } from './navigation.js';

const savedSignatures = new Map();
let saveRequest = 0;
let saving = null;
let messageSignature = null;

function snapshotCard() {
  const design = structuredClone(state.cardDesign);
  design.name = $('#card-name').value.trim() || '未名';
  return design;
}
function payloadFor(design) {
  const payload = { ...(design.evaluation_payload || design), components: list(design.components).map(part => ({ profile_id: part.profile_id, role: part.role })), name: design.name, scenario: design.scenario || '', preferred_facets: list(design.preferred_facets), deemphasized_facets: list(design.deemphasized_facets), excluded_ids: list(design.excluded_ids), user_notes: design.user_words ?? design.user_notes ?? design.evaluation_payload?.user_notes ?? '' };
  if (typeof design.locked === 'boolean') {
    const main = payload.components.find(part => part.role === 'main')?.profile_id;
    if (design.locked && main) payload.locked_main_id = main;
    else delete payload.locked_main_id;
  }
  return payload;
}
function signature(design) {
  const payload = payloadFor(design);
  const context = Object.fromEntries(['description', 'intent', 'preset_id', 'starting_preset_id', 'raw_preferences', 'raw_exclusions'].filter(key => Object.hasOwn(payload, key)).map(key => [key, payload[key]]));
  return JSON.stringify({ ...context, name: payload.name, scenario: payload.scenario, user_notes: payload.user_notes, locked_main_id: payload.locked_main_id || null, data_version: design.data_version || state.boot?.data_version, components: payload.components.sort((a, b) => a.role.localeCompare(b.role)), preferred_facets: [...payload.preferred_facets].sort(), deemphasized_facets: [...payload.deemphasized_facets].sort(), excluded_ids: [...payload.excluded_ids].sort() });
}
function alreadySaved(design) {
  if (!state.user) return false;
  const key = signature(design);
  return savedSignatures.get(state.user.id)?.has(key) || state.savedDesigns.some(item => signature(item.design || item) === key);
}
function refreshSaveButton() {
  const button = $('#save-card'); if (!button) return;
  const design = state.cardDesign && snapshotCard();
  const key = design && signature(design);
  const currentSave = saving && saving.owner === state.user?.id && saving.signature === key;
  const saved = design && alreadySaved(design);
  button.disabled = !design || Boolean(currentSave);
  button.textContent = currentSave ? '正在保存…' : saved ? '已保存到我的香笺' : state.user ? '保存到我的香笺' : '登录后保存到我的香笺';
  button.classList.toggle('saved', Boolean(saved));
  if (messageSignature && messageSignature !== key) { message('#card-save-status', ''); messageSignature = null; }
}
document.addEventListener('account:cleared', () => {
  saveRequest += 1; saving = null; messageSignature = null; savedSignatures.clear();
  message('#card-save-status', ''); refreshSaveButton();
});
document.addEventListener('account:changed', refreshSaveButton);

export async function openCard(components = state.components, name = '') {
  if (!components.some(item => item.role === 'main')) { message('#studio-message', '请先挑一份主调，再为构图留笺。'); navigate('studio'); return; }
  const revision = state.designRevision;
  const accountVersion = state.accountVersion;
  try {
    const payload = currentPayload(components); payload.name = name || state.draftName?.trim() || '未名';
    const result = await api('/api/evaluate', { method: 'POST', body: payload });
    if (revision !== state.designRevision || accountVersion !== state.accountVersion) return;
    if (!result.design || !['ok', 'untested_composite_design'].includes(result.status)) { message('#studio-message', describeFailure(result)); navigate('studio'); return; }
    state.cardOrigin = 'studio';
    state.cardDesign = { ...result.design, components: result.design.components || components, name: payload.name, scenario: payload.scenario, preferred_facets: [...state.preferred], deemphasized_facets: [...state.deemphasized], excluded_ids: [...state.excluded], user_words: payload.user_notes, locked: $('#lock-main').checked, evaluation_payload: payload };
    $('#card-name').value = payload.name === '未名' ? '' : payload.name; messageSignature = null; message('#card-save-status', ''); renderCard(); $('#card-matches').innerHTML = '<p class="fine-note">仅匹配管理者公开的商品；相似方向不代表同一配方。</p>'; openDialog('#card-dialog');
  } catch (error) { if (revision !== state.designRevision || accountVersion !== state.accountVersion) return; message('#studio-message', error.message, 'danger'); navigate('studio'); }
}
export function cardSources(design) {
  const components = list(design.components);
  return components.map(part => ({ name: part.name || profileName(part.profile_id), url: part.source_url || source(profile(part.profile_id)?.source_id)?.url || '', supplier: profile(part.profile_id)?.supplier || '' }));
}
export function renderCard() {
  const design = state.cardDesign; if (!design) return;
  design.name = $('#card-name').value.trim() || '未名';
  if (state.cardOrigin === 'studio') state.draftName = $('#card-name').value;
  renderStudioProgress();
  $('#card-preview').innerHTML = `<p class="card-kicker">合香 · 个人香笺</p><h3 class="card-title">${escapeHTML(design.name)}</h3><p class="card-scene">${escapeHTML(design.scenario || '给自己的生活，留一份香气设计。')}</p><div class="card-composition">${Object.keys(roles).map(role => { const part = list(design.components).find(item => item.role === role); return part ? `<div class="card-role-line ${role}"><span>${roles[role]}</span><strong>${escapeHTML(part.name || profileName(part.profile_id))}</strong></div>` : ''; }).join('')}</div>${design.user_words ? `<p class="card-original">「${escapeHTML(design.user_words)}」</p>` : ''}<p class="card-original">更喜欢：${escapeHTML(list(design.preferred_facets).map(facetLabel).join('、') || '以当前构图表达')}<br>希望少一点：${escapeHTML(list(design.deemphasized_facets).map(facetLabel).join('、') || '未指定')}<br>排除：${escapeHTML(list(design.excluded_ids).map(profileName).join('、') || '未指定')}</p><div class="card-provenance">材料形态：${escapeHTML([...new Set(list(design.components).map(part => forms[part.form || profile(part.profile_id)?.form] || part.form || '参照材料'))].join('、'))}<br>来源：${escapeHTML([...new Set(cardSources(design).map(item => item.supplier).filter(Boolean))].join('、') || '参照材料档案')}<br>主次是设计位置，不是投料比例。</div><div class="card-stamp"><span>数字设计 · 尚未制作、实闻</span><span class="seal" aria-hidden="true">意</span></div>`;
  refreshSaveButton();
  if (state.cardOrigin === 'studio') document.dispatchEvent(new Event('design:rendered'));
}
export async function saveCard(button = $('#save-card')) {
  if (!state.cardDesign) return;
  if (!state.user) { message('#card-save-status', '登录后才能保存到我的香笺。PNG 可以现在直接下载。'); openDialog('#auth-dialog'); return; }
  const design = snapshotCard();
  const key = signature(design);
  if (alreadySaved(design)) { messageSignature = key; message('#card-save-status', '这份香笺已经保存在你的账号里。', 'success'); refreshSaveButton(); return; }
  if (saving) return;
  const requestedDesign = state.cardDesign;
  const accountVersion = state.accountVersion;
  const ownerId = state.user.id;
  const request = ++saveRequest;
  saving = { owner: ownerId, signature: key };
  messageSignature = key; message('#card-save-status', ''); refreshSaveButton();
  try {
    const result = await api('/api/designs', { method: 'POST', body: payloadFor(design) });
    if (request !== saveRequest || accountVersion !== state.accountVersion || ownerId !== state.user?.id) return;
    if (!result.design?.id) throw new Error('这次保存没有返回可确认的香笺，请重试。PNG 仍可下载。');
    if (!savedSignatures.has(ownerId)) savedSignatures.set(ownerId, new Set());
    savedSignatures.get(ownerId).add(key);
    state.savedDesigns = [result.design, ...state.savedDesigns.filter(item => (item.id || item.design?.id) !== result.design.id)];
    renderSavedDesigns();
    if (requestedDesign === state.cardDesign && signature(snapshotCard()) === key) { messageSignature = key; message('#card-save-status', '已保存到我的香笺，可以在“我家的香”中重新打开。', 'success'); }
  } catch (error) {
    if (request !== saveRequest || accountVersion !== state.accountVersion || ownerId !== state.user?.id) return;
    if (requestedDesign === state.cardDesign && signature(snapshotCard()) === key) { messageSignature = key; message('#card-save-status', `${error.message} 你仍可以直接下载 PNG。`, 'danger'); }
  } finally {
    if (request === saveRequest) { saving = null; refreshSaveButton(); }
  }
}
export function continueCard() {
  if (!state.cardDesign) return;
  const design = snapshotCard();
  const payload = payloadFor(design);
  const excluded = [...new Set([...state.excluded, ...payload.excluded_ids])];
  const validComponents = payload.components.length > 0 && payload.components.length <= 3 && payload.components.some(part => part.role === 'main') && payload.components.every(part => profile(part.profile_id) && Object.hasOwn(roles, part.role)) && new Set(payload.components.map(part => part.profile_id)).size === payload.components.length && new Set(payload.components.map(part => part.role)).size === payload.components.length && list(design.components).every(part => !part.form || part.form === profile(part.profile_id)?.form);
  if (!validComponents || excluded.some(id => !profile(id)) || [...payload.preferred_facets, ...payload.deemphasized_facets].some(facet => !Object.hasOwn(state.facets, facet)) || payload.preferred_facets.some(facet => payload.deemphasized_facets.includes(facet))) { message('#card-save-status', '这份香笺有当前资料池无法恢复的材料或选项，未覆盖你的案头。', 'danger'); return; }
  pushHistory();
  state.components = payload.components.filter(part => !excluded.includes(part.profile_id)); state.preferred = [...payload.preferred_facets]; state.deemphasized = [...payload.deemphasized_facets]; state.excluded = excluded; state.selectedMaterial = null;
  state.cardOrigin = 'studio'; state.draftName = design.name === '未名' ? '' : design.name;
  $('#design-scene').value = payload.scenario; $('#design-words').value = payload.user_notes; $('#card-name').value = state.draftName;
  $('#lock-main').checked = typeof design.locked === 'boolean' ? design.locked : Boolean(payload.locked_main_id);
  $('#card-dialog').close(); resetCandidateView(); renderStudio(); navigate('studio', true);
  message('#studio-message', payload.components.length === state.components.length ? '已把香笺带回案头。可以继续调整，排除项保持生效。' : '已把香笺带回案头；之前排除项继续生效，冲突材料已移出。');
}
export function wrapCanvasText(context, text, maxWidth) {
  const lines = []; let line = '';
  for (const char of String(text)) { if (char === '\n') { lines.push(line); line = ''; continue; } const next = line + char; if (context.measureText(next).width > maxWidth && line) { lines.push(line); line = char; } else line = next; }
  lines.push(line); return lines;
}
export async function findMatches(button) {
  if (!state.cardDesign) return;
  const requestedDesign = state.cardDesign;
  await busy(button, '正在查找…', async () => {
    try {
      const result = await api('/api/match', { method: 'POST', body: { design: state.cardDesign } });
      if (requestedDesign !== state.cardDesign) return;
      const matches = list(result.matches);
      $('#card-matches').innerHTML = matches.length ? matches.slice(0, 4).map(match => {
        const product = match.product || {};
        return `<article class="matched-product"><div class="panel-heading"><strong>${escapeHTML(product.name || '未命名香品')}</strong><span class="subtle">${escapeHTML(forms[product.form] || product.form || '形态待补充')}</span></div><div>${tags(match.matched_families || match.display_families)}</div><p>${escapeHTML(list(match.reasons).map(niceText).join(' '))}</p><p class="fine-note">${escapeHTML(list(match.unknowns).map(niceText).join('；'))}</p>${safeURL(product.purchase_url, false) ? `<a class="button secondary" href="${escapeHTML(safeURL(product.purchase_url, false))}" target="_blank" rel="noopener noreferrer">前往商家查看 ↗</a>` : '<span class="status-pill pending">购买入口待补充</span>'}</article>`;
      }).join('') : '<p class="fine-note">目前首页没有资料方向相近的公开商品。你的设计可以继续保存，不会为匹配而取消排除项。</p>';
    } catch (error) { $('#card-matches').innerHTML = `<div class="notice danger">${escapeHTML(error.message)}</div>`; }
  });
}
export async function downloadCard(button) {
  if (!state.cardDesign) return;
  const accountVersion = state.accountVersion;
  const requestedDesign = state.cardDesign;
  await busy(button, '正在留笺…', async () => {
    try {
      const design = structuredClone(state.cardDesign); design.name = $('#card-name').value.trim() || '未名';
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
      const paper = context.createLinearGradient(0, 0, canvas.width, height);
      paper.addColorStop(0, '#faf7ee'); paper.addColorStop(1, '#eee6d6');
      context.fillStyle = paper; context.fillRect(0, 0, canvas.width, height);
      context.strokeStyle = '#c9bca6'; context.lineWidth = 2; context.strokeRect(45, 40, 990, height - 80);
      context.lineWidth = 1; context.strokeRect(56, 51, 968, height - 102);
      // 同一份数字设计的案头题款，器物图形只作装饰。
      context.save(); context.strokeStyle = '#917452'; context.fillStyle = '#917452'; context.lineWidth = 2;
      context.beginPath(); context.ellipse(940, 103, 25, 5, 0, 0, Math.PI * 2); context.stroke();
      context.beginPath(); context.moveTo(915, 104); context.bezierCurveTo(917, 128, 963, 128, 965, 104); context.stroke();
      context.beginPath(); context.moveTo(925, 124); context.lineTo(922, 133); context.moveTo(955, 124); context.lineTo(958, 133); context.stroke();
      context.strokeStyle = '#b7aa92'; context.beginPath(); context.moveTo(940, 96);
      context.bezierCurveTo(927, 83, 955, 76, 940, 63); context.stroke(); context.restore();
      for (const block of blocks) {
        if (block.type === 'line') { context.strokeStyle = '#d2d5c7'; context.beginPath(); context.moveTo(92, block.y); context.lineTo(988, block.y); context.stroke(); continue; }
        context.fillStyle = block.color; context.font = `${block.size}px ${block.font === 'serif' ? '"Songti SC", "STSong", serif' : '"PingFang SC", sans-serif'}`; context.textBaseline = 'top';
        block.lines.forEach((line, i) => context.fillText(line, 92, block.y + i * block.size * 1.65));
      }
      context.strokeStyle = '#a93f35'; context.strokeRect(918, height - 111, 55, 60); context.fillStyle = '#a93f35'; context.font = '40px "Songti SC", serif'; context.fillText('意', 925, height - 104);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')); if (!blob) throw new Error('图片导出未完成，请重试。');
      if (accountVersion !== state.accountVersion || requestedDesign !== state.cardDesign) return;
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `合香-${design.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}.png`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); toast('香笺已导出为 PNG。');
    } catch (error) { if (accountVersion === state.accountVersion && requestedDesign === state.cardDesign) toast(error.message); }
  });
}
