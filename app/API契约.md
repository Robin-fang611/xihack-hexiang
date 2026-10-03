# 本地软件接口契约

同源本地网页，JSON请求和响应。角色为manager/user；客户端不能指定自己角色。会话用HttpOnly cookie，GET /api/session返回csrf_token，修改类请求带X-CSRF-Token。登录/注册同样校验请求来源。以下是本轮实施契约，不表示功能已完成。

## 会话与公共内容

- GET /api/bootstrap → services.bootstrap_data() 的profiles、facets、vocabulary、presets、knowledge、sources、roles，加products（首页公开商品）、capabilities、app_name。
- GET /api/session → {user:{id,username,display_name,role}|null,csrf_token}。
- POST /api/register → {username,password,display_name}，只创建普通用户，返回会话。
- POST /api/login → {username,password}，返回会话；管理员凭据由本机运行者配置。
- POST /api/logout → {ok:true}。
- 接口失败用HTTP状态与{error,code}；来源/权限失败不改变任何状态。

## 本人香品与管理者首页

- GET /api/products → {products:[本人完整档案]}。
- POST /api/products → {name,brand,form,spec,description,notes,ingredients,personal_notes,source_url,kind?,file?} → {product}。kind=private/catalog，默认普通用户private、管理员catalog。普通用户不能创建catalog。
- file={name,type,data}；data为base64或data URL，照片/文字/PDF/Word单份上限8MB。OCR及文档文字由后端提取，analysis来源分层。
- 产品对象：{id,kind,name,brand,form,spec,description,notes,ingredients,personal_notes,source_url,analysis,created_at,updated_at,published,public_fields,purchase_url,price,file_name,asset_url,ocr_status}。owner_id不由客户端控制。
- PATCH /api/products/{id} → 更新本人上述资料文本，返回{product}。公开字段有改动时同步公开投影；未选择公开的私有字段不会暴露。
- GET /api/products/{id}/asset → 本人私有附件；未登录或非本人拒绝。
- POST /api/products/{id}/publish → 管理者本人catalog，{purchase_url,price,public_fields:[description,notes,ingredients,source_url,image,price]}；name/brand/form/spec是商品必要公开身份。返回{product}。图片仅发布去元数据的独立公开副本。
- POST /api/products/{id}/unpublish → 管理者本人catalog撤下，返回{product}。
- GET /api/public-assets/{id} → 只返回已公开且选定image的商品公开副本。
- 首页公开商品对象：{id,name,brand,form,spec,description?,notes?,ingredients?,source_url?,price?,purchase_url,analysis:{families,reported_notes,system_inferences,gaps},image_url?,seller_name,updated_at}；不含原图、私有附件、个人观察或完整咨询记录。

## 自由调香与保存

- POST /api/compose → {preferred_facets:中文或canonical/V编号数组,deemphasized_facets,excluded_ids,locked_main_id?,main_family?,limit?}；返回现有compose候选结构。
- POST /api/evaluate → {components:[{profile_id,role:main/support/accent}],name,scenario,preferred_facets,deemphasized_facets,excluded_ids} → {status,design}或{status,reason}。
- design包括components、name、scenario、资料来源和未验证状态，可直接在前端canvas生成PNG香笺。内部匹配指标不显示为气味含量。
- GET /api/designs → {designs:[本人保存设计]}。
- POST /api/designs → /api/evaluate同样输入，后端再次核验，保存并返回{design}。
- POST /api/match → {design} → {status,matches:[{product,...匹配理由与未知}]}，只匹配首页公开商品。

## 软件接入模拟

- POST /api/simulation，action=handoff时{action,design,space_id:reading/lobby}。reading只接受woody主家族，lobby接受woody/balsamic，均为标明的模拟假设。返回{status:accepted/rejected,reason,simulation:{id,space_id,running,timer_minutes,remaining_minutes,history}}。
- 后续{action:start/stop/set_timer,simulation_id,timer_minutes?}，只访问本人会话的模拟状态。无真实设备连接，无自动配香。

## 开发职责

根代理负责app/server.py、OCR、真实身份/权限/存储、接口及整体测试。前端代理只写app/static三文件。服务代理只写app/services.py、app/presets.json及约定的三个调香文件。知识代理只写两份报告整理新文件。每个文件同一时段只由一个执行者写。
