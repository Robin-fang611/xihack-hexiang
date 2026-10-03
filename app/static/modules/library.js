import { $, $$, escapeHTML, list, roles, forms, state, empty, profile, facetLabel, tags, niceText, sourceLink, evidenceHTML, openDialog, closeDialog, message, toast } from './core.js';
import { renderStudio } from './studio.js';
import { navigate } from './navigation.js';

let initialized = false;
function profilePosition(item) {
  if (state.excluded.includes(item.id)) return '当前案头：已排除';
  const assigned = state.components.find(part => part.profile_id === item.id)?.role;
  return assigned ? `当前案头：${roles[assigned]}` : state.selectedMaterial === item.id ? '已选择，待放入一个位置' : '尚未放入当前案头';
}
function updateFilters() {
  const modern = state.library === 'profiles';
  $('#library-filters').hidden = !modern;
  $('#library-search').disabled = !modern; $('#library-family').disabled = !modern;
  $('#library-results-count').hidden = !modern;
  const previous = $('#library-family').value;
  const reported = new Set(state.profiles.flatMap(item => list(item.reported_facets)));
  $('#library-family').innerHTML = '<option value="">全部资料方向</option>' + [...reported].sort((a, b) => facetLabel(a).localeCompare(facetLabel(b), 'zh-CN')).map(facet => `<option value="${escapeHTML(facet)}">${escapeHTML(facetLabel(facet))}</option>`).join('');
  if (reported.has(previous)) $('#library-family').value = previous;
  $('#library-scope').textContent = modern ? '本案使用具体的现代参照。精油、提取物各自记录，标签来自厂家资料。' : state.library === 'materials' ? '此页记录传统材料资料；物种与加工形态各自核对，未知材料不会直接进入混配。' : state.library === 'formulas' ? '历史原名与现代材料不自动互换；下列资料用于阅读，尚未校勘或复原制作。' : '文化陈述、项目规则与实际气味分别核对。';
}

