'use strict';

// Run only against a separately started, disposable local data directory:
// XIHA_QA_DATA_DIR=/absolute/qa-data XIHA_QA_BASE=http://127.0.0.1:8872 node qa_v2.cjs
// This script never starts a server, installs packages, or reads app/.local credentials.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const base = process.env.XIHA_QA_BASE || 'http://127.0.0.1:8872';
const output = process.env.XIHA_QA_OUTPUT || path.join(__dirname, 'verification', 'current');
const results = [];
const errors = [];
const requestFailures = [];
const static404s = [];
const secrets = [];
let browser;
let currentStage = 'configuration';
let activePage;

function redact(value) {
  let text = String(value);
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text;
}
function checkpoint(id, description, evidence = {}) {
  results.push({ id, description, passed: true, ...evidence });
  console.log(JSON.stringify({ check: id, passed: true, description }));
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function bounded(promise, label, timeout = 15000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}
function monitor(page, label) {
  page.on('pageerror', error => errors.push({ page: label, message: redact(error.message) }));
  page.on('requestfailed', request => requestFailures.push({ page: label, path: new URL(request.url()).pathname, message: request.failure()?.errorText || 'request failed' }));
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname;
    if (pathname.startsWith('/static/') && response.status() === 404) static404s.push({ page: label, path: pathname });
  });
}
async function nextRender(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function showControl(locator) {
  // Optional form sections may begin folded. Expand their native details controls.
  await locator.evaluate(element => {
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (node.tagName === 'DETAILS' && !node.open) node.querySelector(':scope > summary')?.click();
    }
  });
  await locator.waitFor({ state: 'visible' });
}
async function go(page, name) {
  activePage = page;
  await page.locator(`.main-nav [data-page="${name}"]`).click();
  await page.locator('#page-' + name).waitFor({ state: 'visible' });
  await nextRender(page);
}
async function getJSON(page, endpoint, method = 'GET', body) {
  return page.evaluate(async ({ endpoint, method, body }) => {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      const session = await (await fetch('/api/session')).json();
      headers['X-CSRF-Token'] = session.csrf_token;
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(endpoint, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }, { endpoint, method, body });
}
async function responseFor(page, pathname, method, work, expectedStatus = 200) {
  const waiting = page.waitForResponse(response => new URL(response.url()).pathname === pathname && response.request().method() === method);
  await work();
  const response = await waiting;
  assert.equal(response.status(), expectedStatus, 'Unexpected HTTP status for ' + pathname);
  return { data: await response.json(), request: response.request().postDataJSON() };
}
async function authenticate(page, credentials, register = false) {
  await page.locator('#account-area [data-action="login"], #account-area #open-auth').click();
  await page.locator(`#auth-dialog [data-auth-mode="${register ? 'register' : 'login'}"]`).click();
  await page.locator('#auth-username').fill(credentials.username);
  await page.locator('#auth-password').fill(credentials.password);
  const result = await responseFor(page, register ? '/api/register' : '/api/login', 'POST', () => page.locator('#auth-submit').click());
  assert.equal(result.data.user?.role, register ? 'user' : 'manager', 'Incorrect authenticated role');
  await page.locator('#auth-dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('#auth-submit').disabled);
  assert.match(await page.locator('#account-area').innerText(), register ? /普通/ : /管理者/, 'Role is missing from the account area');
}
async function upload(page, prefix, fixture) {
  await page.locator('#' + prefix + '-name').fill(fixture.name);
  await page.locator('#' + prefix + '-brand').fill(fixture.brand);
  await page.locator('#' + prefix + '-form').selectOption('perfume');
  await page.locator('#' + prefix + '-description').fill(fixture.description);
  const notes = page.locator('#' + prefix + '-notes');
  await showControl(notes);
  await notes.fill(fixture.notes);
  await page.locator('#' + prefix + '-ingredients').fill(fixture.ingredients);
  await page.locator('#' + prefix + '-personal-notes').fill(fixture.personal_notes);
  await page.locator('#' + prefix + '-url').fill('https://example.com/qa-reference');
  assert.equal(await page.locator('#' + prefix + '-files').getAttribute('multiple'), null, 'The one-file contract must use a single-file input');
  const result = await responseFor(page, '/api/products', 'POST', () => page.locator('#' + prefix + '-upload-form button[type="submit"]').click(), 201);
  assert.ok(result.data.product?.id, 'Uploaded record has no id');
  assert.equal(result.data.product.kind, prefix === 'manager' ? 'catalog' : 'private', 'Wrong upload purpose');
  await page.locator('#detail-dialog').waitFor({ state: 'visible' });
  const report = await page.locator('#detail-content').innerText();
  for (const heading of ['成分声明', '个人实闻', '系统归纳', '未知']) assert.ok(report.includes(heading), 'Analysis is missing layer: ' + heading);
  assert.ok(report.includes(fixture.ingredients), 'Ingredient declaration was lost');
  assert.ok(report.includes(fixture.personal_notes), 'Provided personal observation was lost');
  await page.locator('#detail-dialog .close-dialog').click();
  await page.locator(`[data-record="${result.data.product.id}"]`).waitFor({ state: 'visible' });
  return result.data.product;
}
async function toggleFacet(page, group, key, active) {
  const control = page.locator(`[data-action="toggle-facet"][data-group="${group}"][data-key="${key}"]`);
  await showControl(control);
  if ((await control.getAttribute('aria-pressed') === 'true') !== active) await control.click();
  assert.equal(await control.getAttribute('aria-pressed'), String(active), 'Facet toggle failed');
}
async function generate(page, expectedStatus = 'ok') {
  const result = await responseFor(page, '/api/compose', 'POST', () => page.locator('#generate-design').click());
  await page.waitForFunction(() => !document.querySelector('#generate-design').disabled);
  assert.equal(result.data.status, expectedStatus, 'Unexpected composition result');
  return result;
}
function inspectPNG(filename) {
  const bytes = fs.readFileSync(filename);
  assert.ok(bytes.length > 1000, 'PNG export is unexpectedly small');
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), 'Invalid PNG signature');
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR', 'PNG has no IHDR header');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.ok(width >= 720 && width <= 4096 && height >= 720 && height <= 20000, 'PNG dimensions do not describe a usable scent card');
  return { width, height, bytes: bytes.length };
}
async function noOverflow(page, view, width) {
  await nextRender(page);
  const dimensions = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    offending: [...document.querySelectorAll('body *')].filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.width && (rect.right > innerWidth + 1 || rect.left < -1);
    }).slice(0, 8).map(node => ({ tag: node.tagName, id: node.id, class: typeof node.className === 'string' ? node.className : '' })),
  }));
  assert.ok(Math.max(dimensions.document, dimensions.body) <= dimensions.viewport + 1,
    `${view} at ${width}px has full-page horizontal overflow: ${JSON.stringify(dimensions)}`);
  return { view, width, document: dimensions.document, body: dimensions.body };
}

