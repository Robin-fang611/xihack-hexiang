import { $, escapeHTML, list, state, api, profileName, facetLabel, message } from './core.js';
import { pushHistory, resetCandidateView, renderStudio } from './studio.js';

let initialized = false;
let requestVersion = 0;
let pendingProposal = null;

function conditions() {
  return { preferred_facets: [...state.preferred], deemphasized_facets: [...state.deemphasized], excluded_ids: [...state.excluded] };
}
function snapshot() {
  return { words: $('#design-words').value, revision: state.designRevision, account: state.accountVersion, conditions: JSON.stringify(conditions()) };
}
function isCurrent(saved) {
  return saved.words === $('#design-words').value && saved.revision === state.designRevision && saved.account === state.accountVersion && saved.conditions === JSON.stringify(conditions());
}
function clearProposal() {
  requestVersion += 1;
  pendingProposal = null;
  const preview = $('#intent-preview');
  preview.replaceChildren(); preview.hidden = true; preview.classList.remove('intent-applied');
  $('#interpret-words').disabled = false;
  $('#interpret-words').textContent = '整理明确偏好';
}
function unique(values) { return [...new Set(list(values))]; }
function contradictory(result) {
  if (list(result.conflicts).some(item => item.kind === 'text_contradiction')) return true;
  const actions = new Map();
  for (const item of list(result.recognized)) {
    if (!item.facet || !['prefer', 'deemphasize'].includes(item.action)) continue;
    if (actions.has(item.facet) && actions.get(item.facet) !== item.action) return true;
    actions.set(item.facet, item.action);
  }
  return false;
}
function proposalFor(result, resolution = 'current') {
  const base = result.proposal || {};
  const next = { preferred_facets: unique(base.preferred_facets), deemphasized_facets: unique(base.deemphasized_facets), excluded_ids: unique([...state.excluded, ...list(base.excluded_ids)]) };
  if (resolution === 'text' && !contradictory(result)) {
    for (const item of list(result.recognized)) {
      if (!item.facet || !['prefer', 'deemphasize'].includes(item.action)) continue;
      next.preferred_facets = next.preferred_facets.filter(facet => facet !== item.facet);
      next.deemphasized_facets = next.deemphasized_facets.filter(facet => facet !== item.facet);
      next[item.action === 'prefer' ? 'preferred_facets' : 'deemphasized_facets'].push(item.facet);
    }
  }
  return next;
}
function hasChanges(next) {
  const current = conditions();
  return Object.keys(current).some(key => JSON.stringify([...current[key]].sort()) !== JSON.stringify([...next[key]].sort()));
}
function conditionHTML(next) {
  return `<p><strong>更喜欢</strong> ${escapeHTML(next.preferred_facets.map(facetLabel).join('、') || '未指定')}</p><p><strong>希望少一点</strong> ${escapeHTML(next.deemphasized_facets.map(facetLabel).join('、') || '未指定')}</p><p><strong>始终排除</strong> ${escapeHTML(next.excluded_ids.map(profileName).join('、') || '未指定')}</p>`;
}
function refreshProposedConditions() {
  if (!pendingProposal) return;
  const result = pendingProposal.result;
  const next = proposalFor(result, $('#intent-resolution')?.value || 'current');
  const proposed = $('#intent-proposed-conditions'); if (proposed) proposed.innerHTML = conditionHTML(next);
  const blocked = contradictory(result);
  const button = $('#apply-intent'); if (!button) return;
  button.disabled = blocked || !hasChanges(next);
  button.textContent = blocked ? '先修改相互矛盾的原话' : hasChanges(next) ? '应用这些选项' : '当前选项已相同';
}
function renderProposal(result) {
  const preview = $('#intent-preview');
  const blocked = contradictory(result);
  const conflicts = list(result.conflicts);
  const manualConflicts = conflicts.some(item => item.kind === 'manual_text_conflict');
  const recognized = list(result.recognized);
  preview.hidden = false;
  if (result.status === 'no_changes' && !conflicts.length) {
    const next = conditions();
    const hasCurrent = next.preferred_facets.length || next.deemphasized_facets.length || next.excluded_ids.length;
    preview.innerHTML = `<h3>${recognized.length ? '这些明确表达已在当前选项中' : '这句话暂未转成选项'}</h3><p>原话已保留，当前选项未改变。</p>${list(result.unknown_segments).length ? `<p class="intent-unknown">尚未对应资料：${list(result.unknown_segments).map(text => `「${escapeHTML(text)}」`).join('、')}。</p>` : ''}${hasCurrent ? `<details class="intent-current"><summary>当前选项（未改变）</summary><div id="intent-proposed-conditions" class="intent-conditions">${conditionHTML(next)}</div></details>` : ''}<p class="intent-method">只整理已有词表中的明确表达。</p>`;
    return;
  }
  preview.innerHTML = `<h3>${blocked ? '这几句话需要你改清楚' : recognized.length ? '看一眼，再应用到这一案' : '暂未找到明确的气味偏好'}</h3>${recognized.length ? `<ul class="intent-recognized">${recognized.map(item => `<li><strong>${escapeHTML(({ prefer: '更喜欢', deemphasize: '少一点', exclude: '排除' })[item.action] || '记录')}</strong> ${escapeHTML(item.profile_id ? profileName(item.profile_id) : facetLabel(item.facet || ''))}<span class="intent-quote">来自原话「${escapeHTML(item.text)}」</span></li>`).join('')}</ul>` : '<p>可以明确写想保留或减少的气味方向。原话会继续保留在香笺上。</p>'}${conflicts.length ? `<div class="intent-conflicts"><strong>${blocked ? '同一方向同时要求喜欢和减少，暂不应用。' : '原话与当前选项不同，请明确取舍。'}</strong><ul>${conflicts.map(item => `<li>${escapeHTML(item.reason || `${facetLabel(item.facet)}的选择需要确认`)}</li>`).join('')}</ul></div>` : ''}${manualConflicts && !blocked ? '<label class="intent-resolution" for="intent-resolution">冲突的方向怎样处理<select id="intent-resolution"><option value="current">保留当前选项</option><option value="text">明确按原话取舍</option></select></label>' : ''}<div id="intent-proposed-conditions" class="intent-conditions"></div>${list(result.unknown_segments).length ? `<p class="intent-unknown">还未整理为选项：${list(result.unknown_segments).map(text => `「${escapeHTML(text)}」`).join('、')}。这些内容原样保留，不据此编造气味。</p>` : ''}<div class="intent-actions"><button type="button" class="button secondary" id="apply-intent">应用这些选项</button><span class="intent-method">按已有词表整理，尚未改变这一案。</span></div>`;
  refreshProposedConditions();
}
async function interpret() {
  clearProposal();
  const saved = snapshot();
  const version = requestVersion;
  const preview = $('#intent-preview');
  if (!saved.words.trim()) {
    preview.hidden = false; preview.innerHTML = '<p>先写一句自己的话，再整理明确偏好。</p>';
    return;
  }
  $('#interpret-words').disabled = true;
  $('#interpret-words').textContent = '正在整理…';
  try {
    const result = await api('/api/interpret', { method: 'POST', body: { user_notes: saved.words, manual_preferred: [...state.preferred], manual_deemphasized: [...state.deemphasized], excluded_ids: [...state.excluded] } });
    if (version !== requestVersion || !isCurrent(saved)) return;
    const proposed = result.proposal || {};
    const valid = ['proposal', 'no_changes', 'needs_confirmation'].includes(result.status) && list(proposed.preferred_facets).every(facet => state.facets[facet]) && list(proposed.deemphasized_facets).every(facet => state.facets[facet]) && list(proposed.excluded_ids).every(id => state.profiles.some(item => item.id === id));
    if (!valid) throw new Error('这次没有形成可应用的选项。请保留原话后重试。');
    pendingProposal = { saved, result };
    renderProposal(result);
    preview.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  } catch (error) {
    if (version !== requestVersion || !isCurrent(saved)) return;
    preview.hidden = false; preview.innerHTML = `<p>${escapeHTML(error.message)}</p>`;
  } finally {
    if (version === requestVersion) { $('#interpret-words').disabled = false; $('#interpret-words').textContent = '整理明确偏好'; }
  }
}
function apply() {
  const pending = pendingProposal;
  if (!pending || !isCurrent(pending.saved)) {
    clearProposal();
    message('#studio-message', '原话或当前选项已经变化，请重新整理再应用。');
    return;
  }
  if (contradictory(pending.result)) return;
  const next = proposalFor(pending.result, $('#intent-resolution')?.value || 'current');
  if (!hasChanges(next)) return;
  clearProposal();
  pushHistory();
  state.preferred = next.preferred_facets;
  state.deemphasized = next.deemphasized_facets;
  state.excluded = next.excluded_ids;
  state.components = state.components.filter(part => !state.excluded.includes(part.profile_id));
  resetCandidateView(); renderStudio();
  const preview = $('#intent-preview');
  preview.hidden = false; preview.classList.add('intent-applied');
  preview.innerHTML = '<p>已应用到这一案，原话保持原样。可以继续调整或生成候选。</p>';
  message('#studio-message', '已应用你确认的明确偏好，排除项保持生效。', 'success');
}

export function setupIntent() {
  if (initialized || !$('#interpret-words')) return;
  initialized = true;
  $('#interpret-words').addEventListener('click', interpret);
  $('#design-words').addEventListener('input', clearProposal);
  document.addEventListener('design:changed', clearProposal);
  document.addEventListener('account:cleared', clearProposal);
  document.addEventListener('change', event => { if (event.target.id === 'intent-resolution') refreshProposedConditions(); });
  document.addEventListener('click', event => { if (event.target.closest('#apply-intent')) apply(); });
}
