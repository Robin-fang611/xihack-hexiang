'use strict';

// No dependencies are installed. The Python runner starts a disposable server.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const round = Number(process.env.XIHA_QA_ROUND);
const base = process.env.XIHA_QA_BASE;
const output = process.env.XIHA_QA_OUTPUT;
const checks = [];
const behavior = [];
const errors = [];
let browser;
let currentPage;
let stage = 'configuration';

function checked(id, description, details = {}) {
  checks.push({ id, description, passed: true, ...details });
  console.log(JSON.stringify({ id, passed: true }));
}
function artifact(description, name) {
  behavior.push({ description, path: path.join(output, name) });
}
async function screenshot(page, name, description) {
  await page.screenshot({ path: path.join(output, name), fullPage: true });
  artifact(description, name);
}
async function frames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function goHome(page) {
  await page.locator('#page-hall .hall-door.door-experience').waitFor({ state: 'visible' });
  await page.locator('#experience-nav [data-page="home"]').click();
  await page.locator('#page-home').waitFor({ state: 'visible' });
  await page.locator('#home-presets [data-action="use-preset"]').first().waitFor({ state: 'visible' });
}
async function go(page, name) {
  const creatorPages = ['manage', 'workbench', 'works'];
  const scope = creatorPages.includes(name) ? '#creator-nav' : '#experience-nav';
  await page.locator(`${scope} [data-page="${name}"]`).click();
  await page.locator(`#page-${name}`).waitFor({ state: 'visible' });
  await frames(page);
}
async function showAdjustments(page) {
  const opened = await page.locator('#studio-adjustments').evaluate(node => node.open);
  if (!opened) await page.locator('#studio-adjustments > summary').click();
}
async function usePreset(page, index) {
  await go(page, 'home');
  await page.locator(`#home-presets [data-action="use-preset"][data-index="${index}"]`).click();
  await page.locator('#page-studio').waitFor({ state: 'visible' });
  await frames(page);
}
async function generate(page, expected = 'ok') {
  const response = page.waitForResponse(item => new URL(item.url()).pathname === '/api/compose' && item.request().method() === 'POST');
  await page.locator('#generate-design').click();
  const result = await response;
  assert.equal(result.status(), 200);
  const body = await result.json();
  assert.equal(body.status, expected);
  await page.waitForFunction(() => !document.querySelector('#generate-design').disabled);
  await page.locator('#candidates-section').waitFor({ state: 'visible' });
  return body;
}
async function responseFor(page, endpoint, work, expectedStatus = 200, method = 'POST') {
  const waiting = page.waitForResponse(item => new URL(item.url()).pathname === endpoint && item.request().method() === method);
  await work();
  const response = await waiting;
  assert.equal(response.status(), expectedStatus, endpoint + ' returned an unexpected HTTP status');
  return { data: await response.json(), request: response.request().postDataJSON() };
}
async function getAPI(page, endpoint) {
  return page.evaluate(async endpoint => {
    const response = await fetch(endpoint);
    return { status: response.status, data: await response.json() };
  }, endpoint);
}
async function authenticateUser(page, credentials, register = true, role = 'user') {
  await page.locator('#account-area [data-action="login"], #account-area #open-auth').click();
  await page.locator(`#auth-dialog [data-auth-mode="${register ? 'register' : 'login'}"]`).click();
  await page.locator('#auth-username').fill(credentials.username);
  await page.locator('#auth-password').fill(credentials.password);
  const response = await responseFor(page, register ? '/api/register' : '/api/login', () => page.locator('#auth-submit').click());
  assert.equal(response.data.user.role, role);
  await page.locator('#auth-dialog').waitFor({ state: 'hidden' });
  return response.data.user;
}
async function apiJSON(page, endpoint, payload) {
  return page.evaluate(async ({ endpoint, payload }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token }, body: JSON.stringify(payload) });
    return { status: response.status, data: await response.json() };
  }, { endpoint, payload });
}
async function conditions(page) {
  return page.evaluate(() => ({
    preferred: [...document.querySelectorAll('[data-action="toggle-facet"][data-group="preferred"][aria-pressed="true"]')].map(node => node.dataset.key).sort(),
    deemphasized: [...document.querySelectorAll('[data-action="toggle-facet"][data-group="deemphasized"][aria-pressed="true"]')].map(node => node.dataset.key).sort(),
    excluded: [...document.querySelectorAll('[data-exclude]:checked')].map(node => node.dataset.exclude).sort(),
  }));
}
function compositionSignature(result) {
  return result.candidates.map(candidate => candidate.components.map(item => item.role + ':' + item.profile_id).sort().join('|')).sort();
}
function inspectPNG(filename) {
  const data = fs.readFileSync(filename);
  assert.deepEqual(data.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.ok(data.length > 1000);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), bytes: data.length };
}

async function roundOne() {
  const mobile = [];
  let page;
  let boot;
  for (const width of [390, 360]) {
    stage = `R1 mobile action distance ${width}`;
    const context = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce', acceptDownloads: true });
    page = await context.newPage();
    currentPage = page;
    page.on('pageerror', error => errors.push({ stage, message: error.message }));
    page.setDefaultTimeout(12000);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await goHome(page);
    boot = await page.evaluate(async () => (await fetch('/api/bootstrap')).json());
    await usePreset(page, 0);
    const metrics = await page.evaluate(() => {
      const position = selector => document.querySelector(selector).getBoundingClientRect().top + scrollY;
      return { width: innerWidth, generate_top: Math.round(position('#generate-design')),
        composition_top: position('.composition-panel'), palette_top: position('.palette-panel'),
        document_width: document.documentElement.scrollWidth,
        words_inside_details: Boolean(document.querySelector('#design-words').closest('details')),
        adjustments_open: document.querySelector('#studio-adjustments').open };
    });
    assert.ok(metrics.generate_top <= 1330, `Generate at ${metrics.generate_top}px; target is <=1330px (baseline 2218px)`);
    assert.ok(metrics.composition_top < metrics.palette_top, 'Mobile composition must appear before the material palette');
    assert.ok(metrics.document_width <= width + 1, 'Mobile page has horizontal overflow');
    assert.equal(metrics.words_inside_details, false, 'User words must remain in the main path');
    assert.equal(metrics.adjustments_open, false, 'Secondary adjustments must begin folded');
    metrics.baseline_top = 2218;
    metrics.reduction_percent = Math.round((1 - metrics.generate_top / 2218) * 10000) / 100;
    mobile.push(metrics);
    await screenshot(page, `r1-mobile-${width}.png`, `${width}px actual composition and generation position`);
    if (width === 390) await context.close();
  }
  checked('r1-mobile-main-path', '360/390px primary composition precedes materials, user words stay visible, generation distance improves by at least 40%', { measurements: mobile });

  stage = 'R1 explicit exclusions stay visible while folded';
  await showAdjustments(page);
  const excluded = boot.profiles.find(item => item.id === 'F05');
  const excludedName = excluded.name.replace(/ (Givaudan|IFF|dsm).*$/, '');
  await page.locator('[data-exclude="F05"]').check();
  assert.match(await page.locator('#studio-adjustments-summary').innerText(), /排除\s*1\s*味/, 'Folded summary must update its selected exclusion count');
  await page.locator('#studio-adjustments > summary').click();
  assert.equal(await page.locator('#studio-adjustments').evaluate(node => node.open), false);
  assert.ok((await page.locator('#studio-constraints').innerText()).includes(excludedName), 'Explicit exclusion is invisible outside the folded details');
  await usePreset(page, 2);
  assert.equal(await page.locator('[data-exclude="F05"]').isChecked(), true, 'Preset canceled explicit exclusion');
  assert.equal(await page.locator('#slot-main .slot-material').count(), 0, 'Conflicting preset inserted an excluded main');
  assert.ok((await page.locator('#studio-constraints').innerText()).includes(excludedName));
  await screenshot(page, 'r1-folded-exclusion.png', 'Folded adjustments and conflicting preset retain explicit exclusion');
  checked('r1-folded-exclusions', 'Summary and always visible constraint text preserve excluded material across a conflicting preset');

  stage = 'R1 direct assignment and keyboard';
  const controls = await page.locator('#profile-palette [data-action="assign-material"]').evaluateAll(nodes => nodes.map(node => {
    const bounds = node.getBoundingClientRect();
    return { id: node.dataset.id, role: node.dataset.role, width: bounds.width, height: bounds.height, tag: node.tagName };
  }));
  assert.equal(controls.length, boot.profiles.length * 3, 'Each material requires three direct role controls');
  for (const control of controls) {
    assert.equal(control.tag, 'BUTTON', 'Role assignment must be a keyboard accessible native control');
    assert.ok(control.width >= 44 && control.height >= 44, 'Mobile role target must be at least 44px: ' + JSON.stringify(control));
  }
  await page.locator('[data-action="assign-material"][data-id="F01"][data-role="main"]').click();
  assert.ok((await page.locator('#slot-main').innerText()).includes(boot.profiles.find(item => item.id === 'F01').name));
  const beforeKeyboard = await page.locator('#slot-support').innerText();
  const keyboard = page.locator('[data-action="assign-material"][data-id="F03"][data-role="support"]');
  await keyboard.focus();
  await page.keyboard.press('Enter');
  assert.ok((await page.locator('#slot-support').innerText()).includes(boot.profiles.find(item => item.id === 'F03').name));
  await page.locator('#undo-design').click();
  assert.equal(await page.locator('#slot-support').innerText(), beforeKeyboard, 'Undo must restore the state before keyboard assignment');
  checked('r1-direct-and-keyboard', 'Every material exposes 44px main/support/accent buttons; mouse and native Enter assign roles, undo restores composition', { controls });

  stage = 'R1 evidence based candidate descriptions';
  await showAdjustments(page);
  await page.locator('[data-exclude="F05"]').uncheck();
  await usePreset(page, 0);
  const normal = await generate(page);
  assert.equal(normal.candidates.length, 2);
  const titles = await page.locator('#candidate-results .candidate-card h3').allTextContents();
  assert.equal(titles.length, 2);
  assert.notEqual(titles[0], titles[1], 'Candidate titles must reflect their actual differences');
  for (const title of titles) assert.doesNotMatch(title, /^(第一份构图|另一种表达)$/);
  const explanations = await page.locator('#candidate-results .candidate-explanation').allTextContents();
  assert.equal(explanations.length, 2, 'Each candidate needs a visible source based explanation');
  for (let index = 0; index < normal.candidates.length; index += 1) {
    const candidate = normal.candidates[index];
    const reported = candidate.components.flatMap(item => item.reported_facets || []);
    assert.ok(reported.some(key => explanations[index].includes(boot.facets[key] || key)), 'Explanation must use a tag reported by its actual material');
    assert.match(explanations[index], /资料|报道|标签/);
  }
  assert.notEqual(explanations[0], explanations[1], 'Two different compositions cannot reuse the same explanation');
  await screenshot(page, 'r1-candidate-differences.png', 'Actual two candidate titles, material roles, and reported-label explanations');
  checked('r1-candidate-explanations', 'Two candidates expose different meaningful titles and explanations grounded in their own reported facets', { titles, explanations });

  stage = 'R1 single supported reference can export';
  await usePreset(page, 1);
  await showAdjustments(page);
  const active = await page.locator('[data-action="toggle-facet"][data-group="preferred"][aria-pressed="true"]').evaluateAll(nodes => nodes.map(node => node.dataset.key));
  for (const key of active) await page.locator(`[data-action="toggle-facet"][data-group="preferred"][data-key="${key}"]`).click();
  await page.locator('[data-action="toggle-facet"][data-group="preferred"][data-key="woody"]').click();
  for (const item of boot.profiles.filter(item => item.id !== 'F01')) await page.locator(`[data-exclude="${item.id}"]`).check();
  const single = await generate(page, 'single_reference_only');
  assert.equal(single.candidates.length, 1);
  assert.equal(await page.locator('#candidate-results .candidate-card').count(), 1);
  assert.match(await page.locator('#studio-message').innerText(), /一|单/);
  await page.locator('#candidate-results [data-action="candidate-card"]').click();
  await page.locator('#card-dialog').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#card-preview').innerText()).includes(boot.profiles.find(item => item.id === 'F01').name));
  await screenshot(page, 'r1-single-reference-card.png', 'One legal supported reference reaches the actual scent card preview');
  const waiting = page.waitForEvent('download');
  await page.locator('#download-card').click();
  const download = await waiting;
  assert.equal(await download.failure(), null);
  const filename = path.join(output, 'r1-single-reference.png');
  await download.saveAs(filename);
  const png = inspectPNG(filename);
  artifact('Actual PNG export from the constrained single reference', 'r1-single-reference.png');
  checked('r1-single-reference-export', 'A one-material constrained result remains selectable and produces an actual valid PNG', { png });
  assert.deepEqual(errors, [], 'Browser script errors were recorded');
  checked('r1-browser-errors', 'No browser pageerror in either mobile viewport');
}

