/* The OpenAI subset, as Rust types.
 *
 * WHY A SUBSET AND NOT THE API. The extension's client speaks the chat shape every local runtime speaks
 * (LM Studio, Ollama, llama.cpp's own `llama-server`), and this sidecar is one more of those. Only the
 * fields the client actually sends and reads are modelled; everything else is ignored by serde, which is
 * what keeps this sidecar able to answer a request written for a different server.
 *
 * THE WIRE SHAPE IS A CONTRACT. `src/ai/assistant.ts` `parseSseChunk` reads `choices[0].delta.content`,
 * `choices[0].finish_reason` and `usage.completion_tokens`; `parseChatCompletionFull` reads
 * `choices[0].message.content`. The builders below are the only place those names appear on this side.
 */

use serde::Deserialize;
use serde_json::{json, Value};

/// One message in the conversation. `content` is a string: the extension never sends parts.
#[derive(Debug, Clone, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

/// `POST /v1/chat/completions`. Every optional field is optional on purpose — a client that omits
/// `stream` wants one JSON body, and one that omits `temperature` wants the server's default.
#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    // A `model` field is accepted and ignored (serde drops unknown fields): this server has exactly one
    // model loaded, and pretending to route by name would be a lie the client cannot detect.
    #[serde(default)]
    pub messages: Vec<Message>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub stream: Option<bool>,
}

/// One streamed delta — what the client appends to the answer it is building.
pub fn chunk_json(model: &str, delta: &str) -> Value {
    json!({
        "id": "chatcmpl-local",
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [{ "index": 0, "delta": { "content": delta }, "finish_reason": null }]
    })
}

/// The prompt size, sent before the first token.
///
/// OpenAI reports usage only in the closing chunk; a client that wants to watch the context fill while it
/// waits needs the count early, and this is the only moment the runtime knows it. A client that ignores it
/// loses nothing (the delta is empty).
pub fn prompt_usage_json(model: &str, prompt_tokens: usize) -> Value {
    json!({
        "id": "chatcmpl-local",
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [{ "index": 0, "delta": {}, "finish_reason": null }],
        "usage": { "prompt_tokens": prompt_tokens }
    })
}

/// The closing chunk: it carries the reason the model stopped and how many tokens it wrote, which is what
/// turns "0 characters" into an explanation (a thinking model that spent its whole budget before answering)
/// rather than a shrug.
pub fn final_chunk_json(model: &str, finish_reason: &str, completion_tokens: u32) -> Value {
    json!({
        "id": "chatcmpl-local",
        "object": "chat.completion.chunk",
        "model": model,
        "choices": [{ "index": 0, "delta": {}, "finish_reason": finish_reason }],
        "usage": { "completion_tokens": completion_tokens }
    })
}

/// The whole answer, for a client that did not ask to stream.
pub fn full_json(
    model: &str,
    content: &str,
    finish_reason: &str,
    completion_tokens: u32,
    prompt_tokens: usize,
) -> Value {
    json!({
        "id": "chatcmpl-local",
        "object": "chat.completion",
        "model": model,
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": content },
            "finish_reason": finish_reason
        }],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens as usize
        }
    })
}
