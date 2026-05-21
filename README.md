# RenSheet

二次元拼团金额计算工具集。纯前端，浏览器内完成 Excel 解析、计算、导出。

## 技术栈

| 层 | 技术 |
|---|---|
| 页面 | HTML5 / CSS3 / Vanilla JS |
| Excel 解析 | [SheetJS](https://sheetjs.com/) (CDN) |
| Excel 导出 | [ExcelJS](https://github.com/exceljs/exceljs) (CDN) |
| 持久化 | localStorage 自动保存草稿 |
| 部署 | Cloudflare Pages / 任意静态托管 |

无框架、无构建工具、无后端依赖。所有计算在用户浏览器完成，文件不会上传到任何服务器。

## 项目结构

```
RenSheet/
├── index.html          # 首页导航
├── shenbiao.html       # 肾表生成器（排表→每人金额清单）
├── guoji.html          # 国际运费分摊表
├── RatioFix.html       # 二调退补表（二次调价退补明细）
├── dashang.html        # 打赏页面
├── images/             # 图片资源
├── sample/             # 排表示例文件（可下载）
├── .vscode/            # VS Code 配置
└── .claude/            # Claude Code 项目配置（不入仓库）
```

## 页面功能

| 页面 | 入口 | 功能 |
|---|---|---|
| 肾表 | shenbiao.html | 导入排表 Excel → 按人聚合 → 分类式/清单式肾表导出 |
| 国际表 | guoji.html | 排表 + 重量参数 → 按重量分摊国际运费 |
| 二调退补表 | RatioFix.html | 原排表 vs 拆配排表 → 配平 → 每人补款/退款明细 |
| 打赏 | dashang.html | 赞赏码展示 |

## 数据流

```
导入排表(.xlsx) → SheetJS 解析 → 按人聚合 → 生成表格 → 预览 → ExcelJS 导出
```

### 排表格式规范

每个排表文件只能包含一个品类：

| 行 | 内容 | 说明 |
|---|---|---|
| A1 | 品类名 | 如"吧唧"、"立牌"，不可为空 |
| B1 起 | 必须为空 | 格式校验项 |
| 第1行 | 角色名列头 | 保持原文，不缩写不删字 |
| 第2行 | 单价 | 该角色谷子单价 |
| 第3行起 | 购买数据 | 每格填购买人名字，不买留空 |

## 核心函数

### 解析层
- `getSheetKind(wb)` — 校验排表格式，提取 A1 品类名
- `parseSheet(wb)` — 遍历数据行，生成 `{person, character, label, kind, price}` 购买记录
- `colToLetter(col)` — 列号转字母（0→A），用于错误定位
- `tryParsePreview(wb)` — 导入时即解析，返回 CN/角色/记录统计

### 聚合层
- `processAllFiles()` — 合并所有文件，按人名聚合到 `personMap`
- `getSortedKinds(personMap)` — 品类排序（吧唧>透卡>立牌>其他）

### 输出层
- `buildCategorizedTable(data)` — 分类式表格
- `buildListTable(data)` — 清单式表格
- `renderPreview()` — HTML 预览渲染
- ExcelJS 导出 — 主题色标题行/表头/交替数据行

### 草稿系统
- `saveDraft()` — 序列化状态到 localStorage
- `restoreDraft()` — 页面加载时自动恢复
- `clearDraft()` — 导出成功后清除

## 主题系统

12 套颜色主题（医用蓝/水色/暗灰/紫蓝/青蓝/薄荷/海蓝/暮紫/海军蓝/钢蓝/苔绿/石墨），统一应用于表格标题行、表头、交替数据行。

## 本地开发

直接浏览器打开 HTML 文件即可，无需启动服务器。

如需热更新，使用任意静态文件服务：

```bash
npx serve .
# 或
python -m http.server 8080
```

## 部署

推送到 GitHub 后接入 Cloudflare Pages：
1. Workers & Pages → Pages → 连接仓库
2. 构建配置留空，输出目录填 `/`
3. 部署完成后获得 `xxx.pages.dev` 域名
4. 后续 `git push` 自动触发部署

## FAQ

**Q: 为什么刷新后文件没了？**
A: 浏览器安全限制，File 对象无法序列化存储。刷新后草稿系统会恢复参数和主题，但需要重新上传文件。

**Q: 大批量文件会卡吗？**
A: 所有处理在浏览器主线程运行，建议单次不超过 50 个排表。国际表上限 50 个，肾表上限 10 个。

**Q: 支持什么 Excel 格式？**
A: 只支持 `.xlsx`。`.xls`、`.csv`、在线表导出须先用 Excel/WPS 另存为 `.xlsx`。

**Q: 数据安全吗？**
A: 纯前端，排表文件不会上传到任何服务器，所有计算在本地完成。
