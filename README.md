# 西客松 · 合香数字创作

面向 XiHack 2026 企业命题三和香方向的本地软件原型：用有来源的文化知识与复合调香规则，让用户自由探索、分析已有香品、创作个人香笺；管理者可选择把自己的实体商品挂到首页并提供商家购买链接。

当前是可运行数字原型；在线多人服务尚未部署。真实配伍、制香师审核、硬件与成交尚未验收。

飞书协作说明：[合香项目现状与协作说明](https://wcnzcbnb3bym.feishu.cn/docx/RmaDdMgvzoLHfHxuYtQcHBJKnJc)。持有链接的所有人可共同访问、编辑。

## 先了解项目

- [项目现状与协作说明](项目现状.md)：通俗解释产品、完成程度和下一步。
- [前期讨论与决策记录](前期讨论与决策记录.md)：从选题、交付形态、游戏化和知识库到两类账号的完整需求演变。
- [交付规格](合香定制原型交付规格.md)与[账号权限](账号权限与已有香品分析.md)。
- [基础知识库](知识库/合香知识库.md)、[复合调香](知识库/复合调香机制.md)、[模型报告整理](知识库/外部报告整理.md)。
- 根目录完整保留比赛 Word 指南，以及 DeepSeek 与 ZCode/GLM 两份报告原文；各自身份、来源和适用边界见整理文件。

## 本机运行

需要 Python 3.11 或更高版本。以下命令面向 macOS/Linux 的本地环境，完整功能本轮在 macOS 验证；安装动作由拉取仓库的人在自己的环境执行，项目公开时没有更改原机依赖。

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python app/server.py --port 8870
```

打开 http://127.0.0.1:8870 。macOS 也可双击 `app/启动软件.command`，它优先使用仓库的虚拟环境。Windows 的时区数据与 OCR 环境尚未适配和验证。

首次启动自动生成本机管理者账号，存放于 `app/.local/本机管理者账号.txt`；普通用户从界面注册。每位协作者获得自己的新账号与空数据库，仓库没有默认密码或私人资料。服务默认仅监听本机。

照片文字识别使用 macOS Apple Vision，需可用的 Apple Swift 工具链。非 macOS 或工具链不可用时照片可保存并手动补充文字；文本、可提取文字的 PDF 和 Word 资料分析仍可使用。扫描 PDF 可改传照片，PDF 取前 5 页。

## 复核

```sh
.venv/bin/python 知识库/核验知识库.py --self-test
.venv/bin/python 知识库/验证数字调香.py
.venv/bin/python app/test_app.py
```

完整 HTTP 检查含 Apple Vision OCR 与 macOS 字体，已在 macOS 验证；不宣称跨系统全部测试通过。结果与截图保留在 [app/verification](app/verification)，均使用隔离的测试资料。

浏览器检查是可选的维护工具：需自行准备 Playwright、Chrome，在另一终端先运行 `python app/server.py --port 8871 --data-dir app/.local/browser-qa`，然后 `node app/qa_browser.cjs`。可通过 `PLAYWRIGHT_MODULE`、`CHROME_EXECUTABLE`、`QA_BASE_URL`、`QA_LABEL_IMAGE` 指定已有环境，不影响正式用户资料。

## 公开内容与来源

本仓库从项目单独导出，包含源码、规格、知识库、报告、原始比赛指南、讨论记录与脱敏验收材料。`.local/`、账号密码、数据库、会话、私人附件与缓存全部排除。公开清单及原文件/发布文件 SHA-256 见 [公开资料清单](公开资料清单.json)。少量本机绝对路径改为仓库路径，启动脚本与浏览器检查增加环境配置；两份模型报告保持字节一致。

历史文件中的“尚未实现”可能描述当时阶段，当前状态请先看项目现状与软件说明。数字设计不是实际制作、实闻或健康功效的证明。公开可读不表示第三方原文或比赛资料的版权被转让；引用资料继续按各自来源与比赛指南处理。
