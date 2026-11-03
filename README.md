<h1 align="center">boxfill · 装柜数量计算器</h1>

<p align="center">
  <strong>Container loading calculator — 算清楚这票货要几个柜、运费多少、怎么拼单最省。</strong><br/>
  同一套装箱算法，两个入口：<strong>H5 网页端</strong>给人用，<strong>MCP Server</strong>给 Agent 用。<br/>
  两端结果必然一致——因为只有一份实现（<code>h5/js/core/</code>）。
</p>

<p align="center">
  <a href="https://boxfill.ybkkasi.com/"><strong>在线体验</strong></a> ·
  <a href="#12-个-mcp-工具">12 个 MCP 工具</a> ·
  <a href="#一h5-网页端">H5 网页端</a> ·
  <a href="#二mcp-服务给-agent-接入">MCP 服务</a> ·
  <a href="#算法">算法细节</a>
</p>

<p align="center">
  <a href="https://github.com/01men/boxfill/actions"><img src="https://img.shields.io/badge/tests-292%20passed-4c1" alt="292 tests passed"></a>
  <a href="https://github.com/01men/boxfill"><img src="https://img.shields.io/badge/MCP%20tools-12-7c5cff" alt="12 MCP tools"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.5-339933" alt="Node.js 22.5+">
</p>

---

## 让 Agent 自己接进来：把这段话贴给它

> **可直接复制的接入指令**（与线上介绍页 https://boxfill.ybkkasi.com/ 的复制按钮内容一致）

```
我要用 boxfill 做装柜测算（该用几个柜、运费多少、怎么拼单最省）。

仓库：https://github.com/01men/boxfill （尚未发布到 npm，请直接 git clone 接入）
线上工具页：https://boxfill.ybkkasi.com/app.html （首页是介绍页，工具在 /app.html）

请按仓库 README.md 完成以下步骤：

1) clone 仓库，跑 `npm install && npm test`，确认 292 条测试全绿（0 失败）再继续。

2) 把 MCP 服务接进你的 MCP 配置（stdio 方式，把路径换成仓库绝对路径）：
   {"mcpServers":{"boxfill":{"command":"node","args":["<仓库绝对路径>/server/stdio.js"]}}}
   装完用 `npm run mcp:probe` 自检一次，它会真起一个 client 连上去把 12 个工具调通一遍。
   如果你需要远程或多端共享，改用 `npm run mcp:http`（默认 127.0.0.1:8787/mcp）。

3) 工作流程：
   · 先 list_containers 查柜型库和限重；
   · 再 plan_containers 排柜（这是主入口，几个柜、每柜装了什么、利用率、甩单、违规都在这）；
   · 要钱用 calc_freight；合并订单用 suggest_consolidation；出单据用 gen_docs；
   · 主数据用 upsert_sku 建档或 import_pi 导入 PI/CSV，用 list_skus / list_orders 查询。

4) 必须遵守的约定：
   · 单位锁死 cm / kg / CBM，和 H5 完全一致，不要自己换算成 mm；
   · 尺寸写错/漏毛重会被入口挡下来并告诉你缺什么，先按提示补齐，别猜；
   · analyze_photo 是实验能力，输出仅供人工核对，不要直接当结算依据。
```

## 12 个 MCP 工具

| 工具 | 作用 | 会写库 |
| --- | --- | --- |
| `list_containers` | 查柜型库：内尺寸、门框、可用容积、限重 | — |
| `plan_containers` | **主入口**：几个柜、每柜装了什么、利用率、甩单、违规 | — |
| `calc_freight` | 四个重量、渠道比价、箱型比选、附加费、纸箱优化 | — |
| `suggest_consolidation` | 拼单建议 + 费用分摊（谁付多少） | — |
| `check_fits` | 箱规能否装进某柜、过不过门框、是否超长 | — |
| `gen_docs` | 装箱单 / 装柜清单 / VGM / 配重 / 费用 | — |
| `upsert_sku` | 建档或更新 SKU（变更自动留版本） | ✅ |
| `import_pi` | 导入 PI/CSV，缺尺寸的行跳过并计数 | ✅ |
| `list_skus` | 查已建档纸箱规格 | — |
| `list_orders` | 查订单（目的港、船期、箱数） | — |
| `get_order_boxes` | 订单展开成箱规清单，汇总体积与抛比 | — |
| `analyze_photo` | 解析纸箱照片出尺寸（实验·仅供参考，结果可改） | — |

