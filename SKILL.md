# 白底产品图 → 多场景多角度商品图（product-shot）

把一张**白底产品图**，生成多套可交付的商品图：不同**场景**（暗黑金属 / 浅色影棚 / 暖石材 …）× 不同**角度**（竖放 / 横放 / 斜放 / 斜立 / 躺放）× 两种**排版**（hero 产品占满 / poster 左栏文案）。

## 铁律（开工前先读）

1. **产品上的文字（丝印 / logo / 型号）必须 100% 原样、像素级清晰** —— 绝不让 AI 重画产品或文字。
2. AI 只负责生成"空背景"（场景），产品主体永远来自原图抠像，用 Pillow 合成。
3. 抠图 / 放大 / 合成 / 排版 / 质检全部走 bundle 自带 `scripts/*.py`，不依赖第三方生图插件。
4. 文案文字由 Pillow 真实渲染（绝不交给 AI 生成文字）。

## 前置依赖

- **Python**：调用 `load_workspace_dependencies` 拿 `python.exe` 绝对路径（自带 numpy + Pillow，无需 pip install）。
- **生图**：本 bundle 的 `generate_scene` 工具（走 Agnes，用户自备 key；申请与接入见 `docs/如何申请并接入API_Key.md`）。
- **生视频**：本 bundle 的 `generate_video` / `video_status` 工具；默认免费链（Agnes → 智谱 → 百炼 → 方舟，720P），超时后按平台报价由用户选付费通道。其他家的 key 用 `ZHIPU_API_KEY` / `DASHSCOPE_API_KEY` / `ARK_API_KEY` / `SILICONFLOW_API_KEY`（可选，缺哪家就少一条通道）。
- **字体**：默认 Windows 微软雅黑（`msyh.ttc` / `msyhbd.ttc` / `simhei.ttf`）；非 Windows 需改 `references/layouts.json` 的 `fonts`。

## 脚本位置

所有脚本在 bundle 根目录的 `scripts/` 下。skill 资源里给出的目录（resourceBase）就是 bundle 根，用 `<bundle根>/scripts/xxx.py` 这样的绝对路径调用。参数外置在 `references/{scenes,angles,layouts}.json`，改参数不用改代码。

## 输入契约（preflight 会拒绝，别硬来）

- 白底产品图，分辨率 **≥1200px**；产品四周留白、不贴边、无原投影。
- 若用户要"躺放"角度、而源图近乎正面拍摄（几乎没有侧壁厚度），先告知该角度只能近似，并建议补拍一张 35° 俯拍图。

## 标准工作流

```bash
PY="<load_workspace_dependencies 返回的 python.exe>"
S="<bundle根>/scripts"

# 1) 预检
"$PY" "$S/preflight.py" --src <产品图>

# 2) 抠图（白底 → RGBA 透明）
"$PY" "$S/key.py" --src <产品图> --out <工作区>/product_rgba.png

# 3) 预乘放大 2x + 边缘安全锐化
"$PY" "$S/upscale.py" --src <工作区>/product_rgba.png --out <工作区>/product_2x.png

# 4) 生成空背景：调用 generate_scene 工具（prompt 只描述场景，不要出现产品）
#    或复用 assets/scenes/ 里已预置的 6 张背景（bg_a_darkmetal / bg_b_lightstudio /
#    bg_c_warmstone / bg_h_darktable / bg_i_lighttable / bg_j_darkstreak）。

# 5) 合成
"$PY" "$S/render.py" --product <工作区>/product_2x.png --scene E --angle vertical \
    --layout hero --out <工作区>/E_hero.png

# 6) 排版 + 第二遍锐化（hero 只锐化不排字；poster 加左栏文案）
"$PY" "$S/typography.py" --src <工作区>/E_hero.png --out <成品>/E_hero.png \
    --palette dark --mode hero

# 7) 质检（失败会非零退出，打印 JSON 报告）
"$PY" "$S/verify.py" --matte <工作区>/product_2x.png --final <成品>/E_hero.png

# 8) 可选：把质检通过的 hero 成品图做成短视频（图生视频，产品外观不变）
#    generate_video(prompt="缓慢横移特写，柔光", image="<成品>/E_hero.png",
#                   seconds="5", aspect_ratio="16:9")
```

## 多通道生视频（免费链 → 多平台付费，报价交用户选）

`generate_video` 默认 `channel: "auto"`：按 `freeChain`（默认 `agnes,zhipu,dashscope,ark`）顺序试**免费/送额度**的通道，某家额度用尽会自动标记并换下一家。

- **文生视频**：只给 `prompt`。
- **图生视频（推荐）**：把已质检通过的 `hero` 成品图作为首帧传 `image`（本地路径或公网 URL），产品外观不会被重画。
- **参考图模式**：传 `references`（最多 5 张），适合同一产品多角度。

默认 `seconds: "5"`、`aspect_ratio: "16:9"`（竖版投放用 `"9:16"`），成品落在 `outputDir/videos/`。

各通道（2026-11-26 参考价，以官网为准）：

| provider | 免费额度 | 付费参考价 | 特点 |
| --- | --- | --- | --- |
| `agnes` | 免费 720P | — | 画面干净、运镜自然，但队列经常满 |
| `zhipu` | CogVideoX-Flash ¥0 | CogVideoX-3 ≈ ¥1/条 | 免费里质量最稳，限并发排队 |
| `dashscope` | 新用户送秒数 | 万相 2.1 turbo ≈ ¥0.24/秒 | 商品主体还原好、动作幅度保守 |
| `ark` | 每模型送 token | Seedance pro-fast ≈ ¥0.20/秒 | 运动幅度大、镜头感强，可 1080P |
| `siliconflow` | — | MiniMax-H3 ≈ ¥0.50/秒 | 带音轨，768P |

