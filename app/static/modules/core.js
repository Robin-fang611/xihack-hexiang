/** 共享状态与同源请求；此模块不导入任何业务模块。 */
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export const list = value => Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
export const roles = { main: '主调', support: '支撑', accent: '点缀' };
export const forms = { essential_oil: '精油', resinoid_extract: '树脂提取物', raw_resin: '原树脂', oleo_gum_resin: '油胶树脂', wood: '木材', dried_flower_bud: '干燥花蕾', burning_fumes: '燃烧烟气', unidentified_material: '身份待核对', incense: '线香 / 燃香', scent_bead: '香珠 / 香牌', sachet: '香包', perfume: '香水', diffuser: '扩香液', candle: '香薰蜡烛', other: '其他', unknown: '形态待补充' };
export const state = { boot: null, user: null, csrf: '', page: 'home', library: 'materials', authMode: 'login', profiles: [], facets: {}, sources: [], products: [], records: [], savedDesigns: [], selectedMaterial: null, components: [], preferred: [], deemphasized: [], excluded: [], history: [], candidates: [], cardDesign: null, simulation: null, simulationConfirmed: false, logs: [], loading: false, accountVersion: 0, recordsRequest: 0, designRevision: 0, draftName: '', cardOrigin: '' };

export function safeURL(value, allowRelative = true) {
  if (!value || typeof value !== 'string') return '';
  try {
    if (!allowRelative && !/^https?:\/\//i.test(value)) return '';
    const parsed = new URL(value, location.origin);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch { return ''; }
}

let unauthorizedHandler = () => {};
export function onUnauthorized(handler) { unauthorizedHandler = handler; }

export async function api(path, { method = 'GET', body } = {}) {
  const accountVersion = state.accountVersion;
  const headers = { Accept: 'application/json' };
  if (/^\/api\/(products|designs|simulation)(?:\/|$)/.test(path)) headers['X-Expected-User'] = state.user?.id || 'guest';
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
    if ((response.status === 401 || result.code === 'session_changed') && accountVersion === state.accountVersion && !['/api/login', '/api/register'].includes(path)) unauthorizedHandler();
    throw error;
  }
  if (accountVersion !== state.accountVersion && /^\/api\/(products|designs|simulation)(?:\/|$)/.test(path)) {
    const error = new Error('账号已切换，本次响应不会写入当前案头。'); error.code = 'session_changed'; throw error;
  }
  return result;
}

export function toast(message) {
  const box = $('#toast'); box.textContent = message; box.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { box.hidden = true; }, 4200);
}
export function message(selector, text, kind = '') {
  const node = $(selector); if (!node) return;
  node.textContent = text; node.className = `notice ${kind}`; node.hidden = !text;
}
export async function busy(button, label, work) {
  const original = button.textContent; button.disabled = true; button.textContent = label;
  try { return await work(); } finally { button.disabled = false; button.textContent = original; }
}
export function empty(title, description, action = '') { return `<div class="empty-state"><div class="empty-symbol" aria-hidden="true">香</div><h3>${escapeHTML(title)}</h3><p>${escapeHTML(description)}</p>${action}</div>`; }
export function profile(id) { return state.profiles.find(item => item.id === id); }
export function profileName(id) { return profile(id)?.name || id || '未选择'; }
export function facetLabel(id) { return state.facets[id] || id; }
export function source(id) { return state.sources.find(item => item.id === id); }
export function tags(items) { return list(items).map(item => `<span class="tag">${escapeHTML(facetLabel(typeof item === 'object' ? item.label || item.tag_id || item.name : item))}</span>`).join(''); }
export function niceText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return value.text || value.description || value.reason || value.name || value.label || value.note || value.value || value.raw || JSON.stringify(value);
}
export function sourceLink(value, label = '查看出处') {
  const item = typeof value === 'object' ? value : source(value);
  const url = safeURL(item?.url || item?.source_url || (typeof value === 'string' && /^https?:/.test(value) ? value : ''));
  return url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(item?.title || label)}</a>` : `<span class="subtle">来源待补充</span>`;
}
export function evidenceHTML(items) {
  return list(items).map(item => `<div class="evidence-list">${sourceLink(item.source_id || item)}${item.locator ? ` · ${escapeHTML(item.locator)}` : ''}${item.object_form ? ` · ${escapeHTML(forms[item.object_form] || item.object_form)}` : ''}</div>`).join('');
}
export function openDialog(id) { const node = $(id); if (!node.open) node.showModal(); }
export function closeDialog(id) { $(id)?.close(); }
