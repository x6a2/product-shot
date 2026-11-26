# 如何申请并接入 API Key（五家通道）

本文写给第一次用 product-shot 的人：先申请 key，再把它填进 DeepSeek Harness（DSH）。**只配你打算用的那几家就行，不需要全配。**

| 通道 | 用途 | 是否必需 | 免费额度（2026-11 现状） |
| --- | --- | --- | --- |
| Agnes（`AGNES_API_KEY`） | 生图 + 免费生视频 | 生图**必需** | 图片免费；视频队列长期满 |
| 智谱 BigModel（`ZHIPU_API_KEY`） | 免费生视频 + 付费 CogVideoX-3 | 可选（强烈建议） | CogVideoX-Flash **0 元** |
| 阿里百炼（`DASHSCOPE_API_KEY`） | 万相生视频 | 可选 | 新用户按模型送秒数 |
| 火山方舟（`ARK_API_KEY`） | Seedance 生视频 | 可选 | 每模型送 token |
| 硅基流动（`SILICONFLOW_API_KEY`） | MiniMax-H3（带音轨） | 可选 | 无免费额度，需充值 |

> 一家都没配也能装插件，但生图会直接报「未配置 key」；免费视频链则只剩已经配好的那几家。

---

## 1. Key 填在哪里（三选一，按优先级取第一个）

```
插件配置里的 xxxApiKey  →  DSH 凭据 refs 里的 xxxApiKeyRef  →  系统环境变量 xxxApiKeyRef
```

### 方式 A（推荐）：写进 DSH 凭据文件

文件：`C:\Users\<你的用户名>\.dsh\.credentials.yaml`（macOS / Linux 为 `~/.dsh/.credentials.yaml`）。

它本来就有 `version` / `refs` / `records` 三段，**只在 `refs:` 下面追加**，别动 `records:`：

```yaml
version: 1
refs:
  AGNES_API_KEY: <你的 Agnes key>
  ZHIPU_API_KEY: <你的智谱 key>
  DASHSCOPE_API_KEY: <你的百炼 key>
  ARK_API_KEY: <你的方舟 key>
  SILICONFLOW_API_KEY: <你的硅基 key>
records:
  ...（保持原样，别删）
```

注意缩进：`refs:` 下每行**两个空格**，冒号后一个空格，key **不要加引号**。

改完**立即生效**，不用重启 DSH（凭据是在每次调用时读取的）。如果 DSH 界面有「凭据 / Credentials」入口，在那里新增同名条目效果一样。

### 方式 B：写在插件配置里

在插件配置（或 profile 的 `cordis.patch.yml` 里本插件那行）直接填：

```yaml
- id: product-shot
  name: product-shot
  config:
    zhipuApiKey: <你的智谱 key>
    dashscopeApiKey: <你的百炼 key>
```

这种方式需要**重载插件**才生效（DSH 插件页关一下再开）。明文写在配置里不如方式 A 安全。

### 方式 C：系统环境变量

把变量名设成上面的 `xxxApiKeyRef`（如 `ZHIPU_API_KEY`），值填 key，然后重启 DSH。适合 CI / 服务器。

---

## 2. 逐家申请

### 2.1 Agnes（生图必需）

1. 打开 <https://platform.agnes-ai.cn/>（国内）或 <https://platform.agnes-ai.com/>（国际）。
2. 注册 / 登录 → **设置 → API 密钥** → 创建新密钥。
3. 复制 `sk-...` 开头的 key。

- 国内节点 `baseURL` 用 `https://api.agnes-ai.cn/v1`；国际节点用 `https://apihub.agnes-ai.com/v1`。
- 和 `dsh-agnes-tools` 插件共用同一个 `AGNES_API_KEY`，装过它就不用再申请。

### 2.2 智谱 BigModel（免费视频首选）

1. 打开 <https://open.bigmodel.cn/> → 注册 / 登录。
2. 控制台 → **API Keys** → 新建，复制 key（形如 `xxxxxxxx.xxxxxxxx`，两段中间一个点）。
3. 想用付费档 `cogvideox-3` 再充值；免费档 `cogvideox-flash` 不用充钱。

- **注意**：智谱会做内容审核，**中文提示词容易被拦**（报「系统检测到输入或生成内容可能包含不安全或敏感内容」）。写视频 prompt 用中性英文，别带人物、品牌、敏感词。
- 免费档有并发限制，排队是正常现象。

### 2.3 阿里百炼（万相）

1. 打开 <https://bailian.console.aliyun.com/>（需阿里云账号）。
2. 右上角 **API-KEY** → 创建，复制 key（注意：新版 workspace key 形如 `sk-ws-...`，也支持 `sk-` + 32 位）。
3. **必须先在「模型广场」开通** `wanx2.1-t2v-turbo`（文生）和 `wanx2.1-i2v-turbo`（图生），否则接口报模型未开通。

- 按秒计费（约 ¥0.24/秒），新用户有赠送额度；额度用完会自动扣费，请在控制台看余额。
- 图生视频的图片要用公网可访问的 URL。

### 2.4 火山方舟（Seedance）

