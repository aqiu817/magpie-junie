// junie-api 逆向事实 + 本机实机探测常量（2026-11-24）。
// 数据来源：fabienfleureau/junie-api v0.3.1 src/lib/api-config.ts、get-models.ts，
// 以及本机 Junie CLI 4100.11 的日志/DPAPI 凭据探测（见规划文档 §0.5）。

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const PROVIDER = "junie"
export const DISPLAY_NAME = "Junie"

// OAuth（Junie CLI 同款）
export const OAUTH = {
  tokenEndpoint: "https://oauth.account.jetbrains.com/oauth2/token",
  userinfoEndpoint: "https://oauth.account.jetbrains.com/api/rest/oauth2/userinfo",
  loginInitialUrl: "https://junie.jetbrains.com/cli-auth",
  clientId: "junie-cli",
  scopes: "offline_access openid jb-authn-service",
  callbackPortStart: 62345,
  callbackPortEnd: 62364,
  refreshLeadMs: 90_000,
}

// 上游端点。注意 CLI 4100.11 实际走 /llm/vllm/v1/chat/completions，
// junie-api 抓包（2026-03）记录的是 /v1/messages 与 /v1/chat/completions；
// 两者都保留，fetch 按路径探测/回退（M1）。
export const UPSTREAM = {
  ingrazzio: "https://ingrazzio-cloud-prod.labs.jb.gg",
  grazie: "https://api.jetbrains.ai",
  anthropicMessagesPath: "/v1/messages",
  openaiChatPath: "/v1/chat/completions",
  vllmChatPath: "/llm/vllm/v1/chat/completions",
  authTestPath: "/auth/test",
  grazieChatPath: "/llm/chat/stream/v9",
}

// 抓包自 Junie CLI 的固定请求头（junie-api src/lib/api-config.ts）；
// CLI 4100.11 日志里的 Grazie-Agent 版本是 4100.11，与旧抓包 888.219 不同，
// 默认用旧值（junie-api 验证过），可通过 options.grazieAgentVersion 覆盖。
// 抓包自 junie-api（2026-03，旧值 888.219）；CLI 反编译的版本常量是构建时注入的
//   `getGrazieAgentVersion()` = "<当前版本>:<当前版本>"（26.11.3 上是 "4171.6:4171.6"）。
// 上游按这个版本判定客户端新旧：版本过旧时 free 模型返回 400 UPDATE_REQUIRED，
// 所以本机装了 CLI 就跟随其版本（读 ~/.local/share/junie/current），读不到再用兜底值。
export function currentCliVersion() {
  try {
    const v = readFileSync(join(homedir(), ".local", "share", "junie", "current"), "utf8").trim()
    if (/^\d+(\.\d+)+$/.test(v)) return v
  } catch { /* 没装 CLI：用兜底值 */ }
  return FALLBACK_CLI_VERSION
}

export function defaultGrazieAgent(version = currentCliVersion()) {
  return JSON.stringify({ name: "junie:cli", version: `${version}:${version}` })
}

export const FALLBACK_CLI_VERSION = "4171.6"
export const DEFAULT_GRAZIE_AGENT = defaultGrazieAgent()

// 上游原生 Anthropic 直通允许的字段（junie-api ALLOWED_FIELDS）。
export const ANTHROPIC_FIELDS = new Set([
  "model", "messages", "max_tokens", "system", "metadata",
  "stop_sequences", "stream", "temperature", "top_p", "top_k",
  "tools", "tool_choice", "thinking",
])

// 上游原生 OpenAI 直通允许的字段（junie-api ALLOWED_FIELDS）。
export const OPENAI_FIELDS = new Set([
  "model", "messages", "max_tokens", "temperature", "top_p",
  "stream", "stop", "tools", "tool_choice", "seed", "response_format",
])

// Grazie profile id → 上游真实 OpenAI 模型名（junie-api OPENAI_MODEL_MAP）。
export const OPENAI_MODEL_MAP = {
  "openai-gpt4.1": "gpt-4.1-2025-04-14",
  "openai-gpt4.1-mini": "gpt-4.1-mini-2025-04-14",
  "openai-gpt-4o": "gpt-4o",
}

export function resolveOpenAIModelId(id) {
  return OPENAI_MODEL_MAP[id] ?? id
}

export function isAnthropicModel(id = "") {
  return id.startsWith("claude-")
}

export function isOpenAIModel(id = "") {
  return id.startsWith("openai-")
}

/** 构造上游直通请求头（junie-api getAnthropicPassthroughHeaders / getOpenAIPassthroughHeaders）。 */
export function passthroughHeaders(token, { kind = "anthropic", freeGoogleApi = true, grazieAgent = DEFAULT_GRAZIE_AGENT, license = "free" } = {}) {
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Accept": "text/event-stream,application/json",
    "Accept-Encoding": "identity",
    "Grazie-Agent": grazieAgent,
    "X-LLM-Model": kind === "openai" ? "openai" : "anthropic",
    "X-Keep-Path": "true",
    "Openai-Version": "2020-11-07",
    "X-Accept-EAP-License": "false",
  }
  if (freeGoogleApi) headers["X-Free-Google-Api"] = "true"
  // Free tier：CLI 反编译 IngrazzioLicense.Free 分支会带这三个头（applyIngrazzioHeaders）。
  // 值必须是协议版本号 "2"（FORCED_LICENSE_FREE_VERSION）——实测 2026-11-28：
  //   X-Forced-License-Free: 2    → 200，原生返回 function_call
  //   X-Forced-License-Free: true → 400 UPDATE_REQUIRED（被判旧客户端）
  if (license === "free") {
    headers["X-Forced-License-Free"] = "2"
    headers["X-Accept-EAP-License"] = "false"
    headers["X-Accept-Release-License"] = "false"
    delete headers["X-Free-Google-Api"] // free license 路径与 free-google 探测互斥
  }
  return headers
}

/** 字段白名单：剥掉上游不支持的字段，避免 400。 */
export function sanitizePayload(body, fields) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body
  const out = {}
  for (const [key, value] of Object.entries(body)) {
    if (fields.has(key)) out[key] = key === "system" ? sanitizeSystem(value) : value
  }
  return out
}

/** system 块里的 cache_control 只保留 { type }（Claude Code 会带 scope 等字段）。 */
export function sanitizeSystem(system) {
  if (!Array.isArray(system)) return system
  return system.map((block) => {
    if (!block || typeof block !== "object" || !("cache_control" in block)) return block
    const { cache_control, ...rest } = block
    if (!cache_control || typeof cache_control !== "object") return block
    return { ...rest, cache_control: { type: cache_control.type } }
  })
}
