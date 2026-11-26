/**
 * product-shot —— 白底产品图 → 多场景多角度商品图（自包含 bundle）。
 *
 * 设计约束（同 dsh-agnes-tools）：插件运行在 profile 的 node_modules 下，解析不到
 * @deepseek-ai/dsh-tools。所以【不 import 任何 @deepseek-ai 运行时包】，工具定义直接
 * 满足 ctx.tools.register() 契约。生图走 Agnes Image API（用户自备 key），与
 * dsh-agnes-tools 共用同一套 key 约定（apiKey / apiKeyRef=AGNES_API_KEY / baseURL）。
 * 另提供付费 fallback 通道（OpenAI 兼容生图，如 SiliconFlow），Agnes 排队超时后改道。
 */
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

export const name = 'product-shot'
export const inject = ['tools', 'skills']

export const Config = z.object({
  /** 直接写 Key（不推荐）；留空则用凭据引用。 */
  apiKey: z.string().default(''),
  /** DSH 凭据里的引用名，与 dsh-agnes-tools 共用。 */
  apiKeyRef: z.string().default('AGNES_API_KEY'),
  baseURL: z.string().default('https://api.agnes-ai.cn/v1'),
  imageModel: z.string().default('agnes-image-2.5-flash'),
  /** 成品输出目录：绝对路径，或相对 DSH 进程 cwd。 */
  outputDir: z.string().default('product-shot-output'),
  /** 预期效果图分区：用户放参考效果图的地方（skill 开工前会先读这里）。 */
  effectsDir: z.string().default('product-shot-effects'),
  /** 免费通道排队多久算"卡住"（毫秒），默认 5 分钟。 */
  queueTimeoutMs: z.number().default(300000),
  /** 付费 fallback 通道（OpenAI 兼容生图，如 SiliconFlow）。enabled=false 时不启用。 */
  fallbackEnabled: z.boolean().default(false),
  fallbackName: z.string().default('SiliconFlow'),
  fallbackBaseURL: z.string().default(''),
  fallbackApiKey: z.string().default(''),
  fallbackApiKeyRef: z.string().default(''),
  fallbackImageModel: z.string().default(''),
  fallbackPricePerImageRMB: z.number().default(0.05),
  /** 视频通道：免费 Agnes 视频模型（720P）。 */
  videoModel: z.string().default('agnes-video-2.5-flash'),
  /** 免费视频通道排队多久算"卡住"（毫秒），默认 10 分钟；超了返回 queue_stalled，让 agent 问用户是否走付费通道。 */
  videoQueueTimeoutMs: z.number().default(600000),
  /** 视频任务轮询间隔（毫秒）。 */
  videoPollIntervalMs: z.number().default(8000),
  /** video_status 一次调用最多等多久（毫秒）。 */
  videoStatusWaitMs: z.number().default(120000),
  /** 付费视频通道模型 id（留空 = 付费视频不可用）。 */
  fallbackVideoModel: z.string().default(''),
  /** 付费视频提交端点，默认 `${fallbackBaseURL}/videos/generations`。 */
  fallbackVideoEndpoint: z.string().default(''),
  /** 付费视频状态端点：含 {id} 用 GET 替换；不含 {id} 用 POST body {requestId}；留空 = 提交接口同步返回成品。 */
  fallbackVideoStatusEndpoint: z.string().default(''),
  /** 单条视频预估 RMB（仅提示，非真实扣费）。 */
  fallbackPricePerVideoRMB: z.number().default(0.5),
  /** 免费视频链：逗号分隔，按顺序试（额度用尽的自动跳过）；默认 Agnes → 智谱 → 百炼 → 方舟。 */
  freeChain: z.string().default('agnes,zhipu,dashscope,ark'),
  /** 智谱 BigModel（CogVideoX）：Flash 免费，CogVideoX-3 约 ¥1/条。 */
  zhipuApiKey: z.string().default(''),
  zhipuApiKeyRef: z.string().default('ZHIPU_API_KEY'),
  zhipuBaseURL: z.string().default('https://open.bigmodel.cn/api/paas/v4'),
  zhipuVideoModel: z.string().default('cogvideox-flash'),
  zhipuPaidVideoModel: z.string().default('cogvideox-3'),
  /** 阿里百炼（万相）：新用户送免费秒数，超出按秒计费。 */
  dashscopeApiKey: z.string().default(''),
  dashscopeApiKeyRef: z.string().default('DASHSCOPE_API_KEY'),
  dashscopeBaseURL: z.string().default('https://dashscope.aliyuncs.com/api/v1'),
  dashscopeT2VModel: z.string().default('wanx2.1-t2v-turbo'),
  dashscopeI2VModel: z.string().default('wanx2.1-i2v-turbo'),
  /** 火山方舟（Seedance）：每模型送免费 token 额度。 */
  arkApiKey: z.string().default(''),
  arkApiKeyRef: z.string().default('ARK_API_KEY'),
  arkBaseURL: z.string().default('https://ark.cn-beijing.volces.com/api/v3'),
  arkVideoModel: z.string().default('doubao-seedance-1-0-pro-fast-251015'),
  /** 硅基流动（MiniMax-H3，带音轨）：按秒计费，无免费额度。 */
  siliconflowApiKey: z.string().default(''),
  siliconflowApiKeyRef: z.string().default('SILICONFLOW_API_KEY'),
  siliconflowBaseURL: z.string().default('https://api.siliconflow.cn/v1'),
  siliconflowVideoModel: z.string().default('MiniMaxAI/MiniMax-H3'),
  /** 报价用单价（RMB）：供应商改价时只改这里，不用动代码。 */
  priceZhipuPerVideo: z.number().default(1),
  priceDashscopePerSecond: z.number().default(0.24),
  priceArkPerSecond: z.number().default(0.2),
  priceSiliconflowPerSecond: z.number().default(0.5),
})

const DEFAULTS = {
  apiKey: '',
  apiKeyRef: 'AGNES_API_KEY',
  baseURL: 'https://api.agnes-ai.cn/v1',
  imageModel: 'agnes-image-2.5-flash',
  outputDir: 'product-shot-output',
  effectsDir: 'product-shot-effects',
  queueTimeoutMs: 300000,
  fallbackEnabled: false,
  fallbackName: 'SiliconFlow',
  fallbackBaseURL: '',
  fallbackApiKey: '',
  fallbackApiKeyRef: '',
  fallbackImageModel: '',
  fallbackPricePerImageRMB: 0.05,
  videoModel: 'agnes-video-2.5-flash',
  videoQueueTimeoutMs: 600000,
  videoPollIntervalMs: 8000,
  videoStatusWaitMs: 120000,
  fallbackVideoModel: '',
  fallbackVideoEndpoint: '',
  fallbackVideoStatusEndpoint: '',
  fallbackPricePerVideoRMB: 0.5,
  freeChain: 'agnes,zhipu,dashscope,ark',
  zhipuApiKey: '',
  zhipuApiKeyRef: 'ZHIPU_API_KEY',
  zhipuBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
  zhipuVideoModel: 'cogvideox-flash',
  zhipuPaidVideoModel: 'cogvideox-3',
  dashscopeApiKey: '',
  dashscopeApiKeyRef: 'DASHSCOPE_API_KEY',
  dashscopeBaseURL: 'https://dashscope.aliyuncs.com/api/v1',
  dashscopeT2VModel: 'wanx2.1-t2v-turbo',
  dashscopeI2VModel: 'wanx2.1-i2v-turbo',
  arkApiKey: '',
  arkApiKeyRef: 'ARK_API_KEY',
  arkBaseURL: 'https://ark.cn-beijing.volces.com/api/v3',
  arkVideoModel: 'doubao-seedance-1-0-pro-fast-251015',
  siliconflowApiKey: '',
  siliconflowApiKeyRef: 'SILICONFLOW_API_KEY',
  siliconflowBaseURL: 'https://api.siliconflow.cn/v1',
  siliconflowVideoModel: 'MiniMaxAI/MiniMax-H3',
  priceZhipuPerVideo: 1,
  priceDashscopePerSecond: 0.24,
  priceArkPerSecond: 0.2,
  priceSiliconflowPerSecond: 0.5,
}

