# 本地软件接口契约

同源本地网页，JSON 请求和响应。角色为 `manager/user`，由服务端决定；会话用 HttpOnly、SameSite=Strict Cookie，`GET /api/session` 返回 `csrf_token`，修改类请求带 `X-CSRF-Token`。登录、注册与其他请求均校验本机来源。以下描述五轮迭代后的当前实现；原开发环境各轮已正式验收计轮，38 份运行源码下 36 项组合行为检查通过。公开验证摘录见 `verification/五轮公开验收.json`；本副本不包含原始完成收据目录。各阶段证据及验证范围见 [README](README.md)。

本次公开副本还完成了一次独立完整复验：36 项组合行为、57 项模块检查及原有完整回归全部通过；38 份运行源码与原最终版逐字节一致。公开环境的一分钟计时在独立 Chrome 关闭约 63.47 秒后已后台自动停止，先核内部状态再请求 HTTP；可配置的验证工具指纹与结果见公开摘要的 public_copy_validation。

内置网页对 `/api/products`、`/api/designs`、`/api/simulation` 及其子路径发送 `X-Expected-User`，值为页面当前用户 ID，匿名页为 `guest`。服务端收到该头时与 Cookie 对应身份比较，失配返回 HTTP 409、`code=session_changed`，在读取或写入业务对象前拒绝请求。该头是身份一致性保护，不代替会话、CSRF、角色或对象归属检查；为兼容已有调用者，未携带该头时仍执行原权限检查。

## 会话与公共内容

- GET /api/bootstrap → services.bootstrap_data() 的profiles、facets、vocabulary、presets、knowledge、sources、roles、data_version、scope、analysis_method，加products（首页公开商品）、capabilities、app_name、simulation_spaces。
- GET /api/session → {user:{id,username,display_name,role}|null,csrf_token}。
- POST /api/register → {username,password,display_name}，只创建普通用户，返回会话。
- POST /api/login → {username,password}，返回会话；首次初始化无管理者账号时自动生成本机管理者账号，凭据保存于本机账号文件并私有保管，接口不返回凭据。
- POST /api/logout → {ok:true}；撤销本 Cookie 对应会话及其后台模拟。登录替换旧会话时也撤销旧模拟。
- 接口失败用 HTTP 状态与 {error,code}。会话身份、对象归属、CSRF 和产品版本错误拒绝相应业务写入；有结构化核验状态的调香接口按下面约定返回。

## 本人香品与管理者首页

- GET /api/products → {products:[本人完整档案]}。
- POST /api/products → {name,brand,form,spec,description,notes,ingredients,personal_notes,source_url,kind?,file?} → {product}。kind=private/catalog，默认普通用户private、管理员catalog。普通用户不能创建catalog。
- file={name,type,data}；data为base64或data URL，照片/文字/PDF/Word单份上限8MB。OCR及文档文字由后端提取，analysis来源分层。
- 产品对象：{id,kind,name,brand,form,spec,description,notes,ingredients,personal_notes,source_url,analysis,created_at,updated_at,revision,published,public_fields,purchase_url,price,file_name,asset_url,ocr_status}。owner_id不由客户端控制；旧资料读取时 revision 默认 0，新建为 1，每次成功修改递增。
- PATCH /api/products/{id} → {上述可改资料文本,expected_revision}，更新本人资料，返回{product}。公开字段有改动时同步公开投影；未选择公开的私有字段不会暴露。
- GET /api/products/{id}/asset → 本人私有附件；未登录或非本人拒绝。
- POST /api/products/{id}/publish → 管理者本人catalog，{purchase_url,price,public_fields:[description,notes,ingredients,source_url,image,price],expected_revision}；name/brand/form/spec是商品必要公开身份。返回{product}。图片仅发布去元数据的独立公开副本。
- POST /api/products/{id}/unpublish → 管理者本人catalog，{expected_revision}，撤下并返回{product}。
- GET /api/public-assets/{id} → 只返回已公开且选定image的商品公开副本。
- 首页公开商品对象：{id,name,brand,form,spec,description?,notes?,ingredients?,source_url?,price?,purchase_url,analysis:{families,reported_notes,system_inferences,gaps},image_url?,seller_name,updated_at}；不含原图、私有附件、个人观察或完整咨询记录。

`expected_revision` 须为非负整数，布尔值、字符串和小数均返回 HTTP 400、`invalid_revision`。值与当前商品 revision 不同返回 HTTP 409、`product_conflict`，数据库事务中再次比较并写入（CAS），防止读取后又被其他请求更新。冲突发生前不生成新公开图片。内置客户端在修改、发布和撤下时携带读取的版本；省略该字段的旧调用者仍兼容，但无法表达客户端原先看到的版本。