async function roundTwo() {
  stage = 'R2 interpreted text API';
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  currentPage = page;
  page.on('pageerror', error => errors.push({ stage, message: error.message }));
  page.setDefaultTimeout(12000);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await goHome(page);
  await go(page, 'studio');
  const responses = [];
  const interpretAPI = async (text, manual = {}) => {
    const request = { user_notes: text, manual_preferred: [], manual_deemphasized: [], excluded_ids: [], ...manual };
    const result = await apiJSON(page, '/api/interpret', request);
    assert.equal(result.status, 200);
    responses.push({ request, response: result.data });
    return result.data;
  };
  const textA = '喜欢木质，甜香少一点，不要丁香';
  const textB = '喜欢甜香，木质少一点';
  const first = await interpretAPI(textA);
  const opposite = await interpretAPI(textB);
  assert.equal(first.status, 'proposal');
  assert.equal(opposite.status, 'proposal');
  assert.deepEqual(first.proposal.preferred_facets, ['woody']);
  assert.deepEqual(first.proposal.deemphasized_facets, ['sweet']);
  assert.deepEqual(first.proposal.excluded_ids, ['F05']);
  assert.deepEqual(opposite.proposal.preferred_facets, ['sweet']);
  assert.deepEqual(opposite.proposal.deemphasized_facets, ['woody']);
  assert.ok(first.recognized.some(item => item.profile_id === 'F05' && item.action === 'exclude'));
  for (const item of [...first.recognized, ...opposite.recognized]) {
    assert.equal(item.basis, 'explicit_user_expression');
    assert.ok(item.text && ['prefer', 'deemphasize', 'exclude'].includes(item.action));
  }
  const candidatesA = await apiJSON(page, '/api/compose', { ...first.proposal, limit: 2 });
  const candidatesB = await apiJSON(page, '/api/compose', { ...opposite.proposal, excluded_ids: ['F05'], limit: 2 });
  assert.equal(candidatesA.data.status, 'ok');
  assert.equal(candidatesB.data.status, 'ok');
  assert.notDeepEqual(compositionSignature(candidatesA.data), compositionSignature(candidatesB.data), 'Opposite user words must produce different actual candidates');
  assert.ok(candidatesA.data.candidates.every(candidate => candidate.components.every(item => item.profile_id !== 'F05')));
  checked('r2-text-changes-real-candidates', 'Opposite explicit user statements become opposite conditions and different actual candidate compositions; explicit no-clove excludes F05',
    { first: first.proposal, opposite: opposite.proposal, signatures: [compositionSignature(candidatesA.data), compositionSignature(candidatesB.data)] });

  stage = 'R2 ambiguity and manual conflict API';
  const manual = await interpretAPI('不喜欢木质', { manual_preferred: ['woody'], excluded_ids: ['F05'] });
  assert.equal(manual.status, 'needs_confirmation');
  assert.ok(manual.conflicts.some(item => item.kind === 'manual_text_conflict' && item.facet === 'woody'));
  assert.ok(manual.proposal.preferred_facets.includes('woody'), 'Interpretation silently replaced manual preference');
  assert.ok(manual.proposal.excluded_ids.includes('F05'));
  const contradictory = await interpretAPI('喜欢木质，但不喜欢木质');
  assert.equal(contradictory.status, 'needs_confirmation');
  assert.ok(contradictory.conflicts.some(item => item.kind === 'text_contradiction' && item.facet === 'woody'));
  assert.ok(!contradictory.proposal.preferred_facets.includes('woody') && !contradictory.proposal.deemphasized_facets.includes('woody'), 'Contradictory text must not choose one side silently');
  for (const text of ['木质好吗？', '不讨厌木质', '想要助眠、书房、雨后清透']) {
    const unknown = await interpretAPI(text);
    assert.equal(unknown.status, 'no_changes', 'Uncertain text was guessed: ' + text);
    assert.equal(unknown.recognized.length, 0);
    assert.deepEqual(unknown.proposal.preferred_facets, []);
    assert.deepEqual(unknown.proposal.deemphasized_facets, []);
    assert.ok(unknown.unknown_segments.length > 0, 'Unmapped text needs an honest boundary');
  }
  fs.writeFileSync(path.join(output, 'r2-intent-responses.json'), JSON.stringify(responses, null, 2) + '\n');
  artifact('Actual HTTP interpretation requests, explicit recognitions, unknown text and manual/self-conflict responses', 'r2-intent-responses.json');
  checked('r2-ambiguity-and-conflict-boundaries', 'Manual choices and exclusions remain intact until resolution; contradictory words require confirmation and unknown questions/scenes/effects stay unmapped');

  stage = 'R2 preview requires explicit application';
  const before = await conditions(page);
  await page.locator('#design-words').fill(textA);
  const previewA = await responseFor(page, '/api/interpret', () => page.locator('#interpret-words').click());
  assert.equal(previewA.data.status, 'proposal');
  await page.locator('#intent-preview').waitFor({ state: 'visible' });
  assert.deepEqual(await conditions(page), before, 'Preview must not apply conditions automatically');
  assert.ok((await page.locator('#intent-preview').innerText()).includes('丁香'));
  await screenshot(page, 'r2-proposal-before-apply.png', 'Interpreted text is shown as an unapplied proposal');
  await page.locator('#apply-intent').click();
  await frames(page);
  const appliedA = await conditions(page);
  assert.deepEqual(appliedA, { preferred: ['woody'], deemphasized: ['sweet'], excluded: ['F05'] });
  await page.locator('#lock-main').uncheck();
  const actualA = await generate(page);
  assert.ok(actualA.candidates.every(candidate => candidate.components.every(item => item.profile_id !== 'F05')));
  checked('r2-preview-before-apply', 'The proposal leaves current conditions unchanged until an actual apply click, then the browser uses its exclusion during generation');

  stage = 'R2 conflict resolutions in actual UI';
  await page.locator('#design-words').fill(textB);
  const conflict = await responseFor(page, '/api/interpret', () => page.locator('#interpret-words').click());
  assert.equal(conflict.data.status, 'needs_confirmation');
  assert.deepEqual(await conditions(page), appliedA, 'Conflict preview overwrote manual conditions');
  await page.locator('#intent-resolution').selectOption('current');
  await frames(page);
  assert.deepEqual(await conditions(page), appliedA, 'Current resolution must retain actual manual choices');
  assert.equal(await page.locator('#apply-intent').isEnabled(), false, 'An unchanged current resolution must not apply redundant conditions');
  await page.locator('#intent-resolution').selectOption('text');
  await screenshot(page, 'r2-explicit-conflict-resolution.png', 'Actual manual-versus-text conflict with an explicit text resolution selection');
  await page.locator('#apply-intent').click();
  await frames(page);
  const appliedB = await conditions(page);
  assert.deepEqual(appliedB, { preferred: ['sweet'], deemphasized: ['woody'], excluded: ['F05'] });
  const actualB = await generate(page);
  assert.notDeepEqual(compositionSignature(actualA), compositionSignature(actualB), 'The actual two UI decisions must alter candidates');
  checked('r2-ui-current-and-text-resolution', 'Actual current/text selection either keeps manual choices or adopts opposite text, preserves exclusions, and changes generated candidate signatures',
    { current: appliedA, text: appliedB, signatures: [compositionSignature(actualA), compositionSignature(actualB)] });

  stage = 'R2 changed text invalidates preview';
  assert.match(await page.locator('#studio-message').innerText(), /已.*(?:2|两).*候选/);
  await page.locator('#design-words').fill('喜欢柑橘');
  assert.equal(await page.locator('#candidates-section').isVisible(), false, 'Changed words retained obsolete candidates');
  assert.equal(await page.locator('#studio-message').textContent(), '', 'Changed words retained the obsolete success notice');
  checked('r2-stale-success-feedback-cleared', 'After real successful generation, editing words clears both obsolete candidates and their old success feedback');
  await responseFor(page, '/api/interpret', () => page.locator('#interpret-words').click());
  await page.locator('#apply-intent').waitFor({ state: 'visible' });
  const beforeEdit = await conditions(page);
  await page.locator('#design-words').fill('木质好吗？');
  await frames(page);
  const usable = await page.locator('#apply-intent').count() > 0 && await page.locator('#apply-intent').isVisible() && await page.locator('#apply-intent').isEnabled();
  assert.equal(usable, false, 'Changing text left an old proposal applicable');
  assert.deepEqual(await conditions(page), beforeEdit);
  await responseFor(page, '/api/interpret', () => page.locator('#interpret-words').click());
  assert.deepEqual(await conditions(page), beforeEdit, 'An unknown question silently changed conditions');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, 'r2-mobile-unmapped-question.png', '390px actual unmapped-question feedback without guessing or auto-application');
  checked('r2-proposal-invalidated-by-edits', 'Editing words invalidates the old apply action; interpreting a question cannot rewrite actual selected conditions');
  assert.deepEqual(errors, []);
  checked('r2-browser-errors', 'No browser script errors in explicit proposal and conflict flows');
}

