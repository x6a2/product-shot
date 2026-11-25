# product-shot

把一张**白底产品图**，一键生成多套可交付的商品图：不同**场景** × 不同**角度** × 两种**排版**，全程自包含（生图走 Agnes，用户自备 key）。

产品上的文字（丝印 / logo / 型号）由抠图 + Pillow 合成保证 **100% 原样、像素级清晰**；AI 只生成"空背景"，绝不动产品主体。

## 安装

1. DSH → **Plugins → Add plugin** → 选择本目录（`product-shot/`）。
2. 申请并接入 Agnes API Key（见 [docs/如何申请并接入API_Key.md](docs/如何申请并接入API_Key.md)，与 `dsh-agnes-tools` 共用同一套 key 约定，填一次即可）。

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

## 已知限制

- 几何合成能保证文字 100% 原样，但"躺放"在近正面源图上会偏薄（源图无侧壁厚度）；要厚度需 AI 重绘，会改动产品外观。
- 字体默认 Windows 微软雅黑；其他系统改 `references/layouts.json` 的 `fonts`。

## 许可

MIT