const ROOT = dirname(fileURLToPath(import.meta.url))
const RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9']
const TIERS = ['1K', '2K', '3K', '4K']
const VIDEO_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']
const VIDEO_SECONDS = ['4', '5', '6', '8', '10', '12']
const VIDEO_DONE = new Set(['completed', 'complete', 'succeeded', 'succeed', 'success', 'done', 'finished'])
const VIDEO_FAIL = new Set(['failed', 'fail', 'error', 'cancelled', 'canceled', 'timeout', 'expired'])

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
function rand() {
  return Math.random().toString(36).slice(2, 6)
}
function mediaTypeOf(file) {
  const ext = extname(file).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return 'image/png'
}

async function resolveKey(ctx, config) {
  if (config.apiKey) return config.apiKey
  const ref = config.apiKeyRef
  try {
    const creds = ctx.get?.('credentials')
    if (creds && typeof creds.resolve === 'function') {
      const got = await creds.resolve(ref)
      if (got && typeof got.value === 'string' && got.value.length > 0) return got.value
    }
  } catch {
    /* 凭据服务不可用就继续 */
  }
  const ambient = process.env[ref]
  if (ambient) return ambient
  throw new Error(`Agnes API Key 未配置：请在 DSH 凭据里设置 ${ref}，或在 product-shot 插件配置里填 apiKey`)
}

async function resolveFallbackKey(ctx, config) {
  if (config.fallbackApiKey) return config.fallbackApiKey
  const ref = config.fallbackApiKeyRef
  if (!ref) throw new Error('付费通道 Key 未配置：请在 product-shot 插件配置里填 fallbackApiKey 或 fallbackApiKeyRef。')
  try {
    const creds = ctx.get?.('credentials')
    if (creds && typeof creds.resolve === 'function') {
      const got = await creds.resolve(ref)
      if (got && typeof got.value === 'string' && got.value.length > 0) return got.value
    }
  } catch {
    /* 凭据服务不可用就继续 */
  }
  const ambient = process.env[ref]
  if (ambient) return ambient
  throw new Error(`付费通道 Key 未配置：请在 DSH 凭据里设置 ${ref}，或在 product-shot 插件配置里填 fallbackApiKey`)
}

async function requestJSON(url, { method = 'GET', key, body, signal, timeoutMs = 300000, headers = {}, label = '接口' } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const forward = () => ac.abort()
  signal?.addEventListener?.('abort', forward, { once: true })
  try {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
      redirect: 'error',
    })
    const text = await res.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text.slice(0, 400) }
    }
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}：${JSON.stringify(data).slice(0, 400)}`)
    return data
  } catch (err) {
    if (err?.name === 'AbortError' && !signal?.aborted) {
      const e = new Error(`请求超时（约 ${Math.round(timeoutMs / 60000)} 分钟，可能仍在排队）`)
      e.code = 'QUEUE_TIMEOUT'
      throw e
    }
    if (err?.name === 'TypeError' || String(err?.message ?? '') === 'fetch failed') {
      const cause = err?.cause
      const detail = String(cause?.code ?? cause?.message ?? err?.message ?? '网络不可达')
      throw new Error(`网络请求失败：${detail}`)
    }
    throw err
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', forward)
  }
}

async function fetchBytes(url, signal) {
  const res = await fetch(url, { signal, redirect: 'error' })
  if (!res.ok) throw new Error(`下载产物失败：HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function imageBytes(item, signal) {
  if (item && typeof item.b64_json === 'string' && item.b64_json.length > 0) {
    return Buffer.from(item.b64_json, 'base64')
  }
  if (item && typeof item.url === 'string' && item.url.length > 0) {
    return fetchBytes(item.url, signal)
  }
  throw new Error(`Agnes 响应里没有图片数据：${JSON.stringify(item ?? {}).slice(0, 200)}`)
}

/** 把"档位 + 画幅"换算成 OpenAI 兼容的像素尺寸，如 1536x1536。 */
function pixelSize(tier, ratio) {
  const short = { '1K': 1024, '2K': 1536, '3K': 1792, '4K': 2048 }[tier] ?? 1536
  const [rw, rh] = ratio.split(':').map(Number)
  let w
  let h
  if (!rw || !rh) {
    w = h = short
  } else if (rw >= rh) {
    h = short
    w = Math.round((short * rw) / rh)
  } else {
    w = short
    h = Math.round((short * rh) / rw)
  }
  const snap = (n) => Math.max(256, Math.min(4096, Math.round(n / 16) * 16))
  return `${snap(w)}x${snap(h)}`
}

function resolveTarget(config, wanted, fallbackName, subdir = 'scenes') {
  const base = isAbsolute(config.outputDir) ? config.outputDir : resolve(process.cwd(), config.outputDir)
  if (typeof wanted === 'string' && wanted.trim().length > 0) {
    return isAbsolute(wanted) ? wanted : resolve(base, wanted)
  }
  return join(base, subdir, fallbackName)
}

async function saveBytes(target, bytes) {
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  return bytes.length
}

/* ------------------------------------------------------------ 视频通道公共件 */

function originOf(baseURL) {
  const u = new URL(baseURL)
  return `${u.protocol}//${u.host}`
}

