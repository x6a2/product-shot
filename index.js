/**
 * product-shot —— 白底产品图 → 多场景多角度商品图（自包含 bundle）。
 *
 * 设计约束（同 dsh-agnes-tools）：插件运行在 profile 的 node_modules 下，解析不到
 * @deepseek-ai/dsh-tools。所以【不 import 任何 @deepseek-ai 运行时包】，工具定义直接
 * 满足 ctx.tools.register() 契约。生图走 Agnes Image API（用户自备 key），与
 * dsh-agnes-tools 共用同一套 key 约定（apiKey / apiKeyRef=AGNES_API_KEY / baseURL）。
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
})

const DEFAULTS = {
  apiKey: '',
  apiKeyRef: 'AGNES_API_KEY',
  baseURL: 'https://api.agnes-ai.cn/v1',
  imageModel: 'agnes-image-2.5-flash',
  outputDir: 'product-shot-output',
  effectsDir: 'product-shot-effects',
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
    path: { type: 'string' },
    model: { type: 'string' },
    size: { type: 'string' },
    ratio: { type: 'string' },
    bytes: { type: 'integer' },
  },
  required: ['path', 'model'],
}

/** 生成一张"空场景"背景图（无产品，供白底产品图合成用）。 */
function sceneTool(ctx, config) {
  return {
    name: 'generate_scene',
    description:
      '为 product-shot 生成一张"空场景"背景图（不含产品，用于把白底产品图合成进去）。走 Agnes Image API，用户自备 key。画面描述建议：材质 + 光照 + 构图 + 风格 + 质量要求。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '空场景描述：材质/光照/构图/风格，不要出现任何产品。' },
        ratio: { type: 'string', description: `画幅，默认 1:1。可选：${RATIOS.join(' / ')}`, enum: RATIOS },
        size: { type: 'string', description: `分辨率档位，默认 2K。可选：${TIERS.join(' / ')}`, enum: TIERS },
        save_path: { type: 'string', description: '可选输出路径（默认写入 outputDir/scenes/）。' },
      },
      required: ['prompt'],
    },
    output: {
      schema: SCENE_OUTPUT,
      render: (_args, value) => blocks(value, `已生成场景背景（${value.model}，${value.size ?? '-'} ${value.ratio ?? '-'}）。`),
    },
    timeoutMs: 360000,
    async execute(args, exec) {
      const key = await resolveKey(ctx, config)
      const size = TIERS.includes(args.size) ? args.size : '2K'
      const ratio = RATIOS.includes(args.ratio) ? args.ratio : '1:1'
      const body = { model: config.imageModel, prompt: args.prompt, size, ratio, return_base64: true }
      const data = await requestJSON(`${config.baseURL}/images/generations`, {
        method: 'POST',
        key,
        body,
        signal: exec?.signal,
      })
      const item = Array.isArray(data?.data) ? data.data[0] : undefined
      const bytes = await imageBytes(item, exec?.signal)
      const target = resolveTarget(config, args.save_path, `scene-${stamp()}-${rand()}.png`)
      await saveBytes(target, bytes)
      return { path: target, model: config.imageModel, size, ratio, bytes: bytes.length }
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
