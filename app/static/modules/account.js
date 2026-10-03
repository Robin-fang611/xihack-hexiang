import { $, $$, escapeHTML, state, message } from './core.js';
import { renderStudio } from './studio.js';

export function renderAccount() {
  const node = $('#account-area');
  if (!state.user) node.innerHTML = '<button type="button" class="button quiet" data-action="login">登录 / 注册</button>';
  else node.innerHTML = `<div><span class="account-name">${escapeHTML(state.user.display_name || state.user.username)}</span><span class="role-label"> · ${state.user.role === 'manager' ? '管理者' : '普通账号'}</span></div><button type="button" class="button quiet" data-action="logout">退出</button>`;
  $$('.manager-only').forEach(node => { node.hidden = state.user?.role !== 'manager'; });
}
export function renderAuthRequirements() {
  $$('[data-auth-required]').forEach(node => { node.hidden = Boolean(state.user); node.innerHTML = '<h2>先把这一案留给自己</h2><p>登录后可以上传香品、保存私人报告。资料不会进入首页推荐。</p><button type="button" class="button primary" data-action="login">登录 / 注册</button>'; });
  $$('[data-auth-content]').forEach(node => { node.hidden = !state.user; });
  $('#manager-content').hidden = state.user?.role !== 'manager';
  message('#manager-access-message', state.user?.role === 'manager' ? '' : '商品管理仅对管理者账号开放。');
}
export function clearPrivateState() {
  state.accountVersion += 1; state.recordsRequest += 1; state.designRevision += 1;
  state.records = []; state.savedDesigns = []; state.cardDesign = null; state.draftName = ''; state.cardOrigin = '';
  state.simulation = null; state.simulationConfirmed = false; state.logs = [];
  state.components = []; state.preferred = []; state.deemphasized = []; state.excluded = []; state.history = []; state.candidates = []; state.selectedMaterial = null;
  for (const selector of ['#private-records', '#manager-records', '#saved-designs', '#detail-content', '#card-preview', '#card-matches', '#handoff-result']) { const node = $(selector); if (node) node.innerHTML = ''; }
  $('#integration-log').textContent = '尚未调用。';
  for (const selector of ['#studio-message', '#private-upload-message', '#manager-upload-message', '#simulation-message']) message(selector, '');
  for (const selector of ['#design-scene', '#design-words', '#card-name']) { const node = $(selector); if (node) node.value = ''; }
  $$('.upload-form').forEach(form => { form.reset(); const files = form.querySelector('.file-selection'); if (files) files.textContent = ''; });
  for (const selector of ['#detail-dialog', '#card-dialog']) if ($(selector)?.open) $(selector).close();
  $('#candidates-section').hidden = true;
  if (state.boot) renderStudio();
  document.dispatchEvent(new Event('account:cleared'));
}
