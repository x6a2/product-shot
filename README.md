# product-shot

把一张**白底产品图**，一键生成多套可交付的商品图：不同**场景** × 不同**角度** × 两种**排版**，全程自包含（生图走 Agnes，用户自备 key）。

产品上的文字（丝印 / logo / 型号）由抠图 + Pillow 合成保证 **100% 原样、像素级清晰**；AI 只生成"空背景"，绝不动产品主体。

## 安装

1. DSH → **Plugins → Add plugin** → 选择本目录（`product-shot/`）。
2. 配 key（见下一节，2 分钟）：生图至少要 Agnes；生视频可选再加智谱 / 百炼 / 方舟 / 硅基。

## 配 API Key（2 分钟）

五家通道各用各的 key，**只配你打算用的那几家**。完整教程（申请入口、开通模型、排错）见
[docs/如何申请并接入API_Key.md](docs/如何申请并接入API_Key.md)。

**推荐做法**：打开 `C:\Users\<你的用户名>\.dsh\.credentials.yaml`，只在 `refs:` 下追加（缩进两空格，key 不加引号）：

```yaml
version: 1
refs:
  AGNES_API_KEY: <你的 Agnes key>          # 生图必需
  ZHIPU_API_KEY: <你的智谱 key>            # 免费视频首选
  DASHSCOPE_API_KEY: <你的百炼 key>        # 万相
  ARK_API_KEY: <你的方舟 key>              # Seedance
  SILICONFLOW_API_KEY: <你的硅基 key>      # MiniMax-H3（带音轨）
# records: ...（保持原样，别删）
```

- 改凭据文件**立即生效**，不用重启；在插件配置里直接填 `xxxApiKey` 则要重载插件。
- 优先级：插件配置 `xxxApiKey` → 凭据 `xxxApiKeyRef` → 环境变量同名。

**注意事项**

1. **key 只留在本机**：不要提交到 Git、不要贴进 prompt、不要发给别人；本仓库不含任何 key，别人用就配自己的。
2. 免费额度会变、会排队；插件里的价格是参考价（常量 `PRICE_UPDATED` 标日期），以官网账单为准。
3. **不会自动扣费**：免费链排队超时会返回多平台报价表，你选定 `provider` 并明确同意后才走 `channel: "paid"`。
4. 智谱有**内容审核**，中文提示词容易被拦，用中性英文描述。
5. 百炼 / 方舟要先在控制台**开通对应模型**（`wanx2.1-t2v-turbo` / `doubao-seedance-1-0-pro-fast-251015`），否则报模型未开通。
6. 图生视频的本地图以 data URI 提交；某家只认公网 URL 时会明确报错，换 URL 即可。
7. key 泄露立刻去控制台吊销重建，再更新凭据文件。

