// OpenAI chat completions ↔ OpenAI Responses API 协议转换。
//
// 背景（2026-11-28 实测）：Ingrazzio 的 free 通道 junie-lite 实际映射到 gpt-6-luna，
// CLI 走的是 POST /v1/responses（OpenAI Responses API），原生返回 function_call。
// 早期 CLI 版本的 /llm/vllm/v1/chat/completions（Qwen）已被上游替换。
//
// 认证/放行的关键（反编译 IngrazzioLicenseHeadersKt.class 实证，见规划 §22）：
//   X-Forced-License-Free: "2"      ← 不是 "true"！这是 free license 协议版本号
//   Grazie-Agent: {"name":"junie:cli","version":"4171.6:4171.6"}  ← 当前 CLI 版本
// 用 "true" 会被上游判定为旧客户端，返回 400 UPDATE_REQUIRED。
//
// 本模块只做纯数据转换，便于单测；网络请求在 bridge-server 里做。

export const RESPONSES_PATH = "/v1/responses"

/** chat completions 的 tools → Responses API 的扁平 tools。 */
export function toolsToResponses(tools) {
  if (!Array.isArray(tools)) return undefined
  const out = []
  for (const t of tools) {
    const fn = t?.function ?? t
    if (!fn?.name) continue
    const item = { type: "function", name: fn.name }
    if (fn.description) item.description = fn.description
    if (fn.parameters) item.parameters = fn.parameters
    out.push(item)
  }
  return out.length ? out : undefined
}

/** chat completions 的 tool_choice → Responses API 的 tool_choice。 */
export function toolChoiceToResponses(choice) {
  if (choice === undefined || choice === null) return undefined
  if (typeof choice === "string") return choice // "auto" | "none" | "required"
  const name = choice?.function?.name ?? choice?.name
  return name ? { type: "function", name } : undefined
}

/** 文本内容块（chat 的 content 可能是 string 或 parts 数组）→ Responses input 文本。 */
export function contentToText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((p) => p?.text ?? p?.input_text ?? "").filter(Boolean).join("\n")
}

/**
 * chat messages → Responses `input` 数组。
 *
 * 多轮工具调用的历史要转成 Responses 的 item 形式：
 *   assistant.tool_calls → { type:"function_call", call_id, name, arguments }
 *   role:"tool"          → { type:"function_call_output", call_id, output }
 * system 消息单独收集到 instructions（Responses 的常规做法）。
 */
export function messagesToInput(messages) {
  const input = []
  const systemParts = []
  for (const m of (Array.isArray(messages) ? messages : [])) {
    const role = m?.role ?? "user"
    if (role === "system" || role === "developer") {
      const text = contentToText(m?.content)
      if (text) systemParts.push(text)
      continue
    }
    if (role === "tool") {
      const output = contentToText(m?.content)
      input.push({ type: "function_call_output", call_id: m?.tool_call_id ?? "", output })
      continue
    }
    if (role === "assistant" && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
      // 文本部分（若有）先作为 assistant 消息，再逐个 function_call
      const text = contentToText(m?.content)
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] })
      for (const tc of m.tool_calls) {
        const fn = tc?.function ?? tc
        input.push({
          type: "function_call",
          call_id: tc?.id ?? "",
          name: fn?.name ?? "",
          arguments: typeof fn?.arguments === "string" ? fn.arguments : JSON.stringify(fn?.arguments ?? {}),
        })
      }
      continue
    }
    if (role === "assistant") {
      const text = contentToText(m?.content)
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] })
      continue
    }
    // user
    input.push({ role: "user", content: [{ type: "input_text", text: contentToText(m?.content) }] })
  }
  return { input, instructions: systemParts.length ? systemParts.join("\n\n") : undefined }
}

/**
 * OpenAI chat completions 请求体 → Responses API 请求体。
 * @param {object} body chat completions body
 * @param {{model?:string}} opts 模型 wire name（上游认的 id）
 */
export function chatToResponses(body, { model } = {}) {
  const src = body && typeof body === "object" ? body : {}
  const { input, instructions } = messagesToInput(src.messages)
  const out = {
    model: model ?? src.model,
    input,
    // 不存储：Ingrazzio 不提供服务端会话；避免 previous_response_id 链路
    store: false,
    truncation: "disabled",
  }
  if (instructions) out.instructions = instructions
  const tools = toolsToResponses(src.tools)
  if (tools) out.tools = tools
  const toolChoice = toolChoiceToResponses(src.tool_choice)
  if (toolChoice !== undefined) out.tool_choice = toolChoice
  if (src.parallel_tool_calls !== undefined) out.parallel_tool_calls = src.parallel_tool_calls
  const maxOut = src.max_completion_tokens ?? src.max_tokens
  if (maxOut !== undefined) out.max_output_tokens = maxOut
  for (const key of ["temperature", "top_p", "reasoning", "text", "metadata"]) {
    if (src[key] !== undefined) out[key] = src[key]
  }
  return out
}