### 真实返回示例（`plan_containers`，实测输出）

```json
{
  "boxType": "20GP",
  "containers": 1,
  "strategy": "体积优先",
  "totals": {
    "boxes": 20, "cbm": 2.4, "weightKg": 240,
    "utilVol": 0.0723, "utilWeight": 0.0085,
    "densityKgPerCbm": 100, "isLight": true
  },
  "perContainer": [
    { "index": 1, "cbm": 2.4, "weightKg": 240,
      "skus": [{ "code": "A-001", "boxes": 20, "weightKg": 240 }],
      "cavityCm": { "l": 49.8, "w": 235.2, "h": 194.3 },
      "fragmentsRatio": 0 }
  ],
  "spill": [],
  "violations": [],
  "elapsedMs": 2
}
```

---

## 本地跑起来

```sh
npm install      # 仅 MCP 服务端需要依赖；H5 侧仍然零依赖
npm start        # 起本地服务 → 首页(介绍页) http://localhost:5173/h5/ ，工具在 /h5/app.html
npm test         # 292 条测试（Node 自带 test runner）
npm run mcp      # 启动 MCP stdio 服务，供本机 Agent 接入
npm run deploy   # 部署到 https://boxfill.ybkkasi.com/ 并端到端验证
```

**线上地址：https://boxfill.ybkkasi.com/**（Cloudflare Worker 静态托管，手机扫码即用）
首页是介绍页，工具本体在 **https://boxfill.ybkkasi.com/app.html**

> H5 用的是 ES 模块，浏览器在 `file://` 下会拒绝加载模块，直接双击一定白屏。
> 必须用 `npm start` 或任意静态服务器访问。

**GitHub 仓库**：https://github.com/01men/boxfill ｜ 许可证 MIT ｜ Node.js ≥ 22.5（`node:sqlite`）

---

# 一、H5 网页端

## 界面

主流程三屏（算 → 单 → 数），另有一屏「测」作为**实验功能**排在最后：

| 屏 | 做什么 |
| --- | --- |
| **算** | 「这票货：**40HQ × 1**，装 66 方，用了 89%，重 14.2 吨，还能再塞 A 款 12 箱」+ 3D 装柜图 |
| **单** | 装箱单 / 装柜清单 / VGM / 配重 / 费用 / 3D 图 PDF，一键发微信 |
| **数** | SKU 主数据、订单、拼单建议（含费用分摊、一键落地测算）、费率设置、方案回溯 |
| **测**（实验） | 摄像头持续检测箱体边缘 → 点「确认测量」→ 核对尺寸重量 → 入库 |

**为什么把「测」排到最后**：摄像头识别依赖受控工位与光线，受环境影响较大；
而「算/单/数」是确定性计算，任何时候都能用。默认首屏是「算」，不把成败押在自动识别上。

## 目录

```
h5/                            H5 应用（ES 模块，零依赖）
  index.html                   站点首页 = 介绍页（真引擎演示 + Agent 接入指令）
  app.html                     工具外壳：三屏 + 实验屏 + 底部导航
  css/app.css
  js/
    tree.js                    介绍页演示：import core 引擎真跑排布，轴测/俯视/侧视三视图
    intro.js                   介绍页交互：复制接入指令（不能内联，CSP script-src 'self'）
    core/                      ← 唯一实现：浏览器与 MCP 服务端共用
      units.js                 单位、柜型库（ISO 668）、限重四层取最小
      engine.js                多 SKU 分层装箱引擎 ← 核心
      billing.js               四个重量、抛比、渠道比价、箱型比选、附加费、纸箱优化
      consolidate.js           拼单规则引擎（硬约束 + 多单吸收 + 费用分摊）
      store.js                 主数据 + 离线存储 + 审计快照 + CSV/PI 解析
      import.js                PI/CSV 导入（H5 与 MCP 共用）
      docs.js                  单据生成（装箱单 / 装柜清单 / VGM / 配重 / 费用 / A4 打印包）
    vision/
      camera.js                摄像头、标定、量距、连续检测判定、质量拦截、双视角求高度
      ocr.js                   七段数码管 OCR（纯函数）
      cloud.js                 云端识别客户端：PNG 编码上传 + 重解析（闭环见第二章）
    ui/
      view3d.js                轴测图 / 分层俯视 / 门端侧视 / 配重剖面
    app.js                     主控：把参数搬到屏幕上
    dsh.js                     URL hash 预填 + window.BoxFiller（复用共用工具层）
worker.js                      Cloudflare Worker（缓存策略 + 安全响应头）
wrangler.toml                  部署配置（routes 用 custom_domain，DNS 与证书自动创建）
server/                        MCP 服务端（见第二章）
scripts/serve.mjs              零依赖静态服务器
scripts/deploy.mjs             部署 + 线上验证
scripts/mcp-probe.mjs          MCP 自检：起 client 连上去真调一次
tests/*.test.mjs               292 条测试
```