内置编辑器收到 `product_conflict` 后保留原输入和公开字段选择，展示“重新加载核对”；读取最新值只更新对照与待保存版本，用户核对后才再次保存。后台列表的迟到 GET 也保留同账号正在编辑或已冲突的发布表单。

## 自由调香与保存

- POST /api/compose → {preferred_facets:中文或canonical/V编号数组,deemphasized_facets,excluded_ids,locked_main_id?,main_family?,limit?}；返回现有compose候选结构。
- POST /api/interpret → {user_notes,manual_preferred?,manual_deemphasized?,excluded_ids?} → {status:proposal/needs_confirmation/no_changes,proposal,recognized,unknown_segments,conflicts,analysis_method,applied:false,scope}。非法输入为 HTTP 400、status=invalid_request；user_notes 须为字符串，最多 12000 字，超长拒绝而非截断。网页原话框限制 600 字。
- interpret 只根据本机词表识别明确的更喜欢、减弱及材料排除；recognized 含引用原句、action、facet 或 profile_id。manual_text_conflict 需要用户选择保留当前项或按原话取舍，text_contradiction 暂停应用；疑问、复杂否定、功效和未收录意象进入 unknown_segments。接口不自动改条件或调用模型，网页确认应用后才使用提案，原排除项持续保留。
- POST /api/evaluate → {components:[{profile_id,role:main/support/accent,form?}],name,scenario,user_notes?,preferred_facets,deemphasized_facets,excluded_ids,locked_main_id?,mode?} → {status:ok,design} 或 {status,reason}。支持一至三个材料和唯一主调，材料、角色各不重复，所选形态须与现代参照档案一致；传统材料 ID、错误形态、被排除材料和其他调香域拒绝。
- design 包括 components、name、scenario、user_notes、资料来源、data_version、现代参照形态、composition_kind 和未验证状态；design.status=untested_composite_design，即使接口核验成功也不表示已制作或实闻。内部匹配指标不显示为气味含量。
- `locked_main_id` 为可选接续字段；锁定时保存当前主调 ID，解除锁定时内置客户端省略该字段。缺省字段不要求响应补成 null。核验后的设计还保留提供者传入的 description、intent、preset_id、starting_preset_id、raw_preferences、raw_exclusions，来源、许可和验证状态由服务端重建。
- GET /api/designs → {designs:[本人保存设计]}。
- POST /api/designs → /api/evaluate 同样输入，后端再次核验，仅保存本人设计。新记录返回 HTTP 201、{design,saved_existing:false}；直接重复调用 API 时，同账号相同规范化核验设计返回 HTTP 200、原 design.id 与 created_at、saved_existing:true。不同账号不共享保存记录。主调锁定和上述接续字段参与设计内容比较；内置前端对已知已保存签名先去重，不再次发送保存请求。
- POST /api/match → {design} → {status,matches:[{product,...匹配理由与未知}]}，只匹配首页公开商品。

PNG 没有下载或保存后端接口。内置网页在点击下载时取当前已核验香笺及名称快照，使用浏览器 Canvas 绘制 PNG，保留原话、偏好、排除、来源与未验证状态；下载不发送 POST /api/designs。保存和下载独立，保存失败也保留香笺与下载能力。查看已存作品不改当前草稿，明确“回到案头继续”后才采用其输入，当前排除项与作品排除项合并。

## 软件接入模拟

- POST /api/simulation，action=handoff 时 {action,design,space_id:reading/lobby}。服务端重核设计，reading 只接受 woody 主家族，lobby 接受 woody/balsamic，均为标明的模拟假设。返回 {status:accepted/rejected,reason,simulation?}；accepted 时生成本 Cookie 会话的新实例，并撤销该会话旧实例。
- simulation={id,space_id,confirmed,running,timer_minutes,remaining_minutes,remaining_seconds,expires_at,history,mode:software_simulation}。新交接默认未确认、未运行、10 分钟；实例只在当前服务进程内存中保存。
- 后续 {action:confirm/start/stop/set_timer/status,simulation_id,timer_minutes?} → {status:accepted,simulation}。匿名和登录用户均只能访问本 Cookie 会话的实例；未知、被替换或外会话 ID 返回 HTTP 404、simulation_not_found。
- confirm 在服务端记录确认；确认前 start 或 set_timer 返回 HTTP 409、simulation_confirmation_required。set_timer 仅接受 1–120 的整数分钟，字符串、小数、布尔值或越界值返回 HTTP 400、invalid_timer。运行中重新设时从新时长重新开始；重复 start 不重置正在运行的截止时间。
- 开始后用服务端单调时钟计时、后台定时器到时写入 auto_stop 历史，running=false、remaining_seconds=0、remaining_minutes=0、expires_at=null。关闭浏览器或暂停前端轮询不会阻止后台停止；服务进程须持续运行，重启后需重新交接。
- 服务端在同一会话锁中执行注销/会话替换与模拟操作，设计核验后再检查会话是否仍有效。已注销或过期的旧请求不能新建或操作模拟，返回 HTTP 409、session_changed 并撤销旧实例。
- 网页倒计时按秒显示，实际 running 和停止结论以服务端响应为准；断联时保留上次记录并暂停确认。案头、账号或交接对象改动会取消本页操作确认，重新交接后才可继续；案头改动本身不远程改写旧后台模拟。全部控制发生在软件中，无真实设备连接或自动配香。