## 配置（全部可选，均可改）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `apiKey` | 空 | 直接写 key（不推荐） |
| `apiKeyRef` | `AGNES_API_KEY` | DSH 凭据里的引用名（推荐） |
| `baseURL` | `https://api.agnes-ai.cn/v1` | 国际节点用 `https://apihub.agnes-ai.com/v1` |
| `imageModel` | `agnes-image-2.5-flash` | 生图模型 |
| `outputDir` | `product-shot-output` | 成品输出目录 |
| `effectsDir` | `product-shot-effects` | 预期效果图分区 |
| `queueTimeoutMs` | `300000` | 免费通道排队多久算"卡住"（默认 5 分钟） |
| `fallbackEnabled` | `false` | 是否启用付费 fallback 通道 |
| `fallbackName` | `SiliconFlow` | 付费通道显示名（报价时用） |
| `fallbackBaseURL` | 空 | 付费通道 OpenAI 兼容接口地址 |
| `fallbackImageModel` | 空 | 付费通道生图模型 |
| `fallbackApiKey` / `fallbackApiKeyRef` | 空 | 付费通道 key（直填 / 凭据引用） |
| `fallbackPricePerImageRMB` | `0.05` | 单张报价（人民币） |
| `videoModel` | `agnes-video-2.5-flash` | 免费视频模型 |
| `videoQueueTimeoutMs` | `600000` | 免费链排队多久算“卡住”（默认 10 分钟，在可用通道间均分） |
| `videoPollIntervalMs` | `8000` | 视频任务轮询间隔 |
| `videoSubmitPatienceMs` | `60000` | 某家“提交阶段”最多等多久，超时就换下一家（不占满总预算） |
| `videoStatusWaitMs` | `120000` | `video_status` 一次最多等多久 |
| `freeChain` | `agnes,zhipu,dashscope,ark` | 免费链顺序（逗号分隔；没配 key 的家自动跳过） |
| `zhipuApiKeyRef` / `zhipuBaseURL` / `zhipuVideoModel` | `ZHIPU_API_KEY` / `https://open.bigmodel.cn/api/paas/v4` / `cogvideox-flash` | 智谱：Flash 免费；付费 `zhipuPaidVideoModel` 默认 `cogvideox-3` |
| `dashscopeApiKeyRef` / `dashscopeBaseURL` / `dashscopeT2VModel` / `dashscopeI2VModel` | `DASHSCOPE_API_KEY` / `https://dashscope.aliyuncs.com/api/v1` / `wanx2.1-t2v-turbo` / `wanx2.1-i2v-turbo` | 阿里百炼万相 |
| `arkApiKeyRef` / `arkBaseURL` / `arkVideoModel` | `ARK_API_KEY` / `https://ark.cn-beijing.volces.com/api/v3` / `doubao-seedance-1-0-pro-fast-251015` | 火山方舟 Seedance |
| `siliconflowApiKeyRef` / `siliconflowBaseURL` / `siliconflowVideoModel` | `SILICONFLOW_API_KEY` / `https://api.siliconflow.cn/v1` / `MiniMaxAI/MiniMax-H3` | 硅基流动 MiniMax-H3（无免费额度） |
| `priceZhipuPerVideo` / `priceDashscopePerSecond` / `priceArkPerSecond` / `priceSiliconflowPerSecond` | `1` / `0.24` / `0.2` / `0.5` | 报价单价（RMB，官网调价时改这里） |
| `fallbackVideoModel` | 空 | 自定义付费视频通道模型（留空 = 不用自定义通道） |
| `fallbackVideoEndpoint` | 空 | 自定义付费提交端点，默认 `${fallbackBaseURL}/videos/generations` |
| `fallbackVideoStatusEndpoint` | 空 | 自定义付费状态端点（异步出片）：含 `{id}` 用 GET，否则 POST `{requestId}` |
| `fallbackPricePerVideoRMB` | `0.5` | 自定义付费通道单条报价（RMB） |

## 用法

安装后在对话里说「用 product-shot 把这 [白底图] 做成商品图」即可。skill 会自动：预检 → 抠图 → 放大 → 生成空场景 → 合成 → 排版 → 质检 → 交付。

## 目录结构

```
product-shot/
├── index.js            # 入口：注册 generate_scene 工具 + product-shot 技能
├── SKILL.md            # 模型可见的工作流说明
├── package.json        # bundle 清单（dsh.bundle.patch）
├── cordis.patch.yml    # 插件行 + 默认配置
├── scripts/            # Python 管线（numpy + Pillow，无需额外安装）
│   ├── preflight.py    # 素材预检（拒绝 <1200px / 贴边 / 非白底）
│   ├── key.py          # 白底抠图 → RGBA
│   ├── upscale.py      # 预乘 2x 放大 + 边缘安全锐化
│   ├── render.py       # 统一合成器（5 种角度）
│   ├── typography.py   # 第二遍锐化 + 左栏文案
│   └── verify.py       # 质量门（软边 / 白晕 / 尺寸 / 空白）
├── references/         # 参数外置 JSON（改参数不改代码）
│   ├── scenes.json     # 6 场景 + 各角度合成参数
│   ├── angles.json     # 5 角度族
│   └── layouts.json    # 文案 / 配色 / 字体 / 锐化
├── assets/
│   ├── scenes/         # 预置 6 张空背景
│   └── effects/        # 自带参考效果图
├── docs/               # API Key 教程等
└── locale/             # 插件显示名（zh/en）
```

## 场景 / 角度

- **场景**：`E` 暗黑金属 · `F` 浅色影棚 · `G` 暖石材 · `H` 暗台面 · `I` 浅台面 · `J` 暗斜光带
- **角度**：`vertical` 竖放 · `flat` 横放 · `diag` 斜放 · `tilt` 斜立 · `lie` 躺放
- **排版**：`hero`（产品占满、无文字）· `poster`（产品右置 + 左栏文案）

## 预期效果图分区

用户把想要的参考效果图丢进 `effectsDir`（默认 `product-shot-effects/`）即可；skill 开工前会先读这里，按用户放的效果图风格去生成。