分层原则：**算法不碰 DOM，UI 不算账**。装箱、计费、拼单都能在 Node 下被测试穷举；
UI 出问题不会连累算法，算法出问题也不会因为界面而测不出来。
MCP 服务端复用同一批模块，因此**不存在"H5 算 2 柜、Agent 算 3 柜"这种事**。

## 算法

### 装箱：分层码 + 矩形块，不是通用 3D Bin Packing

真实装柜的物理规则决定了算法形态——集装箱只能从门口往里码，一层铺满再往上堆。
于是问题被拆成两层：每层是 **2D 矩形块装箱**（每个 SKU 在本层摆一个 nx×ny 的规整矩形块），
层与层之间是简单堆叠。

放弃了一部分理论最优（允许悬空塞缝能多装 3~5%），换来的是**仓管照着摆就一定摆得出来**，
而且每层都能画成一张可直接贴到操作台的俯视图。

多起点寻优：体积优先 / 重量优先 / 整除优先 / 混装亲和，四个策略各跑一遍取最优。

朝向选择按「本层箱数 × 剩余高度还能码几层」预估总收益——层高一旦定死就同时决定了还能往上码几层，
拿到第一个放得下的朝向就用会白白少装三成。

### 已实现的 10 条硬约束

门框约束、边长整除、整层码放（不许斜放悬空）、重下轻上、堆码上限、单层限高（留 5cm 安全余量）、
托盘占用、混装禁忌、可用容积折扣、配重校验（前后差 ≤800kg、左右差 ≤500kg、CTU 60/50）。

限重取四层最小值：**箱型上限 / 航线限重 / 船司限重 / 拖车限重**，并在方案里留痕
（美线拖车常压到 17.2t，比柜型上限低近 10 吨，不取最小就会超重）。

### 拼单：先硬约束，再多单吸收，最后分账

拼单是这套系统里最值钱的一条：不是把两个半柜凑成一个柜省一次运费，
而是"抛货单 + 重货单"互补——体积线和重量线同时吃满。

流程按第一性原理拆成三步：

1. **硬约束过滤**（目的港 / 截关船期缓冲 / 客户许可 / 货物性质冲突）——分组只按目的港，
   船期兼容交给硬约束判断：同港不同船、但截关相差在缓冲期内的两单是可拼的。
2. **贪心合并 + 多单吸收**——先两两锁定"合并后最省柜"的组合，再向已锁定的组继续吸收
   第三、第四单，只要并入后省的柜数还在增加就继续收。三张 60% 满的抛货单拼进一个柜，
   靠的就是这一步。所有柜数结论都来自真实排布引擎，不是体积估算。
3. **费用分摊**——拼成一柜后怎么拆账（`splitConsolCost`）：每个成员按
   max(体积线占用率, 承重线占用率) 分摊，抛货按体积分、重货按重量分，
   金额四舍五入的尾差记到最后一个成员，合计严格等于总成本。

界面上的每条拼单建议带「按此拼单去测算」按钮：一键只勾这几单、跳到「算」跑真实排布——
建议和执行之间不留断层。

### 秤屏 OCR

纯 JS 七段数码管字形模板匹配，不是通用 OCR。合成测试上识别率 **99.7%、误读 0 例**——
读不出会明确报错，读错不会发生（PRD 验收 V-02 的硬要求）。

### 确认制测量（连续检测 + 人工确认）