**免费链累计排队超过 10 分钟**（`videoQueueTimeoutMs`，默认 `600000`，在可用通道间均分）时，工具返回 `status: "queue_stalled"`，并带上：

- `tried[]`：每家试没试成、为什么（未配 key / 额度用尽 / 队列满），以及可续查的 `video_id`
- `quotes[]`：**所有免费与付费档的即时报价**（provider、模型、预估 RMB、画质优劣、是否已配 key、文档链接）
- `phase`：`submit`（还没提交进去）/ `poll`（已提交、生成中）/ `all`（免费链都没成）

这时**必须停下来问用户**，把 `quotes` 的价格和优劣整理成对比表让用户挑 —— 这是产品要求：每次超时都报价对比，由用户决定，不替他选。给两条路：

1. **继续等免费**：`video_status` 带 `tried[].video_id`（一次最多 `wait_seconds` 秒，默认 120，可反复调）。任务不会因为超时被丢弃。
2. **走付费**：`generate_video`（参数不变）加 `channel: "paid"` + `provider: "<用户选中的>"`。若用户只想把某一家免费额度再试一次，用 `channel: "free"` + `provider: "<那家>"`。

规则：

- 用户明确选好 provider 前**绝不自动扣费、绝不自动切付费**；报价里 `configured: false` 的家要如实说“还差哪个 key”（`ZHIPU_API_KEY` / `DASHSCOPE_API_KEY` / `ARK_API_KEY` / `SILICONFLOW_API_KEY`）。
- `video_status` 返回 `done`（已自动下载）/ `pending`（还在跑，稍后再查）/ `failed`（带原因；4xx 多为图片取不到，改公网 URL 再试）。
- 视频里的产品文字会糊、会漂移：**不要指望模型把丝印重画对**，重要文案靠后期贴图/字幕，或只把视频当动效底片。

自定义付费通道（旧 `fallback*` 配置，OpenAI 兼容风格）：`fallbackEnabled=true` + `fallbackBaseURL` + `fallbackVideoModel` + `fallbackApiKey`（或 `fallbackApiKeyRef`）；可选 `fallbackVideoEndpoint`（默认 `${fallbackBaseURL}/videos/generations`）、`fallbackVideoStatusEndpoint`（含 `{id}` 用 GET 替换，否则 POST `{requestId}`）、`fallbackPricePerVideoRMB`（报价用）。

## 双通道生图（免费 Agnes → 付费 fallback）

`generate_scene` 默认走免费通道 Agnes。**若返回 `status: "queue_stalled"`**（Agnes 排队超过约 5 分钟仍未完成）：

1. **停下问用户**（`ask_user_question` 或直接文字），把工具返回的 `fallback.provider` 和 `fallback.estimatedCostRMB` 报给用户，例如："免费通道排队超 5 分钟了，付费通道 SiliconFlow 预计约 ¥0.05/张，要切换吗？"
2. 用户同意 → 用 `channel: "paid"` 重新调用 `generate_scene`（其余参数不变）。
3. 用户不同意 → 稍后重试 `channel: "agnes"`，或改用 `assets/scenes/` 里的预置背景。

付费通道是 OpenAI 兼容接口（默认未启用）：需在插件配置里填 `fallbackEnabled=true` + `fallbackBaseURL` + `fallbackImageModel` + `fallbackApiKey`（或 `fallbackApiKeyRef`）+ `fallbackPricePerImageRMB`（报价用）。

## 参数速查

- **场景 id**（`references/scenes.json`）：`E` 暗黑金属 / `F` 浅色影棚 / `G` 暖石材 / `H` 暗台面（横放）/ `I` 浅台面（横放）/ `J` 暗斜光带（斜立）。
- **角度**（`--angle`）：`vertical` 竖放 / `flat` 横放 / `diag` 斜放 / `tilt` 斜立 / `lie` 躺放。
- **palette**（`references/layouts.json`）：`dark` / `light` / `stone`，跟场景对应。
- **mode**：`hero`（产品占满、无文字，类样品图）/ `poster`（产品右置 + 左栏文案）。

## 效果图分区（用户放参考图的地方）

开工前先列一下**效果图分区**（插件配置 `effectsDir`，默认 `product-shot-effects/`）里有没有用户新放的效果图；有的话按其风格/构图去生成，而不是套默认场景。bundle 自带的参考图在 `assets/effects/`。

## 质量门（verify.py 会挡）

1. matte 软边占比 ≤2%（软边太多 = 白边残留风险）。
2. matte 透明区 RGB 均值 ≤0.15（反预乘失败 = 透明区残留白晕）。
3. 成品 1600×1600 且非空白。

任何一道不过就回头修 `key.py` / `upscale.py` 的抠图放大，不要带着白边交付。

## 已知限制（要如实告知用户，别硬吹）

- 几何合成能保证产品文字 100% 原样；代价是"躺放"在近正面源图上会偏薄（源图没有侧壁厚度）。
- 若用户要"有厚度的躺放"，可选 AI 重绘，但会改动产品外观（机身 / 模组 / 丝印）——默认不这么做。
- 字体默认依赖 Windows 微软雅黑；其他系统需自行改 `fonts`。
