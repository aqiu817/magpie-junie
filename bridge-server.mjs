#!/usr/bin/env node
// Junie CLI headless → OpenAI 兼容本地服务。
//
// 背景：直连 Grazie 端点被 license=NONE 拒绝（403 NO_LICENSE），但 Junie CLI 内部的
// junie-lite 通道能正常回答（隔壁实测结论）。本服务把 OpenAI chat completions 翻译成
// 一次 CLI headless 调用：
//   OpenAI messages → prompt 文本 → 临时文件（真实文件 fd 作 stdin）
//   → spawn junie.bat --output-format json --model junie-lite
//   → 从 stdout 找 JSON 行 → { result } → assistant 回复
//
// 坑（实锤 2026-11-24）：
//   1. CLI 的 readPipedInput() 用 FileInputStream.available()，stdin 是 pipe 时 Windows 抛
//      "函数不正确"；必须给一个**真实文件**作 stdin（用 fs.openSync + spawn stdio fd）。
//   2. CLI stdout 混有日志行（"Junie ... log file:" / "Junie update ... available."），
//      真正的 JSON 是其中一行，要以 `{` 开头解析。
//   3. `--task` 与 stdin 输入互斥；用 stdin 传 prompt 时不能带 --task。
//   4. 当前 CLI 26.11.2 的 junie-lite 被上游拒绝（"version ... doesn't support this free
//      model"），CLI 提示可升级 26.11.3；服务本身与版本无关，升级后即可用。

import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkAndUpdate } from "./lib/auto-update.mjs"

const AUTO_UPDATE = process.env.JUNIE_AUTO_UPDATE !== "off" // 默认开
const UPDATE_INTERVAL_MS = Number(process.env.JUNIE_UPDATE_INTERVAL_MS ?? 6 * 60 * 60 * 1000)

let lastUpdateInfo = null

/** 按需检查 CLI 版本（6h 节流），失败不影响服务。 */
async function maybeUpdate() {
  if (!AUTO_UPDATE) return null
  try {
    const info = await checkAndUpdate({ intervalMs: UPDATE_INTERVAL_MS })
    if (info.checked) {
      lastUpdateInfo = info
      console.log(`[auto-update] ${info.reason}: version=${info.version}${info.output.trim() ? ` | ${info.output.trim().slice(0, 300)}` : ""}`)
    }
    return info
  } catch (err) {
    console.warn(`[auto-update] check failed: ${err?.message ?? err}`)
    return null
  }
}

const PORT = Number(process.env.PORT ?? 4141)
const HOST = process.env.HOST ?? "127.0.0.1"
const JUNIE = process.env.JUNIE_BIN ?? "C:\\Users\\Robin\\.local\\bin\\junie.bat"
const MODEL = process.env.JUNIE_MODEL ?? "junie-lite"
const TIMEOUT_MS = Number(process.env.JUNIE_TIMEOUT_MS ?? 120_000)

/**
 * OpenAI messages + tools → 单个 prompt 文本。
 *
 * 工具处理（B 方案）：CLI headless 的 JSON 输出只有 6 个字段，没有 tool_calls，
 * 无法做标准 function calling（模型返回 tool_calls 给客户端执行）。但 CLI 内置
 * websearch/grep 等工具能自己执行并把结果写进答案。因此把 OpenAI tools 转成
 * "可用工具"说明注入 prompt，引导 CLI 用内置能力完成任务；tool role 的历史消息
 * 转成"工具执行结果"段落，保证多轮上下文不丢。
 */
export function messagesToPrompt(messages, tools) {
  const parts = []
  if (Array.isArray(tools) && tools.length) {
    const names = tools.map((t) => t?.function?.name ?? t?.name).filter(Boolean)
    if (names.length) {
      parts.push([
        "## 可用工具",
        "用户请求中提供了以下工具，请利用你自己的内置能力完成对应任务（联网搜索请用 websearch）：",
        names.map((n) => `- ${n}`).join("\n"),
        "若需要搜索/查资料，请实际执行搜索并给出带来源的结果，不要只说“已检索”。",
      ].join("\n"))
    }
  }
  for (const m of (Array.isArray(messages) ? messages : [])) {
    const role = m?.role ?? "user"
    if (role === "tool") {
      let content = m?.content ?? ""
      if (Array.isArray(content)) content = content.map((p) => p?.text ?? "").join("\n")
      parts.push(`## 工具执行结果${m?.tool_call_id ? ` (${m.tool_call_id})` : ""}\n${content}`)
      continue
    }
    if (role === "assistant" && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map((tc) =>
        `- ${tc?.function?.name ?? tc?.name}: ${tc?.function?.arguments ?? ""}`).join("\n")
      parts.push(`## 助手此前发起的工具调用\n${calls}`)
      continue
    }
    let content = m?.content ?? ""
    if (Array.isArray(content)) content = content.map((p) => p?.text ?? "").join("\n")
    if (role === "system") parts.push(`## 系统指令\n${content}`)
    else if (role === "assistant") parts.push(`## 助手此前回复\n${content}`)
    else parts.push(`## 用户\n${content}`)
  }
  return parts.join("\n\n")
}