摄像头打开后进入**连续检测**：逐帧找箱体四边形、实时画边缘框、持续读秤攒稳定读数，
状态灯只报结论（未找到 / 质量不过关 / 需标定 / 太斜 / **已锁定**）。尺寸换算与入库判定
全部推迟到用户点「确认测量」之后——识别太快把没核对过的数直接弹进主数据，比识别不出来
更危险。判定逻辑收在 `liveVerdict()` 纯函数里，可在 Node 下穷举测试。

## 部署

```sh
npm test              # 改完先跑，235 条
npm run deploy        # wrangler deploy + 端到端验证
npm run deploy -- --dry   # 只做本地检查，不动线上
```

用 Cloudflare Worker 静态资产托管，不走隧道——站在仓库里的操作员网络本来就差，
不能让他对着一个半死不活的页面等 10 秒。`worker.js` 只干两件事：钉死缓存策略
（`index.html` / `app.html` 永远 no-cache，避免用户看到旧版本还不自知）、补安全响应头
（`camera=(self)` 权限声明 + CSP）。

> **`wrangler.toml` 里 `routes` 必须写在所有 `[段名]` 之前。** 写在 `[assets]` 后面会被 TOML
> 当成该表的子键，wrangler 静默忽略、只打印 `No targets deployed`——部署"成功"了但域名是空的，
> DNS 记录和证书都不会建，且看不出原因。

部署与验证细节见 `cloudflare 工作区/README.md §11`。

## DSH 端集成

外部插件（如 dsh-lc-parser）有两条通道接入，都不需要改这个工具的代码。

**① URL hash 预填**——拼个链接跳过来，数据已经带好：

```
h5/app.html#type=40HQ&sku=BX-1001&l=40&w=30&h=25&wt=12&qty=260&port=Jebel%20Ali
```

| 参数 | 含义 |
| --- | --- |
| `type` | 柜型：`20GP` / `40GP` / `40HQ` / `45HQ` / `20OT` / `20FR` … |
| `sku` / `code` | 货号（与主数据对齐） |
| `l` / `w` / `h` | 外箱三边，**cm** |
| `wt` | 单箱毛重，**kg** |
| `qty` | 箱数；只给 `cbm` 不给 `qty` 时按体积反推 |
| `pack` | 装箱数（件/箱） |
| `port` / `vessel` / `cutoff` / `due` / `customer` / `order` | 订单信息 |

不认识的参数只忽略、不报错——插件可以先升级自己再升级这边。缺尺寸或缺毛重的行会被丢掉，
不会带着半截数据进主数据。

**② JS API**——页面挂 `window.BoxFiller`（历史别名 `YiwuBoxLoader` 仍可用，老插件不受影响）：

```js
// 直接算，不碰界面
const r = BoxFiller.solve({
  items: [{ code: 'BX-1001', dimsCm: { l: 40, w: 30, h: 25 }, weightKg: 12, boxes: 260 }],
  boxType: 'AUTO',
  costs: { freightPerCbm: 280, thc: 1800, doc: 300 },
})
r.summary   // { containers, boxes, cbm, chargeableKg, isLight, violations, spill, ... }

// 建档 / 导入 / 取单据
BoxFiller.upsertSku({ code, dimsCm, weightKg })
BoxFiller.importCSV(csvText)          // 认中文表头，缺失的 SKU 自动建
BoxFiller.export('csv' | 'packing' | 'html')
BoxFiller.getPlan()                   // 取界面上已算好的方案
BoxFiller.addLines([{ skuId, code, boxes }])
BoxFiller.goto('calc')                // 把用户定位到某一屏
```

## 离线

采集与 OCR 全部跑在端侧，断网可测尺寸、读重量、存结果；主数据、待装清单、方案历史都在
`localStorage`，断网不丢。装箱引擎较重，断网时给降级方案（按体积估算柜数，误差约 ±2 箱）。
联网后自动重算并同步。存储被禁（无痕模式）时自动退回内存存储，不崩。

## 与 PRD 的偏差（写在这里，别到时候被人当 bug 报）

PRD 有几处按现实做会出问题，实现时做了调整。**这不是"没做"，是"做了但改法不同"。**