1. 打开 <https://console.volcengine.com/ark>（需火山引擎账号）。
2. **API Key 管理** → 创建，复制 key（形如 `ark-xxxx-...`）。
3. 到 **模型广场** 开通 `doubao-seedance-1-0-pro-fast-251015`（不开通会报模型不存在/未授权）。

- 每个模型有免费 token 额度；参数（分辨率、时长、画幅）通过 prompt 后缀传给模型，插件已经拼好。

### 2.5 硅基流动（MiniMax-H3，带音轨）

1. 打开 <https://cloud.siliconflow.cn/> → 注册 / 登录。
2. **API 密钥** → 新建，复制 `sk-...`。
3. 需要先充值（无免费视频额度）；模型 `MiniMaxAI/MiniMax-H3` 已默认可用。

- 单价约 ¥0.5/秒（768P，带音轨），是三家里最贵的，但出片带声音。

---

## 3. 怎么确认配好了（不花钱）

任选一种；返回「鉴权通过」就说明 key 填对了，**不会产生生成费用**。

```bash
# 智谱：400 + code 1233 = key 可用；401 = key 无效
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer <智谱key>" \
  https://open.bigmodel.cn/api/paas/v4/async-result/probe-not-exist

# 百炼：200（task_status=UNKNOWN）= key 可用；401 = key 无效
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer <百炼key>" \
  https://dashscope.aliyuncs.com/api/v1/tasks/probe-not-exist

# 方舟：404 ResourceNotFound = key 可用；401 = key 无效
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer <方舟key>" \
  https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/probe-not-exist

# 硅基：200 = key 可用
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Authorization: Bearer <硅基key>" \
  https://api.siliconflow.cn/v1/models
```

在 DSH 里也可以直接说「生成一个 5 秒测试视频」，看返回的是「已生成视频」还是「没配 key」。

---

## 4. 注意事项（务必看）

1. **key 不要提交到 Git / 不要发给别人**。这个插件只从你本机的凭据文件、插件配置或环境变量读取 key，仓库里没有任何 key。
2. 别人用这个插件时，**各自配自己的 key**，用量算在各自账号上。
3. **改凭据文件立即生效**；改插件配置（`cordis.patch.yml`）需要重载插件或重启 DSH。
4. 免费额度是各家营销政策，**随时会变**；插件里的报价是参考价（`PRICE_UPDATED` 常量标注日期），真实扣费以各家账单为准。
5. **不自动扣费**：免费链排队超时会停下来给你一张多平台报价表，你选中哪家、说了「走付费」，才会调用付费通道。
6. 智谱的**内容审核**会拦中文提示词（见 2.2）；被拦时换英文中性描述。
7. 百炼 / 方舟要**先在控制台开通对应模型**，否则报「模型未开通 / 不存在」。
8. 图生视频时，**本地图片会以 data URI 提交**；若某家接口只认公网 URL，会明确报错提示你换 URL。
9. 排队满（`503 video_queue_full`）不是 key 的问题，是平台队列；插件会退避重试并换下一家。
10. key 泄露了就立刻去控制台**吊销重建**，再更新凭据文件。

---

## 5. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 「没配 key：请填 xxxApiKey，或在 DSH 凭据里配 XXX_API_KEY」 | 该家没配；按第 1 节填，或不管它（免费链会跳过这家） |
| `401` / `令牌已过期或验证不正确` | key 抄错、少了字符、或已被吊销 |
| 智谱报「内容可能包含不安全或敏感内容」 | 提示词过审失败，改中性英文（见 2.2） |
| 百炼报模型未开通 | 去模型广场开通 `wanx2.1-t2v-turbo` |
| 方舟报 ResourceNotFound / 未授权 | 去模型广场开通 `doubao-seedance-1-0-pro-fast-251015` |
| `503 video_queue_full` | 平台队列满，等一会儿或换下一家（插件自动做） |
| 报价里某家显示「未配置 key」 | 那家没配；不影响其他通道 |
| 出片落在哪 | `outputDir/videos/`（默认 `product-shot-output/videos/`） |

---

## 附：本插件用到的 key 相关配置项

| 键 | 默认 ref | 说明 |
| --- | --- | --- |
| `apiKey` / `apiKeyRef` | `AGNES_API_KEY` | 生图 + Agnes 视频 |
| `zhipuApiKey` / `zhipuApiKeyRef` | `ZHIPU_API_KEY` | 智谱（免费 Flash / 付费 CogVideoX-3） |
| `dashscopeApiKey` / `dashscopeApiKeyRef` | `DASHSCOPE_API_KEY` | 阿里百炼万相 |
| `arkApiKey` / `arkApiKeyRef` | `ARK_API_KEY` | 火山方舟 Seedance |
| `siliconflowApiKey` / `siliconflowApiKeyRef` | `SILICONFLOW_API_KEY` | 硅基流动 MiniMax-H3 |
| `fallbackApiKey` / `fallbackApiKeyRef` | 空 | 自定义付费生图通道 |
| `fallbackEnabled` | `false` | 自定义付费视频通道开关 |