## 前端模块与写入边界

界面以浏览器原生 ES modules 加载，无构建器或新依赖。`static/app.js` 只负责初始化、事件绑定与模块协调，不挂载业务状态到 window。

| 文件 | 职责 | 依赖边界 |
| --- | --- | --- |
| `modules/core.js` | 共享状态、DOM、转义、来源链接、同源请求和消息 | 不导入任何业务模块；401处理由入口注入 |
| `modules/account.js` | 登录态展示、权限入口与退出清理 | core、studio |
| `modules/home.js` | 首页设计草案与公开商品投影 | core |
| `modules/studio.js` | 构图、偏好、排除、撤回、候选比较与进度 | core |
| `modules/products.js` | 本人档案、上传、资料分析及已存香笺列表 | core、home |
| `modules/library.js` | 传统/现代域、现代参照筛选、来源详情与选材回案头 | core、studio、navigation |
| `modules/card.js` | 已核验设计、命名、现成香匹配与PNG导出 | core、studio、products、navigation |
| `modules/integration.js` | 设计交接与软件模拟 | core、studio |
| `modules/navigation.js` | 页面切换与按需刷新 | core、account、products、integration、studio |
| `modules/intent.js` | 本机原话提案、引用、未知、冲突确认与应用 | core、studio |
| `modules/draft.js` | 本标签页草稿校验、留存、恢复和账号清理 | core、studio |

同一文件同一时段由一个执行者写入。视觉层修改 `static/index.html`、`static/style.css`、`static/styles/`、`static/assets/`；业务模块按上表分工。修改页面元素ID或data-action前，先同步入口与对应模块。

## 前端一致性约束

- 更喜欢与希望少一点互斥；点击一侧时移除另一侧相同描述，引用已有香品也遵守此规则。
- 预设保留用户当前排除项，与预设排除取并集；有冲突的材料移出构图并明确说明，由用户自行取消排除。
- 材料、偏好、排除、场景、用户原话与主调锁定变化后，旧候选和未保存香笺失效。候选与核验响应携带请求时设计版本，过时结果不回填。
- 私人资料请求记录账号代次与请求代次，并携带 X-Expected-User；退出、401、session_changed 或本页换号后旧响应不能写入当前状态。focus/visibilitychange 再查 /api/session，发现共享 Cookie 在另一页换号时清理本页私人内容，等待刷新，不自动采用新账号。会话清理同时移除私人报告、香笺、构图、上传表单与模拟调用记录。
- PNG使用点击导出时的已核验设计快照；用户原话、来源、排除项及未验证状态与该快照一致。
- 场景、原话与锁定修改可撤回；输入连续编辑作为一次撤回操作。
- 首页草案是项目设计意图，独立于真实公开商品；点击草案进入调香案，草案说明不填入用户原话。
- 草稿位于本标签页 sessionStorage，key=`hexiang:draft:v1:anonymous` 或 `hexiang:draft:v1:user:<id>`，envelope={schema_version,knowledge_version,owner,saved_at,draft}。draft 只含 components、preferred、deemphasized、excluded、scene、words、locked、name；校验版本、用户、合法材料/形态范围和互斥条件后整份恢复，候选、核验结果与模拟须重新生成或确认。
- 非法或过期草稿不部分注入，也不在自动渲染时覆盖原始存储；明确继续编辑后可写新草稿。退出或会话清理删除本页所有草稿键，启动恢复时清理其他账号草稿。匿名当前草稿在本人明确登录后可转入该登录账号；sessionStorage 不承担跨设备或长期备份。
- 图鉴筛选和“选这份，到案头”仅作用于现代 profiles。传统香材详情按 knowledge.materials 查找，现代详情按 profiles 查找，历史原名与现代同名材料不互换；选材保留现有构图与排除，仅选中材料，随后由用户指定角色。
