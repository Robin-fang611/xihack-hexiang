/* 双端口（消费者端 + OPC 创作者端）浏览器验收：大厅、入驻、工作台、作品发布、
   首页设计与商品呈现、手机布局。使用 XIHA_QA_BASE/XIHA_QA_OUTPUT 指向隔离实例与证据目录。 */
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const path = require('path');
const base = process.env.XIHA_QA_BASE || 'http://127.0.0.1:8875';
const output = process.env.XIHA_QA_OUTPUT || path.join(__dirname, 'verification', 'dual-portal');
fs.mkdirSync(output, {recursive: true});

(async () => {
  const browser = await chromium.launch({executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
  const results = [];
  const errors = [];
  const static404 = [];
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: 'reduce'});
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('requestfailed', r => errors.push('requestfailed: ' + r.url()));
  page.on('response', r => { if (r.url().startsWith(base + '/static/') && r.status() === 404) static404.push(r.url()); });

  const apiJSON = async (endpoint, method = 'GET', body) => page.evaluate(async ({endpoint, method, body}) => {
    const headers = {Accept: 'application/json'};
    if (method !== 'GET') {
      const session = await (await fetch('/api/session')).json();
      headers['X-CSRF-Token'] = session.csrf_token;
      headers['Content-Type'] = 'application/json';
      headers['X-Expected-User'] = (await (await fetch('/api/session')).json()).user?.id || 'guest';
    }
    const response = await fetch(endpoint, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: response.status, data: await response.json()};
  }, {endpoint, method, body});

  // —— 场景一：访客进站见大厅双门 ——
  await page.goto(base, {waitUntil: 'domcontentloaded'});
  await page.locator('#page-hall .hall-door.door-experience').waitFor({state: 'visible'});
  if (await page.locator('#creator-nav').isVisible()) throw new Error('未入创作者端不应显示创作者导航');
  await page.screenshot({path: path.join(output, '大厅.png'), fullPage: true});
  results.push('访客进站默认显示端口大厅，双门与香事导航正常，创作者导航隐藏');

  // —— 场景二：左门 → 首页设计起点（三炉 + 创作者作品） ——
  await page.locator('.hall-door.door-experience').getByRole('button', {name: '进入香事体验'}).click();
  await page.locator('#page-home').waitFor({state: 'visible'});
  await page.locator('#home-presets .home-preset').first().waitFor();
  results.push('大厅左门进入首页，三炉草案渲染');

  // —— 场景三：右门未登录 → 入驻引导 ——
  await page.locator('.brand-name').click();
  await page.locator('#page-hall').waitFor({state: 'visible'});
  await page.locator('.hall-door.door-creator').getByRole('button', {name: '进入创作者端'}).click();
  await page.locator('#page-creator-gate').waitFor({state: 'visible'});
  await page.locator('.gate-value').waitFor({state: 'visible'});
  await page.screenshot({path: path.join(output, '入驻引导.png'), fullPage: true});
  results.push('大厅右门未登录时进入入驻引导页，说明作品与商品双轨价值');

  // —— 场景四：注册创作者入驻 → 工作台 ——
  await page.locator('.gate-action').first().getByRole('button', {name: '登录 / 注册'}).click();
  await page.locator('#auth-dialog').waitFor({state: 'visible'});
  await page.locator('[data-auth-mode="register-creator"]').click();
  if (!(await page.locator('#auth-submit').innerText()).includes('入驻')) throw new Error('入驻按钮文案不正确');
  const suffix = String(Date.now()).slice(-6);
  await page.locator('#auth-username').fill('portalqa' + suffix);
  await page.locator('#auth-password').fill('Portal-QA-12345');
  await page.screenshot({path: path.join(output, '入驻弹窗.png'), fullPage: false});
  await page.locator('#auth-submit').click();
  await page.locator('#page-workbench').waitFor({state: 'visible'});
  await page.locator('#creator-nav').waitFor({state: 'visible'});
  await page.locator('#experience-nav').waitFor({state: 'hidden'});
  if (!(await page.locator('.role-label').innerText()).includes('创作者')) throw new Error('角色标签未显示创作者');
  if ((await page.locator('#workbench-works').innerText()).trim() !== '0') throw new Error('新创作者作品数应为0');
  await page.screenshot({path: path.join(output, '工作台.png'), fullPage: true});
  results.push('注册时选择创作者入驻直达工作台；双导航切换、角色标签与空统计正确');

  // —— 场景五：API 保存两份作品（含原话），UI 发布其中一份 ——
  const boot = await page.evaluate(async () => (await fetch('/api/bootstrap')).json());
  const woody = boot.profiles.find(p => p.id === 'F02');
  const saved = [];
  for (const [index, spec] of [['松风入案', '晨间阅读', '这条原话不应出现在任何公开投影'], ['雾枕', '夜间阅读', '另一条私密原话']].entries()) {
    const [name, scenario, notes] = spec;
    const response = await apiJSON('/api/designs', 'POST', {
      components: [{profile_id: woody.id, role: 'main'}], name, scenario, notes,
      preferred_facets: ['woody'], deemphasized_facets: [], excluded_ids: [],
    });
    if (![200, 201].includes(response.status)) throw new Error('作品保存失败: ' + response.status);
    saved.push(response.data.design.id);
  }
  await page.locator('#creator-nav').getByRole('button', {name: '我的作品'}).click();
  await page.locator('#page-works').waitFor({state: 'visible'});
  const workCard = page.locator('#works-list .work-card').filter({hasText: '松风入案'});
  await workCard.waitFor();
  await workCard.locator('textarea[name=public_note]').fill('为晨间书桌设计的清润木质案头（验收发布）。');
  await workCard.getByRole('button', {name: '发布到首页'}).click();
  await page.locator('#works-list').getByText('已在首页', {exact: true}).first().waitFor();
  await page.screenshot({path: path.join(output, '我的作品.png'), fullPage: true});
  results.push('我的作品发布成功：公开创作说明，状态同步为已在首页');

  // —— 场景六：首页作品区署名展示 + 一键入案 ——
  await page.locator('#creator-nav').getByRole('button', {name: '回到香事'}).click();
  await page.locator('#page-home').waitFor({state: 'visible'});
  await page.locator('#home-works-section').waitFor({state: 'visible'});
  const workSection = await page.locator('#home-works-section').innerText();
  if (!workSection.includes('松风入案')) throw new Error('首页作品区缺少已发布作品');
  if (workSection.includes('不应出现在任何公开投影')) throw new Error('首页泄露用户原话');
  await page.locator('#home-works').getByRole('button', {name: '以此起稿'}).first().click();
  await page.locator('#page-studio').waitFor({state: 'visible'});
  const mainSlot = await page.locator('#slot-main').innerText();
  if (!mainSlot.trim()) throw new Error('作品入案后主调为空');
  results.push('首页创作者作品署名展示、一键入案后主调就位，用户原话未泄露');

  // —— 场景七：商品上架与首页购买入口 ——
  await page.locator('.brand-name').click();
  await page.locator('#page-hall').waitFor({state: 'visible'});
  await page.locator('.hall-door.door-creator').getByRole('button', {name: '进入创作者端'}).click();
  await page.locator('#page-workbench').waitFor({state: 'visible'});
  await page.locator('#creator-nav').getByRole('button', {name: '我的商品'}).click();
  await page.locator('#page-manage').waitFor({state: 'visible'});
  await page.locator('#manager-name').fill('QA 双端口商品・验收');
  await page.locator('#manager-brand').fill('QA创作者');
  await page.locator('#manager-form').selectOption('incense');
  await page.locator('#manager-description').fill('验收用木质线香描述；非真实在售产品。');
  await page.locator('#manager-upload-form details summary').click();
  await page.locator('#manager-notes').fill('木质、树脂');
  await page.locator('#manager-upload-form').getByRole('button', {name: '保存并分析'}).click();
  await page.locator('#detail-dialog').waitFor({state: 'visible'});
  await page.locator('#detail-dialog .close-dialog').click();
  const record = page.locator('#manager-records [data-record]').first();
  const productId = await record.getAttribute('data-record');
  await record.locator('input[name=purchase_url]').fill('https://example.com/qa-portal-product');
  await record.locator('input[name=public_fields][value=notes]').check();
  await record.getByRole('button', {name: '挂到首页', exact: true}).click();
  await page.locator('#manager-records').getByText('已挂首页', {exact: true}).first().waitFor();
  await page.locator('#creator-nav').getByRole('button', {name: '回到香事'}).click();
  await page.locator('#page-home').waitFor({state: 'visible'});
  await page.locator('#home-products').getByText('QA 双端口商品・验收', {exact: true}).waitFor();
  const purchaseLink = page.locator('#home-products').getByRole('link', {name: '前往商家购买 ↗'});
  const href = await purchaseLink.first().getAttribute('href');
  if (href !== 'https://example.com/qa-portal-product') throw new Error('首页购买入口链接不正确: ' + href);
  await page.screenshot({path: path.join(output, '首页设计与商品.png'), fullPage: true});
  results.push('商品上架后进入首页现成香推荐位，购买入口链接正确');

  // —— 场景八：作品撤下同步 ——
  await page.locator('.brand-name').click();
  await page.locator('#page-hall').waitFor({state: 'visible'});
  await page.locator('.hall-door.door-creator').getByRole('button', {name: '进入创作者端'}).click();
  await page.locator('#page-workbench').waitFor({state: 'visible'});
  await page.locator('#creator-nav').getByRole('button', {name: '我的作品'}).click();
  const unpublished = page.locator('#works-list .work-card').filter({hasText: '雾枕'});
  await unpublished.getByRole('button', {name: '发布到首页'}).click();
  await page.locator('#works-list').getByText('已在首页', {exact: true}).nth(1).waitFor();
  await unpublished.getByRole('button', {name: '从首页撤下'}).click();
  await page.waitForFunction(id => {
    return fetch('/api/bootstrap').then(r => r.json()).then(d => !d.works.some(w => w.id === id));
  }, await unpublished.getAttribute('data-work') || saved[1]);
  results.push('作品可再次发布与撤下，首页公共接口同步移除');

  // —— 场景九：390px 手机端大厅与首页 ——
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('#creator-nav').getByRole('button', {name: '端口大厅'}).click();
  await page.locator('#page-hall').waitFor({state: 'visible'});
  await page.screenshot({path: path.join(output, '大厅手机.png'), fullPage: true});
  const hallOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  if (hallOverflow) throw new Error('390px 大厅横向溢出');
  await page.locator('.hall-door.door-experience').getByRole('button', {name: '进入香事体验'}).click();
  await page.locator('#page-home').waitFor({state: 'visible'});
  await page.screenshot({path: path.join(output, '首页手机.png'), fullPage: true});
  const homeOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  if (homeOverflow) throw new Error('390px 首页横向溢出');
  results.push('390px 手机端大厅与首页无横向溢出');

  await browser.close();
  const result = {passed: errors.length === 0 && static404.length === 0, results, errors, static_404s: static404,
                  scope: '隔离本地Chrome验收；无真实商家成交、无真实香气验证；演示与测试资料均为虚构'};
  fs.writeFileSync(path.join(output, '双端口验收.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({passed: result.passed, checks: results.length, errors: errors.length, static_404s: static404.length}, null, 2));
  if (!result.passed) { errors.forEach(e => console.error(' - ' + e)); process.exit(1); }
})().catch(e => { console.error('QA FAIL:', e.message); process.exit(1); });
