import test from "node:test"
import assert from "node:assert/strict"
import { messagesToPrompt, parseCliOutput, decodeCliStdout, cleanResult, usageFromLlmUsage, completionBody, streamChunks, modelsResponse } from "../bridge-server.mjs"

test("messagesToPrompt keeps roles and flattens content parts", () => {
  const prompt = messagesToPrompt([
    { role: "system", content: "be brief" },
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: "hi" },
    { role: "user", content: "again" },
  ])
  assert.match(prompt, /## 系统指令\nbe brief/)
  assert.match(prompt, /## 用户\nhello/)
  assert.match(prompt, /## 助手此前回复\nhi/)
  assert.match(prompt, /## 用户\nagain/)
})

test("parseCliOutput finds the JSON line among CLI logs", () => {
  const stdout = [
    "Junie 26.11.2 (4100.11) (pid=1): log file: C:\\x.log",
    "Junie update 26.11.3 is available.",
    '{"sessionId":"s1","result":"OK","errors":[],"llmUsage":[]}',
    "some trailing log",
  ].join("\n")
  assert.equal(parseCliOutput(stdout).result, "OK")
})

test("parseCliOutput returns null when no JSON", () => {
  assert.equal(parseCliOutput("just logs"), null)
})

test("completionBody wraps result as assistant message", () => {
  const b = completionBody("hello", "junie-lite")
  assert.equal(b.object, "chat.completion")
  assert.equal(b.choices[0].message.role, "assistant")
  assert.equal(b.choices[0].message.content, "hello")
  assert.equal(b.choices[0].finish_reason, "stop")
})

test("streamChunks emits role, content chunks and [DONE]", () => {
  const sse = streamChunks("abcdef", "junie-lite")
  assert.match(sse, /"role":"assistant"/)
  assert.match(sse, /"content":"abcdef"/)
  assert.match(sse, /"finish_reason":"stop"/)
  assert.match(sse, /data: \[DONE\]/)
})

test("modelsResponse exposes junie-lite", () => {
  const r = modelsResponse()
  assert.ok(r.data.some((m) => m.id === "junie-lite"))
})


test("decodeCliStdout decodes GBK bytes from Chinese Windows CLI", () => {
  // 真实捕获的 GBK 字节（"用中文回答“你好"）+ ASCII JSON 结构
  const gbkJson = Buffer.from(
    "7b226e616d65223a22" + "d3c3d6d0cec4bbd8b4f0a1b0c4e3bac3" + "222c226572726f7273223a5b5d7d",
    "hex",
  )
  const decoded = decodeCliStdout(gbkJson)
  assert.match(decoded, /用中文回答/)
  const obj = parseCliOutput(gbkJson)
  assert.equal(obj.name, "用中文回答“你好")
})

test("decodeCliStdout keeps UTF-8 bytes intact", () => {
  const b = Buffer.from('{"name":"英文 ok"}', "utf8")
  assert.equal(decodeCliStdout(b), '{"name":"英文 ok"}')
  assert.equal(parseCliOutput(b).name, "英文 ok")
})


test("cleanResult strips agent Changes/Verification/Notes sections", () => {
  const raw = "今天天气不错。\n\n### Changes\n- 无代码变更。\n\n### Verification\n- 已确认。\n\n### Notes\n- 额外说明。"
  assert.equal(cleanResult(raw), "今天天气不错。")
  assert.equal(cleanResult("纯回答"), "纯回答")
})

test("cleanResult keeps a user's own ### heading that is not an agent section", () => {
  assert.equal(cleanResult("解释一下 ### 是什么"), "解释一下 ### 是什么")
})

test("cleanResult strips a leading Changes section (no preceding newline)", () => {
  assert.equal(cleanResult("### Changes\n- None.\n\n### Verification\n- ok."), "")
  assert.equal(cleanResult("## Verification\n- done"), "")
})

test("usageFromLlmUsage sums tokens across calls", () => {
  const usage = usageFromLlmUsage([
    { model: "junie-lite/gpt-6-luna", calls: 7, cost: 0, inputTokens: 2287, cacheInputTokens: 9626, cacheCreateTokens: 10970, outputTokens: 522 },
    { inputTokens: 100, outputTokens: 50, cacheInputTokens: 20, cacheCreateTokens: 10 },
  ])
  assert.equal(usage.prompt_tokens, 2287 + 9626 + 10970 + 100 + 20 + 10)
  assert.equal(usage.completion_tokens, 522 + 50)
  assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens)
  assert.equal(usage.prompt_tokens_details.cached_tokens, 9626 + 20)
})

test("completionBody carries provided usage", () => {
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  assert.deepEqual(completionBody("hi", "junie-lite", usage).usage, usage)
})

test("streamChunks includes usage chunk before DONE", () => {
  const usage = { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 }
  const sse = streamChunks("hi", "junie-lite", usage)
  assert.match(sse, /"usage":\{"prompt_tokens":12,"completion_tokens":6,"total_tokens":18\}/)
  assert.ok(sse.indexOf('"usage"') < sse.indexOf("data: [DONE]"))
})


test("messagesToPrompt injects tool definitions and asks for real execution", () => {
  const prompt = messagesToPrompt(
    [{ role: "user", content: "搜索今天的新闻" }],
    [{ type: "function", function: { name: "web_search", parameters: {} } }],
  )
  assert.match(prompt, /## 可用工具/)
  assert.match(prompt, /web_search/)
  assert.match(prompt, /实际执行搜索/)
  assert.match(prompt, /## 用户\n搜索今天的新闻/)
})

test("messagesToPrompt preserves tool results and assistant tool_calls history", () => {
  const prompt = messagesToPrompt([
    { role: "assistant", tool_calls: [{ function: { name: "web_search", arguments: '{"q":"news"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "搜索结果：今天有新闻" },
    { role: "user", content: "总结上面结果" },
  ])
  assert.match(prompt, /## 助手此前发起的工具调用/)
  assert.match(prompt, /web_search: \{"q":"news"\}/)
  assert.match(prompt, /## 工具执行结果 \(call_1\)\n搜索结果：今天有新闻/)
})