async function roundThree() {
  const prefix = 'hexiang:draft:v1:';
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
  await context.addInitScript(() => {
    const original = CanvasRenderingContext2D.prototype.fillText;
    window.__QA_DRAWN_TEXT__ = [];
    CanvasRenderingContext2D.prototype.fillText = function(text, ...arguments_) {
      window.__QA_DRAWN_TEXT__.push({ text: String(text), width: this.canvas.width, height: this.canvas.height });
      return original.call(this, text, ...arguments_);
    };
  });
  const page = await context.newPage();
  currentPage = page;
  page.on('pageerror', error => errors.push({ stage, message: error.message }));
  page.setDefaultTimeout(12000);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await goHome(page);
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const accountA = { username: 'qa_r3_a_' + suffix, password: 'QaR3-Only-A-' + suffix };
  const accountB = { username: 'qa_r3_b_' + suffix, password: 'QaR3-Only-B-' + suffix };
  const user = await authenticateUser(page, accountA);
  const key = prefix + 'user:' + user.id;
  const readDraft = () => page.evaluate(key => {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, key);

  stage = 'R3 draft retains actual input and excludes derived state';
  await usePreset(page, 0);
  await page.locator('[data-action="assign-material"][data-id="F01"][data-role="main"]').click();
  await showAdjustments(page);
  await page.locator('[data-action="toggle-facet"][data-group="deemphasized"][data-key="sweet"]').click();
  await page.locator('[data-exclude="F05"]').check();
  await page.locator('#lock-main').uncheck();
  const scene = '第三轮 · 私人阅读角';
  const words = '  想保留木质，甜香少一点。\n不要丁香。保留这句自己的原话。  ';
  const cardName = '第三轮私笺-' + suffix;
  await page.locator('#design-scene').fill(scene);
  await page.locator('#design-words').fill(words);
  const before = await conditions(page);
  const slots = {};
  for (const role of ['main', 'support', 'accent']) slots[role] = await page.locator('#slot-' + role).innerText();
  await generate(page);
  await page.locator('#save-current-card').click();
  await page.locator('#card-dialog').waitFor({ state: 'visible' });
  await page.locator('#card-name').fill(cardName);
  await page.locator('#card-to-integration').click();
  await page.locator('#integration-scene').selectOption('reading');
  await responseFor(page, '/api/simulation', () => page.locator('#handoff-design').click());
  await page.locator('[data-action="confirm-simulation"]').click();
  await responseFor(page, '/api/simulation', () => page.locator('#simulation-on').click());
  await page.waitForFunction(({ key, name }) => {
    const raw = sessionStorage.getItem(key);
    return raw && JSON.parse(raw).draft?.name === name;
  }, { key, name: cardName });
  const persisted = await readDraft();
  assert.equal(persisted.schema_version, 1);
  assert.equal(persisted.owner, 'user:' + user.id);
  for (const field of ['candidates', 'cardDesign', 'simulation', 'csrf', 'password', 'user']) assert.equal(Object.hasOwn(persisted.draft, field), false, 'Draft persisted an inappropriate derived/private field: ' + field);
  assert.equal(persisted.draft.words, words);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#home-presets [data-action="use-preset"]').first().waitFor({ state: 'attached' });
  await go(page, 'studio');
  assert.deepEqual(await conditions(page), before);
  assert.equal(await page.locator('#design-scene').inputValue(), scene);
  assert.equal(await page.locator('#design-words').inputValue(), words, 'Draft must preserve original whitespace and line breaks');
  assert.equal(await page.locator('#lock-main').isChecked(), false);
  assert.equal(await page.locator('#card-name').inputValue(), cardName);
  for (const role of Object.keys(slots)) assert.equal(await page.locator('#slot-' + role).innerText(), slots[role]);
  assert.equal(await page.locator('#candidates-section').isVisible(), false);
  assert.equal(await page.locator('#card-dialog').isVisible(), false);
  assert.equal(await page.locator('#card-preview').innerText(), '');
  await go(page, 'integration');
  assert.match(await page.locator('#simulation-state').innerText(), /等待方案交接/);
  await go(page, 'studio');
  await screenshot(page, 'r3-restored-draft.png', 'Actual refreshed draft preserves composition, manual conditions, exclusions, words and lock without restoring derived results');
  checked('r3-refresh-restores-only-input', 'Actual refresh retains components, preferences, exclusions, scene, exact words, lock and name; no old candidates/card/simulation are restored', { snapshot: persisted.draft });

  stage = 'R3 explicit save and independent repeated downloads';
  let postDesigns = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/designs' && request.method() === 'POST') postDesigns += 1;
  });
  await page.locator('#save-current-card').click();
  await page.locator('#card-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#card-name').inputValue(), cardName, 'Restored draft name was discarded when opening its card');
  const saved = await responseFor(page, '/api/designs', () => page.locator('#save-card').click(), 201);
  assert.equal(saved.data.saved_existing, false);
  assert.equal((await getAPI(page, '/api/designs')).data.designs.length, 1);
  const duplicate = await apiJSON(page, '/api/designs', saved.request);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.saved_existing, true);
  assert.equal(duplicate.data.design.id, saved.data.design.id);
  assert.equal((await getAPI(page, '/api/designs')).data.designs.length, 1);
  const postsBeforeDownloads = postDesigns;
  const exported = [];
  for (let index = 1; index <= 2; index += 1) {
    await page.evaluate(() => { window.__QA_DRAWN_TEXT__ = []; });
    const waiting = page.waitForEvent('download');
    await page.locator('#download-card').click();
    const download = await waiting;
    assert.equal(await download.failure(), null);
    const filename = path.join(output, `r3-pure-download-${index}.png`);
    await download.saveAs(filename);
    const drawn = await page.evaluate(() => window.__QA_DRAWN_TEXT__);
    assert.ok(drawn.map(item => item.text).join('').includes(cardName), 'Actual Canvas image text did not use the current card name');
    exported.push({ ...inspectPNG(filename), rendered_name: cardName });
    artifact('Actual pure Canvas export without a design save request', `r3-pure-download-${index}.png`);
  }
  assert.equal(postDesigns, postsBeforeDownloads, 'Downloading PNG posted a design unexpectedly');
  assert.equal((await getAPI(page, '/api/designs')).data.designs.length, 1);
  checked('r3-save-deduplicates-download-does-not-save', 'Explicit save creates one owner record; same normalized design returns existing id, and two actual PNG downloads send zero save requests and leave count unchanged', { exported });

  stage = 'R3 save failure cannot prevent actual export';
  const failedName = '只导出未保存-' + suffix;
  await page.locator('#card-name').fill(failedName);
  const saveFailure = async route => {
    if (route.request().method() !== 'POST') return route.continue();
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'QA受控保存失败，原卡仍可导出。', code: 'qa_controlled_save_failure' }) });
  };
  await page.route('**/api/designs', saveFailure);
  const failing = page.waitForResponse(response => new URL(response.url()).pathname === '/api/designs' && response.request().method() === 'POST');
  await page.locator('#save-card').click();
  assert.equal((await failing).status(), 500);
  await page.waitForFunction(() => !document.querySelector('#save-card').disabled);
  assert.ok((await page.locator('#card-preview').innerText()).includes(failedName));
  const beforeFailedExport = postDesigns;
  await page.evaluate(() => { window.__QA_DRAWN_TEXT__ = []; });
  const downloading = page.waitForEvent('download');
  await page.locator('#download-card').click();
  const fallback = await downloading;
  assert.ok(fallback.suggestedFilename().includes(failedName), 'Export used an obsolete name snapshot');
  const fallbackPath = path.join(output, 'r3-export-after-save-failure.png');
  await fallback.saveAs(fallbackPath);
  assert.equal(postDesigns, beforeFailedExport);
  inspectPNG(fallbackPath);
  const drawnAfterFailure = await page.evaluate(() => window.__QA_DRAWN_TEXT__);
  assert.ok(drawnAfterFailure.map(item => item.text).join('').includes(failedName), 'Actual PNG Canvas retained the obsolete saved name');
  fs.writeFileSync(path.join(output, 'r3-exported-canvas-text.json'), JSON.stringify(drawnAfterFailure, null, 2) + '\n');
  artifact('Actual native Canvas fillText calls, forwarded unchanged into the downloaded image, prove the current unsaved card snapshot', 'r3-exported-canvas-text.json');
  artifact('Actual current card PNG still exported after an injected save HTTP 500', 'r3-export-after-save-failure.png');
  await screenshot(page, 'r3-card-after-save-failure.png', 'Actual retained card and save failure feedback with an independent export control');
  await page.unroute('**/api/designs', saveFailure);
  assert.equal((await getAPI(page, '/api/designs')).data.designs.length, 1);
  checked('r3-save-failure-keeps-export', 'Injected save HTTP 500 retains the current named card and actual PNG download works without retrying save');

  stage = 'R3 saved scent card continues in studio';
  await page.locator('#card-dialog .close-dialog').click();
  const currentScene = '待续草稿 · 只看旧作不会采用';
  const currentWords = '当前案头的新原话，不应被查看旧作覆盖';
  const currentName = '另一个案头-' + suffix;
  await go(page, 'studio');
  await page.locator('#design-scene').fill(currentScene);
  await page.locator('#design-words').fill(currentWords);
  await page.locator('[data-action="assign-material"][data-id="F02"][data-role="support"]').click();
  await page.locator('#save-current-card').click();
  await page.locator('#card-dialog').waitFor({ state: 'visible' });
  await page.locator('#card-name').fill(currentName);
  await page.locator('#card-dialog .close-dialog').click();
  await page.waitForFunction(({ key, name }) => JSON.parse(sessionStorage.getItem(key) || '{}').draft?.name === name, { key, name: currentName });
  const currentConditions = await conditions(page);
  await go(page, 'collection');
  const record = page.locator('#saved-designs .record-card').filter({ hasText: cardName });
  await record.locator('[data-action="reopen-design"]').click();
  await page.locator('#card-dialog').waitFor({ state: 'visible' });
  const openedPayload = await page.evaluate(async () => {
    const { state } = await import('/static/modules/core.js');
    return structuredClone(state.cardDesign.evaluation_payload);
  });
  assert.deepEqual(openedPayload.raw_preferences, saved.request.raw_preferences, 'Reopened card lost raw preference input');
  assert.deepEqual(openedPayload.raw_exclusions, saved.request.raw_exclusions, 'Reopened card lost raw exclusion input');
  const reopenedRetry = await apiJSON(page, '/api/designs', openedPayload);
  assert.equal(reopenedRetry.status, 200, 'Replaying the actual reopened payload must reuse the existing record');
  assert.equal(reopenedRetry.data.saved_existing, true);
  assert.equal(reopenedRetry.data.design.id, saved.data.design.id);
  await page.locator('#card-dialog .close-dialog').click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#home-presets [data-action="use-preset"]').first().waitFor({ state: 'attached' });
  await go(page, 'studio');
  assert.equal(await page.locator('#card-name').inputValue(), currentName, 'Merely viewing a saved card polluted current draft name');
  assert.equal(await page.locator('#design-scene').inputValue(), currentScene);
  assert.equal(await page.locator('#design-words').inputValue(), currentWords);
  assert.deepEqual(await conditions(page), currentConditions);
  assert.match(await page.locator('#slot-support').innerText(), /雪松/);
  checked('r3-view-saved-card-does-not-adopt', 'Viewing and closing an old work preserves the differently named current draft through reload; actual reopened payload retains raw fields and deduplicates by server record id');
  await go(page, 'collection');
  await page.locator('#saved-designs .record-card').filter({ hasText: cardName }).locator('[data-action="reopen-design"]').click();
  await page.locator('#card-dialog').waitFor({ state: 'visible' });
  await page.locator('#card-to-studio').click();
  await page.locator('#page-studio').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#card-name').inputValue(), cardName);
  assert.equal(await page.locator('#design-scene').inputValue(), scene);
  assert.equal((await page.locator('#design-words').inputValue()).trim(), words.trim());
  assert.deepEqual(await conditions(page), before);
  assert.equal(await page.locator('#lock-main').isChecked(), false, 'A new saved card must preserve the explicit unlocked main state');
  await page.locator('[data-action="assign-material"][data-id="F02"][data-role="support"]').click();
  assert.match(await page.locator('#slot-support').innerText(), /雪松/);
  assert.equal((await getAPI(page, '/api/designs')).data.designs.length, 1, 'Continue editing must not overwrite saved records');
  await screenshot(page, 'r3-saved-card-continues.png', 'Actual saved card resumes in studio and accepts a new material role without overwriting its saved version');
  checked('r3-saved-card-continues-editing', 'The saved card returns its original conditions, scene, words and name to studio; an actual support assignment edits a new draft');

  stage = 'R3 logout account switch and actual revoked session clear drafts';
  await responseFor(page, '/api/logout', () => page.locator('#account-area [data-action="logout"]').click());
  await page.locator('#account-area [data-action="login"]').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).length, prefix), 0);
  assert.equal(await page.locator('#design-words').inputValue(), '');
  assert.ok(!(await page.locator('#draft-status').textContent()).includes(cardName));
  await authenticateUser(page, accountB);
  assert.equal((await getAPI(page, '/api/designs')).data.designs.length, 0);
  const separateOwner = await apiJSON(page, '/api/designs', saved.request);
  assert.equal(separateOwner.status, 201, 'Deduplication must not reuse another owner\'s saved record');
  assert.equal(separateOwner.data.saved_existing, false);
  assert.notEqual(separateOwner.data.design.id, saved.data.design.id);
  assert.equal((await getAPI(page, '/api/designs')).data.designs.length, 1);
  assert.equal(await page.locator('#design-words').inputValue(), '');
  await go(page, 'studio');
  await page.locator('#design-words').fill('第二个账号的私人原话，仅临时测试');
  await page.waitForFunction(prefix => Object.keys(sessionStorage).some(key => key.startsWith(prefix)), prefix);
  // Revoke the actual HTTP session separately while UI still believes it is logged in.
  assert.equal((await apiJSON(page, '/api/logout', {})).status, 200);
  await go(page, 'collection');
  await page.locator('#account-area [data-action="login"]').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(prefix => Object.keys(sessionStorage).filter(key => key.startsWith(prefix)).length, prefix), 0);
  assert.equal(await page.locator('#design-words').inputValue(), '');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#home-presets [data-action="use-preset"]').first().waitFor({ state: 'attached' });
  assert.equal(await page.locator('#design-words').inputValue(), '');
  checked('r3-account-boundary-clears-storage', 'Actual UI logout, account switch, and a real server-revoked session 401 clear private words and storage; reload cannot revive old drafts');

  stage = 'R3 malformed persisted inputs are rejected together';
  const malformed = { ...persisted, owner: 'anonymous', draft: { ...persisted.draft,
    components: [{ profile_id: 'F01', role: 'main' }, { profile_id: 'QA_INVALID_PROFILE', role: 'support' }],
    excluded: ['F05', 'QA_UNKNOWN_EXCLUSION'], words: '不得局部恢复的损坏草稿' } };
  const malformedRaw = JSON.stringify(malformed);
  await page.evaluate(({ key, raw }) => sessionStorage.setItem(key, raw), { key: prefix + 'anonymous', raw: malformedRaw });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#home-presets [data-action="use-preset"]').first().waitFor({ state: 'attached' });
  await go(page, 'studio');
  assert.equal(await page.locator('#role-slots .slot-material').count(), 0);
  assert.equal(await page.locator('#design-words').inputValue(), '');
  assert.ok(await page.locator('#draft-status').isVisible(), 'Malformed draft needs visible recovery feedback');
  assert.match(await page.locator('#draft-status').innerText(), /草稿|恢复|载入|排除|错误/);
  assert.equal(await page.evaluate(key => sessionStorage.getItem(key), prefix + 'anonymous'), malformedRaw, 'Rejected draft and its exclusions were silently overwritten');
  await screenshot(page, 'r3-rejected-invalid-draft.png', 'Actual invalid material/exclusion draft is rejected as a whole with visible feedback and retained raw recovery data');
  checked('r3-malformed-draft-no-partial-injection', 'Unknown profile and exclusion cause whole draft rejection; no illegal material or private words are injected, and the original stored exclusion data is preserved with visible feedback');

  stage = 'R3 mobile primary path retains previous improvement';
  const metrics = [];
  for (const width of [360, 390]) {
    const mobileContext = await browser.newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
    const mobilePage = await mobileContext.newPage();
    currentPage = mobilePage;
    mobilePage.on('pageerror', error => errors.push({ stage, message: error.message }));
    await mobilePage.goto(base, { waitUntil: 'domcontentloaded' });
    await goHome(mobilePage);
    await usePreset(mobilePage, 0);
    const top = await mobilePage.locator('#generate-design').evaluate(node => node.getBoundingClientRect().top + scrollY);
    assert.ok(top <= 1330, `${width}px new draft flow pushed generation to ${top}px`);
    metrics.push({ width, generate_top: top });
    await screenshot(mobilePage, `r3-mobile-${width}.png`, `${width}px fresh draft retains the primary action distance improvement`);
    await mobileContext.close();
  }
  checked('r3-mobile-primary-action-preserved', '360/390px fresh draft generation stays within 1330px despite new recovery/save capabilities', { metrics });
  assert.deepEqual(errors, []);
  checked('r3-browser-errors', 'No browser script errors across refresh, pure export, save failure, account changes, invalid storage and mobile layouts');
}