/**
 * 从 CLI stdout 里找最后一个 JSON 对象行并解析。
 *
 * 编码坑（2026-11-24 实测）：中文 Windows 上 CLI 的 stdout 是 **GBK** 字节
 * （JSON 结构 ASCII + 中文 GBK 双字节），按 UTF-8 解码会得到 "Ŀǰ..." 乱码。
 * 策略：先把 Buffer 按 UTF-8 解，若出现替换字符（U+FFFD）说明不是 UTF-8，
 * 改用 GBK（TextDecoder('gbk')，Node 24 ICU 支持；GBK 兼容 ASCII，结构不受影响）。
 */
export function decodeCliStdout(stdout) {
  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout), "utf8")
  const utf8 = buf.toString("utf8")
  if (!utf8.includes("\uFFFD")) return utf8
  try { return new TextDecoder("gbk").decode(buf) } catch { return utf8 }
}

export function parseCliOutput(stdout) {
  const lines = decodeCliStdout(stdout).split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith("{")) continue
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj === "object") return obj
    } catch { /* 不是 JSON 行，继续往前找 */ }
  }
  return null
}

/** 正确实现：用 fs.openSync 把真实文件 fd 传给 spawn 的 stdin。 */
export function callJunie(prompt, { model = MODEL, timeoutMs = TIMEOUT_MS, bin = JUNIE } = {}) {
  return new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(tmpdir(), "magpie-junie-"))
    const stdinPath = join(dir, "prompt.txt")
    // prompt 用 UTF-8 写：实测 CLI 从真实文件 stdin 读 UTF-8 中文能正确理解
    // （"函数不正确"是 pipe stdin 的问题，与编码无关）。
    writeFileSync(stdinPath, prompt, "utf8")
    let fd
    try { fd = openSync(stdinPath, "r") } catch (err) { rmSync(dir, { recursive: true, force: true }); return reject(err) }
    // Windows 上 .bat 不能由 spawn 直接执行（EINVAL），必须经 cmd.exe /c。
    const isWindows = process.platform === "win32"
    const cmd = isWindows ? "cmd.exe" : bin
    const args = isWindows ? ["/c", bin, "--output-format", "json", "--model", model]
      : ["--output-format", "json", "--model", model]
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: [fd, "pipe", "pipe"],
    })
    closeSync(fd)
    // 必须累积 Buffer：中文 Windows 上 CLI stdout 是 GBK 字节，
    // 若用 `stdout += c`（Buffer 隐式 toString/utf8）会在这一步就破坏原始字节。
    const outChunks = [], errChunks = []
    let done = false
    const timer = setTimeout(() => child.kill(), timeoutMs)
    const finish = (err, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      rmSync(dir, { recursive: true, force: true })
      err ? reject(err) : resolve(value)
    }
    child.stdout?.on("data", (c) => outChunks.push(c))
    child.stderr?.on("data", (c) => errChunks.push(c))
    child.on("error", (err) => finish(err))
    child.on("close", (code) => {
      try {
        const stdoutBuf = Buffer.concat(outChunks)
        const obj = parseCliOutput(stdoutBuf)
        if (!obj) return finish(new Error(`CLI exited ${code} without JSON: ${decodeCliStdout(stdoutBuf || Buffer.concat(errChunks)).slice(0, 400)}`))
        finish(null, {
          code,
          obj,
          result: obj.result ?? "",
          errors: obj.errors ?? [],
          llmUsage: obj.llmUsage ?? [],
          sessionId: obj.sessionId ?? "",
        })
      } catch (err) { finish(err) }
    })
  })
}

/**
 * Junie CLI 作为 coding agent，会在答案后固定附一段模板：
 *   ### Changes\n- ...\n\n### Verification\n- ...  （有时还有 ### Notes）
 * 对纯对话场景这些是噪音，从第一个已知段落标题起截断。
 * 只匹配已知标题，避免用户正文里出现 "### " 时被误伤。
 */