## 双通道生图（免费 → 付费 fallback）

`generate_scene` 默认走免费 Agnes。若 Agnes 排队超过 `queueTimeoutMs`（默认 5 分钟），工具会返回 `queue_stalled` 并附付费通道的报价；skill 会停下来问用户要不要切换，用户同意才走 `channel: paid`。

付费通道是 **OpenAI 兼容**接口，默认关闭。启用时填：

- `fallbackEnabled: true`
- `fallbackBaseURL`（如 SiliconFlow `https://api.siliconflow.cn/v1`）
- `fallbackImageModel`（如 `black-forest-labs/FLUX.1-schnell` 或 `Qwen/Qwen-Image`）
- `fallbackApiKey`（或 `fallbackApiKeyRef`）
- `fallbackPricePerImageRMB`（报价用，如 `0.05`）

> 付费通道只为"免费排队太久"兜底，不改变默认行为；不启用就不影响任何现有流程。

## 多通道生视频（免费链 → 多平台付费，报价交用户选）

`generate_video` 默认 `channel: "auto"`：按 `freeChain`（默认 `agnes,zhipu,dashscope,ark`）顺序试免费/送额度的通道 —— Agnes 视频、智谱 CogVideoX-Flash、百炼万相免费秒数、方舟 Seedance 免费 token。某家额度用尽会记进 `tried` 并自动换下一家。

文生视频只给 `prompt`；图生视频把已质检的 `hero` 成品图当首帧传 `image`（产品外观不变）；也可传 1–5 张 `references` 做多角度。默认 720P、5 秒、`16:9`，成品落在 `outputDir/videos/`。

免费链累计排队超过 `videoQueueTimeoutMs`（默认 10 分钟，在可用通道间均分）→ 返回 `queue_stalled`，带：

- `tried[]`：每家试没试成、为什么（未配 key / 额度用尽 / 队列满）
- `quotes[]`：**所有免费与付费档的即时报价**（provider、模型、预估 RMB、画质优劣、是否已配 key、文档链接）
- `video_id`：已提交成功的那单保留，`video_status` 可续查，任务不丢

skill 会停下来，把报价整理成对比表让用户挑：继续等免费，或 `channel: "paid"` + `provider: "<选中的>"`。**用户不点头不扣费。**

各通道（2026-11-26 参考价，以官网为准）：

| provider | 免费额度 | 付费参考价 | 特点 |
| --- | --- | --- | --- |
| `agnes` | 免费 720P | — | 画面干净、运镜自然；队列经常满 |
| `zhipu` | CogVideoX-Flash ¥0 | CogVideoX-3 ≈ ¥1/条 | 免费里最稳，限并发排队 |
| `dashscope` | 新用户送秒数 | 万相 2.1 turbo ≈ ¥0.24/秒 | 商品主体还原好、动作保守 |
| `ark` | 每模型送 token | Seedance pro-fast ≈ ¥0.20/秒 | 运动幅度大、可 1080P |
| `siliconflow` | — | MiniMax-H3 ≈ ¥0.50/秒 | 带音轨，768P |

自定义付费通道（旧 `fallback*` 配置，OpenAI 兼容风格）仍可用：`fallbackEnabled: true` + `fallbackBaseURL` + `fallbackVideoModel` + key，可选 `fallbackVideoEndpoint` / `fallbackVideoStatusEndpoint` / `fallbackPricePerVideoRMB`。

## 已知限制

- 几何合成能保证文字 100% 原样，但"躺放"在近正面源图上会偏薄（源图无侧壁厚度）；要厚度需 AI 重绘，会改动产品外观。
- 字体默认 Windows 微软雅黑；其他系统改 `references/layouts.json` 的 `fonts`。
- 免费视频队列经常满（尤其 Agnes）：免费链会退避重试并换下一家，10 分钟预算用完就返回 `queue_stalled` + 全平台报价。要真走付费，得先配好对应家的 key：`ZHIPU_API_KEY` / `DASHSCOPE_API_KEY` / `ARK_API_KEY` / `SILICONFLOW_API_KEY`（缺哪家，报价里会标 `configured: false`）。
- 视频里的产品文字会糊/漂移，丝印文字仍以静态成品图和后期字幕为准；图生视频的本地图以 data URI 提交，若接口要求公网 URL 会明确报错提示。

## 许可

MIT
