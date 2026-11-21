# 如何申请并接入生图 API Key（Agnes）

本文教第一次使用「白底图 → 产品图」插件（product-shot）的新用户：先申请一个免费的 Agnes AI 生图 Key，再把它填进 DeepSeek Harness（DSH）。全程约 2 分钟，只做一次。

---

## 0. 为什么需要 Key

- DSH 本身**没有生图能力**。本插件用 **Agnes AI** 的免费生图接口来生成场景背景图。
- Agnes 要求每个用户用自己的 API Key（形如 `sk-xxxxx...`）调用，所以需要你注册账户并创建一个 Key。
- 这个 Key 只属于你、只存在你自己的电脑上；你的用量、额度都记在你自己的账户里。

> 本插件与常见的 `dsh-agnes-tools` 插件共用同一套 Key 约定（见第 2 节），
> 如果你已经装过并配过它，同一个 Key 直接通用，不用再申请。

---

## 1. 申请 API Key（免费）

1. 打开 Agnes AI 平台（按所在地区二选一，两家是同一家的国内 / 国际节点）：
   - **国内节点**：<https://platform.agnes-ai.cn/>
   - **国际节点**：<https://platform.agnes-ai.com/>
2. 注册账号，或登录已有账号。
3. 进入控制台，找到 **设置 → API 密钥**（Settings → API Keys）。
4. 点击 **创建新密钥**（Create New Key）。
5. 复制生成的 Key（格式 `sk-xxxxx...`）。

> ⚠️ **Key 一般只完整显示一次**，复制后请立刻保存到安全的地方。
>
> 当前推广期图片 / 视频模型免费；免费额度约 **20 次请求 / 分钟**，日常做产品图完全够用。

---

## 2. 把 Key 接入 DSH（三选一，推荐方式 A）

插件按下面的顺序找 Key，**填一种即可**（填了多种就按这个顺序取第一个）：

```
apiKey（插件配置里直接写） → DSH 凭据 AGNES_API_KEY → 环境变量 AGNES_API_KEY
```

### 方式 A：写在插件的 cordis.patch.yml（最简单，已验证可行）

打开你的 DSH profile 补丁文件 `cordis.patch.yml`：

- Windows 通常位于：`C:\Users\你的用户名\.dsh\profiles\<profile名>\cordis.patch.yml`

找到本插件的行，在 `config` 下加 `apiKey`（以及你所在地区对应的 `baseURL`）：

```yaml
- id: agnes                       # 本插件在 Loader 里的行 id（product-shot 的安装说明会写明）
  name: dsh-agnes-tools
  config:
    apiKey: sk-你的Key
    baseURL: https://api.agnes-ai.cn/v1        # 国内节点
    # baseURL: https://apihub.agnes-ai.com/v1  # 国际节点（二选一）
    imageModel: agnes-image-2.5-flash
```

保存后**重启 dsh**（host 侧插件在启动时装载，没有热加载）。

> 不推荐把 Key 长期明文写在配置里，但这是最快、最不容易出错的方式；
> 更讲究的做法用下面的方式 B。

### 方式 B：存进 DSH 凭据（更安全，进阶）

DSH 的凭据服务按名字读 Key，本插件默认读名为 `AGNES_API_KEY` 的凭据。在 DSH 的凭据文件
`$DSH_HOME/.env`（Windows：`C:\Users\你的用户名\.dsh\.env`）里加一行：

```
AGNES_API_KEY=sk-你的Key
```

保存后重启 dsh。若你的 DSH 界面提供了「凭据 / Credentials」的图形入口，在那里新增一条
`AGNES_API_KEY` 效果等同。

### 方式 C：系统环境变量

在系统环境变量里新增 `AGNES_API_KEY`，值填你的 Key，然后重启 dsh。

---

## 3. 验证是否接入成功

在 dsh 对话里说一句「列出我可用的生图模型」，让 Agent 调用 `agnes_models`（或直接运行对应工具）：

- **能列出模型清单**（如 `agnes-image-2.5-flash`）→ Key 有效、已接通 ✅
- 报「Agnes API Key 未配置」→ 还没读到 Key，回到第 2 节检查填的位置
- 报 `401` / `403` → Key 抄错、多带了空格、或已撤销，重新复制一遍

---

## 4. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `401` / `403` | Key 错、复制时多带空格、或已撤销 → 重新复制 |
| `429` | 超过免费额度 20 请求/分钟 → 稍等片刻再试 |
| `503 video_queue_full` | 视频队列满（生图一般不会遇到）→ 插件自动退避重试 |
| 生图返回慢 / 失败 | 换国际节点 `https://apihub.agnes-ai.com/v1`；图片走 base64 返回，不依赖境外图床 |
| 图片落在哪 | `outputDir` 指定的目录（默认 `agnes-output`） |

---

## 附：本插件用到的关键配置项（供排查参考）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `apiKey` | 空 | 直接写 Key，优先级最高（不推荐长期明文） |
| `apiKeyRef` | `AGNES_API_KEY` | 从 DSH 凭据里按这个名字取 Key |
| `baseURL` | `https://api.agnes-ai.cn/v1` | 国内节点；国际站用 `https://apihub.agnes-ai.com/v1` |
| `imageModel` | `agnes-image-2.5-flash` | 生图模型 |
| `videoModel` | `agnes-video-2.5-flash` | 生视频模型 |
| `outputDir` | `agnes-output` | 产物输出目录（绝对路径，或相对 dsh 进程 cwd） |

> 数据来源（已在本机核对）：`dsh-agnes-tools@0.1.0` 的 `cordis.patch.yml`、`README.md`、
> `lib/index.js`（`resolveKey()` 的解析顺序与报错文案），以及 Agnes 官方文档
> <https://wiki.agnes-ai.cn/zh-Hans/docs/cid5>。