async function roundFour() {
  stage = 'R4 server owned confirmation and scope';
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  currentPage = page;
  page.on('pageerror', error => errors.push({ stage, message: error.message }));
  page.setDefaultTimeout(12000);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await goHome(page);
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const credentials = { username: 'qa_r4_owner_' + suffix, password: 'QaR4-Owner-' + suffix };
  await authenticateUser(page, credentials);
  await usePreset(page, 0);
  await go(page, 'integration');
  await page.locator('#integration-design').selectOption('current');
  await page.locator('#integration-scene').selectOption('reading');
  const first = await responseFor(page, '/api/simulation', () => page.locator('#handoff-design').click());
  const oldId = first.data.simulation.id;
  for (const action of ['start', 'set_timer']) {
    const rejected = await apiJSON(page, '/api/simulation', { action, simulation_id: oldId, timer_minutes: 1 });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.data.code, 'simulation_confirmation_required');
  }
  const confirmation = await responseFor(page, '/api/simulation', () => page.locator('[data-action="confirm-simulation"]').click());
  assert.equal(confirmation.request.action, 'confirm', 'User confirmation must reach the server');
  assert.equal(confirmation.data.simulation.confirmed, true);
  const invalid = [];
  for (const minutes of [1.9, true, '5', 0, 121]) {
    const rejected = await apiJSON(page, '/api/simulation', { action: 'set_timer', simulation_id: oldId, timer_minutes: minutes });
    assert.equal(rejected.status, 400, 'Invalid timer accepted: ' + JSON.stringify(minutes));
    assert.equal(rejected.data.code, 'invalid_timer');
    invalid.push({ value: minutes, status: rejected.status, code: rejected.data.code });
  }
  const foreignContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const foreignPage = await foreignContext.newPage();
  await foreignPage.goto(base, { waitUntil: 'domcontentloaded' });
  await goHome(foreignPage);
  await authenticateUser(foreignPage, { username: 'qa_r4_other_' + suffix, password: 'QaR4-Other-' + suffix });
  const forbidden = await apiJSON(foreignPage, '/api/simulation', { action: 'status', simulation_id: oldId });
  assert.equal(forbidden.status, 404);
  await page.locator('#integration-scene').selectOption('lobby');
  const replaced = await responseFor(page, '/api/simulation', () => page.locator('#handoff-design').click());
  assert.notEqual(replaced.data.simulation.id, oldId);
  assert.equal((await apiJSON(page, '/api/simulation', { action: 'status', simulation_id: oldId })).status, 404);
  const replacedId = replaced.data.simulation.id;
  await responseFor(page, '/api/logout', () => page.locator('#account-area [data-action="logout"]').click());
  await page.locator('#account-area [data-action="login"]').waitFor({ state: 'visible' });
  await authenticateUser(page, credentials, false);
  assert.equal((await apiJSON(page, '/api/simulation', { action: 'status', simulation_id: replacedId })).status, 404);
  checked('r4-confirm-scope-and-strict-timer', 'Actual HTTP rejects unconfirmed start/timer, requires server confirmation, rejects noninteger/out-of-range timers, hides foreign instances and revokes replaced/logout instances', { invalid });

  stage = 'R4 actual UI one minute countdown';
  await usePreset(page, 0);
  await go(page, 'integration');
  await page.locator('#integration-design').selectOption('current');
  await page.locator('#integration-scene').selectOption('reading');
  await responseFor(page, '/api/simulation', () => page.locator('#handoff-design').click());
  await responseFor(page, '/api/simulation', () => page.locator('[data-action="confirm-simulation"]').click());
  await page.locator('#simulation-duration').fill('1');
  await responseFor(page, '/api/simulation', () => page.locator('#simulation-timer').click());
  const started = await responseFor(page, '/api/simulation', () => page.locator('#simulation-on').click());
  assert.equal(started.data.simulation.running, true);
  const uiStarted = Date.now();
  const initialCountdown = await page.locator('#simulation-countdown').innerText();
  assert.match(initialCountdown, /\d{1,3}:\d{2}/);
  await page.waitForTimeout(1200);
  const laterCountdown = await page.locator('#simulation-countdown').innerText();
  assert.notEqual(laterCountdown, initialCountdown, 'The displayed timer must tick in seconds');
  await screenshot(page, 'r4-real-running-countdown.png', 'Actual one-minute software countdown with a server confirmed running state');

  // A separate Chrome process controls another owner, then closes entirely.
  // The Python runner later observes its server entry before any status query.
  stage = 'R4 independent browser closure background timer';
  assert.ok(process.env.XIHA_QA_LIVE_COOKIES, 'The Python test client must retain the original background session');
  const closingBrowser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const closingContext = await closingBrowser.newContext({ viewport: { width: 1440, height: 1000 } });
    await closingContext.addCookies(JSON.parse(process.env.XIHA_QA_LIVE_COOKIES));
    const closingPage = await closingContext.newPage();
    closingPage.on('pageerror', error => errors.push({ stage, message: error.message }));
    await closingPage.goto(base, { waitUntil: 'domcontentloaded' });
    await goHome(closingPage);
    assert.match(await closingPage.locator('#account-area').innerText(), /香友/, 'Injected original test session was not authenticated');
    const accepted = await apiJSON(closingPage, '/api/simulation', { action: 'handoff', space_id: 'reading', design: { components: [{ profile_id: 'F01', role: 'main' }] } });
    assert.equal(accepted.status, 200);
    const id = accepted.data.simulation.id;
    assert.equal((await apiJSON(closingPage, '/api/simulation', { action: 'confirm', simulation_id: id })).status, 200);
    assert.equal((await apiJSON(closingPage, '/api/simulation', { action: 'set_timer', simulation_id: id, timer_minutes: 1 })).status, 200);
    const running = await apiJSON(closingPage, '/api/simulation', { action: 'start', simulation_id: id });
    assert.equal(running.data.simulation.running, true);
    const job = { simulation_id: id, started_epoch: Date.now() / 1000, timer_minutes: 1,
      browser_closed: false, source: 'Actual local Chrome HTTP start followed by closing that separate browser process; no subsequent status polling for this instance.' };
    await closingBrowser.close();
    job.browser_closed = !closingBrowser.isConnected();
    assert.equal(job.browser_closed, true);
    fs.writeFileSync(path.join(output, 'r4-live-job.json'), JSON.stringify(job, null, 2) + '\n');
    artifact('Actual start receipt for a one-minute instance whose independent Chrome process then closed', 'r4-live-job.json');
    console.log(JSON.stringify({ live_timer_started: true, browser_closed: true, simulation_id: id }));
  } finally { if (closingBrowser.isConnected()) await closingBrowser.close(); }

  stage = 'R4 two real manager edit pages protect concurrent updates';
  const credentialsText = fs.readFileSync(path.join(process.env.XIHA_QA_DATA_DIR, '本机管理者账号.txt'), 'utf8');
  const manager = { username: credentialsText.match(/^账号：(.+)$/m)?.[1].trim(), password: credentialsText.match(/^密码：(.+)$/m)?.[1].trim() };
  assert.ok(manager.username && manager.password);
  const managerPages = [];
  for (let index = 0; index < 2; index += 1) {
    const managerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const managerPage = await managerContext.newPage();
    managerPage.setDefaultTimeout(12000);
    managerPage.on('pageerror', error => errors.push({ stage, message: error.message }));
    await managerPage.goto(base, { waitUntil: 'domcontentloaded' });
    await managerPage.locator('#page-hall .hall-door.door-experience').waitFor({ state: 'visible' });
    await authenticateUser(managerPage, manager, false, 'manager');
    managerPages.push(managerPage);
  }
  const created = await apiJSON(managerPages[0], '/api/products', { name: 'QA第四轮并发商品-' + suffix, description: '原始并发说明', notes: '木质', ingredients: '仅本地测试声明' });
  assert.equal(created.status, 201);
  const productId = created.data.product.id;
  const endpoint = '/api/products/' + productId;
  for (const managerPage of managerPages) {
    await go(managerPage, 'manage');
    await managerPage.locator(`[data-record="${productId}"] [data-action="edit-record"]`).click();
    await managerPage.locator('#edit-product-form').waitFor({ state: 'visible' });
  }
  const [one, two] = managerPages;
  const editOne = one.locator('#edit-product-form');
  const editTwo = two.locator('#edit-product-form');
  const baseRevision = Number(await editOne.getAttribute('data-revision'));
  assert.equal(Number(await editTwo.getAttribute('data-revision')), baseRevision);
  assert.ok(Number.isInteger(baseRevision));
  await editOne.locator('[name="description"]').fill('第一页面成功保存的说明');
  await editTwo.locator('[name="description"]').fill('第二页面尚未保存的私人编辑');
  const firstUpdate = await responseFor(one, endpoint, () => editOne.locator('button[type="submit"]').click(), 200, 'PATCH');
  assert.equal(firstUpdate.data.product.revision, baseRevision + 1);
  const staleUpdate = await responseFor(two, endpoint, () => editTwo.locator('button[type="submit"]').click(), 409, 'PATCH');
  assert.equal(staleUpdate.data.code, 'product_conflict');
  assert.equal(await editTwo.locator('[name="description"]').inputValue(), '第二页面尚未保存的私人编辑');
  assert.equal(await two.locator('#detail-dialog').isVisible(), true);
  await screenshot(two, 'r4-edit-conflict-retains-input.png', 'Actual HTTP 409 from a stale manager editor leaves the user\'s edited text intact');
  await editTwo.locator('[data-action="reload-conflict"]').click();
  await two.waitForFunction(({ expected }) => Number(document.querySelector('#edit-product-form').dataset.revision) === expected, { expected: baseRevision + 1 });
  assert.equal(await editTwo.locator('[name="description"]').inputValue(), '第二页面尚未保存的私人编辑', 'Reload for comparison must preserve user edits');
  assert.ok((await editTwo.innerText()).includes('第一页面成功保存的说明'), 'Reload must show the current server values for review');
  const resolved = await responseFor(two, endpoint, () => editTwo.locator('button[type="submit"]').click(), 200, 'PATCH');
  assert.equal(resolved.request.expected_revision, baseRevision + 1);
  assert.equal(resolved.data.product.description, '第二页面尚未保存的私人编辑');
  assert.equal(resolved.data.product.revision, baseRevision + 2);
  checked('r4-concurrent-edit-cas', 'Two real manager pages share a base revision; first update succeeds, second receives 409 without losing text, explicit reload shows server values and a new revision before the user saves again');

  stage = 'R4 publication conflicts preserve selected public fields';
  for (const managerPage of managerPages) {
    const productRefresh = managerPage.waitForResponse(item => new URL(item.url()).pathname === '/api/products' && item.request().method() === 'GET');
    const designRefresh = managerPage.waitForResponse(item => new URL(item.url()).pathname === '/api/designs' && item.request().method() === 'GET');
    await managerPage.locator('#refresh-products').click();
    await Promise.all([(await productRefresh).json(), (await designRefresh).json()]);
    await frames(managerPage);
    await managerPage.waitForFunction(({ productId, revision }) => Number(document.querySelector(`.publish-form[data-product="${productId}"]`)?.dataset.revision) === revision, { productId, revision: baseRevision + 2 });
  }
  stage = 'R4 editable old form survives a deliberately delayed refresh';
  let capturedResolve;
  let releaseResolve;
  const captured = new Promise(resolve => { capturedResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  let heldRequest;
  const delayRefresh = async route => {
    if (route.request().method() !== 'GET' || heldRequest) return route.continue();
    heldRequest = route.request();
    const response = await route.fetch();
    const body = await response.body();
    capturedResolve();
    await release;
    await route.fulfill({ response, body });
  };
  await two.route('**/api/products', delayRefresh);
  try {
    await two.locator('#refresh-products').click();
    await captured;
    const editable = two.locator(`.publish-form[data-product="${productId}"]`);
    await editable.locator('[name="purchase_url"]').fill('https://example.com/qa-r4-edit-during-refresh');
    await editable.locator('[name="public_fields"][value="ingredients"]').check();
    await editable.locator('[name="public_fields"][value="description"]').uncheck();
    const editedFields = await editable.locator('[name="public_fields"]:checked').evaluateAll(nodes => nodes.map(node => node.value).sort());
    const consumed = two.waitForEvent('requestfinished', { predicate: request => request === heldRequest });
    releaseResolve();
    await consumed;
    await frames(two);
    assert.equal(await editable.locator('[name="purchase_url"]').inputValue(), 'https://example.com/qa-r4-edit-during-refresh', 'A delayed refresh erased input typed into the still editable form');
    assert.deepEqual(await editable.locator('[name="public_fields"]:checked').evaluateAll(nodes => nodes.map(node => node.value).sort()), editedFields, 'A delayed refresh erased checked public choices');
    checked('r4-dirty-form-survives-delayed-refresh', 'An actual products GET is held while the visible old form accepts URL/checkbox input; releasing the response preserves the user input instead of redrawing it away');
  } finally {
    releaseResolve();
    await two.unroute('**/api/products', delayRefresh);
  }
  stage = 'R4 publication conflicts preserve selected public fields';
  const publishOne = one.locator(`.publish-form[data-product="${productId}"]`);
  const publishTwo = two.locator(`.publish-form[data-product="${productId}"]`);
  await publishOne.locator('[name="purchase_url"]').fill('https://example.com/qa-r4-first');
  await publishTwo.locator('[name="purchase_url"]').fill('https://example.com/qa-r4-preserved');
  await publishTwo.locator('[name="price"]').fill('仅本地验证的价说明');
  await publishTwo.locator('[name="public_fields"][value="ingredients"]').check();
  await publishTwo.locator('[name="public_fields"][value="description"]').uncheck();
  assert.equal(await publishTwo.locator('[name="purchase_url"]').inputValue(), 'https://example.com/qa-r4-preserved', 'Setup refresh must finish before the conflict fixture is filled');
  assert.equal(await publishTwo.locator('[name="price"]').inputValue(), '仅本地验证的价说明');
  const selectedFields = await publishTwo.locator('[name="public_fields"]:checked').evaluateAll(nodes => nodes.map(node => node.value).sort());
  await responseFor(one, endpoint + '/publish', () => publishOne.locator('button[type="submit"]').click());
  const publishConflict = await responseFor(two, endpoint + '/publish', () => publishTwo.locator('button[type="submit"]').click(), 409);
  assert.equal(publishConflict.data.code, 'product_conflict');
  assert.equal(await publishTwo.locator('[name="purchase_url"]').inputValue(), 'https://example.com/qa-r4-preserved');
  assert.equal(await publishTwo.locator('[name="price"]').inputValue(), '仅本地验证的价说明');
  assert.deepEqual(await publishTwo.locator('[name="public_fields"]:checked').evaluateAll(nodes => nodes.map(node => node.value).sort()), selectedFields);
  await screenshot(two, 'r4-publication-conflict-retains-fields.png', 'Actual publication HTTP 409 preserves the chosen public fields, price and URL');
  await publishTwo.locator('[data-action="reload-conflict"]').click();
  await two.waitForFunction(({ productId, revision }) => Number(document.querySelector(`.publish-form[data-product="${productId}"]`)?.dataset.revision) === revision, { productId, revision: baseRevision + 3 });
  assert.deepEqual(await publishTwo.locator('[name="public_fields"]:checked').evaluateAll(nodes => nodes.map(node => node.value).sort()), selectedFields);
  const publication = await responseFor(two, endpoint + '/publish', () => publishTwo.locator('button[type="submit"]').click());
  assert.equal(publication.request.expected_revision, baseRevision + 3);
  assert.equal(publication.data.product.purchase_url, 'https://example.com/qa-r4-preserved');
  assert.equal((await apiJSON(page, endpoint + '/publish', { expected_revision: publication.data.product.revision })).status, 403);
  const foreignPatch = await foreignPage.evaluate(async ({ endpoint, revision }) => {
    const session = await (await fetch('/api/session')).json();
    const result = await fetch(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token }, body: JSON.stringify({ expected_revision: revision, description: 'QA forbidden foreign edit' }) });
    return result.status;
  }, { endpoint, revision: publication.data.product.revision });
  assert.equal(foreignPatch, 404);
  checked('r4-publication-cas-and-permissions', 'Stale publication receives 409 without losing public checkbox choices, URL or price; explicit latest-value review enables a new revision save; ordinary publication and foreign edits remain denied', { selected_fields: selectedFields });

  stage = 'R4 UI expiration confirmed by actual server status';
  currentPage = page;
  const until = uiStarted + 72000;
  let ended = null;
  while (Date.now() < until) {
    ended = await page.evaluate(async () => {
      const { state } = await import('/static/modules/core.js');
      return state.simulation ? structuredClone(state.simulation) : null;
    });
    if (ended && !ended.running && (ended.history || []).some(item => item.action === 'auto_stop')) break;
    await page.waitForTimeout(1000);
  }
  assert.ok(ended && !ended.running && ended.history.some(item => item.action === 'auto_stop'), 'UI did not adopt the server\'s real timed auto-stop state');
  assert.ok(Date.now() - uiStarted >= 59000, 'A one-minute real timer expired implausibly early');
  assert.match(await page.locator('#simulation-countdown').innerText(), /00:00|已.*到时|定时.*关闭/);
  await screenshot(page, 'r4-real-auto-stop.png', 'Actual one-minute expiry is shown only after the frontend receives server auto_stop history');
  checked('r4-real-ui-countdown-auto-stop', 'Actual one-minute timer ticks in seconds and the frontend receives server auto_stop history and a stopped state', { initial: initialCountdown, later: laterCountdown, elapsed_seconds: (Date.now() - uiStarted) / 1000, history: ended.history });
  assert.deepEqual(errors, []);
  checked('r4-browser-errors', 'No browser errors across server confirmation, real timers and concurrent manager conflicts');
}