function sleep(ms, signal) {
  return new Promise((done) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      done()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      done()
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** 网络层抖动（DNS/TLS/连接超时）：也值得重试，不该整单失败。 */
function isTransientNetwork(error) {
  const message = String(error?.message ?? '')
  return (
    message.includes('网络') ||
    message.includes('fetch failed') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT') ||
    message.includes('ENOTFOUND') ||
    message.includes('EAI_AGAIN') ||
    message.includes('UND_ERR')
  )
}

/** 队列满 / 限流这类「等一会儿就好」的错误。 */
function isVideoQueueBusy(error) {
  const message = String(error?.message ?? '')
  return (
    message.includes('video_queue_full') ||
    message.includes('queue is full') ||
    message.includes('队列已满') ||
    message.includes('HTTP 429') ||
    message.includes('HTTP 502') ||
    message.includes('HTTP 503') ||
    message.includes('HTTP 504')
  )
}

/** 把本地首帧图转成 data URI；公网 URL / data URI 原样返回。 */
async function toVideoFrame(value, cwd) {
  const one = String(value ?? '').trim()
  if (!one) throw new Error('图片参数为空')
  if (/^https?:\/\//i.test(one) || one.startsWith('data:')) return one
  const file = isAbsolute(one) ? one : resolve(cwd ?? process.cwd(), one)
  const bytes = await readFile(file)
  return `data:${mediaTypeOf(file)};base64,${bytes.toString('base64')}`
}

function normalizeVideoStatus(data) {
  const raw = data?.status ?? data?.state ?? data?.data?.status ?? data?.result?.status ?? ''
  const status = String(raw).trim().toLowerCase()
  if (VIDEO_DONE.has(status)) return 'completed'
  if (VIDEO_FAIL.has(status)) return 'failed'
  return 'pending'
}

function videoProgress(data) {
  const n = data?.progress ?? data?.percent ?? data?.data?.progress
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0
}

/** 从各种常见响应形状里挑出视频地址。 */
function pickVideoUrl(data) {
  const list = [
    data?.url,
    data?.video_url,
    data?.videoUrl,
    data?.output_url,
    data?.data?.[0]?.url,
    data?.data?.[0]?.video_url,
    data?.result?.url,
    data?.result?.video_url,
    data?.results?.videos?.[0]?.url,
    data?.output?.url,
    Array.isArray(data?.output) ? data.output[0]?.url : undefined,
    data?.videos?.[0]?.url,
  ]
  return list.find((one) => typeof one === 'string' && one.length > 0) ?? ''
}

function pickTaskId(data) {
  const list = [
    data?.video_id,
    data?.id,
    data?.task_id,
    data?.taskId,
    data?.request_id,
    data?.requestId,
    data?.data?.video_id,
    data?.data?.id,
    data?.data?.task_id,
  ]
  return list.find((one) => typeof one === 'string' && one.length > 0) ?? ''
}

function videoFallback(config) {
  return {
    provider: config.fallbackName || 'fallback',
    estimatedCostRMB: config.fallbackPricePerVideoRMB,
    enabled: Boolean(config.fallbackEnabled),
    configured: Boolean(config.fallbackEnabled && config.fallbackBaseURL && config.fallbackVideoModel),
  }
}

function normalizeVideoSeconds(value) {
  const one = String(value ?? '').trim()
  return VIDEO_SECONDS.includes(one) ? one : '5'
}

/** 把毫秒说成人话：<90 秒报秒，否则报分钟。 */
function fmtDuration(ms) {
  const sec = Math.max(1, Math.round(Number(ms ?? 0) / 1000))
  if (sec < 90) return `${sec} 秒`
  return `${Math.round(sec / 60)} 分钟`
}

/** 从错误信息里抠出尽量短的一句（避免把整段 503 body 甩给用户）。 */
function shortError(error) {
  const raw = String(error?.message ?? '').replace(/\s+/g, ' ')
  const match = raw.match(/"message"\s*:\s*"([^"]{1,160})"/)
  return (match ? match[1] : raw).slice(0, 160)
}

/* ============================ 视频通道（多 provider） ============================ */

/** 报价表价格的更新时间：改价时改这里，README 里同步标注。 */
const PRICE_UPDATED = '2026-11-26'

/** 免费链默认顺序：Agnes → 智谱 → 百炼 → 方舟（越靠前越优先试）。 */
const FREE_CHAIN_DEFAULT = 'agnes,zhipu,dashscope,ark'

/**
 * 视频 provider 注册表：能力、价格、优劣、文档都放这里，报价表和提示文案统一取用。
 * free=true 表示有免费额度（进免费链）；canPay=true 表示可按量付费。
 * model(config, job, paid) 返回模型 id；cost(config, seconds) 返回单条预估 RMB。
 */
const VIDEO_PROVIDERS = {
  agnes: {
    id: 'agnes',
    label: 'Agnes',
    free: true,
    canPay: false,
    baseField: 'baseURL',
    defaultBase: 'https://api.agnes-ai.cn/v1',
    keyField: 'apiKey',
    refField: 'apiKeyRef',
    defaultRef: 'AGNES_API_KEY',
    model: (config) => config.videoModel,
    cost: () => 0,
    quality: '免费 720P，画面干净、运镜自然，画质中等',
    pros: ['完全免费', '720P', '文生 / 首帧图生 / 参考图'],
    cons: ['免费队列经常排满，等待不可控', '无音轨', '商品上的文字会糊'],
    docs: 'https://agnes-ai.com',
    note: '免费队列长期满，通常直接走到超时',
  },
  zhipu: {
    id: 'zhipu',
    label: '智谱 BigModel',
    free: true,
    canPay: true,
    baseField: 'zhipuBaseURL',
    defaultBase: 'https://open.bigmodel.cn/api/paas/v4',
    keyField: 'zhipuApiKey',
    refField: 'zhipuApiKeyRef',
    defaultRef: 'ZHIPU_API_KEY',
    model: (config, _job, paid) => (paid ? config.zhipuPaidVideoModel : config.zhipuVideoModel),
    cost: (config) => round2(config.priceZhipuPerVideo),
    quality: 'CogVideoX-Flash 免费、画质中等偏上；付费 CogVideoX-3 细节更好',
    pros: ['Flash 模型官方 0 元', '文生 + 图生', '国内直连快'],
    cons: ['免费版限并发排队', '时长基本固定 5s', '无音轨'],
    docs: 'https://open.bigmodel.cn/dev/api/video-model/cogvideox',
    note: 'Flash 免费；额度用尽可切 cogvideox-3（约 ¥1/条）',
  },
  dashscope: {
    id: 'dashscope',
    label: '阿里百炼·万相',
    free: true,
    canPay: true,
    baseField: 'dashscopeBaseURL',
    defaultBase: 'https://dashscope.aliyuncs.com/api/v1',
    keyField: 'dashscopeApiKey',
    refField: 'dashscopeApiKeyRef',
    defaultRef: 'DASHSCOPE_API_KEY',
    model: (config, job) => (job.image ? config.dashscopeI2VModel : config.dashscopeT2VModel),
    cost: (config, seconds) => round2(config.priceDashscopePerSecond * seconds),
    quality: '万相 2.1 turbo，720P，商品主体还原好、动作幅度保守',
    pros: ['新用户按模型送免费秒数', '国内直连、稳定', '图生视频还原好'],
    cons: ['免费额度有限', '单条 5s（2.5 才 10s）', '无音轨'],
    docs: 'https://help.aliyun.com/zh/model-studio/video-generation-api',
    note: '免费额度用完按秒计费，约 ¥0.24/秒（720P）',
  },
  ark: {
    id: 'ark',
    label: '火山方舟·Seedance',
    free: true,
    canPay: true,
    baseField: 'arkBaseURL',
    defaultBase: 'https://ark.cn-beijing.volces.com/api/v3',
    keyField: 'arkApiKey',
    refField: 'arkApiKeyRef',
    defaultRef: 'ARK_API_KEY',
    model: (config) => config.arkVideoModel,
    cost: (config, seconds) => round2(config.priceArkPerSecond * seconds),
    quality: 'Seedance 1.0 pro-fast，运动幅度大、镜头感强，可 1080P',
    pros: ['每个模型送免费 token 额度', '画质和运动好', '支持 1080P'],
    cons: ['免费额度很快用完', '参数走文本后缀，接入略绕', '价格随分辨率变化'],
    docs: 'https://www.volcengine.com/docs/82379/1520757',
    note: 'pro-fast 约 ¥1/5s；pro 更贵',
  },
  siliconflow: {
    id: 'siliconflow',
    label: '硅基流动',
    free: false,
    canPay: true,
    baseField: 'siliconflowBaseURL',
    defaultBase: 'https://api.siliconflow.cn/v1',
    keyField: 'siliconflowApiKey',
    refField: 'siliconflowApiKeyRef',
    defaultRef: 'SILICONFLOW_API_KEY',
    model: (config) => config.siliconflowVideoModel,
    cost: (config, seconds) => round2(config.priceSiliconflowPerSecond * seconds),
    quality: 'MiniMax-H3，768P，带音轨，运动自然',
    pros: ['按秒计费便宜', '带音轨', '接口简单（提交 + 查状态）'],
    cons: ['需要充值', '排队视负载'],
    docs: 'https://docs.siliconflow.cn/docs/api/video-submit-post',
    note: '768P 约 ¥0.5/秒，480P 约 ¥0.33/秒',
  },
  custom: {
    id: 'custom',
    label: '自定义通道',
    free: false,
    canPay: true,
    baseField: 'fallbackBaseURL',
    defaultBase: '',
    keyField: 'fallbackApiKey',
    refField: 'fallbackApiKeyRef',
    defaultRef: '',
    model: (config) => config.fallbackVideoModel,
    cost: (config) => round2(config.fallbackPricePerVideoRMB),
    quality: '自建或第三方聚合，能力看 provider',
    pros: ['任意 OpenAI 风格接口'],
    cons: ['要自己填端点和价格'],
    docs: '',
    note: '旧版 fallback* 配置，保留兼容',
  },
}

/** 本次进程内的 provider 状态：免费额度用尽就标记，后续直接跳过。 */
const providerState = new Map()

/** 已提交、还没拿到的任务：video_status 续查时估算已排队时长。 */
const videoTasks = new Map()

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

function providerLabel(id) {
  return VIDEO_PROVIDERS[id]?.label ?? id
}

async function resolveProviderKey(ctx, config, id) {
  const p = VIDEO_PROVIDERS[id]
  if (!p) return ''
  const direct = config[p.keyField]
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const ref =
    typeof config[p.refField] === 'string' && config[p.refField].trim()
      ? config[p.refField].trim()
      : p.defaultRef
  if (!ref) return ''
  try {
    const value = await ctx.get('credentials')?.resolve(ref)
    if (value) return String(value).trim()
  } catch {
    /* 凭据服务不可用时退回环境变量 */
  }
  return String(process.env[ref] ?? '').trim()
}

function providerBaseURL(config, id) {
  const p = VIDEO_PROVIDERS[id]
  if (!p) return ''
  const raw = String(config[p.baseField] ?? '').trim().replace(/\/+$/, '')
  return raw || p.defaultBase
}

function providerModel(config, id, job, { paid = false } = {}) {
  const p = VIDEO_PROVIDERS[id]
  if (!p || typeof p.model !== 'function') return ''
  return String(p.model(config, job, paid) ?? '').trim()
}

/** 单条视频的预估费用（RMB，付费价；免费额度内按 0 展示）。 */
function videoCostRMB(config, id, seconds) {
  const p = VIDEO_PROVIDERS[id]
  if (!p) return 0
  return round2(p.cost(config, Number(seconds) || 5))
}

/** 额度不足 / 欠费这类「这家不能再白嫖了」的错误。 */
function isQuotaError(error) {
  const text = String(error?.message ?? '')
  return /insufficient|quota|arrears|欠费|余额不足|额度不足|额度已用尽|免费额度/i.test(text)
}

/** 生成多平台报价对比表：免费额度 + 付费价，含优劣、key 状态、文档。 */
async function videoQuotes(ctx, config, job) {
  const rows = []
  for (const id of Object.keys(VIDEO_PROVIDERS)) {
    const p = VIDEO_PROVIDERS[id]
    if (id === 'custom' && !config.fallbackEnabled) continue
    const key = await resolveProviderKey(ctx, config, id)
    const configured = Boolean(key)
    const state = providerState.get(id) ?? {}
    const keyRef = p.defaultRef || p.refField
    const base = {
      provider: id,
      label: p.label,
      configured,
      keyRef,
      quality: p.quality,
      pros: p.pros,
      cons: p.cons,
      docs: p.docs,
      notes: p.note,
    }
    if (p.free) {
      rows.push({
        ...base,
        model: providerModel(config, id, job, { paid: false }),
        tier: 'free',
        estimatedCostRMB: 0,
        status: !configured
          ? `未配置 key（${keyRef}）`
          : state.quotaExhausted
            ? '本次会话免费额度已用尽'
            : '免费额度内',
      })
    }
    if (p.canPay) {
      const cost = videoCostRMB(config, id, Number(job.seconds) || 5)
      rows.push({
        ...base,
        model: providerModel(config, id, job, { paid: true }),
        tier: 'paid',
        estimatedCostRMB: cost,
        status: !configured ? `未配置 key（${keyRef}）` : '可按量付费',
      })
    }
  }
  rows.sort((a, b) => {
    if (a.estimatedCostRMB !== b.estimatedCostRMB) return a.estimatedCostRMB - b.estimatedCostRMB
    return String(a.label).localeCompare(String(b.label))
  })
  return rows
}

/* ------------------------------- provider 适配器 ------------------------------- */

function videoJobOf(job) {
  return {
    prompt: job.prompt,
    image: job.image ?? '',
    references: Array.isArray(job.references) ? job.references : [],
    seconds: String(job.seconds ?? '5'),
    ratio: String(job.ratio ?? '16:9'),
  }
}

/** 把画幅换算成 720P 档的像素尺寸（硅基流动要 image_size）。 */
function ratioToPixels(ratio) {
  const [rw, rh] = String(ratio ?? '16:9').split(':').map(Number)
  if (!rw || !rh) return '1280x720'
  const short = 720
  const snap = (n) => Math.round(n / 8) * 8
  return rw >= rh ? `${snap((short * rw) / rh)}x${short}` : `${short}x${snap((short * rh) / rw)}`
}

const VIDEO_ADAPTERS = {
  agnes: {
    label: 'Agnes',
    async submit(_ctx, config, key, job, signal) {
      const model = job.model || providerModel(config, 'agnes', job)
      const body = {
        model,
        prompt: job.prompt,
        mode: job.image ? 'keyframe' : job.references.length ? 'reference' : 'text',
        seconds: job.seconds,
        size: '720P',
        aspect_ratio: job.ratio,
      }
      if (job.image) body.first_frame = job.image
      if (job.references.length) body.images = job.references.slice(0, 5)
      const data = await requestJSON(`${providerBaseURL(config, 'agnes')}/videos`, {
        method: 'POST',
        key,
        body,
        signal,
        label: 'Agnes',
      })
      const taskId = pickTaskId(data)
      if (!taskId) throw new Error(`Agnes 没有返回 video_id：${JSON.stringify(data).slice(0, 200)}`)
      return { taskId }
    },
    async poll(config, key, taskId, signal) {
      const url = `${originOf(providerBaseURL(config, 'agnes'))}/agnesapi?video_id=${encodeURIComponent(taskId)}&model_name=${encodeURIComponent(config.videoModel)}`
      const data = await requestJSON(url, { key, signal, timeoutMs: 60000, label: 'Agnes' })
      return {
        state: normalizeVideoStatus(data),
        url: pickVideoUrl(data),
        progress: videoProgress(data),
        message: typeof data?.message === 'string' ? data.message : undefined,
      }
    },
  },
  zhipu: {
    label: '智谱',
    async submit(_ctx, config, key, job, signal) {
      const model = job.model || providerModel(config, 'zhipu', job)
      const body = { model, prompt: job.prompt }
      const frame = job.image || job.references[0] || ''
      if (frame) body.image_url = frame
      const data = await requestJSON(`${providerBaseURL(config, 'zhipu')}/videos/generations`, {
        method: 'POST',
        key,
        body,
        signal,
        label: '智谱',
      })
      const taskId = pickTaskId(data)
      if (!taskId) throw new Error(`智谱没有返回任务 id：${JSON.stringify(data).slice(0, 200)}`)
      return { taskId }
    },
    async poll(config, key, taskId, signal) {
      const data = await requestJSON(
        `${providerBaseURL(config, 'zhipu')}/async-result/${encodeURIComponent(taskId)}`,
        { key, signal, timeoutMs: 60000, label: '智谱' },
      )
      const status = data?.task_status ?? data?.status
      return {
        state: normalizeVideoStatus({ status }),
        url: pickVideoUrl(data),
        progress: 0,
        message: typeof data?.message === 'string' ? data.message : undefined,
      }
    },
  },
  dashscope: {
    label: '百炼',
    async submit(_ctx, config, key, job, signal) {
      const model = job.model || providerModel(config, 'dashscope', job)
      const duration = /2\.5/.test(model) ? (Number(job.seconds) >= 10 ? 10 : 5) : 5
      const body = {
        model,
        input: { prompt: job.prompt },
        parameters: { resolution: '720P', duration, prompt_extend: true },
      }
      if (job.image) body.input.img_url = job.image
      const data = await requestJSON(
        `${providerBaseURL(config, 'dashscope')}/services/aigc/video-generation/video-synthesis`,
        { method: 'POST', key, body, signal, headers: { 'X-DashScope-Async': 'enable' }, label: '百炼' },
      )
      const taskId = data?.output?.task_id ?? pickTaskId(data)
      if (!taskId) throw new Error(`百炼没有返回 task_id：${JSON.stringify(data).slice(0, 200)}`)
      return { taskId }
    },
    async poll(config, key, taskId, signal) {
      const data = await requestJSON(
        `${providerBaseURL(config, 'dashscope')}/tasks/${encodeURIComponent(taskId)}`,
        { key, signal, timeoutMs: 60000, label: '百炼' },
      )
      const out = data?.output ?? {}
      return {
        state: normalizeVideoStatus({ status: out.task_status }),
        url: out.video_url ?? pickVideoUrl(data),
        progress: 0,
        message: typeof out.message === 'string' ? out.message : undefined,
      }
    },
  },
  ark: {
    label: '方舟',
    async submit(_ctx, config, key, job, signal) {
      const model = job.model || providerModel(config, 'ark', job)
      const text = `${job.prompt} --resolution 720p --duration ${job.seconds} --ratio ${job.ratio} --watermark false`
      const content = [{ type: 'text', text }]
      if (job.image) content.push({ type: 'image_url', image_url: { url: job.image } })
      const data = await requestJSON(
        `${providerBaseURL(config, 'ark')}/contents/generations/tasks`,
        { method: 'POST', key, body: { model, content }, signal, label: '方舟' },
      )
      const taskId = pickTaskId(data) || String(data?.data?.id ?? '')
      if (!taskId) throw new Error(`方舟没有返回任务 id：${JSON.stringify(data).slice(0, 200)}`)
      return { taskId }
    },
    async poll(config, key, taskId, signal) {
      const data = await requestJSON(
        `${providerBaseURL(config, 'ark')}/contents/generations/tasks/${encodeURIComponent(taskId)}`,
        { key, signal, timeoutMs: 60000, label: '方舟' },
      )
      return {
        state: normalizeVideoStatus({ status: data?.status }),
        url: data?.content?.video_url ?? pickVideoUrl(data),
        progress: 0,
        message: typeof data?.error?.message === 'string' ? data.error.message : undefined,
      }
    },
  },
  siliconflow: {
    label: '硅基流动',
    async submit(_ctx, config, key, job, signal) {
      const model = job.model || providerModel(config, 'siliconflow', job)
      const body = { model, prompt: job.prompt, image_size: ratioToPixels(job.ratio) }
      if (job.image) body.image = job.image
      const data = await requestJSON(`${providerBaseURL(config, 'siliconflow')}/video/submit`, {
        method: 'POST',
        key,
        body,
        signal,
        label: '硅基流动',
      })
      const taskId = data?.requestId ?? data?.request_id ?? pickTaskId(data)
      if (!taskId) throw new Error(`硅基流动没有返回 requestId：${JSON.stringify(data).slice(0, 200)}`)
      return { taskId }
    },
    async poll(config, key, taskId, signal) {
      const data = await requestJSON(`${providerBaseURL(config, 'siliconflow')}/video/status`, {
        method: 'POST',
        key,
        body: { requestId: taskId },
        signal,
        timeoutMs: 60000,
        label: '硅基流动',
      })
      return {
        state: normalizeVideoStatus({ status: data?.status }),
        url: pickVideoUrl(data),
        progress: videoProgress(data),
        message: typeof data?.reason === 'string' ? data.reason : undefined,
      }
    },
  },
  custom: {
    label: '自定义',
    async submit(_ctx, config, key, job, signal) {
      const base = providerBaseURL(config, 'custom')
      if (!base) throw new Error('自定义通道没配 fallbackBaseURL')
      const endpoint = config.fallbackVideoEndpoint || `${base}/videos/generations`
      const body = {
        model: job.model || config.fallbackVideoModel,
        prompt: job.prompt,
        seconds: Number(job.seconds) || 5,
        aspect_ratio: job.ratio,
      }
      if (job.image) body.image = job.image
      const data = await requestJSON(endpoint, { method: 'POST', key, body, signal, label: '自定义通道' })
      const url = pickVideoUrl(data)
      const taskId = pickTaskId(data)
      // 同步返回成品的接口：直接给 url，不用再轮询。
      if (url && (!config.fallbackVideoStatusEndpoint || !taskId)) return { url }
      if (!taskId) throw new Error(`自定义通道没有返回任务 id：${JSON.stringify(data).slice(0, 200)}`)
      return { taskId }
    },
    async poll(config, key, taskId, signal) {
      const base = providerBaseURL(config, 'custom')
      const tpl = config.fallbackVideoStatusEndpoint
      if (!tpl) return { state: 'pending', url: '', progress: 0, message: '自定义通道没有配置状态查询端点' }
      let data
      if (tpl.includes('{id}')) {
        data = await requestJSON(tpl.replaceAll('{id}', encodeURIComponent(taskId)), {
          key,
          signal,
          timeoutMs: 60000,
          label: '自定义通道',
        })
      } else {
        data = await requestJSON(tpl, {
          method: 'POST',
          key,
          body: { requestId: taskId },
          signal,
          timeoutMs: 60000,
          label: '自定义通道',
        })
      }
      return {
        state: normalizeVideoStatus(data),
        url: pickVideoUrl(data),
        progress: videoProgress(data),
        message: typeof data?.message === 'string' ? data.message : undefined,
      }
    },
  },
}

/* --------------------------------- 通用执行器 --------------------------------- */

async function downloadVideo(config, url, savePath, signal) {
  const bytes = await fetchBytes(url, signal)
  const ext = /\.(mp4|mov|webm)(?:\?|$)/i.exec(url)?.[1]?.toLowerCase() ?? 'mp4'
  const target = resolveTarget(config, savePath, `video-${stamp()}-${rand()}.${ext}`, 'videos')
  await saveBytes(target, bytes)
  return { path: target, bytes: bytes.length }
}

/**
 * 跑一家 provider：提交（队列满自动重试）→ 轮询 → 到 deadline 为止。
 * 返回 {status: done|failed|queue_stalled|quota_exhausted, ...}。
 */
async function runProviderJob(ctx, config, id, key, job, { deadline, savePath, signal, taskId: preset = '' }) {
  const adapter = VIDEO_ADAPTERS[id]
  const startedAt = Date.now()
  let taskId = preset
  let lastProgress = 0
  let lastMessage = ''
  let notFound = 0
  let attempt = 0

  while (Date.now() < deadline) {
    if (!taskId) {
      attempt += 1
      try {
        const submitted = await adapter.submit(ctx, config, key, job, signal)
        if (submitted.url && !submitted.taskId) {
          return { status: 'done', url: submitted.url, video_id: '', model: job.model, elapsedMs: Date.now() - startedAt }
        }
        taskId = submitted.taskId
        if (!taskId) throw new Error(`${providerLabel(id)} 没有返回任务 id`)
      } catch (err) {
        if (isQuotaError(err)) return { status: 'quota_exhausted', message: shortError(err), elapsedMs: Date.now() - startedAt }
        const retryable = isVideoQueueBusy(err) || err?.code === 'QUEUE_TIMEOUT' || isTransientNetwork(err)
        if (retryable) {
          lastMessage = shortError(err)
          const wait = Math.min(30000, 6000 + (attempt - 1) * 4000)
          if (Date.now() + wait >= deadline) break
          await sleep(wait, signal)
          continue
        }
        const imageRejected = Boolean(job.image) && /HTTP 4\d\d/.test(String(err?.message ?? ''))
        const message = imageRejected
          ? `${shortError(err)}（提示：图生视频的图片需要接口能取到；本地图会以 data URI 提交，若接口不接受，请换成公网可访问的图片 URL，或只用 text / reference 模式。）`
          : shortError(err)
        return { status: 'failed', message, elapsedMs: Date.now() - startedAt }
      }
      continue
    }

    try {
      const polled = await adapter.poll(config, key, taskId, signal)
      notFound = 0
      if (polled.message) lastMessage = polled.message
      if (polled.state === 'completed') {
        return {
          status: 'done',
          url: polled.url,
          video_id: `${id}:${taskId}`,
          progress: 100,
          elapsedMs: Date.now() - startedAt,
        }
      }
      if (polled.state === 'failed') {
        return {
          status: 'failed',
          message: polled.message || `${providerLabel(id)} 返回失败`,
          video_id: `${id}:${taskId}`,
          elapsedMs: Date.now() - startedAt,
        }
      }
      lastProgress = polled.progress ?? lastProgress
    } catch (err) {
      const text = String(err?.message ?? '')
      if (/HTTP 404|task not found|not found/i.test(text)) {
        if (++notFound >= 8) {
          return {
            status: 'failed',
            message: '查不到这个 video_id（任务 id）：可能 id 写错、任务已过期，或它来自别的通道（付费任务不能在免费查询接口里查）。',
            video_id: `${id}:${taskId}`,
            elapsedMs: Date.now() - startedAt,
          }
        }
      } else if (isQuotaError(err)) {
        return {
          status: 'quota_exhausted',
          message: shortError(err),
          video_id: `${id}:${taskId}`,
          elapsedMs: Date.now() - startedAt,
        }
      } else if (!(isVideoQueueBusy(err) || err?.code === 'QUEUE_TIMEOUT' || isTransientNetwork(err))) {
        return {
          status: 'failed',
          message: shortError(err),
          video_id: `${id}:${taskId}`,
          elapsedMs: Date.now() - startedAt,
        }
      }
    }

    const wait = Math.max(2000, Number(config.videoPollIntervalMs) || 8000)
    if (Date.now() + wait >= deadline) break
    await sleep(wait, signal)
  }

  return {
    status: 'queue_stalled',
    phase: taskId ? 'poll' : 'submit',
    video_id: taskId ? `${id}:${taskId}` : '',
    progress: lastProgress,
    message: lastMessage,
    elapsedMs: Date.now() - startedAt,
  }
}

/**
 * 免费链：按 freeChain 顺序串行试，总预算 videoQueueTimeoutMs 在「可用候选」间公平切分。
 * 额度用尽的 provider 标记后跳过，并自动出现在付费报价里。
 */
async function runFreeChain(ctx, config, job, { started, savePath, signal }) {
  const budget = Math.max(5000, Number(config.videoQueueTimeoutMs) || 600000)
  const deadline = started + budget
  const chain = String(config.freeChain ?? '')
    .split(',')
    .map((one) => one.trim())
    .filter((id) => VIDEO_PROVIDERS[id] && VIDEO_PROVIDERS[id].free)
  const chainIds = chain.length ? chain : FREE_CHAIN_DEFAULT.split(',')
  const tried = []
  const available = []

  for (const id of chainIds) {
    const p = VIDEO_PROVIDERS[id]
    const key = await resolveProviderKey(ctx, config, id)
    if (!key) {
      tried.push({ provider: id, reason: `未配置 key（${p.defaultRef || p.refField}）` })
      continue
    }
    if (providerState.get(id)?.quotaExhausted) {
      tried.push({ provider: id, reason: '本次会话免费额度已用尽' })
      continue
    }
    available.push({ id, key })
  }

  let stall = null
  for (let i = 0; i < available.length; i++) {
    const { id, key } = available[i]
    const now = Date.now()
    const left = available.length - i
    const slice = Math.min(deadline, now + Math.max(20000, (deadline - now) / left))
    if (slice <= now) break
    const result = await runProviderJob(ctx, config, id, key, job, { deadline: slice, savePath, signal })
    if (result.status === 'done') return { ...result, provider: id, tried }
    if (result.status === 'quota_exhausted') {
      providerState.set(id, { quotaExhausted: true })
      tried.push({ provider: id, reason: `免费额度用尽：${result.message}`, elapsedMs: result.elapsedMs })
      continue
    }
    if (result.status === 'failed') {
      tried.push({ provider: id, reason: result.message, video_id: result.video_id, elapsedMs: result.elapsedMs })
      // 4xx 是「这次请求本身有问题」（如图片不是公网 URL），换通道也没用，直接失败。
      if (/HTTP 4\d\d/.test(result.message ?? '') && !/HTTP 404/.test(result.message ?? '')) {
        return { status: 'failed', message: result.message, elapsedMs: Date.now() - started, tried }
      }
      continue
    }
    tried.push({
      provider: id,
      reason: result.message || result.status,
      video_id: result.video_id,
      elapsedMs: result.elapsedMs,
    })
    // 保留「真的提交成功、只是没等到」的那一单，方便 video_status 续查。
    if (result.video_id) stall = result
  }

  // tried 按 freeChain 顺序排列，方便用户按「先试了哪家」理解。
  tried.sort((a, b) => chainIds.indexOf(a.provider) - chainIds.indexOf(b.provider))

  return {
    status: 'queue_stalled',
    phase: stall?.phase ?? 'all',
    video_id: stall?.video_id ?? '',
    progress: stall?.progress ?? 0,
    elapsedMs: Date.now() - started,
    tried,
    message: tried.length
      ? `免费通道都试过了：${tried.map((one) => `${providerLabel(one.provider)}（${one.reason}）`).join('；')}`
      : '没有可用的免费通道：freeChain 里的 provider 都没配 key。',
  }
}

/** 指定付费通道跑一单。 */
async function runPaidChannel(ctx, config, job, providerId, { started, savePath, signal }) {
  const id = providerId || (config.fallbackVideoModel ? 'custom' : '')
  if (!id) {
    throw new Error(
      '请指定付费通道 provider（zhipu / dashscope / ark / siliconflow / custom），或先配置 fallbackVideoModel 走自定义通道。',
    )
  }
  const p = VIDEO_PROVIDERS[id]
  if (!p) throw new Error(`未知的视频通道：${id}`)
  if (id === 'custom' && !config.fallbackEnabled) {
    throw new Error('自定义付费通道未启用：请设置 fallbackEnabled=true，并填 fallbackBaseURL / fallbackVideoModel / key。')
  }
  const key = await resolveProviderKey(ctx, config, id)
  if (!key) throw new Error(`${p.label} 没配 key：请填 ${p.keyField}，或在 DSH 凭据里配 ${p.defaultRef || p.refField}。`)
  const model = job.model || providerModel(config, id, job, { paid: true })
  if (!model) throw new Error(`${p.label} 没配模型 id（${p.keyField} 旁边那组配置）。`)
  const deadline = started + Math.max(60000, Number(config.videoQueueTimeoutMs) || 600000)
  const result = await runProviderJob(ctx, config, id, key, { ...job, model }, { deadline, savePath, signal })
  if (result.status === 'failed' || result.status === 'queue_stalled') {
    return { ...result, provider: id, model }
  }
  return { ...result, provider: id, model }
}

/* ---------------------------------- 输出与渲染 ---------------------------------- */

const VIDEO_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['done', 'pending', 'failed', 'queue_stalled'] },
    phase: { type: 'string', enum: ['submit', 'poll', 'all'] },
    provider: { type: 'string' },
    video_id: { type: 'string' },
    path: { type: 'string' },
    url: { type: 'string' },
    model: { type: 'string' },
    seconds: { type: 'string' },
    aspect_ratio: { type: 'string' },
    bytes: { type: 'integer' },
    progress: { type: 'integer' },
    elapsedMs: { type: 'integer' },
    message: { type: 'string' },
    tried: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string' },
          reason: { type: 'string' },
          video_id: { type: 'string' },
          elapsedMs: { type: 'integer' },
        },
      },
    },
    quotes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string' },
          label: { type: 'string' },
          model: { type: 'string' },
          tier: { type: 'string', enum: ['free', 'paid'] },
          estimatedCostRMB: { type: 'number' },
          configured: { type: 'boolean' },
          keyRef: { type: 'string' },
          quality: { type: 'string' },
          pros: { type: 'array', items: { type: 'string' } },
          cons: { type: 'array', items: { type: 'string' } },
          docs: { type: 'string' },
          notes: { type: 'string' },
          status: { type: 'string' },
        },
      },
    },
    fallback: {
      type: 'object',
      additionalProperties: false,
      properties: {
        provider: { type: 'string' },
        estimatedCostRMB: { type: 'number' },
        enabled: { type: 'boolean' },
        configured: { type: 'boolean' },
      },
    },
  },
  required: ['status'],
}