| # | PRD 原文 | 实际实现 | 为什么 |
| --- | --- | --- | --- |
| 1 | 4.2.1 方案 A「参照物法，一次取景测出 L×W×H，±1.5cm」 | 一次俯视测**长×宽**，**高度**需侧拍一张或手工填 | 俯视图里没有纵深信息，高度在几何上就拍不出来。单张照拿三个维度做不到，所以宁可多问一次也不猜 |
| 2 | 5.1「堆码层数上限，默认 5」 | **默认不限**，按物理层数与 5cm 安全余量算；显式填写才生效，易碎品硬性 ≤3 | 40HQ 柜内高 2698mm，装 350mm 的箱子物理上能码 7 层。默认锁 5 层等于每次白扔 900mm 柜高，利用率凭空掉 12 个点，现场没人这么装 |
| 3 | 14 章 C-01「单一 SKU 塞满 20GP 利用率 ≥92%」 | 改成验证**可整除箱规下每层铺满、层高顶到安全余量** | 92% 隐含"纸箱能整除柜内尺寸"的前提。现实中 60×40×35 装 20GP 只能到 65–70%，那是箱型不整除造成的，不是排布差。测试改成守"排布本身不浪费"这件事 |
| 4 | 9.1 密度互补例「22 CBM + 6 CBM = 40HQ 一柜吃满」 | 如实按柜内占用率展示 | 28 CBM 装进 66.9 CBM 的 40HQ 数学上就是"没吃满"，示例本身不成立。所以界面改为报"柜内占用率"，而不是相对理论容积的利用率 |
| 5 | 4.4 视觉识别用目标检测模型 | 边缘密度 + 连通域 + 四角拟合的规则检测 | 卷积模型要几百 MB 权重，仓库手机在弱网下下不动；而在受控工位（哑光垫板、顶部漫射光、垂直俯拍）里规则方法足够稳，且失败时能明确说"看不清，请翻面"，而不是给一个自信的错答案 |
| 6 | — | 未做 | 语音输入留了接口（`camera.js` 的 `startVoice`）但界面未接；微信小程序端按要求未做；危险品申报、报关行资质、汇率换算明确不做（PRD 13 已划边界） |

## 已知限制

- **摄像头采集需要 HTTPS**（或 localhost）。HTTP 下会明确提示"请使用 HTTPS 或微信打开"，
  不会静默失败。生产部署必须配证书。
- **装箱引擎是工程可行解，不是数学最优**。整层码放的约束下放弃了悬空塞缝的 3~5% 理论空间，
  换来仓管照着摆一定摆得出来。
- **运费需要填真实费率**。费率全 0 时只出装载方案不出钱，渠道比价与箱型比选会退化成空表。
- **OCR 只认七段数码管**。电子秤是点阵屏或 LCD 字符屏时识别率会下降，需在 `ocr.js` 里补字形模板。
- 客户端未做多租户隔离（PRD 11 要求店铺级隔离），当前是单机单人形态，接后端时需要补。
- 界面主流程的 GUI 自动化点击测试尚未跑通（详见交付说明），核心算法的 292 条测试已覆盖。

---

# 二、MCP 服务（给 Agent 接入）

把同一套装箱算法开放给 Agent 工具（Claude Code、WorkBuddy、DSH 等）。
**H5 与 MCP 共用 `h5/js/core/` 下的全部算法**，同一票货在两边算出的柜数、
费用、拼单建议必然一致——这不是靠约定，是靠只有一份实现。

```
h5/js/core/     ← 引擎、计费、拼单、单据（唯一实现，浏览器与 Node 共用）
  ├─ h5/        浏览器用它渲染界面
  └─ server/    MCP 用它算，返回 JSON 给 Agent

server/
  tools.js          共用工具层：12 个工具的业务实现与 JSON Schema
  mcp-server.js     把工具层装配成 McpServer（两种 transport 共用）
  stdio.js          MCP 服务器 · stdio（本地 Agent）
  http.js           MCP 服务器 · Streamable HTTP + REST 视觉端点
  sqlite-storage.js SQLite 适配器（node:sqlite，零外部依赖）
  vision.js         云端视觉解析（复用 h5/js/vision 算法，附赠能力）
  png.js            纯 Node PNG 解码（零依赖）
```

## 快速开始

```sh
npm install            # 只装 MCP SDK 与 zod，H5 侧仍是零依赖
npm test               # 292 条测试
npm run mcp:probe      # 自检：真起一个 client 连上去验 16 项

npm run mcp            # stdio 服务（本地 Agent 用）
npm run mcp:http       # HTTP 服务，默认 127.0.0.1:8787/mcp
```