async function checkStalePrivateResponses(page, oldProduct, oldCardName, nextAccount) {
  await page.locator(`#private-records [data-action="record-reference"][data-id="${oldProduct.id}"]`).click();
  await page.locator('#page-studio').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#studio-message').textContent()).includes(oldProduct.name), 'Private reference did not populate the notice fixture');
  await go(page, 'collection');
  const captured = deferred();
  const released = deferred();
  const finished = deferred();
  const held = new Map();
  let completed = 0;
  const endpoints = ['/api/products', '/api/designs'];
  const handler = async route => {
    const endpoint = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET' || held.has(endpoint)) return route.continue();
    held.set(endpoint, { request: route.request() });
    try {
      const response = await route.fetch();
      const body = await response.body();
      assert.equal(response.status(), 200, 'Cannot capture the old authenticated response');
      const data = JSON.parse(body.toString('utf8'));
      if (endpoint === '/api/products') assert.ok(data.products.some(item => item.id === oldProduct.id), 'Held products response has no old private record');
      else assert.ok(data.designs.some(item => (item.design || item).name === oldCardName), 'Held designs response has no old saved card');
      held.set(endpoint, { request: route.request(), response, body });
      if (endpoints.every(key => held.get(key)?.body)) captured.resolve();
      await released.promise;
      await route.fulfill({ response, body });
      completed += 1;
      if (completed === endpoints.length) finished.resolve();
    } catch (error) { captured.reject(error); finished.reject(error); }
  };
  // Suppress unhandled-rejection warnings while the bounded gates preserve failures.
  captured.promise.catch(() => {});
  finished.promise.catch(() => {});
  for (const endpoint of endpoints) await page.route('**' + endpoint, handler);
  try {
    await page.locator('#refresh-private').click();
    await bounded(captured.promise, 'Capture of delayed private responses');
    await responseFor(page, '/api/logout', 'POST', () => page.locator('#account-area [data-action="logout"]').click());
    await page.locator('#account-area [data-action="login"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#studio-message').textContent(), '', 'Logout retained a private product name in the studio notice');
    for (const selector of ['#private-records', '#manager-records', '#saved-designs']) {
      const text = await page.locator(selector).textContent();
      assert.ok(!text.includes(oldProduct.name) && !text.includes(oldCardName), 'Logout retained old private data');
    }
    await authenticate(page, nextAccount, true);
    await go(page, 'collection');
    const newProducts = await getJSON(page, '/api/products');
    const newDesigns = await getJSON(page, '/api/designs');
    assert.equal(newProducts.data.products.length, 0, 'The new test account must start with no products');
    assert.equal(newDesigns.data.designs.length, 0, 'The new test account must start with no saved designs');
    const responsesConsumed = endpoints.map(endpoint => page.waitForEvent('requestfinished', {
      predicate: request => request === held.get(endpoint).request,
    }));
    released.resolve();
    await bounded(Promise.all([finished.promise, ...responsesConsumed]), 'Release of delayed private responses');
    await nextRender(page);
    assert.equal(await page.locator('#account-area [data-action="logout"]').count(), 1, 'An old account response logged out the newly authenticated account');
    for (const selector of ['#private-records', '#manager-records', '#saved-designs']) {
      const text = await page.locator(selector).textContent();
      assert.ok(!text.includes(oldProduct.name) && !text.includes(oldCardName), 'An old response repopulated private data after the account changed');
    }
    assert.equal(await page.locator('#private-records [data-record]').count(), 0, 'Old private records became visible in the new account');
    assert.equal(await page.locator('#saved-designs .record-card').count(), 0, 'Old saved cards became visible in the new account');
    return { held_endpoints: endpoints, synchronization: 'route.fetch before logout; route.fulfill after new login; requestfinished and render frames' };
  } finally {
    released.resolve();
    await bounded(finished.promise, 'Delayed request cleanup').catch(() => {});
    for (const endpoint of endpoints) await page.unroute('**' + endpoint, handler);
  }
}