export function renderLibrary() {
  $$('.tab-button[data-library]').forEach(node => { const active = node.dataset.library === state.library; node.classList.toggle('active', active); node.setAttribute('aria-selected', String(active)); });
  const knowledge = state.boot?.knowledge || {};
  updateFilters();
  let items;
  if (state.library === 'profiles') {
    const terms = $('#library-search').value.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const family = $('#library-family').value;
    const filtered = state.profiles.filter(item => {
      const text = [item.name, item.source_plant_name, item.supplier, forms[item.form] || item.form, ...list(item.reported_facets), ...list(item.reported_facets).map(facetLabel)].join(' ').normalize('NFKC').toLocaleLowerCase();
      return terms.every(term => text.includes(term)) && (!family || list(item.reported_facets).includes(family));
    });
    $('#library-results-count').textContent = `找到 ${filtered.length} / ${state.profiles.length} 份现代参照`;
    items = filtered.map(item => `<article class="library-card" data-library-profile="${escapeHTML(item.id)}"><p class="eyebrow">现代参照 · ${escapeHTML(forms[item.form] || item.form)}</p><h2>${escapeHTML(item.name)}</h2><p class="latin">${escapeHTML(item.source_plant_name || '')}</p><div>${tags(item.reported_facets)}</div><p class="library-position">${escapeHTML(profilePosition(item))}</p><p class="fine-note">厂家描述已记录；团队尚未实闻，组合效果未验证。</p><div class="library-actions"><button type="button" class="text-button" data-action="profile-detail" data-id="${escapeHTML(item.id)}">完整资料 →</button><button type="button" class="text-button" data-action="use-profile" data-id="${escapeHTML(item.id)}">选这份，到案头 →</button></div></article>`);
  }
  else if (state.library === 'materials') items = list(knowledge.materials).map(item => `<article class="library-card" data-library-material="${escapeHTML(item.id)}"><p class="eyebrow">传统香材资料</p><h2>${escapeHTML(item.name)}</h2><p class="latin">${escapeHTML(item.source_plant_candidate || '植物身份尚待核对')}</p><div>${[...new Set(list(item.forms).map(form => forms[form.object_form] || form.name || form.object_form))].map(label => `<span class="tag">${escapeHTML(label)}</span>`).join('')}</div><p>${escapeHTML(list(item.gaps).slice(0, 2).join('；') || '请查阅具体记录的使用范围。')}</p><div class="source-note">资料陈述与实物验证分开 · 尚未实闻</div><button type="button" class="text-button" data-action="material-detail" data-id="${escapeHTML(item.id)}">查看来源与未知 →</button></article>`);
  else if (state.library === 'formulas') items = list(knowledge.historical_formulas).map(item => `<article class="library-card"><p class="eyebrow">历史参考 · 非制作香方</p><h2>${escapeHTML(item.name)}</h2><p>${escapeHTML(list(item.ingredients_original).join('、'))}</p><p>${escapeHTML(item.limitations || '')}</p><div class="source-note">数字转录已记录；现代身份、制作与气味仍待核对。</div><button type="button" class="text-button" data-action="formula-detail" data-id="${escapeHTML(item.id)}">查看书卷与原名 →</button></article>`);
  else items = [...list(knowledge.culture_claims).map(item => `<article class="library-card"><p class="eyebrow">文化与感知记录</p><p>${escapeHTML(item.text)}</p>${evidenceHTML(item.evidence)}${item.limitations ? `<p class="fine-note">${escapeHTML(item.limitations)}</p>` : ''}</article>`), ...list(knowledge.rules).map(item => `<article class="library-card"><p class="eyebrow">项目知识使用规则</p><h2>${escapeHTML(item.name)}</h2><p>${escapeHTML(item.policy)}</p><span class="status-pill pending">项目规则，不是古典事实</span></article>`)];
  $('#library-content').innerHTML = items.length ? items.join('') : state.library === 'profiles' && state.profiles.length ? empty('没有符合这些条件的现代参照', '可以换一个名称或资料方向，也可以清除筛选。') : empty('这一页资料尚未载入', '未知内容保持空缺，不由模型补写。');
}
export function selectLibraryProfile(id) {
  const item = profile(id); if (!item) return;
  state.selectedMaterial = id; closeDialog('#detail-dialog'); navigate('studio', true); renderStudio();
  const name = item.name.replace(/ (Givaudan|IFF|dsm).*$/, '');
  const assigned = state.components.find(part => part.profile_id === id)?.role;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (state.excluded.includes(id)) {
    message('#studio-message', `「${name}」在当前排除项里，排除继续生效。若想入案，请先在微调中明确取消排除。`);
    $('#studio-adjustments').open = true;
    const checkbox = $$('[data-exclude]').find(node => node.dataset.exclude === id);
    checkbox?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' }); checkbox?.focus({ preventScroll: true });
  } else {
    message('#studio-message', `已选中「${name}」（${forms[item.form] || item.form}）。${assigned ? `它当前在${roles[assigned]}，可以选择另一个位置换位。` : '在这张卡片上选择主调、支撑或点缀入案。'}`);
    const card = $$('.material-card').find(node => node.dataset.profile === id);
    card?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center', inline: 'start' });
    card?.querySelector('.material-role-button')?.focus({ preventScroll: true });
  }
  toast(`已带回「${name}」，当前构图与排除项仍保留。`);
}
export function setupLibrary() {
  if (initialized || !$('#library-search')) return;
  initialized = true;
  $('#library-search').addEventListener('input', renderLibrary);
  $('#library-family').addEventListener('change', renderLibrary);
  $('#library-reset').addEventListener('click', () => { $('#library-search').value = ''; $('#library-family').value = ''; renderLibrary(); $('#library-search').focus(); });
  document.addEventListener('click', event => { const button = event.target.closest('button, a[data-go]'); if ((button?.dataset.page || button?.dataset.go) === 'library') renderLibrary(); });
  window.addEventListener('hashchange', () => { if (state.page === 'library') renderLibrary(); });
  document.addEventListener('design:rendered', () => { if (state.page === 'library') renderLibrary(); });
  document.addEventListener('account:cleared', () => { $('#library-search').value = ''; $('#library-family').value = ''; if (state.boot) renderLibrary(); });
}
export function showProfile(id) {
  const item = profile(id); if (!item) return;
  $('#detail-content').innerHTML = `<p class="eyebrow">现代参照 · 具体材料档案</p><h2 class="detail-heading">${escapeHTML(item.name)}</h2><p class="latin">${escapeHTML(item.source_plant_name || '')}</p><p>${escapeHTML(forms[item.form] || item.form)} · ${escapeHTML(item.supplier || '')}</p><div>${tags(item.reported_facets)}</div><p class="fine-note">以上是厂家资料中的定性描述，不是本团队实闻或混合预测。</p><div class="detail-block"><h3>形态与条件</h3><p>加工记录：${escapeHTML(item.process || '未公开')}<br>使用部位：${escapeHTML(item.processed_part || '未确认')}<br>稀释情况：${escapeHTML(item.dilution ? niceText(item.dilution) : '未公开，不默认纯品')}</p></div>${item.temporal_note ? `<div class="detail-block"><h3>持久度资料的范围</h3><p>${escapeHTML(item.temporal_note)}</p></div>` : ''}<div class="detail-block"><h3>出处</h3>${sourceLink(item.source_id || item.source_url)}<p class="fine-note">精油、提取物、香粉与燃烧烟气分别记录，不自动继承描述。</p></div><button type="button" class="button secondary" data-action="use-profile" data-id="${escapeHTML(id)}">带到调香案</button>`;
  openDialog('#detail-dialog');
}
export function showKnowledge(kind, id) {
  const knowledge = state.boot?.knowledge || {};
  const item = list(knowledge[kind]).find(record => record.id === id); if (!item) return;
  if (kind === 'materials') $('#detail-content').innerHTML = `<p class="eyebrow">香材资料 · 按字段核对</p><h2>${escapeHTML(item.name)}</h2><p class="latin">候选植物来源：${escapeHTML(item.source_plant_candidate || '待核对')}</p><ul class="fact-list">${list(item.facts).map(fact => `<li>${escapeHTML(fact.text)}${evidenceHTML(fact.evidence)}${fact.limitations ? `<p class="fine-note">${escapeHTML(fact.limitations)}</p>` : ''}</li>`).join('')}</ul><div class="detail-block"><h3>按具体形态阅读</h3>${list(item.forms).map(form => `<p><strong>${escapeHTML(form.name)}</strong><br>${form.sensory_tags?.length ? tags(form.sensory_tags) : '<span class="subtle">暂无可用的细嗅觉标签。</span>'}</p>`).join('')}</div><div class="detail-block"><h3>尚未知晓</h3><ul class="gap-list">${list(item.gaps).map(gap => `<li>${escapeHTML(gap)}</li>`).join('')}</ul></div><p class="fine-note">找到出处只验证资料陈述，不验证市售实物身份、制作安全或组合气味。</p>`;
  else $('#detail-content').innerHTML = `<p class="eyebrow">历史香方档案</p><h2>${escapeHTML(item.name)}</h2><p>原名材料：${escapeHTML(list(item.ingredients_original).join('、'))}</p><p>条目定位：${escapeHTML(item.locator || '')}</p>${sourceLink(item.source_id)}<div class="notice">数字转录已记录，尚未逐字校勘影印。原名不自动替换成现代原料，本版不导出克数、比例或制作工艺。</div><p>${escapeHTML(item.limitations || '')}</p>`;
  openDialog('#detail-dialog');
}