> `node:sqlite` 需要 **Node ≥ 22.5**（22.5~23 还要 `--experimental-sqlite`，24 起默认可用）。

## 接入方式

**stdio（推荐，本机 Agent）**——在 Agent 的 MCP 配置里加：

```json
{ "mcpServers": { "boxfill": { "command": "node",
  "args": ["/绝对路径/物流箱体测算工具/server/stdio.js"] } } }
```

**HTTP（远程或多端共享）**：

```sh
PORT=8787 HOST=127.0.0.1 node server/http.js
# Agent 端点：http://127.0.0.1:8787/mcp
```

## 工具清单

12 个工具的完整说明见上文「[12 个 MCP 工具](#12-个-mcp-工具)」，
每个工具的 JSON Schema 直接由 `server/tools.js` 的 `TOOLS` 注册表导出，
stdio 与 HTTP 两个 transport 共用这一份定义，不存在"两份工具定义"的分歧。

输入输出全是 JSON，**单位锁死 cm / kg / CBM**（与 H5 一致）。
脏数据在入口被挡下并说明缺什么，例如：

```
✗ items[0] 尺寸不完整或非正数
  提示：收到 l=60 w=40 h=undefined；单位是 cm，三边都要大于 0
```

## 云端视觉解析（附赠能力，不单独收费）

视觉识别是**附赠能力**：它替用户省下"敲 200 个 SKU 建档"的工时，但省不了运费——
真正值钱的是装柜方案与拼单分摊（engine / consolidate）。所以商业化只靠
**SaaS 订阅 + MCP/API 接入**两条线，识别永远免费随主流程送。

### 架构：一条照片的闭环

```
H5 拍照/选图 → canvas 缩到 1600px 内编码 PNG
  → POST /api/vision/analyze（无标定参数）
  → 服务端纯 Node 解 PNG（server/png.js，零依赖）→ 复用 h5/js/vision/ 现有算法
  → 返回箱体候选框 + NEED_CALIBRATION
  → 用户在照片上点参照物两端（A4 长边）→ 前端算出 refPx 带参重解析
  → 返回 长×宽（cm）+ 误差估计
  → 核对表单：**所有字段可改** + 固定展示"仅供参考"免责声明 → 人工确认入库
```

几个刻意的决定：

- **强制 PNG**：JPEG 解码要引第三方库，PNG 用 Node 自带 zlib 一行解开——
  服务端保持零依赖，代价只是客户端多一次 canvas 编码。
- **高度不猜**：单张俯视图几何上拍不出高度，返回 null 并要求补录。
- **重量读不出不猜**：OCR 失败返回 null + 原因，表单里手填。
- **结果必须可改 + 免责声明**：`editable:true` 与 `disclaimer` 由服务端固定返回，
  客户端想抹掉都抹不掉；入库前必须人工核对。
- **参照物仍是硬前提**：没有比例尺就没有厘米。云端省的是算力和录入，省不掉标定。

### REST 端点

```
POST /api/vision/analyze
  · content-type: image/png   → body 是 PNG 字节，参数走 query：
      ?roi=0.2,0.1,0.6,0.5          箱体区域（多候选时必传，否则可能量到参照物）
      &refRealCm=29.7&refPx=297     参照物真实长度与像素长度
      &scaleRegion=0.2,0.7,0.6,0.2  秤屏区域（给了才尝试读重）
  · content-type: application/json → { imageBase64, roi, refRealCm, ... }

业务失败（拍糊/没标定）= 200 + ok:false + warnings；
请求错误（非 PNG / 超限 / 缺参）= 4xx + error + hint。
GET /api/health 探活。
```

### H5 侧启用

`数 → 设置 → 云端识别 API` 填服务地址（本机 `http://localhost:8787`，
服务端 `npm run mcp:http` 启动）。留空 = 关闭，测屏不显示云端入口；
服务连不上会明确提示转手工补录，不会静默失败。

### MCP 工具

`analyze_photo`（实验）：Agent 传 base64 PNG + 标定参数，拿到同样的可编辑结果。
与 REST 端点调的是同一个 `analyzeImage`——**Agent 与 H5 对同一张照片给出同一个答案**。

## MCP 侧已知限制

- **多租户隔离未做**（见上）。
- **H5 与 MCP 的主数据不互通**（见上）。
- **HTTP 单进程单库**，没有连接池；装箱引擎有 `timeLimitMs` 上限（默认 8 秒），
  但并发大量请求时仍需排队。
- **视觉解析的精度上限是规则算法的天花板**：多目标同框、参照物与箱体亮度接近时
  可能漏检或选错目标（服务端会告警而不是硬给数）。要更高识别率需换学习模型，
  那是另一个量级的工程，先看附赠能力的使用率再决定值不值。

## 数据存放

SQLite，默认 `~/.boxfill/boxfill.db`（`BOXFILL_DB` 可覆盖）。
H5 侧仍用 localStorage，两者是**各自独立的主数据**，不自动同步——
真要打通，应在 H5 加导出、服务端用 `import_pi` 导入，而不是让两个存储层悄悄合并。

## 多租户隔离

**当前是单库单账本，没有租户隔离。** 多店铺的两种做法：

1. 每个店铺一个 `BOXFILL_DB` 文件、各起一个进程（最简单，推荐先这么做）；
2. 在 HTTP 前挂带鉴权的反代，按 client 身份分库（需改 `http.js` 的 session 分发）。

**HTTP 服务默认只监听 127.0.0.1，且没有鉴权**——任何能访问端口的客户端都能读写全部主数据。
要对外暴露必须自己加鉴权；改成非回环地址时进程会打印警告。

## MCP 侧已知限制

- **多租户隔离未做**（见上）。
- **H5 与 MCP 的主数据不互通**（见上）。
- **HTTP 单进程单库**，没有连接池；装箱引擎有 `timeLimitMs` 上限（默认 8 秒），
  但并发大量请求时仍需排队。

---

# 三、旧版单箱规计算器（保留）

`index.html` 是上一代的单箱规装柜计算器（单文件、零依赖、MaxRects 混方向寻优），
仍然可用：`http://localhost:5173/index.html`，也可以直接双击（它是纯静态单文件）。
定位与新 H5 不同——它管单箱规的最大装箱数，新 H5 管整票货、多个 SKU、运费与拼单。

| 能力 | 说明 |
| --- | --- |
| 柜型 | 20GP / 40GP / 40HQ / 45HQ 预设，也可手填任意柜内尺寸 |
| 混合方向 | 遍历 6 种摆放方向，5 种策略寻优 + 二次塞缝 |
| 单一方向 | 所有箱子朝同一方向整齐码放，作为对比基线 |
| Top3 对比 | 不同策略各跑一遍完整装柜，取最优 3 个并排对比 |
| 3D 装柜图 | 可拖拽旋转 / 滚轮缩放，逐层上色 + 背面剔除 + 画家算法 |
| 约束 | 最大堆码层数、预留装卸间隙、待装数量上限、禁止旋转 |

**算法为什么用极大矩形法**：极点 / 扫描线那类算法的空闲空间是靠"候选点"间接表达的，
一旦候选列表被裁剪或去重，就可能漏掉仍然合法的空位，把箱子放到已占用区域上——
表现就是装出一柜 20,000 箱的荒谬结果。极大矩形法把空闲空间显式维护成互不重叠的矩形列表，
每步放置都从真实空闲区取，放不下就是真的放不下，物理上不会越界。

**对外接口**（供 dsh-lc-parser 等插件调用）：

```js
const plan = ContainerLoader.set({
  ctype: '40HQ', bL: 600, bW: 400, bH: 350,   // mm
  bWt: 15, gap: 0, maxLayer: 0, qty: 0,
  allowRotate: true, useSecondPass: true,
})
```

也支持 URL hash 预填：`index.html#len=600&wid=400&hei=350&wt=15&qty=1360&type=40HQ`
（参数单位是 **mm**，与新 H5 的 cm 不同，两套工具不要混用）。

## 测试维护注意

`tests/packing.test.mjs` 通过正则从 `index.html` 的 `<script>` 里抽取装箱内核
（截到「渲染」分节之前，无 DOM 依赖），在 Node 的 vm 沙箱里跑。

> **改动 `index.html` 结构时，如果测试报「装箱内核抽取失败」，说明那条分节注释分隔符
> 被挪动了**，需要同步更新测试里的 `loadKernel()`。这条约定是旧工具与它的测试之间的硬耦合。

---

仓库私有，仅供内部使用。
