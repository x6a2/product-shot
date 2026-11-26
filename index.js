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

async function requestJSON(url, { method = 'GET', key, body, signal, timeoutMs = 300000 } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  const forward = () => ac.abort()
  signal?.addEventListener?.('abort', forward, { once: true })
  try {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
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
    if (!res.ok) throw new Error(`Agnes API HTTP ${res.status}：${JSON.stringify(data).slice(0, 400)}`)
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
  const list = [data?.id, data?.task_id, data?.taskId, data?.request_id, data?.requestId, data?.data?.id, data?.data?.task_id]
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

/** 已提交、还没拿到的免费任务，用于 video_status 续查时估算已排队时长。 */
const videoTasks = new Map()

async function queryAgnesVideo(config, key, videoId, signal) {
  const url = new URL(`${originOf(config.baseURL)}/agnesapi`)
  url.searchParams.set('video_id', videoId)
  url.searchParams.set('model_name', config.videoModel)
  return requestJSON(url.toString(), { key, signal, timeoutMs: 60000 })
}

/** 免费通道：提交（队列满就退避重试，直到预算耗尽）→ 轮询 → 下载 mp4。 */
async function runAgnesVideo(config, key, body, { started, savePath, signal }) {
  const budget = Math.max(1000, config.videoQueueTimeoutMs)
  const stallAt = started + budget
  let videoId = ''
  let lastError
  let attempt = 0

  while (videoId.length === 0) {
    attempt += 1
    const left = stallAt - Date.now()
    if (left <= 0) break
    try {
      const created = await requestJSON(`${config.baseURL}/videos`, {
        method: 'POST',
        key,
        body,
        signal,
        timeoutMs: Math.min(120000, Math.max(5000, left)),
      })
      const id = created?.video_id ?? created?.id
      if (typeof id !== 'string' && typeof id !== 'number') {
        throw new Error(`Agnes 未返回 video_id：${JSON.stringify(created).slice(0, 300)}`)
      }
      videoId = String(id)
    } catch (err) {
      if (signal?.aborted) throw err
      lastError = err
      const retryable = isVideoQueueBusy(err) || err?.code === 'QUEUE_TIMEOUT' || isTransientNetwork(err)
      if (!retryable) {
        const hasImage = Boolean(body.first_frame) || (Array.isArray(body.images) && body.images.length > 0)
        if (hasImage && /HTTP 4\d\d/.test(String(err?.message ?? ''))) {
          throw new Error(`${shortError(err)}（提示：图生视频的图片需要接口能取到；本地图会以 data URI 提交，若接口不接受，请换成公网可访问的图片 URL，或只用 text / reference 模式。）`)
        }
        throw err
      }
      const wait = Math.min(30000, 6000 + (attempt - 1) * 4000)
      if (Date.now() + wait >= stallAt) break
      await sleep(wait, signal)
    }
  }

  if (videoId.length === 0) {
    return {
      status: 'queue_stalled',
      phase: 'submit',
      elapsedMs: Date.now() - started,
      message: `免费视频通道排队超过 ${fmtDuration(budget)}仍未提交成功${lastError ? `（最近一次：${shortError(lastError)}）` : ''}。`,
      fallback: videoFallback(config),
    }
  }

  videoTasks.set(videoId, { started, model: body.model })
  return pollAgnesVideo(config, key, videoId, {
    started,
    stallAt,
    stopAt: Number.POSITIVE_INFINITY,
    savePath,
    signal,
    seconds: body.seconds,
    ratio: body.aspect_ratio,
  })
}

/**
 * 轮询免费任务。
 * - stallAt：到达即返回 queue_stalled（generate_video 用，代表"排队超预算"）
 * - stopAt：到达即返回 pending（video_status 用，代表"这次等够了，先返回"）
 */
async function pollAgnesVideo(config, key, videoId, { started, stallAt, stopAt, savePath, signal, seconds, ratio }) {
  const interval = Math.max(2000, Number(config.videoPollIntervalMs) || 8000)
  let last = {}
  let notFound = 0

  for (;;) {
    try {
      last = await queryAgnesVideo(config, key, videoId, signal)
      notFound = 0
    } catch (err) {
      if (signal?.aborted) throw err
      const message = String(err?.message ?? '')
      const missing = message.includes('404') || message.includes('task not found') || message.includes('任务不存在')
      const transient = isVideoQueueBusy(err) || err?.code === 'QUEUE_TIMEOUT' || isTransientNetwork(err)
      if (!transient && !missing) throw err
      if (missing) {
        // Agnes 提交后约 20 秒才可查；连续多次 404 才判定任务真的不存在。
        notFound += 1
        if (notFound >= 8) {
          videoTasks.delete(videoId)
          return {
            status: 'failed',
            video_id: videoId,
            elapsedMs: Date.now() - started,
            message: '查不到这个 video_id：可能 id 写错、任务已过期，或它来自别的通道（付费异步任务不在免费查询接口里）。',
          }
        }
      }
    }

    const status = normalizeVideoStatus(last)
    if (status === 'completed') {
      const url = pickVideoUrl(last)
      if (url.length === 0) {
        videoTasks.delete(videoId)
        return {
          status: 'failed',
          video_id: videoId,
          elapsedMs: Date.now() - started,
          message: '任务已完成，但响应里没有视频地址。',
        }
      }
      const bytes = await fetchBytes(url, signal)
      if (bytes.length === 0) {
        videoTasks.delete(videoId)
        return { status: 'failed', video_id: videoId, elapsedMs: Date.now() - started, message: '下载到的视频是空文件。' }
      }
      const target = resolveTarget(config, savePath, `video-${stamp()}-${rand()}.mp4`, 'videos')
      await saveBytes(target, bytes)
      videoTasks.delete(videoId)
      return {
        status: 'done',
        video_id: videoId,
        path: target,
        url,
        model: config.videoModel,
        seconds: typeof last?.seconds === 'string' ? last.seconds : seconds,
        aspect_ratio: typeof last?.aspect_ratio === 'string' ? last.aspect_ratio : ratio,
        bytes: bytes.length,
        elapsedMs: Date.now() - started,
      }
    }

    if (status === 'failed') {
      videoTasks.delete(videoId)
      return {
        status: 'failed',
        video_id: videoId,
        elapsedMs: Date.now() - started,
        message: `视频任务失败：${JSON.stringify(last?.error ?? last?.message ?? last).slice(0, 300)}`,
      }
    }

    const now = Date.now()
    if (now >= stallAt) {
      return {
        status: 'queue_stalled',
        phase: 'poll',
        video_id: videoId,
        progress: videoProgress(last),
        elapsedMs: now - started,
        message: `免费视频通道排队/生成超过 ${fmtDuration(Math.max(1000, config.videoQueueTimeoutMs))}仍未完成（当前进度 ${videoProgress(last)}%）。任务仍保留，可用 video_status 继续等免费通道。`,
        fallback: videoFallback(config),
      }
    }
    if (now >= stopAt) {
      return {
        status: 'pending',
        video_id: videoId,
        progress: videoProgress(last),
        elapsedMs: now - started,
        message: '任务仍在进行，稍后用 video_status 带同一个 video_id 继续查询。',
      }
    }

    const next = Math.min(interval, Math.max(1000, Math.min(stallAt, stopAt) - now))
    await sleep(next, signal)
  }
}

/** 付费通道：一次提交；如果只返回任务 id，就按配置的状态端点轮询到出片。 */
async function pollPaidVideo(config, key, taskId, { started, signal }) {
  const template = String(config.fallbackVideoStatusEndpoint ?? '').trim()
  const budget = Math.max(60000, config.videoQueueTimeoutMs)
  for (;;) {
    let data
    if (template.includes('{id}')) {
      data = await requestJSON(template.replace('{id}', encodeURIComponent(taskId)), { key, signal, timeoutMs: 60000 })
    } else {
      data = await requestJSON(template, { method: 'POST', key, body: { requestId: taskId }, signal, timeoutMs: 60000 })
    }
    const url = pickVideoUrl(data)
    if (url.length > 0) return url
    if (normalizeVideoStatus(data) === 'failed') {
      throw new Error(`付费视频任务失败：${JSON.stringify(data?.error ?? data).slice(0, 300)}`)
    }
    if (Date.now() - started >= budget) {
      throw new Error(`付费视频通道生成超过 ${Math.round(budget / 60000)} 分钟仍未出片。`)
    }
    await sleep(5000, signal)
  }
}

const VIDEO_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['done', 'pending', 'failed', 'queue_stalled'] },
    phase: { type: 'string', enum: ['submit', 'poll'] },
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

function renderVideo(_args, value) {
  const status = value?.status ?? 'unknown'
  if (status === 'done') {
    return blocks(value, `已生成视频（${value.model ?? 'video'}，${value.seconds ?? '-'}s ${value.aspect_ratio ?? ''}）。`)
  }
  if (status === 'queue_stalled') {
    const waited = fmtDuration(value.elapsedMs)
    const fallback = value.fallback ?? {}
    const cost = fallback.configured
      ? `付费通道「${fallback.provider}」预计约 ¥${fallback.estimatedCostRMB} / 条，用户同意后可改 channel="paid" 重试。`
      : fallback.enabled
        ? '付费通道已启用但没配齐（缺 fallbackVideoModel / fallbackBaseURL / key），要先补配置。'
        : '付费通道未启用（fallbackEnabled=false），只能继续等免费通道或放弃。'
    const tail = value.video_id ? `\n任务 id：${value.video_id}（可用 video_status 继续等免费通道）。` : ''
    const phase = value.phase === 'submit' ? '提交' : '生成'
    return [{ type: 'text', text: `免费视频通道已排队 ${waited}（阶段：${phase}）。${cost}${tail}` }]
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

function videoTool(ctx, config) {
  return {
    name: 'generate_video',
    description:
      '为 product-shot 生成商品短视频，默认走免费 Agnes 视频（720P）：可文生视频，也可传一张首帧图做图生视频（例如把 hero 成品图动起来）。免费通道排队超过 videoQueueTimeoutMs（默认 10 分钟）会返回 queue_stalled 并附付费通道报价，此时应停下问用户是否改用 channel="paid"。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '视频描述：主体动作 + 环境 + 运镜 + 光照 + 风格。丝印/包装文字不要指望模型重画正确。',
        },
        image: { type: 'string', description: '可选首帧图（本地路径或公网 URL），传了就是图生视频。' },
        references: {
          type: 'array',
          items: { type: 'string' },
          description: '可选参考图（本地路径/URL），不传 image 时按 reference 模式提交，最多 5 张。',
        },
        seconds: {
          type: 'string',
          description: `时长秒数，默认 5。可选：${VIDEO_SECONDS.join(' / ')}`,
          enum: VIDEO_SECONDS,
        },
        aspect_ratio: {
          type: 'string',
          description: `画幅，默认 16:9。可选：${VIDEO_RATIOS.join(' / ')}`,
          enum: VIDEO_RATIOS,
        },
        channel: {
          type: 'string',
          description: '通道：agnes（免费，默认）/ paid（付费 fallback，需要先配置 fallbackVideoModel 等）。',
          enum: ['agnes', 'paid'],
        },
        save_path: { type: 'string', description: '可选 mp4 输出路径（默认 outputDir/videos/）。' },
      },
      required: ['prompt'],
    },
    output: { schema: VIDEO_OUTPUT, render: renderVideo },
    timeoutMs: 900000,
    async execute(args, exec) {
      const prompt = String(args.prompt ?? '').trim()
      if (prompt.length === 0) throw new Error('prompt 不能为空')
      const seconds = normalizeVideoSeconds(args.seconds)
      const ratio = VIDEO_RATIOS.includes(args.aspect_ratio) ? args.aspect_ratio : '16:9'
      const channel = args.channel === 'paid' ? 'paid' : 'agnes'

      if (channel === 'paid') {
        if (!config.fallbackEnabled || !config.fallbackBaseURL || !config.fallbackVideoModel) {
          throw new Error(
            '付费视频通道未配置：请在 product-shot 插件配置里启用 fallbackEnabled，并填 fallbackBaseURL / fallbackVideoModel / fallbackApiKey（或 fallbackApiKeyRef）；异步出片再填 fallbackVideoStatusEndpoint。',
          )
        }
        const key = await resolveFallbackKey(ctx, config)
        const endpoint =
          config.fallbackVideoEndpoint || `${String(config.fallbackBaseURL).replace(/\/+$/, '')}/videos/generations`
        const body = {
          model: config.fallbackVideoModel,
          prompt,
          seconds: Number(seconds),
          aspect_ratio: ratio,
        }
        if (typeof args.image === 'string' && args.image.trim().length > 0) {
          body.image = await toVideoFrame(args.image)
        }
        const started = Date.now()
        const data = await requestJSON(endpoint, { method: 'POST', key, body, signal: exec?.signal, timeoutMs: 300000 })
        let url = pickVideoUrl(data)
        const taskId = pickTaskId(data)
        if (url.length === 0 && taskId.length > 0 && String(config.fallbackVideoStatusEndpoint ?? '').trim().length > 0) {
          url = await pollPaidVideo(config, key, taskId, { started, signal: exec?.signal })
        }
        if (url.length === 0) {
          throw new Error(`付费视频通道没有返回视频地址：${JSON.stringify(data).slice(0, 300)}`)
        }
        const bytes = await fetchBytes(url, exec?.signal)
        if (bytes.length === 0) throw new Error('付费视频通道返回空文件。')
        const target = resolveTarget(config, args.save_path, `video-${stamp()}-${rand()}.mp4`, 'videos')
        await saveBytes(target, bytes)
        return {
          status: 'done',
          path: target,
          url,
          model: config.fallbackVideoModel,
          seconds,
          aspect_ratio: ratio,
          bytes: bytes.length,
          elapsedMs: Date.now() - started,
        }
      }

      const key = await resolveKey(ctx, config)
      const frame = typeof args.image === 'string' && args.image.trim().length > 0 ? await toVideoFrame(args.image) : ''
      const refs = Array.isArray(args.references)
        ? args.references.filter((one) => typeof one === 'string' && one.trim().length > 0).slice(0, 5)
        : []
      const mode = frame.length > 0 ? 'keyframe' : refs.length > 0 ? 'reference' : 'text'
      const body = { model: config.videoModel, prompt, mode, seconds, size: '720P', aspect_ratio: ratio }
      if (frame.length > 0) body.first_frame = frame
      if (mode === 'reference') body.images = await Promise.all(refs.map((one) => toVideoFrame(one)))

      return runAgnesVideo(config, key, body, { started: Date.now(), savePath: args.save_path, signal: exec?.signal })
    },
  }
}