async function crossTabPrivacy(probe = false) {
  stage = probe ? 'R5 pre-fix two-tab identity reproduction' : 'R5 two-tab privacy identity binding';
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const pageA = await context.newPage();
  currentPage = pageA;
  await pageA.goto(base, { waitUntil: 'domcontentloaded' });
  await goHome(pageA);
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const a = await authenticateUser(pageA, { username: 'qa_tabs_a_' + suffix, password: 'QaTabs-Only-A-' + suffix });
  const markerA = '仅属于旧页账号A的私人原话-' + suffix;
  await usePreset(pageA, 0);
  await pageA.locator('#design-words').fill(markerA);
  const privateA = await apiJSON(pageA, '/api/products', { name: '旧页A私人香品-' + suffix, description: 'wood label; temporary fixture' });
  assert.equal(privateA.status, 201);
  await go(pageA, 'collection');
  await pageA.locator(`#private-records [data-record="${privateA.data.product.id}"]`).waitFor({ state: 'visible' });

  const pageB = await context.newPage();
  await pageB.goto(base, { waitUntil: 'domcontentloaded' });
  await goHome(pageB);
  await responseFor(pageB, '/api/logout', () => pageB.locator('#account-area [data-action="logout"]').click());
  await pageB.locator('#account-area [data-action="login"]').waitFor({ state: 'visible' });
  const b = await authenticateUser(pageB, { username: 'qa_tabs_b_' + suffix, password: 'QaTabs-Only-B-' + suffix });
  const markerB = '应只属于新账号B的私人香品-' + suffix;
  const cardB = '应只属于新账号B的香笺-' + suffix;
  assert.equal((await apiJSON(pageB, '/api/products', { name: markerB, description: 'temporary private woody fixture' })).status, 201);
  assert.equal((await apiJSON(pageB, '/api/designs', { name: cardB, components: [{ profile_id: 'F01', role: 'main' }], user_notes: '仅B自己的测试原话' })).status, 201);
  await pageA.bringToFront();
  await pageA.waitForTimeout(100);
  let responseStatus;
  let returned;
  if (await pageA.locator('#refresh-private').isVisible()) {
    const waiting = pageA.waitForResponse(response => new URL(response.url()).pathname === '/api/products' && response.request().method() === 'GET');
    await pageA.locator('#refresh-private').click();
    const response = await waiting;
    responseStatus = response.status();
    returned = await response.json();
  } else {
    const direct = await pageA.evaluate(async expected => {
      const response = await fetch('/api/products', { headers: { 'X-Expected-User': expected } });
      return { status: response.status, data: await response.json() };
    }, a.id);
    responseStatus = direct.status;
    returned = direct.data;
  }
  await frames(pageA);
  const observed = await pageA.evaluate(async () => {
    const { state } = await import('/static/modules/core.js');
    return { local_user_id: state.user?.id || null, account_text: document.querySelector('#account-area').textContent,
      product_text: document.querySelector('#private-records').textContent,
      saved_text: document.querySelector('#saved-designs').textContent,
      words: document.querySelector('#design-words').value,
      draft_keys: Object.keys(sessionStorage).filter(key => key.startsWith('hexiang:draft:v1:')) };
  });
  const leak = observed.product_text.includes(markerB) || observed.saved_text.includes(cardB);
  const evidence = { probe, before_user_id: a.id, cookie_user_id: b.id, observed,
    product_http_status: responseStatus, product_error_code: returned.code || null,
    returned_other_account_marker: JSON.stringify(returned).includes(markerB), private_cross_tab_leak_reproduced: leak };
  fs.writeFileSync(path.join(output, 'r5-cross-tab-identity.json'), JSON.stringify(evidence, null, 2) + '\n');
  artifact('Actual shared-cookie two-tab account change, old tab request and rendered private data or identity rejection', 'r5-cross-tab-identity.json');
  await screenshot(pageA, 'r5-cross-tab-identity.png', 'Actual old tab after another tab logs out and switches the shared cookie to another account');
  if (probe) {
    console.log(JSON.stringify({ cross_tab_leak_reproduced: leak, product_http_status: responseStatus, local_user_is_old_account: observed.local_user_id === a.id }));
    return;
  }
  assert.equal(leak, false, 'Another account\'s private data was filled into the old tab');
  assert.equal(responseStatus, 409);
  assert.equal(returned.code, 'session_changed');
  assert.equal(evidence.returned_other_account_marker, false);
  assert.equal(observed.local_user_id, null);
  assert.equal(observed.words, '');
  assert.equal(observed.draft_keys.length, 0);
  const protectedPaths = await pageA.evaluate(async expected => {
    const session = await (await fetch('/api/session')).json();
    const results = [];
    for (const [endpoint, method, payload] of [
      ['/api/designs', 'GET', null],
      ['/api/designs', 'POST', { name: 'QA forbidden stale save', components: [{ profile_id: 'F01', role: 'main' }] }],
      ['/api/simulation', 'POST', { action: 'handoff', space_id: 'reading', design: { components: [{ profile_id: 'F01', role: 'main' }] } }],
    ]) {
      const headers = { 'X-Expected-User': expected };
      if (payload) { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = session.csrf_token; }
      const response = await fetch(endpoint, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
      results.push({ endpoint, method, status: response.status, data: await response.json() });
    }
    return results;
  }, a.id);
  for (const result of protectedPaths) {
    assert.equal(result.status, 409);
    assert.equal(result.data.code, 'session_changed');
    assert.ok(!JSON.stringify(result.data).includes(markerB) && !JSON.stringify(result.data).includes(cardB));
  }
  const legacy = await getAPI(pageB, '/api/designs');
  assert.equal(legacy.status, 200, 'Legacy cookie-authorized callers remain supported');
  assert.equal(legacy.data.designs.length, 1, 'Rejected stale save changed the new owner\'s records');
  fs.writeFileSync(path.join(output, 'r5-private-endpoint-identity.json'), JSON.stringify(protectedPaths, null, 2) + '\n');
  artifact('Actual GET/POST private endpoint identity rejection plus unchanged legacy owner records', 'r5-private-endpoint-identity.json');
  checked('r5-cross-tab-user-binding', 'Actual shared-cookie account switch returns identity conflict before another owner\'s data, clears old tab private state/draft and never renders the new account\'s data');
}

async function roundFiveNewBehaviors() {
  stage = 'R5 searchable library keeps material domains separate';
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  currentPage = page;
  page.on('pageerror', error => errors.push({ stage, message: error.message }));
  page.setDefaultTimeout(12000);
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await goHome(page);
  const boot = (await getAPI(page, '/api/bootstrap')).data;
  await go(page, 'library');
  await page.locator('[data-library="profiles"]').click();
  await page.locator('#library-search').fill('雪松');
  assert.equal(await page.locator('#library-content [data-action="use-profile"]').count(), 1);
  assert.equal(await page.locator('#library-content [data-action="use-profile"]').getAttribute('data-id'), 'F02');
  await page.locator('#library-search').fill('');
  await page.locator('#library-family').selectOption('woody');
  assert.equal(await page.locator('#library-content [data-action="use-profile"]').count(), boot.profiles.filter(item => item.reported_facets.includes('woody')).length);
  await page.locator('#library-family').selectOption('');
  await page.locator('#library-search').fill(boot.facets.creamy);
  assert.equal(await page.locator('#library-content [data-action="use-profile"]').count(), boot.profiles.filter(item => item.reported_facets.includes('creamy')).length);
  await page.locator('#library-search').fill('QA不存在的材料或标签');
  assert.equal(await page.locator('#library-content [data-action="use-profile"]').count(), 0);
  await page.locator('#library-search').fill('');
  await page.locator('#library-family').selectOption('spicy');
  await page.locator('#library-content [data-action="use-profile"][data-id="F05"]').click();
  await page.locator('#page-studio').waitFor({ state: 'visible' });
  const selected = page.locator('#profile-palette .material-card[data-profile="F05"]');
  assert.match(await selected.getAttribute('class'), /selected/);
  const bounds = await selected.evaluate(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, viewport: innerWidth }; });
  assert.ok(bounds.left >= -1 && bounds.right <= bounds.viewport + 1, 'Selected modern reference remains outside the mobile carousel viewport');
  assert.equal(await page.locator('#role-slots .slot-material').count(), 0, 'Bringing a reference to studio must not assign an unchosen role');
  await selected.locator('[data-action="assign-material"][data-role="main"]').click();
  assert.match(await page.locator('#slot-main').innerText(), /丁香/);
  const materialBefore = await page.locator('#role-slots').innerText();
  await go(page, 'library');
  await page.locator('[data-library="materials"]').click();
  assert.equal(await page.locator('#library-search').isEnabled(), false);
  assert.equal(await page.locator('#library-family').isEnabled(), false);
  assert.equal(await page.locator('#library-content [data-action="use-profile"]').count(), 0, 'Traditional materials acquired a modern composition action');
  await page.locator('#library-content [data-action="material-detail"]').first().click();
  await page.locator('#detail-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#detail-content [data-action="use-profile"]').count(), 0);
  await page.locator('#detail-dialog .close-dialog').click();
  await go(page, 'studio');
  assert.equal(await page.locator('#role-slots').innerText(), materialBefore);
  await screenshot(page, 'r5-selected-modern-reference.png', 'A searched modern reference is visibly selected in the mobile carousel and assigned only by an explicit role click');
  checked('r5-library-search-family-and-domain', 'Actual name/reported-label/family filtering finds correct references; a chosen modern reference is visible and requires role selection, while traditional material pages never enter the modern composition');

  stage = 'R5 general negation and unknown text remain honest';
  const rows = [];
  for (const text of ['不喜欢木质', '不要木质', '不想要木质', '不喜欢甜香', '不要辛香', '不想要柑橘']) {
    const result = await apiJSON(page, '/api/interpret', { user_notes: text, manual_preferred: [], manual_deemphasized: [], excluded_ids: ['F04'] });
    assert.equal(result.status, 200);
    assert.equal(result.data.proposal.preferred_facets.length, 0, 'Negation was reversed into a positive preference: ' + text);
    assert.equal(result.data.proposal.deemphasized_facets.length, 1);
    assert.ok(result.data.proposal.excluded_ids.includes('F04'));
    rows.push({ text, proposal: result.data.proposal, recognized: result.data.recognized });
  }
  const materialUnknown = await apiJSON(page, '/api/interpret', { user_notes: '不喜欢丁香', manual_preferred: [], manual_deemphasized: [], excluded_ids: ['F04'] });
  assert.equal(materialUnknown.data.status, 'no_changes');
  assert.deepEqual(materialUnknown.data.proposal.excluded_ids, ['F04'], 'Disliking a material must not invent a strong exclusion');
  for (const text of ['不要丁香', '不用丁香', '排除丁香', '避开丁香', '不想要丁香']) {
    const result = await apiJSON(page, '/api/interpret', { user_notes: text, manual_preferred: [], manual_deemphasized: [], excluded_ids: ['F04'] });
    assert.ok(result.data.proposal.excluded_ids.includes('F04') && result.data.proposal.excluded_ids.includes('F05'));
    rows.push({ text, proposal: result.data.proposal, recognized: result.data.recognized });
  }
  await page.locator('#design-words').fill('木质好吗？');
  await responseFor(page, '/api/interpret', () => page.locator('#interpret-words').click());
  assert.equal(await page.locator('#apply-intent').count(), 0, 'An unmapped no-change sentence must not expose an empty apply action');
  const currentChoices = page.locator('#intent-preview #intent-proposed-conditions');
  if (await currentChoices.count()) {
    assert.equal(await currentChoices.evaluate(node => Boolean(node.closest('details') && !node.closest('details').open)), true, 'Current conditions must be folded in compact unmapped feedback');
  }
  await screenshot(page, 'r5-compact-unknown.png', 'A genuinely unmapped sentence shows compact feedback with current conditions folded and no misleading apply control');
  fs.writeFileSync(path.join(output, 'r5-negation-requests.json'), JSON.stringify(rows, null, 2) + '\n');
  artifact('Actual generalized negation and explicit material exclusion interpretation responses', 'r5-negation-requests.json');
  checked('r5-negation-unknown-compact', 'Several negation families reduce the stated facet without reversing it; material dislike stays unknown, explicit exclusion only adds, and unmapped feedback is compact');

  stage = 'R5 actual save signature includes both lock directions';
  await page.setViewportSize({ width: 1440, height: 1000 });
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await authenticateUser(page, { username: 'qa_lock_' + suffix, password: 'QaLock-Only-' + suffix });
  await usePreset(page, 0);
  const name = '同名锁切换-' + suffix;
  await page.locator('#lock-main').check();
  await page.locator('#save-current-card').click();
  await page.locator('#card-dialog').waitFor({ state: 'visible' });
  await page.locator('#card-name').fill(name);
  const locked = await responseFor(page, '/api/designs', () => page.locator('#save-card').click(), 201);
  assert.equal(locked.data.design.locked_main_id, 'F02');
  await page.locator('#card-to-studio').click();
  await page.locator('#lock-main').uncheck();
  await page.locator('#save-current-card').click();
  await page.locator('#card-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#card-name').inputValue(), name);
  assert.equal(await page.locator('#save-card').isEnabled(), true, 'Only changing lock was wrongly treated as an already saved card');
  const unlocked = await responseFor(page, '/api/designs', () => page.locator('#save-card').click(), 201);
  assert.equal(Object.hasOwn(unlocked.data.design, 'locked_main_id'), false, 'An unlocked request omits the optional lock field');
  assert.notEqual(unlocked.data.design.id, locked.data.design.id);
  await page.locator('#card-to-studio').click();
  await page.locator('#lock-main').check();
  await page.locator('#save-current-card').click();
  await page.locator('#card-dialog').waitFor({ state: 'visible' });
  const duplicateRequests = [];
  const observeDuplicate = request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/designs') duplicateRequests.push(request.url());
  };
  page.on('request', observeDuplicate);
  await page.locator('#save-card').click();
  assert.match(await page.locator('#card-save-status').innerText(), /已经保存在你的账号/);
  await frames(page);
  page.off('request', observeDuplicate);
  assert.equal(duplicateRequests.length, 0, 'Returning to an existing signature should deduplicate before another save request');
  assert.equal((await getAPI(page, '/api/designs')).data.designs.length, 2);

  // A second same-name pair starts unlocked, proving the other lock-only
  // transition with a genuinely new signature instead of an existing duplicate.
  await page.locator('#card-to-studio').click();
  await page.locator('#lock-main').uncheck();
  await page.locator('#save-current-card').click();
  await page.locator('#card-dialog').waitFor({ state: 'visible' });
  const reverseName = name + '-反向';
  await page.locator('#card-name').fill(reverseName);
  const reverseUnlocked = await responseFor(page, '/api/designs', () => page.locator('#save-card').click(), 201);
  assert.equal(Object.hasOwn(reverseUnlocked.data.design, 'locked_main_id'), false);
  await page.locator('#card-to-studio').click();
  await page.locator('#lock-main').check();
  await page.locator('#save-current-card').click();
  await page.locator('#card-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#card-name').inputValue(), reverseName);
  const reverseLocked = await responseFor(page, '/api/designs', () => page.locator('#save-card').click(), 201);
  assert.equal(reverseLocked.data.design.locked_main_id, 'F02');
  assert.notEqual(reverseLocked.data.design.id, reverseUnlocked.data.design.id);
  assert.equal((await getAPI(page, '/api/designs')).data.designs.length, 4);
  const reopenStates = [];
  await page.locator('#card-dialog .close-dialog').click();
  for (const [id, expected] of [[locked.data.design.id, true], [unlocked.data.design.id, false], [reverseUnlocked.data.design.id, false], [reverseLocked.data.design.id, true]]) {
    await go(page, 'collection');
    await frames(page);
    const index = await page.evaluate(async id => {
      const { state } = await import('/static/modules/core.js');
      return state.savedDesigns.findIndex(item => item.id === id);
    }, id);
    assert.ok(index >= 0);
    await page.locator(`#saved-designs [data-action="reopen-design"][data-index="${index}"]`).click();
    await page.locator('#card-dialog').waitFor({ state: 'visible' });
    await page.locator('#card-to-studio').click();
    const actual = await page.locator('#lock-main').isChecked();
    assert.equal(actual, expected, 'Saved lock state did not survive actual reopen/continue');
    reopenStates.push({ id, expected, actual });
  }
  fs.writeFileSync(path.join(output, 'r5-lock-save-responses.json'), JSON.stringify({ locked, unlocked, reverseUnlocked, reverseLocked, duplicate_save_requests: duplicateRequests.length, reopenStates }, null, 2) + '\n');
  artifact('Actual 201 save responses in both lock-only change directions, omitted unlocked fields, no duplicate request for an existing signature, and four actual reopen checkbox states', 'r5-lock-save-responses.json');
  await screenshot(page, 'r5-reopened-lock-state.png', 'A saved locked version is reopened and continued with its actual main lock checked');
  checked('r5-lock-save-signature-both-directions', 'Lock-only changes create real 201 saves in both directions for new same-name signatures; existing signatures deduplicate without another request, and all four versions reopen with their own actual lock state');
  await crossTabPrivacy(false);
}