function cleanReason(text) {
  return String(text ?? '')
    .replace(/\s*\(request id:[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function quoteLine(one, tried) {
  const money = one.estimatedCostRMB === 0 ? '免费额度内' : `约 ¥${one.estimatedCostRMB}`
  const flags = []
  const reason = cleanReason(tried?.get(one.provider))
  if (reason) flags.push(`本次：${reason.slice(0, 42)}`)
  if (!one.configured && !(reason && reason.includes(one.keyRef))) flags.push(`未配置 key：${one.keyRef}`)
  if (!reason && one.configured) flags.push(one.estimatedCostRMB === 0 ? '可直接试' : '可按量付费')
  return `- ${one.label} ${one.model || ''}｜${money}${flags.length ? `（${flags.join('；')}）` : ''}｜${one.quality}`
}

function renderVideo(_args, value) {
  const status = value?.status ?? 'unknown'
  if (status === 'done') {
    return blocks(value, `已生成视频（${providerLabel(value.provider)}，${value.seconds ?? '-'}s ${value.aspect_ratio ?? ''}）。`)
  }
  if (status === 'queue_stalled') {
    const lines = [`免费通道试了 ${value.tried?.length ?? 0} 家，共等 ${fmtDuration(value.elapsedMs)}，仍未出片。`]
    if (value.tried?.length) {
      lines.push('', '尝试记录：')
      for (const one of value.tried) {
        const reason = cleanReason(one.reason) || '未说明原因'
        lines.push(`- ${providerLabel(one.provider)}：${reason}${one.video_id ? `（video_id=${one.video_id}，可 video_status 续查）` : ''}`)
      }
    }
    if (value.quotes?.length) {
      const triedMap = new Map((value.tried ?? []).map((one) => [one.provider, one.reason]))
      lines.push('', `可选通道（参考价，更新于 ${PRICE_UPDATED}）：`)
      for (const one of value.quotes) lines.push(quoteLine(one, triedMap))
      lines.push('', '以上为不同平台的报价和优劣，请交给用户对比选择；用户明确选好后，用 channel="paid" + provider 重试，不要自动切付费。')
    }
    return blocks({ ...value, message: lines.join('\n') }, '免费通道排队超时')
  }
  if (status === 'pending') {
    return [
      {
        type: 'text',
        text: typeof value.message === 'string' && value.message.length > 0
          ? value.message
          : `视频任务仍在进行（进度 ${value.progress ?? 0}%）。`,
      },
    ]
  }
  return blocks(value, `视频任务状态：${status}`)
}

/** 只保留 schema 里声明过的字段，避免 undefined 破坏输出校验。 */
function cleanVideoOutput(value) {
  const out = {}
  for (const key of Object.keys(VIDEO_OUTPUT.properties)) {
    const one = value?.[key]
    if (one !== undefined && one !== null && one !== '') out[key] = one
  }
  return out
}

/* ----------------------------------- 工具 ----------------------------------- */

function videoTool(ctx, config) {
  return {
    name: 'generate_video',
    description:
      '为 product-shot 生成商品短视频。默认走免费链（Agnes → 智谱 CogVideoX-Flash → 百炼万相 → 方舟 Seedance，按配置顺序，总预算 videoQueueTimeoutMs 默认 10 分钟），可文生视频，也可传首帧图做图生视频。排队超时返回 queue_stalled，并附多平台报价对比（含价格/优劣/是否配 key）；此时必须停下让用户选，再用 channel="paid" + provider 重试，不要自动扣费。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '视频描述：主体动作 + 环境 + 运镜 + 光照 + 风格，尽量具体。' },
        image: { type: 'string', description: '首帧图：本地路径 / 公网 URL / data URI（图生视频，例如把 hero 成品图动起来）。' },
        references: {
          type: 'array',
          items: { type: 'string' },
          description: '参考图（最多 5 张；仅部分通道支持，和 image 二选一）。',
        },
        seconds: { type: 'string', description: '时长（秒），默认 5。', enum: VIDEO_SECONDS },
        aspect_ratio: { type: 'string', description: '画幅，默认 16:9。', enum: VIDEO_RATIOS },
        channel: {
          type: 'string',
          description: 'auto=免费链（默认，按 freeChain 顺序试）；free=只用指定免费通道；paid=指定付费通道（需用户确认）。',
          enum: ['auto', 'free', 'paid'],
        },
        provider: {
          type: 'string',
          description: '通道 id：channel=free/paid 时指定。agnes / zhipu / dashscope / ark / siliconflow / custom。',
          enum: ['agnes', 'zhipu', 'dashscope', 'ark', 'siliconflow', 'custom'],
        },
        save_path: { type: 'string', description: '视频保存路径（默认 outputDir/videos/）。' },
      },
      required: ['prompt'],
    },
    output: { schema: VIDEO_OUTPUT, render: renderVideo },
    timeoutMs: 900000,
    async execute(args, exec) {
      const started = Date.now()
      const signal = exec?.signal
      const cwd = exec?.cwd
      const prompt = String(args.prompt ?? '').trim()
      if (!prompt) throw new Error('prompt 不能为空')

      const job = {
        prompt,
        image: args.image ? await toVideoFrame(args.image, cwd) : '',
        references: [],
        seconds: normalizeVideoSeconds(args.seconds),
        ratio: VIDEO_RATIOS.includes(args.aspect_ratio) ? args.aspect_ratio : '16:9',
      }
      if (Array.isArray(args.references) && args.references.length) {
        job.references = (await Promise.all(args.references.slice(0, 5).map((one) => toVideoFrame(one, cwd)))).filter(Boolean)
      }

      const channel = args.channel ?? 'auto'

      if (channel === 'paid') {
        const result = await runPaidChannel(ctx, config, job, args.provider, { started, savePath: args.save_path, signal })
        if (result.status === 'done') {
          const saved = result.url ? await downloadVideo(config, result.url, args.save_path, signal) : {}
          return cleanVideoOutput({
            status: 'done',
            provider: result.provider,
            model: result.model,
            video_id: result.video_id,
            url: result.url,
            path: saved.path,
            bytes: saved.bytes,
            seconds: job.seconds,
            aspect_ratio: job.ratio,
            progress: 100,
            elapsedMs: Date.now() - started,
          })
        }
        if (result.status === 'queue_stalled') {
          return cleanVideoOutput({
            status: 'queue_stalled',
            phase: result.phase,
            provider: result.provider,
            video_id: result.video_id,
            progress: result.progress,
            elapsedMs: result.elapsedMs,
            message: `付费通道「${providerLabel(result.provider)}」等了 ${fmtDuration(result.elapsedMs)} 仍未出片。${result.message ?? ''}`,
            quotes: await videoQuotes(ctx, config, job),
          })
        }
        return cleanVideoOutput({
          status: 'failed',
          provider: result.provider,
          video_id: result.video_id,
          elapsedMs: result.elapsedMs,
          message: result.message,
        })
      }

      // 免费：auto 走整条链；free 只跑指定一家。
      let result
      if (channel === 'free' && args.provider) {
        const id = args.provider
        const p = VIDEO_PROVIDERS[id]
        if (!p?.free) throw new Error(`${id} 不是免费通道`)
        const key = await resolveProviderKey(ctx, config, id)
        if (!key) throw new Error(`${p.label} 没配 key：请填 ${p.keyField}，或在 DSH 凭据里配 ${p.defaultRef}。`)
        const deadline = started + Math.max(60000, Number(config.videoQueueTimeoutMs) || 600000)
        const one = await runProviderJob(ctx, config, id, key, job, { deadline, savePath: args.save_path, signal })
        result = one.status === 'done' ? { ...one, provider: id } : { ...one, tried: [{ provider: id, reason: one.message, video_id: one.video_id, elapsedMs: one.elapsedMs }] }
      } else {
        result = await runFreeChain(ctx, config, job, { started, savePath: args.save_path, signal })
      }

      if (result.status === 'failed') throw new Error(result.message || '视频生成失败')

      if (result.status === 'done') {
        const saved = result.url ? await downloadVideo(config, result.url, args.save_path, signal) : {}
        return cleanVideoOutput({
          status: 'done',
          provider: result.provider,
          model: result.model || providerModel(config, result.provider, job),
          video_id: result.video_id,
          url: result.url,
          path: saved.path,
          bytes: saved.bytes,
          seconds: job.seconds,
          aspect_ratio: job.ratio,
          progress: 100,
          elapsedMs: Date.now() - started,
        })
      }

      if (result.video_id) {
        videoTasks.set(result.video_id, {
          provider: result.video_id.split(':')[0],
          started,
          seconds: job.seconds,
          ratio: job.ratio,
        })
      }
      return cleanVideoOutput({
        status: 'queue_stalled',
        phase: result.phase,
        provider: result.provider ?? (result.video_id ? result.video_id.split(':')[0] : ''),
        video_id: result.video_id,
        progress: result.progress,
        elapsedMs: result.elapsedMs,
        message: result.message,
        tried: result.tried,
        quotes: await videoQuotes(ctx, config, job),
      })
    },
  }
}

function parseVideoId(raw) {
  const text = String(raw ?? '').trim()
  const match = /^([a-z]+):(.+)$/i.exec(text)
  if (match && VIDEO_PROVIDERS[match[1].toLowerCase()]) {
    return { provider: match[1].toLowerCase(), taskId: match[2] }
  }
  return { provider: videoTasks.get(text)?.provider ?? 'agnes', taskId: text }
}

function videoStatusTool(ctx, config) {
  return {
    name: 'video_status',
    description:
      '查询/继续等一个视频任务（generate_video 返回的 video_id 形如 "zhipu:xxx"；不带前缀时免费任务默认按 Agnes 查）。wait_seconds 内出了就下载，没出返回 pending，可稍后再查。',
    parameters: {
      type: 'object',
      properties: {
        video_id: { type: 'string', description: 'generate_video 返回的 video_id（provider:taskId，也接受不带前缀的）。' },
        wait_seconds: { type: 'number', description: '本次最多等多少秒（5–600，默认取插件配置 videoStatusWaitMs）。' },
        save_path: { type: 'string', description: '视频保存路径（默认 outputDir/videos/）。' },
      },
      required: ['video_id'],
    },
    output: { schema: VIDEO_OUTPUT, render: renderVideo },
    timeoutMs: 660000,
    async execute(args, exec) {
      const started = Date.now()
      const signal = exec?.signal
      const { provider, taskId } = parseVideoId(args.video_id)
      const p = VIDEO_PROVIDERS[provider]
      if (!p) throw new Error(`未知的视频通道前缀：${provider}`)
      const key = await resolveProviderKey(ctx, config, provider)
      if (!key) throw new Error(`${p.label} 没配 key：请填 ${p.keyField}。`)
      const waitMs = Math.min(600000, Math.max(5000, Number(args.wait_seconds ?? config.videoStatusWaitMs) * 1000 || 120000))
      const known = videoTasks.get(String(args.video_id ?? '').trim()) ?? videoTasks.get(`${provider}:${taskId}`)
      const job = { prompt: '', image: '', references: [], seconds: known?.seconds ?? '5', ratio: known?.ratio ?? '16:9' }
      const result = await runProviderJob(ctx, config, provider, key, job, {
        deadline: Date.now() + waitMs,
        savePath: args.save_path,
        signal,
        taskId,
      })

      if (result.status === 'done') {
        const saved = result.url ? await downloadVideo(config, result.url, args.save_path, signal) : {}
        return cleanVideoOutput({
          status: 'done',
          provider,
          video_id: `${provider}:${taskId}`,
          url: result.url,
          path: saved.path,
          bytes: saved.bytes,
          seconds: job.seconds,
          aspect_ratio: job.ratio,
          progress: 100,
          elapsedMs: Date.now() - started,
        })
      }
      if (result.status === 'failed') {
        return cleanVideoOutput({
          status: 'failed',
          provider,
          video_id: `${provider}:${taskId}`,
          elapsedMs: Date.now() - started,
          message: result.message,
        })
      }
      return cleanVideoOutput({
        status: 'pending',
        provider,
        video_id: `${provider}:${taskId}`,
        progress: result.progress ?? 0,
        elapsedMs: Date.now() - started,
        message: `视频还在生成（已等 ${fmtDuration(result.elapsedMs ?? waitMs)}，进度 ${result.progress ?? 0}%）；可稍后再用 video_status 查一次。`,
      })
    },
  }
}

function blocks(value, headline) {
  const parts = [headline]
  if (typeof value.path === 'string') parts.push(`文件：${value.path}`)
  if (typeof value.message === 'string') parts.push(value.message)
  return [{ type: 'text', text: parts.join('\n') }]
}

const SCENE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['done', 'queue_stalled'] },
    path: { type: 'string' },
    model: { type: 'string' },
    size: { type: 'string' },
    ratio: { type: 'string' },
    bytes: { type: 'integer' },
    elapsedMs: { type: 'integer' },
    fallback: {
      type: 'object',
      properties: {
        provider: { type: 'string' },
        estimatedCostRMB: { type: 'number' },
      },
    },
  },
  required: ['status'],
}