function videoStatusTool(ctx, config) {
  return {
    name: 'video_status',
    description:
      '查询 generate_video 提交后仍在排队/生成中的视频任务；完成后会自动下载 mp4 并返回路径。同一个 video_id 可反复查。',
    parameters: {
      type: 'object',
      properties: {
        video_id: { type: 'string', description: 'generate_video 返回的 video_id（queue_stalled / pending 时会带）。' },
        wait_seconds: { type: 'number', description: '这次最多等多少秒，默认 120，范围 5–600。' },
        save_path: { type: 'string', description: '可选 mp4 输出路径。' },
      },
      required: ['video_id'],
    },
    output: { schema: VIDEO_OUTPUT, render: renderVideo },
    timeoutMs: 660000,
    async execute(args, exec) {
      const videoId = String(args.video_id ?? '').trim()
      if (videoId.length === 0) throw new Error('video_id 不能为空')
      const key = await resolveKey(ctx, config)
      const known = videoTasks.get(videoId)
      const started = known?.started ?? Date.now()
      const wanted = Number(args.wait_seconds)
      const waitMs = Math.max(
        5000,
        Math.min(600000, Number.isFinite(wanted) && wanted > 0 ? wanted * 1000 : config.videoStatusWaitMs),
      )
      return pollAgnesVideo(config, key, videoId, {
        started,
        stallAt: Number.POSITIVE_INFINITY,
        stopAt: Date.now() + waitMs,
        savePath: args.save_path,
        signal: exec?.signal,
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
