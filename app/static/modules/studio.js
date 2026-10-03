import { $, $$, escapeHTML, list, roles, forms, state, api, message, busy, empty, profile, profileName, facetLabel, tags, niceText } from './core.js';

export function designSnapshot() {
  return { components: structuredClone(state.components), preferred: [...state.preferred], deemphasized: [...state.deemphasized], excluded: [...state.excluded], scene: $('#design-scene').value, words: $('#design-words').value, locked: $('#lock-main').checked, name: state.draftName };
}
export function pushHistory(snapshot = designSnapshot()) {
  state.history.push(snapshot);
  if (state.history.length > 30) state.history.shift(); $('#undo-design').disabled = false;
}
export function resetCandidateView() {
  state.designRevision += 1;
  state.candidates = []; state.cardDesign = null; state.cardOrigin = ''; state.simulationConfirmed = false;
  $('#candidates-section').hidden = true; $('#candidate-comparison').hidden = true;
  $('#card-preview').innerHTML = '';
  $('#card-matches')?.replaceChildren();
  message('#studio-message', '');
  renderStudioProgress();
  document.dispatchEvent(new Event('design:changed'));
}
export function renderStudioProgress() {
  const container = $('#studio-progress'); if (!container) return;
  const hasMain = state.components.some(part => part.role === 'main');
  const stage = state.cardDesign ? 4 : state.candidates.length ? 3 : hasMain ? 2 : $('#design-scene').value.trim() ? 1 : 0;
  container.innerHTML = ['选一个场景', '放入主调', '比较两份构图', '命名留笺'].map((label, index) => `<div class="progress-step ${index < stage ? 'complete' : index === stage ? 'active' : ''}" ${index === stage ? 'aria-current="step"' : ''}><span>${index + 1}</span><span>${label}</span></div>`).join('');
}
export function toggleFacet(group, key) {
  if (!['preferred', 'deemphasized'].includes(group) || !state.facets[key]) return;
  pushHistory();
  const selected = state[group].includes(key);
  state[group] = selected ? state[group].filter(item => item !== key) : [...state[group], key];
  if (!selected) {
    const other = group === 'preferred' ? 'deemphasized' : 'preferred';
    state[other] = state[other].filter(item => item !== key);
  }
  resetCandidateView(); renderStudio();
}
export function setRole(role, id) {
  if (!profile(id) || !roles[role]) return;
  if (state.excluded.includes(id)) { message('#studio-message', '这份材料在你的排除项里。要加入它，请先由你取消排除。', 'danger'); return; }
  pushHistory(); state.components = state.components.filter(item => item.role !== role && item.profile_id !== id); state.components.push({ profile_id: id, role }); state.selectedMaterial = null; resetCandidateView(); renderStudio(); message('#studio-message', `${profileName(id)}已放入${roles[role]}。`);
}
export function shortProfileName(item) {
  return (typeof item === 'string' ? profileName(item) : item?.name || '').replace(/ (Givaudan|IFF|dsm).*$/, '');
}
export function currentPayload(components = state.components) {
  return { components: components.map(item => ({ profile_id: item.profile_id, role: item.role })), name: (state.draftName || '').trim() || '未名', scenario: $('#design-scene').value.trim(), user_notes: $('#design-words').value.trim(), raw_preferences: [...state.preferred], raw_exclusions: state.excluded.map(profileName), preferred_facets: [...state.preferred], deemphasized_facets: [...state.deemphasized], excluded_ids: [...state.excluded], locked_main_id: $('#lock-main').checked ? components.find(part => part.role === 'main')?.profile_id : undefined };
}
export function renderStudio() {
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
  $('#studio-constraints').textContent = state.excluded.length ? `始终排除：${state.excluded.map(id => shortProfileName(id)).join('、')}` : '排除项：未指定。需要时可在下方微调。';
  $('#studio-constraints').classList.toggle('has-exclusions', state.excluded.length > 0);
  const adjustments = [state.preferred.length ? `喜欢 ${state.preferred.map(facetLabel).join('、')}` : '', state.deemphasized.length ? `少一点 ${state.deemphasized.map(facetLabel).join('、')}` : '', state.excluded.length ? `排除 ${state.excluded.length} 味` : ''].filter(Boolean);
  $('#studio-adjustments-summary').textContent = adjustments.join(' · ') || '也可以先比较，再回来调整';
  $('#design-summary').innerHTML = `<div class="summary-row"><strong>当前主调</strong>${escapeHTML(profileName(state.components.find(item => item.role === 'main')?.profile_id))}</div><div class="summary-row"><strong>更喜欢</strong>${escapeHTML(state.preferred.map(facetLabel).join('、') || '还未选定')}</div><div class="summary-row"><strong>希望少一点</strong>${escapeHTML(state.deemphasized.map(facetLabel).join('、') || '还未选定')}</div><div class="summary-row"><strong>排除项</strong>${escapeHTML(state.excluded.map(profileName).join('、') || '未指定')}</div><div class="summary-row"><strong>结果状态</strong>数字设计；尚未制作或实闻</div>`;
  $('#undo-design').disabled = !state.history.length;
  renderStudioProgress();
  $$('[data-scene]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.scene === $('#design-scene').value)));
  document.dispatchEvent(new Event('design:rendered'));
}
export function renderPalette() {
  const previousScroll = $('#profile-palette').scrollLeft;
  const focused = document.activeElement?.closest('#profile-palette') ? { action: document.activeElement.dataset.action, id: document.activeElement.dataset.id, role: document.activeElement.dataset.role, material: document.activeElement.dataset.profile } : null;
  $('#profile-palette').innerHTML = state.profiles.length ? state.profiles.map(item => {
    const assigned = state.components.find(part => part.profile_id === item.id)?.role;
    const excluded = state.excluded.includes(item.id);
    return `<article class="material-card ${state.selectedMaterial === item.id ? 'selected' : ''}" draggable="true" data-profile="${escapeHTML(item.id)}" tabindex="0" aria-label="选择${escapeHTML(item.name)}"><h3><span class="family-mark ${escapeHTML(item.primary_family)}" aria-hidden="true"></span>${escapeHTML(shortProfileName(item))}</h3><p class="material-form">${escapeHTML(forms[item.form] || item.form)} · ${escapeHTML(item.supplier || '')}</p><div>${tags(list(item.reported_facets).slice(0, 4))}</div><p class="material-placement" role="status">${excluded ? '已排除；取消排除后才能入案' : assigned ? `已放入${roles[assigned]}` : state.selectedMaterial === item.id ? '已选中，可直接选择下面的位置' : '放入这一案'}</p><div class="material-role-actions" aria-label="${escapeHTML(shortProfileName(item))}的构图位置">${Object.entries(roles).map(([role, label]) => `<button type="button" class="material-role-button ${assigned === role ? 'assigned' : ''}" data-action="assign-material" data-id="${escapeHTML(item.id)}" data-role="${role}" aria-label="将${escapeHTML(shortProfileName(item))}放入${label}" aria-pressed="${assigned === role}" ${excluded ? 'disabled' : ''}>${label}</button>`).join('')}</div><div class="material-footer"><span class="subtle">厂家资料参照</span><button type="button" class="text-button" data-action="profile-detail" data-id="${escapeHTML(item.id)}">看出处</button></div></article>`;
  }).join('') : empty('参照材料尚未载入', '请检查本地服务后重试。');
  $('#profile-palette').scrollLeft = previousScroll;
  if (focused) {
    const target = focused.material ? $$('.material-card').find(node => node.dataset.profile === focused.material) : $$('#profile-palette button').find(node => node.dataset.action === focused.action && node.dataset.id === focused.id && node.dataset.role === focused.role);
    target?.focus({ preventScroll: true });
  }
  updatePaletteControls();
  const presets = list(state.boot?.presets);
  const presetCards = presets.map((item, index) => `<div class="preset-card"><strong>${escapeHTML(item.name || item.title || `设计草案 ${index + 1}`)}</strong><p>${escapeHTML(item.description || item.intent || item.scenario || '项目拟定的数字构图，尚未实闻。')}</p><span class="subtle">设计意图 · 非古方复原</span><br><button type="button" class="text-button" data-action="use-preset" data-index="${index}">以此起稿 →</button></div>`);
  const workCards = list(state.works).map(item => `<div class="preset-card creator-work-card"><strong>${escapeHTML(item.name)}</strong><p>${escapeHTML(item.public_note || item.intent || item.scenario || '创作者发布的数字构图，尚未实闻。')}</p><span class="subtle">OPC 作品 · ${escapeHTML(item.creator_name || '创作者')}</span><br><button type="button" class="text-button" data-action="use-work" data-id="${escapeHTML(item.id)}">以此起稿 →</button></div>`);
  const allCards = [...presetCards, ...workCards];
  $('#preset-list').innerHTML = allCards.length ? allCards.join('') : '<p class="fine-note">暂无已整理的设计草案。可以直接挑选材料开始。</p>';
}
export function updatePaletteControls() {
  const palette = $('#profile-palette');
  $('#palette-prev').disabled = palette.scrollLeft < 2;
  $('#palette-next').disabled = palette.scrollLeft + palette.clientWidth >= palette.scrollWidth - 2;
}
export function describeFailure(result) {
  const words = list(result.unknown_descriptors || result.unknown_facets || result.unmapped_project_terms).map(niceText);
  if (words.length) return `这些描述还没有对应资料：${words.join('、')}。你的原话会保留，可以换一个词或继续查图鉴。`;
  const unmatched = list(result.unmatched_preferences).map(facetLabel);
  if (unmatched.length) return `当前参照材料的资料还不足以支持${unmatched.join('、')}方向。你的原话与排除项会保留，可以换一个方向，或先到图鉴了解材料。`;
  return result.reason || result.message || '当前资料池没有满足这些条件的候选。排除项保持不变，可以由你调整偏好。';
}
export async function generateDesign(button) {
  message('#studio-message', '');
  const revision = state.designRevision;
  const scenario = $('#design-scene').value.trim();
  await busy(button, '正在比较构图…', async () => {
    try {
      const main = state.components.find(item => item.role === 'main');
      const request = { preferred_facets: state.preferred, deemphasized_facets: state.deemphasized, excluded_ids: state.excluded, limit: 2 };
      if (main && $('#lock-main').checked) request.locked_main_id = main.profile_id;
      const result = await api('/api/compose', { method: 'POST', body: request });
      if (revision !== state.designRevision) return;
      if (!['ok', 'single_reference_only'].includes(result.status) || !result.candidates?.length) { resetCandidateView(); message('#studio-message', describeFailure(result)); return; }
      state.candidates = result.candidates.map((item, index) => ({ ...item, name: item.name || `候选${index + 1}`, scenario }));
      renderCandidates();
      message('#studio-message', state.candidates.length > 1 ? `已按资料标签和你的条件形成 ${state.candidates.length} 份候选。比较的是设计构图，真实组合气味仍待实闻。` : '当前条件只支持一份材料参照，排除项保持不变。可以继续调整或留笺，真实气味仍待实闻。', 'success');
      $('#candidates-section').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    } catch (error) { message('#studio-message', error.message, 'danger'); }
  });
}
export function componentChanges(components) {
  const before = new Map(state.components.map(item => [item.profile_id, item.role]));
  const after = new Map(components.map(item => [item.profile_id, item.role]));
  const changes = [];
  for (const [id, role] of before) if (!after.has(id)) changes.push(`移出${profileName(id)}`); else if (after.get(id) !== role) changes.push(`${profileName(id)}从${roles[role]}移到${roles[after.get(id)]}`);
  for (const [id, role] of after) if (!before.has(id)) changes.push(`加入${profileName(id)}，放在${roles[role]}`);
  return changes.length ? changes : ['保留当前构图，以你的偏好继续比较。'];
}
function candidateReading(item, index) {
  const other = state.candidates.find((candidate, candidateIndex) => candidateIndex !== index);
  const components = list(item.components);
  const different = components.filter(part => !list(other?.components).some(peer => peer.profile_id === part.profile_id && peer.role === part.role));
  const part = different[0] || components[0];
  if (!part) return { title: '保留这一份构图', explanation: '没有可说明的材料差异。' };
  const material = profile(part.profile_id);
  const peer = list(other?.components).find(component => component.role === part.role);
  const recorded = list(part.reported_facets || material?.reported_facets);
  const peerRecorded = list(peer?.reported_facets || profile(peer?.profile_id)?.reported_facets);
  const distinctive = recorded.filter(facet => !peerRecorded.includes(facet));
  const labels = (distinctive.length ? distinctive : recorded).slice(0, 3).map(facetLabel);
  const title = `${roles[part.role] || '参照'}取${shortProfileName(material || part)}`;
  const explanation = `${shortProfileName(material || part)}的资料${labels.length ? `记录了${labels.join('、')}` : '还没有可用的气味细标签'}。${other ? `这里比较${roles[part.role] || '材料'}的选择，组合气味仍待实闻。` : '当前条件下保留这一份参照，未补造另一份候选。'}`;
  return { title, explanation };
}
export function renderCandidates() {
  $('#candidates-section').hidden = false;
  $('#candidates-section .eyebrow').textContent = `${state.candidates.length} 份候选 · 保留你的条件`;
  $('#candidate-results').innerHTML = state.candidates.map((item, index) => {
    const reading = candidateReading(item, index);
    return `<article class="candidate-card"><p class="candidate-index">候选 ${index + 1}</p><h3>${escapeHTML(reading.title)}</h3><p class="candidate-explanation">${escapeHTML(reading.explanation)}</p>${list(item.components).map(part => `<div class="candidate-role"><span class="role-name">${escapeHTML(roles[part.role] || part.role)}</span><div><strong>${escapeHTML(part.name || profileName(part.profile_id))}</strong><div class="subtle">${escapeHTML(forms[part.form || profile(part.profile_id)?.form] || part.form || '')}</div></div></div>`).join('')}<div class="candidate-matched"><span class="subtle">资料支持的偏好</span><div>${list(item.matched_preferences).length ? tags(item.matched_preferences) : '<span class="subtle">未指定或暂无匹配</span>'}</div></div>${list(item.unmatched_preferences).length ? `<p class="fine-note">尚未匹配：${escapeHTML(item.unmatched_preferences.map(facetLabel).join('、'))}</p>` : ''}<div class="candidate-changes"><strong>相对当前案头</strong><ul>${componentChanges(item.components || []).map(text => `<li>${escapeHTML(text)}</li>`).join('')}</ul></div><div class="candidate-actions"><button type="button" class="button primary" data-action="choose-candidate" data-index="${index}">以此继续调整</button><button type="button" class="button quiet" data-action="candidate-card" data-index="${index}">命名留笺</button></div><p class="fine-note">数字设计 · 组合气味未经实闻，不含制作比例。</p></article>`;
  }).join('');
  $('#candidate-comparison').hidden = state.candidates.length < 2;
  if (state.candidates.length > 1) {
    $('#candidate-comparison').hidden = false;
    const [a, b] = state.candidates;
    const unique = item => list(item.components).filter(part => !list(item === a ? b.components : a.components).some(other => other.profile_id === part.profile_id && other.role === part.role));
    $('#candidate-comparison').innerHTML = `<h3>两份之间的差别</h3><div class="comparison-grid">${[a, b].map((item, i) => `<div><strong>候选 ${i + 1} 的不同处</strong><p>${escapeHTML(unique(item).map(part => `${roles[part.role]}：${part.name || profileName(part.profile_id)}`).join('；') || '材料与角色一致。')}</p></div>`).join('')}</div><p class="fine-note">标签没有报道，不等于气味不存在；“少一点甜香”是本轮设计意图，不是无甜、无刺激的保证。</p>`;
  }
  renderStudioProgress();
}