const AGENT_SECTIONS = ["Changes", "Verification", "Notes"]

export function cleanResult(result) {
  if (typeof result !== "string") return ""
  let cut = result.length
  for (const title of AGENT_SECTIONS) {
    // 支持标题在开头（^）或换行后（\n）；CLI 偶尔让模板段落在 result 最前面。
    const re = new RegExp(`(?:^|\\n)#{1,3}\\s*${title}\\b`, "i")
    const m = re.exec(result)
    if (m && m.index < cut) cut = m.index
  }
  return result.slice(0, cut).trim()
}

/** CLI llmUsage 数组 → OpenAI usage（缓存输入计入 prompt_tokens）。 */
export function usageFromLlmUsage(llmUsage) {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0
  for (const u of (Array.isArray(llmUsage) ? llmUsage : [])) {
    input += Number(u?.inputTokens) || 0
    output += Number(u?.outputTokens) || 0
    cacheRead += Number(u?.cacheInputTokens) || 0
    cacheWrite += Number(u?.cacheCreateTokens) || 0
  }
  const prompt = input + cacheRead + cacheWrite
  return {
    prompt_tokens: prompt,
    completion_tokens: output,
    total_tokens: prompt + output,
    prompt_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite },
  }
}

/** OpenAI chat completion 响应体 */
export function completionBody(result, model, usage) {
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: result },
      finish_reason: "stop",
    }],
    usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

/** SSE 流式：CLI 不支持增量，把 result 切成块发出。usage 放最后一个 chunk。 */
export function streamChunks(result, model, usage) {
  const id = `chatcmpl-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta, finish_reason = null, extra = {}) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`
  const out = [chunk({ role: "assistant" })]
  for (let i = 0; i < result.length; i += 64) out.push(chunk({ content: result.slice(i, i + 64) }))
  out.push(chunk({}, "stop"))
  out.push(chunk({}, null, { usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }))
  out.push("data: [DONE]\n\n")
  return out.join("")
}

export const modelsResponse = () => ({
  object: "list",
  data: [MODEL, "junie-lite"].filter((v, i, a) => a.indexOf(v) === i)
    .map((id) => ({ id, object: "model", created: 0, owned_by: "junie-cli" })),
})

export function createBridgeServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`)
      if (url.pathname === "/v1/models" || url.pathname === "/models") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(modelsResponse()))
        return
      }
      if ((url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") && req.method === "POST") {
        const chunks = []
        for await (const c of req) chunks.push(c)
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        // 每次对话前按需检查版本（6h 节流），确保 CLI 不被上游版本门槛卡住。
        await maybeUpdate()
        const prompt = messagesToPrompt(body.messages, body.tools)
        const { result, errors, llmUsage } = await callJunie(prompt, { model: body.model && body.model !== "junie-lite" ? MODEL : MODEL })
        if (errors.length) {
          res.writeHead(400, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: { message: errors.join("; "), type: "junie_error" } }))
          return
        }
        const replyModel = body.model ?? MODEL
        const answer = cleanResult(result)
        const usage = usageFromLlmUsage(llmUsage)
        if (body.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
          res.end(streamChunks(answer, replyModel, usage))
        } else {
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end(JSON.stringify(completionBody(answer, replyModel, usage)))
        }
        return
      }
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({
          ok: true,
          model: MODEL,
          bin: JUNIE,
          autoUpdate: AUTO_UPDATE,
          lastUpdate: lastUpdateInfo && {
            checked: lastUpdateInfo.checked,
            updated: lastUpdateInfo.updated,
            version: lastUpdateInfo.version,
            reason: lastUpdateInfo.reason,
          },
        }))
        return
      }
      res.writeHead(404)
      res.end()
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { message: String(err?.message ?? err), type: "server_error" } }))
    }
  })
}

// 直接运行时启动服务（Linux 上 import.meta 入口检测可能失效，用显式开关兜底）
if (process.env.JUNIE_BRIDGE_SERVE === "1" || (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href)) {
  const server = createBridgeServer()
  server.listen(PORT, HOST, () => {
    console.log(`junie-openai bridge listening on http://${HOST}:${PORT}/v1 (model=${MODEL})`)
    maybeUpdate() // 启动后后台检查一次（6h 节流），不阻塞服务可用
  })
}
