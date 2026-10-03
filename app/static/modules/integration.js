import { $, escapeHTML, list, state, api, message, busy } from './core.js';
import { currentPayload, describeFailure } from './studio.js';

let initialized = false;
let operationVersion = 0;
let pollGeneration = 0;
let statusTimer = null;
let displayTimer = null;
let activeContext = null;
let mutationPending = false;
let pollBusy = false;
let syncError = '';
let invalidReason = '';
let lastObservedAt = null;

function selectionKey() {
  const choice = $('#integration-design').value;
  const selected = choice === 'card' ? state.cardDesign : currentPayload(choice === 'current' ? state.components : state.candidates[Number(choice)]?.components || []);
  return JSON.stringify({ choice, space: $('#integration-scene').value, selected });
}
function selectionSnapshot() { return { account: state.accountVersion, revision: state.designRevision, selection: selectionKey() }; }
function sameSelection(saved) { return saved.account === state.accountVersion && saved.revision === state.designRevision && saved.selection === selectionKey(); }
function currentContext(saved = activeContext) { return saved && saved.id === state.simulation?.id && sameSelection(saved) && !invalidReason; }
function stopPolling() {
  pollGeneration += 1;
  clearTimeout(statusTimer); clearInterval(displayTimer);
  statusTimer = null; displayTimer = null; pollBusy = false;
}
function invalidate(reason = '') {
  operationVersion += 1; stopPolling(); activeContext = null; mutationPending = false; syncError = ''; invalidReason = reason;
  state.simulationConfirmed = false;
  if (reason) message('#simulation-message', reason);
  renderSimulation();
}
function observed(item) {
  state.simulation = item;
  state.simulationConfirmed = Boolean(item?.confirmed);
  lastObservedAt = Date.now(); syncError = '';
  renderSimulation();
}
function mostRecentHistory(item) {
  return list(item?.history).reduce((latest, entry) => !latest || Date.parse(entry.at) >= Date.parse(latest.at) ? entry : latest, null);
}
function remainingSeconds(item) {
  if (!item) return 0;
  if (!item.running) return Math.max(0, Number(item.remaining_seconds) || 0);
  const expires = Date.parse(item.expires_at);
  if (Number.isFinite(expires)) return Math.max(0, Math.ceil((expires - Date.now()) / 1000));
  return Math.max(0, Math.ceil((Number(item.remaining_seconds) || 0) - (lastObservedAt ? (Date.now() - lastObservedAt) / 1000 : 0)));
}
function renderCountdown() {
  const node = $('#simulation-countdown'); if (!node) return;
  const item = state.simulation;
  if (!item) { node.textContent = '确认交接后，可设置软件模拟的定时。'; return; }
  if (syncError || invalidReason) { node.textContent = '倒计时暂停显示，等待重新同步或交接。'; return; }
  const seconds = remainingSeconds(item);
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  node.innerHTML = `<strong>${clock}</strong><span>${item.running ? seconds > 0 ? '距软件模拟定时结束' : '等待后台确认停止' : mostRecentHistory(item)?.action === 'auto_stop' ? '定时到期，后台已停止模拟' : item.confirmed ? '开启后开始倒计时' : '等待确认本次模拟'}</span>`;
}
export function renderIntegrationOptions() {
  const previousDesign = $('#integration-design').value;
  const previousSpace = $('#integration-scene').value;
  const options = [{ value: 'current', label: '当前调香案' }, ...state.candidates.map((item, i) => ({ value: String(i), label: `候选 ${i + 1}` })), ...(state.cardDesign ? [{ value: 'card', label: `香笺：${state.cardDesign.name || '未名'}` }] : [])];
  $('#integration-design').innerHTML = options.map(item => `<option value="${item.value}">${escapeHTML(item.label)}</option>`).join('');
  if (options.some(item => item.value === previousDesign)) $('#integration-design').value = previousDesign;
  $('#integration-scene').innerHTML = '<option value="reading">书房 · 仅接受木质主调（模拟假设）</option><option value="lobby">民宿公共区 · 木质 / 香脂主调（模拟假设）</option>';
  if (['reading', 'lobby'].includes(previousSpace)) $('#integration-scene').value = previousSpace;
  if (activeContext && !sameSelection(activeContext)) invalidate('交接对象已变化，请重新提交并确认。');
}
export function logCall(request, response) {
  state.logs.unshift({ time: new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }), request, response }); if (state.logs.length > 12) state.logs.pop(); $('#integration-log').textContent = JSON.stringify(state.logs, null, 2);
}
async function readStatus(generation = pollGeneration) {
  const saved = activeContext;
  if (!currentContext(saved) || pollBusy || generation !== pollGeneration) return;
  pollBusy = true; renderSimulation();
  try {
    const result = await api('/api/simulation', { method: 'POST', body: { action: 'status', simulation_id: saved.id } });
    if (generation !== pollGeneration || !currentContext(saved)) return;
    if (result.simulation?.id !== saved.id) throw new Error('没有收到这次模拟的可核对状态。');
    observed(result.simulation);
  } catch (error) {
    if (generation !== pollGeneration || !currentContext(saved)) return;
    if (error.status === 404) { invalidate('这次软件模拟会话已失效，请重新交接。'); message('#simulation-message', '这次软件模拟会话已失效，请重新交接。'); }
    else { syncError = '暂时无法同步；保留上次记录，不能确认当前状态。'; renderSimulation(); }
  } finally {
    if (generation === pollGeneration) {
      pollBusy = false; renderSimulation();
      if (currentContext(saved) && document.visibilityState !== 'hidden') statusTimer = setTimeout(() => readStatus(generation), 2000);
    }
  }
}
function startPolling(immediate = false) {
  stopPolling();
  if (!currentContext() || document.visibilityState === 'hidden') return;
  const generation = pollGeneration;
  displayTimer = setInterval(() => { if (currentContext()) renderCountdown(); else stopPolling(); }, 1000);
  statusTimer = setTimeout(() => readStatus(generation), immediate ? 0 : 2000);
}
export async function handoff(button) {
  const saved = selectionSnapshot();
  const operation = ++operationVersion;
  stopPolling(); activeContext = null; state.simulationConfirmed = false; syncError = ''; invalidReason = '正在交接新的方案。'; mutationPending = true;
  message('#simulation-message', '');
  renderSimulation();
  await busy(button, '正在交接…', async () => {
    try {
      const choice = $('#integration-design').value;
      let design = choice === 'card' && state.cardDesign ? structuredClone(state.cardDesign) : null;
      if (!design) {
        const components = choice === 'current' ? state.components : state.candidates[Number(choice)]?.components || [];
        const result = await api('/api/evaluate', { method: 'POST', body: currentPayload(components) });
        if (operation !== operationVersion || !sameSelection(saved)) return;
        if (!result.design) throw new Error(describeFailure(result));
        design = result.design;
      }
      const request = { action: 'handoff', design, space_id: $('#integration-scene').value };
      const result = await api('/api/simulation', { method: 'POST', body: request });
      if (operation !== operationVersion || !sameSelection(saved)) return;
      logCall(request, result);
      const accepted = result.status === 'accepted' && result.simulation?.id;
      invalidReason = ''; state.simulation = accepted ? result.simulation : null;
      activeContext = accepted ? { ...saved, id: result.simulation.id } : null;
      observed(state.simulation);
      $('#handoff-result').innerHTML = `<div class="handoff-status ${accepted ? '' : 'rejected'}"><h3>${accepted ? '模拟空间接受这份设计' : '模拟空间暂不接受'}</h3><p>${escapeHTML(result.reason || (accepted ? '符合本演示的模拟兼容规则。' : '请查看场景支持的主家族。'))}</p>${accepted ? '<button type="button" class="button secondary" data-action="confirm-simulation">确认这次模拟使用</button>' : '<button type="button" class="text-button" data-go="studio">返回案头调整 →</button>'}<p class="fine-note">接受只说明符合模拟规则；计时和控制都发生在软件中，没有连接实物。</p></div>`;
    } catch (error) {
      if (operation !== operationVersion || !sameSelection(saved)) return;
      invalidReason = '交接没有完成，请重新提交。'; message('#simulation-message', error.message, 'danger');
    } finally { if (operation === operationVersion) mutationPending = false; }
  });
  if (operation === operationVersion) { renderSimulation(); startPolling(); }
}
export function renderSimulation() {
  const item = state.simulation;
  const label = !item ? '等待方案交接' : invalidReason ? `${invalidReason} 上次记录：${item.running ? '模拟运行中' : '模拟未运行'}` : syncError ? `无法同步；上次记录为${item.running ? '模拟运行中' : '模拟未运行'}` : !item.confirmed ? '等待你确认本次模拟' : item.running ? '软件模拟运行中' : mostRecentHistory(item)?.action === 'auto_stop' ? '定时到期，后台已停止软件模拟' : '软件模拟未运行';
  $('#simulation-state').innerHTML = `<span class="device-dot ${item?.running && !syncError && !invalidReason ? 'on' : ''}"></span><span>${escapeHTML(label)}${item?.timer_minutes ? `<br><small>软件定时 ${escapeHTML(item.timer_minutes)} 分钟</small>` : ''}</span>`;
  const enabled = currentContext() && item?.confirmed && state.simulationConfirmed && !mutationPending && !syncError;
  for (const id of ['#simulation-on', '#simulation-off', '#simulation-timer']) $(id).disabled = !enabled;
  if ($('#refresh-simulation')) $('#refresh-simulation').disabled = !currentContext() || mutationPending || pollBusy;
  if ($('#simulation-sync')) $('#simulation-sync').textContent = syncError || (lastObservedAt && item ? `上次同步 ${new Date(lastObservedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} · 软件模拟` : '尚未收到软件模拟状态。');
  renderCountdown();
}
export async function confirmSimulation(button) {
  const saved = activeContext;
  if (!currentContext(saved) || mutationPending) return;
  const operation = ++operationVersion; stopPolling(); mutationPending = true; renderSimulation();
  await busy(button, '正在确认…', async () => {
    try {
      const request = { action: 'confirm', simulation_id: saved.id };
      const result = await api('/api/simulation', { method: 'POST', body: request });
      if (operation !== operationVersion || !currentContext(saved)) return;
      if (result.simulation?.id !== saved.id || result.simulation.confirmed !== true) throw new Error('后台尚未确认这次软件模拟，请重试。');
      logCall(request, result); observed(result.simulation); message('#simulation-message', '本次软件模拟已由后台确认，可以开启或设置定时。', 'success');
    } catch (error) {
      if (operation === operationVersion && currentContext(saved)) {
        if (!error.status || error.status >= 500) syncError = '暂时无法同步；保留上次记录，不能确认当前状态。';
        message('#simulation-message', error.message, 'danger');
      }
    }
    finally { if (operation === operationVersion) mutationPending = false; }
  });
  renderSimulation();
  if (operation === operationVersion && currentContext(saved)) { if (state.simulation?.confirmed) { button.disabled = true; button.textContent = '已确认本次软件模拟'; } startPolling(); }
}
export async function controlSimulation(action, button) {
  const saved = activeContext;
  if (!currentContext(saved)) { invalidate('交接对象已变化，请重新交接并确认。'); return; }
  if (!state.simulation?.confirmed || !state.simulationConfirmed || mutationPending) return;
  const operation = ++operationVersion; stopPolling(); mutationPending = true; renderSimulation();
  await busy(button, '操作中…', async () => {
    let sent = false;
    try {
      const request = { action, simulation_id: saved.id };
      if (action === 'set_timer') { const minutes = Number($('#simulation-duration').value); if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw new Error('请填写 1 至 120 之间的整数分钟数。'); request.timer_minutes = minutes; }
      sent = true;
      const result = await api('/api/simulation', { method: 'POST', body: request });
      if (operation !== operationVersion || !currentContext(saved)) return;
      if (result.simulation?.id !== saved.id) throw new Error('没有收到这次模拟的可核对状态。');
      logCall(request, result); observed(result.simulation); message('#simulation-message', '后台已更新这次软件模拟的状态。', 'success');
    } catch (error) {
      if (operation === operationVersion && currentContext(saved)) {
        if (sent && (!error.status || error.status >= 500)) syncError = '暂时无法同步；保留上次记录，不能确认当前状态。';
        message('#simulation-message', error.message, 'danger');
      }
    }
    finally { if (operation === operationVersion) mutationPending = false; }
  });
  renderSimulation();
  if (operation === operationVersion && currentContext(saved)) startPolling();
}
export function setupSimulation() {
  if (initialized) return;
  initialized = true;
  $('#refresh-simulation')?.addEventListener('click', () => { if (currentContext()) { stopPolling(); startPolling(true); } });
  document.addEventListener('account:cleared', () => { invalidate(); lastObservedAt = null; message('#simulation-message', ''); renderSimulation(); });
  document.addEventListener('account:changed', () => { if (activeContext && !sameSelection(activeContext)) invalidate('账号已变化，请重新交接。'); });
  document.addEventListener('design:changed', () => { if (state.simulation) { invalidate('案头已调整，请重新交接并确认。'); message('#simulation-message', '案头改动已取消本页操作确认，后台上次的软件模拟状态未被改写。'); } });
  document.addEventListener('change', event => { if (['integration-design', 'integration-scene'].includes(event.target.id) && state.simulation) invalidate('交接对象已变化，请重新提交并确认。'); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') stopPolling(); else startPolling(true); });
  window.addEventListener('pagehide', stopPolling);
  window.addEventListener('pageshow', () => { if (activeContext) startPolling(true); });
}