async function main() {
  const address = new URL(base);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname), 'Browser QA may only modify a loopback service');
  assert.equal(address.protocol, 'http:', 'Browser QA expects the local HTTP service');
  assert.ok(process.env.XIHA_QA_DATA_DIR, 'XIHA_QA_DATA_DIR is required; start an isolated QA server first');
  const dataDirectory = fs.realpathSync(path.resolve(process.env.XIHA_QA_DATA_DIR));
  assert.ok(!dataDirectory.split(path.sep).includes('.local'), 'QA must not use an actual app/.local data directory');
  const accountText = fs.readFileSync(path.join(dataDirectory, '本机管理者账号.txt'), 'utf8');
  const managerCredentials = { username: accountText.match(/^账号：(.+)$/m)?.[1].trim(), password: accountText.match(/^密码：(.+)$/m)?.[1].trim() };
  assert.ok(managerCredentials.username && managerCredentials.password, 'The isolated manager credential file is incomplete');
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const userCredentials = { username: 'qa_v2_user_' + suffix, password: 'QaV2TestOnly-' + suffix };
  const nextCredentials = { username: 'qa_v2_next_' + suffix, password: 'QaV2SecondOnly-' + suffix };
  secrets.push(managerCredentials.username, managerCredentials.password, userCredentials.username, userCredentials.password, nextCredentials.username, nextCredentials.password);
  fs.mkdirSync(output, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const userContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, reducedMotion: 'reduce' });
  const userPage = await userContext.newPage();
  activePage = userPage;
  monitor(userPage, 'ordinary');
  userPage.setDefaultTimeout(12000);
  await userPage.goto(base, { waitUntil: 'domcontentloaded' });
  await userPage.locator('#home-presets [data-action="use-preset"]').first().waitFor({ state: 'visible' });
  const bootResult = await getJSON(userPage, '/api/bootstrap');
  assert.equal(bootResult.status, 200, 'Bootstrap failed');
  const boot = bootResult.data;
  assert.equal(boot.products.length, 0, 'Use an isolated dataset with no initially published products');
  assert.equal(boot.presets.length, 3, 'Expected three reference presets');
  assert.equal(await userPage.locator('#home-presets [data-action="use-preset"]').count(), 3, 'Empty-product homepage must still expose three presets');
  await userPage.screenshot({ path: path.join(output, '首页.png'), fullPage: true });
  currentStage = 'homepage and presets';
  for (let index = 0; index < boot.presets.length; index += 1) {
    await go(userPage, 'home');
    await userPage.locator(`#home-presets [data-action="use-preset"][data-index="${index}"]`).click();
    await userPage.locator('#page-studio').waitFor({ state: 'visible' });
    const preset = boot.presets[index];
    for (const role of ['main', 'support', 'accent']) {
      const component = preset.components.find(item => item.role === role);
      const slotText = await userPage.locator('#slot-' + role).innerText();
      if (component) assert.ok(slotText.includes(component.name), 'Preset inserted an incorrect ' + role + ' material');
      else assert.equal(await userPage.locator('#slot-' + role + ' .slot-material').count(), 0, 'Preset retained an obsolete role');
    }
    assert.equal(await userPage.locator('#design-scene').inputValue(), preset.scenario, 'Preset scene was lost');
    assert.equal(await userPage.locator('#design-words').inputValue(), '', 'Preset intent must not impersonate the user');
  }
  checkpoint('home-presets', '无商品首页仍有三份参考香型，一键入案与三个构图角色对应准确');

  currentStage = 'presets preserve explicit exclusions';
  const blockedPreset = boot.presets[1];
  const blockedComponent = blockedPreset.components.find(item => item.role === 'main');
  const blockedControl = userPage.locator(`[data-exclude="${blockedComponent.profile_id}"]`);
  await showControl(blockedControl);
  await blockedControl.check();
  const assertPresetExclusion = async () => {
    assert.equal(await userPage.locator(`[data-exclude="${blockedComponent.profile_id}"]`).isChecked(), true, 'Preset silently relaxed an explicit exclusion');
    const slotText = await userPage.locator('#role-slots').innerText();
    assert.ok(!slotText.includes(blockedComponent.name), 'Preset inserted an excluded material into a role');
    assert.match(await userPage.locator('#studio-message').innerText(), /排除|冲突|不加入/, 'Conflicting preset gave no exclusion feedback');
  };
  await go(userPage, 'home');
  await userPage.locator('#home-presets [data-action="use-preset"][data-index="1"]').click();
  await userPage.locator('#page-studio').waitFor({ state: 'visible' });
  await assertPresetExclusion();
  const drawerPreset = userPage.locator('#preset-list [data-action="use-preset"][data-index="1"]');
  await showControl(drawerPreset);
  await drawerPreset.click();
  await assertPresetExclusion();
  await showControl(blockedControl);
  await blockedControl.uncheck();
  await showControl(drawerPreset);
  await drawerPreset.click();
  assert.ok((await userPage.locator('#slot-main').innerText()).includes(blockedComponent.name), 'Explicitly canceling the exclusion did not restore access to the preset');
  await userPage.locator('#clear-design').click();
  await go(userPage, 'home');
  checkpoint('preset-exclusions', '首页与抽屉预设都保留明确排除并解释冲突，只有用户主动取消后才能加入材料');

  currentStage = 'ordinary private consultation';
  await authenticate(userPage, userCredentials, true);
  assert.equal(await userPage.locator('.main-nav [data-page="manage"]').isVisible(), false, 'Ordinary user sees the manager navigation');
  await go(userPage, 'collection');
  const userFixture = { name: 'QA V2 Private ' + suffix, brand: 'QA Test Fixture', description: 'Private household fixture. Label describes woody and herbal notes. Not a real product.', notes: 'woody\nherbal', ingredients: 'QA_V2_USER_INGREDIENT_PRIVATE_' + suffix, personal_notes: 'QA_V2_USER_OBSERVATION_PRIVATE_' + suffix };
  const userProduct = await upload(userPage, 'private', userFixture);
  const userPublish = await getJSON(userPage, '/api/products/' + userProduct.id + '/publish', 'POST', {});
  assert.equal(userPublish.status, 403, 'Ordinary private record acquired homepage permission');
  const roleSpoof = await getJSON(userPage, '/api/register', 'POST', { username: 'qa_reject_' + suffix, password: 'QaRejectedOnly-123', role: 'manager' });
  assert.equal(roleSpoof.status, 403, 'Public registration accepted a manager role');
  const catalogSpoof = await getJSON(userPage, '/api/products', 'POST', { name: 'QA Rejected Catalog', kind: 'catalog' });
  assert.equal(catalogSpoof.status, 403, 'Ordinary user created a manager catalog record');
  await go(userPage, 'home');
  assert.ok(!(await userPage.locator('#home-products').innerText()).includes(userFixture.name), 'Private household upload was published');
  checkpoint('private-consultation', '普通账号文字上传、分层咨询与私有归属成立，伪造角色和目录类型被拒绝');

  currentStage = 'composition interactions';
  await userPage.locator('#home-presets [data-action="use-preset"][data-index="1"]').click();
  await userPage.locator('#page-studio').waitFor({ state: 'visible' });
  const preset = boot.presets[1];
  const mainId = preset.components.find(item => item.role === 'main').profile_id;
  const excludedId = preset.components.find(item => item.role === 'accent')?.profile_id || boot.profiles.find(item => item.id !== mainId).id;
  const sceneControl = userPage.locator('[data-scene]').first();
  await showControl(sceneControl);
  const scene = await sceneControl.getAttribute('data-scene');
  assert.ok(scene, 'Scene shortcut has no value');
  await sceneControl.click();
  assert.equal(await userPage.locator('#design-scene').inputValue(), scene, 'Scene shortcut did not update the scene');
  await toggleFacet(userPage, 'preferred', 'sweet', true);
  await toggleFacet(userPage, 'deemphasized', 'sweet', true);
  assert.equal(await userPage.locator('[data-group="preferred"][data-key="sweet"]').getAttribute('aria-pressed'), 'false', 'Preferred and reduced facets must be mutually exclusive');
  await toggleFacet(userPage, 'preferred', 'sweet', true);
  assert.equal(await userPage.locator('[data-group="deemphasized"][data-key="sweet"]').getAttribute('aria-pressed'), 'false', 'Reverse facet selection did not clear the conflict');
  await toggleFacet(userPage, 'deemphasized', 'sweet', true);
  const exclusion = userPage.locator(`[data-exclude="${excludedId}"]`);
  await showControl(exclusion);
  await exclusion.check();
  assert.equal(await userPage.locator('#slot-accent .slot-material').count(), 0, 'Excluded material stayed in the active composition');
  await userPage.locator('#lock-main').check();
  const selectedPreferences = await userPage.locator('[data-action="toggle-facet"][data-group="preferred"][aria-pressed="true"]').evaluateAll(nodes => nodes.map(node => node.dataset.key));
  for (const key of selectedPreferences) await toggleFacet(userPage, 'preferred', key, false);
  await toggleFacet(userPage, 'preferred', 'floral', true);
  await generate(userPage, 'no_supported_preferences');
  await userPage.locator('#candidates-section').waitFor({ state: 'hidden' });
  const unknownMessage = await userPage.locator('#studio-message').innerText();
  assert.match(unknownMessage, /花香/, 'Unknown flower preference was not named in the feedback');
  assert.match(unknownMessage, /未|没有|暂无|缺|待|不足|不能/, 'Unknown flower preference was not explained');
  assert.equal(await userPage.locator(`[data-exclude="${excludedId}"]`).isChecked(), true, 'Unsupported preference cleared the exclusion');
  await toggleFacet(userPage, 'preferred', 'floral', false);
  await toggleFacet(userPage, 'preferred', 'woody', true);
  let composition = await generate(userPage);
  const assertComposition = result => {
    assert.equal(result.data.candidates.length, 2, 'Expected two comparison candidates');
    assert.equal(result.request.locked_main_id, mainId, 'Locked main material was lost');
    assert.ok(result.request.excluded_ids.includes(excludedId), 'Composition request lost the exclusion');
    assert.ok(!result.request.preferred_facets.some(key => result.request.deemphasized_facets.includes(key)), 'Composition contains conflicting facets');
    for (const candidate of result.data.candidates) {
      assert.equal(candidate.components.find(item => item.role === 'main').profile_id, mainId, 'Candidate changed a locked main material');
      assert.ok(candidate.components.every(item => item.profile_id !== excludedId), 'Candidate reintroduced an excluded material');
    }
  };
  assertComposition(composition);
  await userPage.locator('#candidates-section').waitFor({ state: 'visible' });
  assert.equal(await userPage.locator('#candidate-results .candidate-card').count(), 2, 'Two API candidates were not rendered');
  const changedScene = 'QA revised reading scene';
  await userPage.locator('#design-scene').fill(changedScene);
  await userPage.locator('#candidates-section').waitFor({ state: 'hidden' });
  composition = await generate(userPage);
  assertComposition(composition);
  const changedWords = 'Keep the woody character. Less sweet. This is a private test design.';
  await userPage.locator('#design-words').fill(changedWords);
  await userPage.locator('#candidates-section').waitFor({ state: 'hidden' });
  composition = await generate(userPage);
  assertComposition(composition);
  await userPage.screenshot({ path: path.join(output, '调香工作台.png'), fullPage: true });
  checkpoint('composition', '场景快捷选择、偏好互斥、主调锁定、材料排除及未知花香反馈有效；场景与原话修改使旧候选失效');

  currentStage = 'scent card and simulation';
  await userPage.locator('#candidate-results [data-action="candidate-card"]').first().click();
  await userPage.locator('#card-dialog').waitFor({ state: 'visible' });
  const cardName = 'QA Scent Card ' + suffix;
  await userPage.locator('#card-name').fill(cardName);
  const preview = await userPage.locator('#card-preview').innerText();
  assert.ok(preview.includes(changedScene) && preview.includes(changedWords), 'Card preview does not use the latest scene and user words');
  assert.ok(preview.includes(boot.profiles.find(item => item.id === excludedId).name), 'Card preview lost the excluded material');
  assert.match(preview, /尚未.*实闻/, 'Card preview does not disclose its unverified state');
  await userPage.screenshot({ path: path.join(output, '香笺预览.png'), fullPage: true });
  await responseFor(userPage, '/api/designs', 'POST', () => userPage.locator('#save-card').click(), 201);
  const downloading = userPage.waitForEvent('download');
  await userPage.locator('#download-card').click();
  const download = await downloading;
  assert.equal(await download.failure(), null, 'Browser rejected the PNG download');
  const pngPath = path.join(output, '香笺.png');
  await download.saveAs(pngPath);
  const png = inspectPNG(pngPath);
  const saved = await getJSON(userPage, '/api/designs');
  const savedCard = saved.data.designs.map(item => item.design || item).find(item => item.name === cardName);
  assert.ok(savedCard, 'Explicit save did not retain a personal design');
  assert.equal(savedCard.scenario, changedScene, 'Saved design has an obsolete scene');
  assert.equal(savedCard.user_notes, changedWords, 'Saved design has obsolete user words');
  assert.ok(savedCard.excluded_ids.includes(excludedId), 'Saved design lost the exclusion');
  checkpoint('png-export', '最终双候选形成香笺，最新场景、原话及排除项保存一致，PNG 头与尺寸有效', { png, file: '香笺.png' });
  await userPage.locator('#card-to-integration').click();
  await userPage.locator('#integration-scene').selectOption('reading');
  const handoff = await responseFor(userPage, '/api/simulation', 'POST', () => userPage.locator('#handoff-design').click());
  assert.equal(handoff.data.status, 'accepted', 'Wood-based card was rejected by the simulated reading space');
  assert.equal(await userPage.locator('#simulation-on').isDisabled(), true, 'Simulation can run before user confirmation');
  await responseFor(userPage, '/api/simulation', 'POST', () => userPage.locator('[data-action="confirm-simulation"]').click());
  const start = await responseFor(userPage, '/api/simulation', 'POST', () => userPage.locator('#simulation-on').click());
  assert.equal(start.data.simulation.running, true, 'Simulated device did not start');
  await userPage.locator('#simulation-duration').fill('12');
  const timer = await responseFor(userPage, '/api/simulation', 'POST', () => userPage.locator('#simulation-timer').click());
  assert.equal(timer.data.simulation.timer_minutes, 12, 'Simulated timer did not retain the chosen value');
  const stop = await responseFor(userPage, '/api/simulation', 'POST', () => userPage.locator('#simulation-off').click());
  assert.equal(stop.data.simulation.running, false, 'Simulated device did not stop');
  // The spicy preset uses the material excluded in the preceding design. The user
  // explicitly cancels that exclusion before testing the space's rejection rule.
  await go(userPage, 'studio');
  await showControl(userPage.locator(`[data-exclude="${excludedId}"]`));
  await userPage.locator(`[data-exclude="${excludedId}"]`).uncheck();
  await go(userPage, 'home');
  await userPage.locator('#home-presets [data-action="use-preset"][data-index="2"]').click();
  await go(userPage, 'integration');
  await userPage.locator('#integration-design').selectOption('current');
  await userPage.locator('#integration-scene').selectOption('reading');
  const rejected = await responseFor(userPage, '/api/simulation', 'POST', () => userPage.locator('#handoff-design').click());
  assert.equal(rejected.data.status, 'rejected', 'Spicy main material bypassed the explicit simulated compatibility rule');
  assert.equal(await userPage.locator('#simulation-on').isDisabled(), true, 'Rejected handoff retained a runnable device');
  checkpoint('simulation', '软件模拟的接受、确认、开关、定时和有理由拒绝均可完成');

  currentStage = 'manager publication and ownership';
  const managerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const managerPage = await managerContext.newPage();
  monitor(managerPage, 'manager');
  managerPage.setDefaultTimeout(12000);
  await managerPage.goto(base, { waitUntil: 'domcontentloaded' });
  await managerPage.locator('#home-presets [data-action="use-preset"]').first().waitFor({ state: 'visible' });
  await authenticate(managerPage, managerCredentials);
  await go(managerPage, 'collection');
  const managerPrivate = await upload(managerPage, 'private', { name: 'QA V2 Manager Private ' + suffix, brand: 'QA Test Fixture', description: 'Private manager consultation fixture. Woody label notes.', notes: 'woody', ingredients: 'QA_V2_MANAGER_PRIVATE_' + suffix, personal_notes: 'QA_V2_MANAGER_OBSERVATION_' + suffix });
  assert.equal((await getJSON(managerPage, '/api/products/' + managerPrivate.id + '/publish', 'POST', {})).status, 403, 'Manager private consultation was publishable');
  await go(managerPage, 'manage');
  const catalogFixture = { name: 'QA V2 Catalog ' + suffix, brand: 'QA Test Fixture', description: 'Browser verification fixture with woody resinous notes. Not a real sale product.', notes: 'woody\nresinous\nsweet', ingredients: 'QA_V2_CATALOG_INGREDIENT_PRIVATE_' + suffix, personal_notes: 'QA_V2_CATALOG_OBSERVATION_PRIVATE_' + suffix };
  const catalog = await upload(managerPage, 'manager', catalogFixture);
  let record = managerPage.locator(`[data-record="${catalog.id}"]`);
  await record.locator('input[name="purchase_url"]').fill('https://example.com/qa-product');
  for (const field of ['description', 'notes', 'source_url']) await record.locator(`input[name="public_fields"][value="${field}"]`).check();
  for (const field of ['ingredients', 'price']) await record.locator(`input[name="public_fields"][value="${field}"]`).uncheck();
  await responseFor(managerPage, '/api/products/' + catalog.id + '/publish', 'POST', () => record.locator('button[type="submit"]').click());
  await managerPage.locator(`[data-record="${catalog.id}"]`).getByText('已挂首页', { exact: true }).waitFor();
  await go(managerPage, 'home');
  await managerPage.locator('#home-products').getByText(catalogFixture.name, { exact: true }).waitFor();
  const publicSnapshot = await getJSON(userPage, '/api/bootstrap');
  assert.equal(publicSnapshot.data.products.length, 1, 'Homepage includes a private consultation');
  const publicProduct = publicSnapshot.data.products[0];
  assert.equal(publicProduct.id, catalog.id, 'Homepage published the wrong record');
  assert.equal(publicProduct.purchase_url, 'https://example.com/qa-product', 'Published purchase link changed');
  for (const field of ['ingredients', 'personal_notes', 'file_name', 'asset_url', 'owner_id']) assert.equal(Object.hasOwn(publicProduct, field), false, 'Public product exposes private field ' + field);
  const publicText = JSON.stringify(publicSnapshot.data.products);
  for (const marker of [catalogFixture.ingredients, catalogFixture.personal_notes, userFixture.name, managerPrivate.name]) assert.ok(!publicText.includes(marker), 'Public projection leaks an unselected/private field');
  assert.equal((await getJSON(userPage, '/api/products/' + catalog.id + '/publish', 'POST', {})).status, 403, 'Ordinary user can publish a manager product');
  assert.equal((await getJSON(userPage, '/api/products/' + catalog.id, 'PATCH', { description: 'QA forbidden edit' })).status, 404, 'Ordinary user can edit another owner\'s product');
  assert.equal((await getJSON(userPage, '/api/products/' + managerPrivate.id + '/asset')).status, 404, 'Ordinary user can access another owner\'s private asset path');
  assert.equal((await getJSON(managerPage, '/api/products/' + userProduct.id, 'PATCH', { description: 'QA forbidden manager edit' })).status, 404, 'Manager can edit another owner\'s private product');
  const ownProducts = await getJSON(userPage, '/api/products');
  assert.deepEqual(ownProducts.data.products.map(item => item.id), [userProduct.id], 'User product list crossed an ownership boundary');
  checkpoint('manager-publication', '双角色可分别咨询本人香品；管理者选择公开字段后首页展示，普通账号与跨所有者请求均被拒绝');

  currentStage = 'ordinary public recommendation and design matching';
  await go(userPage, 'home');
  await userPage.reload({ waitUntil: 'domcontentloaded' });
  await userPage.locator('#home-products').getByText(catalogFixture.name, { exact: true }).waitFor();
  await userPage.locator(`#home-products [data-action="product-detail"][data-id="${catalog.id}"]`).click();
  await userPage.locator('#detail-dialog').waitFor({ state: 'visible' });
  const publicDetails = await userPage.locator('#detail-content').innerText();
  for (const marker of [catalogFixture.ingredients, catalogFixture.personal_notes, managerPrivate.name]) assert.ok(!publicDetails.includes(marker), 'Ordinary product detail leaks private information');
  assert.equal(await userPage.locator('#detail-content a[href="https://example.com/qa-product"]').count(), 1, 'Public product detail has no purchase link');
  await userPage.locator('#detail-dialog .close-dialog').click();
  await go(userPage, 'collection');
  const savedRecord = userPage.locator('#saved-designs .record-card').filter({ hasText: cardName });
  await savedRecord.locator('[data-action="reopen-design"]').click();
  await userPage.locator('#card-dialog').waitFor({ state: 'visible' });
  const matched = await responseFor(userPage, '/api/match', 'POST', () => userPage.locator('#find-matches').click());
  assert.equal(matched.data.status, 'ok', 'Public product matching failed');
  assert.equal(matched.data.matches.length, 1, 'Matching did not use the one public catalog product');
  assert.equal(matched.data.matches[0].product.id, catalog.id, 'Matching selected private consultation data');
  assert.equal(matched.data.matches[0].exclusion_status, 'unknown_not_guaranteed', 'Incomplete declarations were incorrectly treated as an exclusion guarantee');
  await userPage.locator('#card-matches').getByText(catalogFixture.name, { exact: true }).waitFor();
  assert.match(await userPage.locator('#card-matches').innerText(), /不能保证|未验证/, 'Product match omits the unknown boundary');
  await userPage.locator('#card-dialog .close-dialog').click();
  await savedRecord.locator('[data-action="reopen-design"]').click();
  await userPage.locator('#card-dialog').waitFor({ state: 'visible' });
  assert.ok(!(await userPage.locator('#card-matches').innerText()).includes(catalogFixture.name), 'Reopening a saved card retained a previous product match');
  await userPage.locator('#card-dialog .close-dialog').click();
  await go(userPage, 'home');
  await userPage.locator('#home-presets [data-action="use-preset"][data-index="1"]').click();
  checkpoint('public-recommendation', '普通账号能阅读公开商品与购买入口，已保存香笺只匹配公开商品并保留排除条件未知提示');

  currentStage = 'responsive layout and screenshots';
  await go(userPage, 'library');
  await userPage.screenshot({ path: path.join(output, '香材图鉴.png'), fullPage: true });
  const layouts = [];
  for (const width of [1440, 768, 390, 360]) {
    await userPage.setViewportSize({ width, height: width <= 390 ? 844 : 1000 });
    for (const pageName of ['home', 'studio', 'collection', 'library', 'integration']) {
      await go(userPage, pageName);
      layouts.push(await noOverflow(userPage, pageName, width));
      if (pageName === 'studio' && width !== 1440) await userPage.screenshot({ path: path.join(output, '手机调香-' + width + '.png'), fullPage: true });
    }
    await managerPage.setViewportSize({ width, height: width <= 390 ? 844 : 1000 });
    for (const pageName of ['home', 'studio', 'collection', 'library', 'integration', 'manage']) {
      await go(managerPage, pageName);
      layouts.push(await noOverflow(managerPage, 'manager-' + pageName, width));
    }
    await go(userPage, 'studio');
    await userPage.locator('#save-current-card').click();
    await userPage.locator('#card-dialog').waitFor({ state: 'visible' });
    layouts.push(await noOverflow(userPage, 'card-dialog', width));
    await userPage.locator('#card-dialog .close-dialog').click();
  }
  checkpoint('responsive', '360／390／768／1440 像素下两种角色所有页面和香笺弹窗均无全页横向溢出', { layouts });

  currentStage = 'product withdrawal';
  await managerPage.setViewportSize({ width: 1440, height: 1000 });
  await go(managerPage, 'manage');
  record = managerPage.locator(`[data-record="${catalog.id}"]`);
  await responseFor(managerPage, '/api/products/' + catalog.id + '/unpublish', 'POST', () => record.locator('[data-action="unpublish"]').click());
  await managerPage.locator(`[data-record="${catalog.id}"]`).getByText('仅本人可见', { exact: true }).waitFor();
  await go(managerPage, 'home');
  assert.ok(!(await managerPage.locator('#home-products').innerText()).includes(catalogFixture.name), 'Withdrawn product remains in the homepage DOM');
  assert.equal((await getJSON(userPage, '/api/bootstrap')).data.products.length, 0, 'Withdrawn product remains public through the API');
  checkpoint('withdrawal', '管理者撤下后首页与公共接口同步移除商品，私有档案继续保留');

  currentStage = 'delayed requests across logout and account change';
  await userPage.setViewportSize({ width: 1440, height: 1000 });
  await go(userPage, 'collection');
  await userPage.locator(`[data-record="${userProduct.id}"]`).waitFor({ state: 'visible' });
  await userPage.locator('#saved-designs').getByText(cardName, { exact: true }).waitFor();
  const race = await checkStalePrivateResponses(userPage, userProduct, cardName, nextCredentials);
  checkpoint('stale-private-responses', '退出并切换账号后，延迟到达的旧产品与旧设计响应不会回填私人资料', race);

  currentStage = 'browser telemetry';
  assert.deepEqual(errors, [], 'Browser pageerror detected');
  assert.deepEqual(requestFailures, [], 'Browser requestfailed detected');
  assert.deepEqual(static404s, [], 'Static resource 404 detected');
  checkpoint('telemetry', '浏览器无 pageerror、requestfailed 或静态资源 404');
}

(async () => {
  let passed = false;
  let failure;
  try {
    await main();
    passed = true;
  } catch (error) {
    failure = { stage: currentStage, message: redact(error.message), stack: redact(error.stack) };
    process.exitCode = 1;
    if (activePage && !activePage.isClosed() && fs.existsSync(output)) {
      const authVisible = await activePage.locator('#auth-dialog').isVisible().catch(() => true);
      if (!authVisible) await activePage.screenshot({ path: path.join(output, '失败现场.png'), fullPage: true }).catch(() => {});
    }
  } finally {
    if (browser) await browser.close();
  }
  const report = {
    passed,
    base,
    generated_at: new Date().toISOString(),
    results,
    errors,
    request_failures: requestFailures,
    static_404s: static404s,
    failure,
    scope: '真实本地 Chrome 与隔离账号、纯英文测试资料；不访问正式数据，不验证实际气味、商家成交或真实设备。',
  };
  if (fs.existsSync(output)) fs.writeFileSync(path.join(output, '浏览器验收.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed, checks: results.length, errors: errors.length, request_failures: requestFailures.length, static_404s: static404s.length, failure }));
})().catch(error => {
  console.error(redact(error.stack));
  process.exitCode = 1;
});
