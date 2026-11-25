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
import { mkdir, writeFile } from 'node:fs/promises'
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
}

const ROOT = dirname(fileURLToPath(import.meta.url))
const RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9']
const TIERS = ['1K', '2K', '3K', '4K']

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

function resolveTarget(config, wanted, fallbackName) {
  const base = isAbsolute(config.outputDir) ? config.outputDir : resolve(process.cwd(), config.outputDir)
  if (typeof wanted === 'string' && wanted.trim().length > 0) {
    return isAbsolute(wanted) ? wanted : resolve(base, wanted)
  }
  return join(base, 'scenes', fallbackName)
}

async function saveBytes(target, bytes) {
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  return bytes.length
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

  const content = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8')
  ctx.skills.register({
    name: 'product-shot',
    description: '白底产品图 → 多场景多角度商品图：抠图、场景生成、合成、排版、质检的全流程（自包含，文字像素级清晰）。',
    content,
    source: 'product-shot bundle',
    resourceBase: { kind: 'directory', path: ROOT },
  })
}