/** Responses usage → chat completions usage。 */
export function usageFromResponses(usage) {
  const u = usage && typeof usage === "object" ? usage : {}
  const prompt = Number(u.input_tokens) || 0
  const completion = Number(u.output_tokens) || 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(u.total_tokens) || prompt + completion,
    prompt_tokens_details: {
      cached_tokens: Number(u.input_tokens_details?.cached_tokens) || 0,
      cache_write_tokens: Number(u.input_tokens_details?.cache_write_tokens) || 0,
    },
    completion_tokens_details: {
      reasoning_tokens: Number(u.output_tokens_details?.reasoning_tokens) || 0,
    },
  }
}

/**
 * Responses 响应的 output 数组 → assistant 文本 + tool_calls。
 * function_call item 形如 { id, type:"function_call", call_id, name, arguments }。
 */
export function outputToMessage(output) {
  let text = ""
  const toolCalls = []
  for (const item of (Array.isArray(output) ? output : [])) {
    if (!item || typeof item !== "object") continue
    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id ?? item.id ?? "",
        type: "function",
        function: {
          name: item.name ?? "",
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      })
      continue
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string") text += part.text
      }
    }
  }
  return { text, toolCalls }
}

/**
 * Responses 非流式响应 → chat completions 响应体。
 * 有 tool_calls 时 content 置 null（OpenAI 惯例），finish_reason 为 "tool_calls"。
 */
export function responsesToChat(json, model, { id, created } = {}) {
  const { text, toolCalls } = outputToMessage(json?.output)
  const hasTools = toolCalls.length > 0
  const message = { role: "assistant", content: hasTools ? (text || null) : text }
  if (hasTools) message.tool_calls = toolCalls
  return {
    id: id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: created ?? Math.floor(Date.now() / 1000),
    model: model ?? json?.model,
    choices: [{
      index: 0,
      message,
      finish_reason: hasTools ? "tool_calls" : "stop",
    }],
    usage: usageFromResponses(json?.usage),
  }
}

/**
 * 流式转换器：Responses SSE 事件 → chat completions chunk。
 *
 * 每次调用喂入一个已解析的事件对象，返回要写出的 chunk 数组（可能为空）。
 * 状态跨事件累积：tool_call 的 index、finish_reason、usage。
 */
export function createStreamConverter(model, { id, created } = {}) {
  const chunkId = id ?? `chatcmpl-${Date.now()}`
  const created_ = created ?? Math.floor(Date.now() / 1000)
  const state = {
    sentRole: false,
    toolIndex: 0,
    itemToolIndex: new Map(), // Responses item_id → chat tool_calls index
    sawToolCall: false,
    usage: null,
  }
  const mk = (delta, finish = null, extra = {}) =>
    `data: ${JSON.stringify({
      id: chunkId,
      object: "chat.completion.chunk",
      created: created_,
      model,
      choices: finish === "usage-only" ? [] : [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    })}\n\n`

  function feed(event) {
    const out = []
    const type = event?.type ?? ""
    if (!type) return out
    if (!state.sentRole) {
      state.sentRole = true
      out.push(mk({ role: "assistant" }))
    }
    if (type === "response.output_item.added") {
      const item = event.item ?? {}
      if (item.type === "function_call") {
        state.sawToolCall = true
        const index = state.toolIndex++
        state.itemToolIndex.set(item.id ?? item.call_id ?? String(index), index)
        out.push(mk({
          tool_calls: [{
            index,
            id: item.call_id ?? item.id ?? "",
            type: "function",
            function: { name: item.name ?? "", arguments: "" },
          }],
        }))
      }
      return out
    }
    if (type === "response.function_call_arguments.delta") {
      const index = state.itemToolIndex.get(event.item_id)
      if (index === undefined) return out
      out.push(mk({ tool_calls: [{ index, function: { arguments: String(event.delta ?? "") } }] }))
      return out
    }
    if (type === "response.output_text.delta") {
      out.push(mk({ content: String(event.delta ?? "") }))
      return out
    }
    if (type === "response.completed" || type === "response.incomplete") {
      const resp = event.response ?? {}
      state.usage = usageFromResponses(resp.usage)
      out.push(mk({}, state.sawToolCall ? "tool_calls" : "stop"))
      out.push(mk({}, "usage-only", { usage: state.usage }))
      out.push("data: [DONE]\n\n")
      return out
    }
    if (type === "response.failed" || type === "error") {
      const message = event.response?.error?.message ?? event.error?.message ?? event.message ?? "upstream error"
      out.push(`data: ${JSON.stringify({ error: { message, type: "upstream_error" } })}\n\n`)
      out.push("data: [DONE]\n\n")
      return out
    }
    return out
  }

  return { feed, state }
}