async function main() {
  assert.ok([1, 2, 3, 4, 5].includes(round), 'Only implemented round-specific acceptance may run');
  assert.ok(base && output && process.env.XIHA_QA_DATA_DIR, 'Use the disposable Python runner with explicit base/output/data-dir');
  const address = new URL(base);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname));
  assert.equal(address.protocol, 'http:');
  const dataset = fs.realpathSync(process.env.XIHA_QA_DATA_DIR);
  assert.ok(!dataset.split(path.sep).includes('.local'), 'Do not use an actual private data directory');
  fs.mkdirSync(output, { recursive: true });
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  if (round === 1) await roundOne();
  if (round === 2) await roundTwo();
  if (round === 3) await roundThree();
  if (round === 4) await roundFour();
  if (round === 5 && process.env.XIHA_QA_PROBE === 'cross-tab') await crossTabPrivacy(true);
  if (round === 5 && !process.env.XIHA_QA_PROBE) {
    if (process.env.XIHA_QA_R5_NEW_ONLY !== '1') {
      await roundOne();
      await roundTwo();
      await roundThree();
      await roundFour();
    }
    await roundFiveNewBehaviors();
  }
}

main().catch(async error => {
  errors.push({ stage, message: error.message });
  if (currentPage) await screenshot(currentPage, 'failure.png', `Failure screenshot at ${stage}`).catch(() => {});
  console.error(error.stack);
  process.exitCode = 1;
}).finally(async () => {
  if (output) {
    fs.mkdirSync(output, { recursive: true });
    const trace = { round, passed: process.exitCode !== 1, generated_at: new Date().toISOString(), checks, errors, behavior_evidence: behavior,
      scope: 'Disposable local Chrome behavior checks; no existing accounts, actual scent, real devices, or production acceptance.' };
    fs.writeFileSync(path.join(output, '浏览器行为.json'), JSON.stringify(trace, null, 2) + '\n');
  }
  if (browser) await browser.close();
});
