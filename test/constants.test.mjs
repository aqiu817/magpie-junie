// 常量 / 纯函数：对照 junie-api v0.3.1 源码
import test from "node:test"
import assert from "node:assert/strict"
import {
  OPENAI_MODEL_MAP, resolveOpenAIModelId, isAnthropicModel, isOpenAIModel,
  passthroughHeaders, sanitizePayload, sanitizeSystem, ANTHROPIC_FIELDS, OPENAI_FIELDS,
  currentCliVersion, defaultGrazieAgent,
} from "../lib/constants.mjs"
import { MODELS, configModels, routeOf } from "../lib/models.mjs"

test("model id map matches junie-api", () => {
  assert.equal(resolveOpenAIModelId("openai-gpt4.1"), "gpt-4.1-2025-04-14")
  assert.equal(resolveOpenAIModelId("openai-gpt4.1-mini"), "gpt-4.1-mini-2025-04-14")
  assert.equal(resolveOpenAIModelId("openai-gpt-4o"), "gpt-4o")
  assert.equal(resolveOpenAIModelId("other"), "other")
})

test("model family detection", () => {
  assert.equal(isAnthropicModel("claude-sonnet-4-6"), true)
  assert.equal(isOpenAIModel("openai-gpt4.1"), true)
  assert.equal(isAnthropicModel("openai-gpt4.1"), false)
})

test("passthrough headers: auth + fixed grab headers; free-google in standard mode", () => {
  const h = passthroughHeaders("T", { kind: "openai", license: "standard", freeGoogleApi: true })
  assert.equal(h.Authorization, "Bearer T")
  assert.equal(h["X-LLM-Model"], "openai")
  assert.equal(h["X-Keep-Path"], "true")
  assert.equal(h["X-Free-Google-Api"], "true")
  const off = passthroughHeaders("T", { kind: "anthropic", license: "standard", freeGoogleApi: false })
  assert.equal("X-Free-Google-Api" in off, false)
  assert.equal(off["X-LLM-Model"], "anthropic")
})

test("passthrough headers: free license adds forced-free trio", () => {
  const h = passthroughHeaders("T", { license: "free" })
  // 值必须是协议版本号 "2"（FORCED_LICENSE_FREE_VERSION）；"true" 会被上游判旧客户端。
  assert.equal(h["X-Forced-License-Free"], "2")
  assert.equal(h["X-Accept-EAP-License"], "false")
  assert.equal(h["X-Accept-Release-License"], "false")
  assert.equal("X-Free-Google-Api" in h, false)
})

test("default Grazie-Agent follows the installed CLI version", () => {
  const v = currentCliVersion()
  assert.match(v, /^\d+(\.\d+)+$/)
  assert.deepEqual(JSON.parse(defaultGrazieAgent()), { name: "junie:cli", version: `${v}:${v}` })
})

test("free-google toggle by version option", () => {
  const h = passthroughHeaders("T", { grazieAgent: '{"name":"junie:cli","version":"4100.11"}' })
  assert.equal(h["Grazie-Agent"], '{"name":"junie:cli","version":"4100.11"}')
})

test("sanitizePayload strips unknown fields", () => {
  const payload = {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    context_management: { x: 1 },
    top_k: 5,
  }
  const out = sanitizePayload(payload, ANTHROPIC_FIELDS)
  assert.equal("context_management" in out, false)
  assert.equal(out.top_k, 5)
  assert.deepEqual(out.messages, payload.messages)
})

test("sanitizeSystem strips unsupported cache_control props", () => {
  const out = sanitizeSystem([
    { type: "text", text: "x", cache_control: { type: "ephemeral", scope: "global" } },
    { type: "text", text: "y" },
  ])
  assert.deepEqual(out[0].cache_control, { type: "ephemeral" })
  assert.equal("cache_control" in out[1], false)
})

test("openai whitelist keeps response_format and seed", () => {
  const payload = { model: "openai-gpt4.1", messages: [], seed: 1, response_format: { type: "json_object" }, n: 2 }
  const out = sanitizePayload(payload, OPENAI_FIELDS)
  assert.equal(out.seed, 1)
  assert.equal(out.response_format.type, "json_object")
  assert.equal("n" in out, false)
})

test("configModels hides grazie in passthrough-only mode", () => {
  const all = configModels({ passthroughOnly: false })
  assert.ok(all["google-chat-gemini-pro-2.5"])
  const only = configModels({})
  assert.equal("google-chat-gemini-pro-2.5" in only, false)
  assert.ok(only["claude-sonnet-4-6"])
})

test("routeOf picks upstream path by model family", () => {
  assert.equal(routeOf("claude-opus-4-6"), "anthropic")
  assert.equal(routeOf("openai-gpt-4o"), "openai")
  assert.equal(routeOf("google-chat-gemini-flash-2.5"), "grazie")
  assert.equal(routeOf("Qwen/Qwen3.6-27B-FP8"), "vllm")
  assert.equal(routeOf("unknown-model"), "vllm")
})
