import test from "node:test"
import assert from "node:assert/strict"
import {
  toolsToResponses,
  toolChoiceToResponses,
  messagesToInput,
  chatToResponses,
  usageFromResponses,
  outputToMessage,
  responsesToChat,
  createStreamConverter,
} from "../lib/responses.mjs"

test("toolsToResponses flattens chat tools into Responses tools", () => {
  const out = toolsToResponses([
    { type: "function", function: { name: "get_weather", description: "天气", parameters: { type: "object" } } },
  ])
  assert.deepEqual(out, [{ type: "function", name: "get_weather", description: "天气", parameters: { type: "object" } }])
  assert.equal(toolsToResponses([]), undefined)
  assert.equal(toolsToResponses(undefined), undefined)
})

test("toolChoiceToResponses handles strings and function objects", () => {
  assert.equal(toolChoiceToResponses("auto"), "auto")
  assert.deepEqual(toolChoiceToResponses({ type: "function", function: { name: "x" } }), { type: "function", name: "x" })
  assert.equal(toolChoiceToResponses(undefined), undefined)
})

test("messagesToInput moves system to instructions and keeps user turns", () => {
  const { input, instructions } = messagesToInput([
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: [{ type: "text", text: "again" }] },
  ])
  assert.equal(instructions, "be brief")
  assert.deepEqual(input[0], { role: "user", content: [{ type: "input_text", text: "hello" }] })
  assert.deepEqual(input[1], { role: "assistant", content: [{ type: "output_text", text: "hi" }] })
  assert.equal(input[2].content[0].text, "again")
})

test("messagesToInput converts tool history into function_call items", () => {
  const { input } = messagesToInput([
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "晴 20C" },
  ])
  assert.deepEqual(input[0], { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"北京"}' })
  assert.deepEqual(input[1], { type: "function_call_output", call_id: "call_1", output: "晴 20C" })
})

test("chatToResponses maps limits and keeps tools", () => {
  const body = chatToResponses({
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "f" } }],
    tool_choice: "auto",
    max_tokens: 128,
    temperature: 0.2,
  }, { model: "gpt-6-luna" })
  assert.equal(body.model, "gpt-6-luna")
  assert.equal(body.max_output_tokens, 128)
  assert.equal(body.store, false)
  assert.equal(body.truncation, "disabled")
  assert.deepEqual(body.tools, [{ type: "function", name: "f" }])
  assert.equal(body.tool_choice, "auto")
  assert.equal(body.temperature, 0.2)
  assert.equal(body.instructions, undefined)
})

test("usageFromResponses maps token details", () => {
  const u = usageFromResponses({ input_tokens: 65, output_tokens: 18, total_tokens: 83, input_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 }, output_tokens_details: { reasoning_tokens: 3 } })
  assert.equal(u.prompt_tokens, 65)
  assert.equal(u.completion_tokens, 18)
  assert.equal(u.total_tokens, 83)
  assert.equal(u.prompt_tokens_details.cached_tokens, 10)
  assert.equal(u.prompt_tokens_details.cache_write_tokens, 5)
  assert.equal(u.completion_tokens_details.reasoning_tokens, 3)
})

test("outputToMessage collects text and function calls", () => {
  const { text, toolCalls } = outputToMessage([
    { type: "message", content: [{ type: "output_text", text: "好的。" }] },
    { type: "function_call", id: "fc_1", call_id: "call_a", name: "get_weather", arguments: '{"city":"北京"}' },
  ])
  assert.equal(text, "好的。")
  assert.deepEqual(toolCalls, [{ id: "call_a", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } }])
})

test("responsesToChat sets tool_calls finish_reason and null content", () => {
  const chat = responsesToChat({
    model: "gpt-6-luna",
    output: [{ type: "function_call", call_id: "call_a", name: "get_weather", arguments: "{}" }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  }, "junie-lite")
  assert.equal(chat.object, "chat.completion")
  assert.equal(chat.model, "junie-lite")
  assert.equal(chat.choices[0].finish_reason, "tool_calls")
  assert.equal(chat.choices[0].message.content, null)
  assert.equal(chat.choices[0].message.tool_calls[0].id, "call_a")
  assert.equal(chat.usage.total_tokens, 15)
})

test("responsesToChat plain text ends with stop", () => {
  const chat = responsesToChat({
    output: [{ type: "message", content: [{ type: "output_text", text: "你好" }] }],
    usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
  }, "junie-lite")
  assert.equal(chat.choices[0].message.content, "你好")
  assert.equal(chat.choices[0].finish_reason, "stop")
  assert.equal(chat.choices[0].message.tool_calls, undefined)
})

test("stream converter emits role, text, finish and usage", () => {
  const c = createStreamConverter("junie-lite")
  const role = c.feed({ type: "response.created" })
  assert.match(role[0], /"role":"assistant"/)
  const text = c.feed({ type: "response.output_text.delta", delta: "你好" })
  assert.match(text[0], /"content":"你好"/)
  const done = c.feed({ type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } })
  assert.match(done[0], /"finish_reason":"stop"/)
  assert.match(done[1], /"usage":\{"prompt_tokens":3/)
  assert.equal(done[2], "data: [DONE]\n\n")
})

test("stream converter maps function_call items to tool_calls chunks", () => {
  const c = createStreamConverter("junie-lite")
  c.feed({ type: "response.created" })
  const added = c.feed({ type: "response.output_item.added", item: { id: "fc_1", type: "function_call", call_id: "call_a", name: "get_weather" } })
  assert.match(added[0], /"tool_calls":\[\{"index":0,"id":"call_a","type":"function","function":\{"name":"get_weather","arguments":""\}\}/)
  const args = c.feed({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"city":"北京"}' })
  assert.match(args[0], /"arguments":"{\\"city\\":\\"北京\\"}"/)
  const done = c.feed({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })
  assert.match(done[0], /"finish_reason":"tool_calls"/)
})

test("stream converter ignores unknown events and reports upstream errors", () => {
  const c = createStreamConverter("junie-lite")
  assert.deepEqual(c.feed({ type: "response.in_progress" }).length, 1) // 只有 role chunk
  const err = c.feed({ type: "response.failed", response: { error: { message: "boom" } } })
  assert.match(err[0], /"error":\{"message":"boom"/)
  assert.equal(err[1], "data: [DONE]\n\n")
})