/** 生成一张"空场景"背景图（无产品，供白底产品图合成用）。免费 Agnes + 付费 fallback 双通道。 */
function sceneTool(ctx, config) {
  return {
    name: 'generate_scene',
    description:
      '为 product-shot 生成一张"空场景"背景图（不含产品，用于把白底产品图合成进去）。默认走免费 Agnes；若排队超时会返回 queue_stalled，可改 channel=paid 走付费通道。画面描述建议：材质 + 光照 + 构图 + 风格 + 质量要求。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '空场景描述：材质/光照/构图/风格，不要出现任何产品。' },
        ratio: { type: 'string', description: `画幅，默认 1:1。可选：${RATIOS.join(' / ')}`, enum: RATIOS },
        size: { type: 'string', description: `分辨率档位，默认 2K。可选：${TIERS.join(' / ')}`, enum: TIERS },
        channel: { type: 'string', description: '通道：agnes（免费，默认）/ paid（付费 fallback，需先配置 fallback*）。', enum: ['agnes', 'paid'] },
        save_path: { type: 'string', description: '可选输出路径（默认写入 outputDir/scenes/）。' },
      },
      required: ['prompt'],
    },
    output: {
      schema: SCENE_OUTPUT,
      render: (_args, value) => {
        if (value?.status === 'queue_stalled') {
          const m = Math.round((value.elapsedMs ?? 0) / 60000)
          const f = value.fallback ?? {}
          return [{ type: 'text', text: `Agnes 排队已超 ${m} 分钟仍未完成。付费通道「${f.provider ?? 'fallback'}」预计约 ¥${f.estimatedCostRMB ?? '-'} / 张。` }]
        }
        return blocks(value, `已生成场景背景（${value.model}，${value.size ?? '-'} ${value.ratio ?? '-'}）。`)
      },
    },
    timeoutMs: 480000,
    async execute(args, exec) {
      const size = TIERS.includes(args.size) ? args.size : '2K'
      const ratio = RATIOS.includes(args.ratio) ? args.ratio : '1:1'
      const channel = args.channel === 'paid' ? 'paid' : 'agnes'

      if (channel === 'paid') {
        if (!config.fallbackEnabled || !config.fallbackBaseURL || !config.fallbackImageModel) {
          throw new Error('付费通道未配置：请在 product-shot 插件配置里启用 fallbackEnabled，并填 fallbackBaseURL / fallbackImageModel / fallbackApiKey（或 fallbackApiKeyRef）。')
        }
        const key = await resolveFallbackKey(ctx, config)
        const body = {
          model: config.fallbackImageModel,
          prompt: args.prompt,
          size: pixelSize(size, ratio),
          n: 1,
          response_format: 'b64_json',
        }
        const data = await requestJSON(`${config.fallbackBaseURL}/images/generations`, {
          method: 'POST',
          key,
          body,
          signal: exec?.signal,
        })
        const item = Array.isArray(data?.data) ? data.data[0] : undefined
        const bytes = await imageBytes(item, exec?.signal)
        const target = resolveTarget(config, args.save_path, `scene-${stamp()}-${rand()}.png`)
        await saveBytes(target, bytes)
        return { status: 'done', path: target, model: config.fallbackImageModel, size, ratio, bytes: bytes.length }
      }

      const key = await resolveKey(ctx, config)
      const body = { model: config.imageModel, prompt: args.prompt, size, ratio, return_base64: true }
      const started = Date.now()
      try {
        const data = await requestJSON(`${config.baseURL}/images/generations`, {
          method: 'POST',
          key,
          body,
          signal: exec?.signal,
          timeoutMs: config.queueTimeoutMs,
        })
        const item = Array.isArray(data?.data) ? data.data[0] : undefined
        const bytes = await imageBytes(item, exec?.signal)
        const target = resolveTarget(config, args.save_path, `scene-${stamp()}-${rand()}.png`)
        await saveBytes(target, bytes)
        return { status: 'done', path: target, model: config.imageModel, size, ratio, bytes: bytes.length }
      } catch (err) {
        if (err?.code === 'QUEUE_TIMEOUT') {
          const elapsedMs = Date.now() - started
          if (config.fallbackEnabled) {
            return {
              status: 'queue_stalled',
              elapsedMs,
              fallback: { provider: config.fallbackName, estimatedCostRMB: config.fallbackPricePerImageRMB },
            }
          }
          throw new Error(`Agnes 排队超过 ${Math.round(config.queueTimeoutMs / 60000)} 分钟仍未完成。可在插件配置里启用付费通道（fallbackEnabled）加速，或稍后重试。`)
        }
        throw err
      }
    },
  }
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  ctx.tools.register(sceneTool(ctx, config))
  ctx.tools.register(videoTool(ctx, config))
  ctx.tools.register(videoStatusTool(ctx, config))

  const content = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8')
  ctx.skills.register({
    name: 'product-shot',
    description: '白底产品图 → 多场景多角度商品图：抠图、场景生成、合成、排版、质检的全流程（自包含，文字像素级清晰）。',
    content,
    source: 'product-shot bundle',
    resourceBase: { kind: 'directory', path: ROOT },
  })
}
