# rusty-model-host

The local model server for **Grumpy's Rusty Platform**'s AI coding assist. It is a small HTTP server on
`127.0.0.1` that speaks the subset of the OpenAI API the extension's client already uses, backed by
[`llama-cpp-2`](https://crates.io/crates/llama-cpp-2) (llama.cpp).

## Why this is built on your machine

The extension ships **this source**, not a binary. On first use it runs `cargo build --release` here, which
compiles llama.cpp for your machine; the GGUF weights are downloaded once into the extension's storage. That
is what lets one VSIX serve Linux, Windows and macOS on x64 and arm64, and why the model file — gigabytes —
never has to fit in a package. It also means the sidecar is compiled with the same toolchain that builds
your firmware.

## Requirements

- The Rust toolchain (`cargo`) — you have it, this is an embedded Rust project.
- `cmake` and a C++ compiler (`gcc`/`clang`), because llama.cpp is C++.
- `libclang`, because `llama-cpp-2` generates its bindings with `bindgen`.

The first build takes **minutes** (it compiles ~300 K lines of C++); later builds are incremental. The
extension's `Rusty AI: Status and Hardware Check` command says which of these is missing when a build fails.

## Running it by hand

```sh
cargo build --release
./target/release/rusty-model-host \
    --model /path/to/model.gguf \
    --port 8080 \
    --ctx 4096 \
    --threads 8 \
    --gpu-layers 0 \
    --backend cpu
```

It prints `MODEL_HOST_READY <port>` as soon as the port is bound — **before** the weights are loaded — and
`/health` answers immediately with `{"loading":true}` until they are.

## Endpoints

| Method | Path | Body |
|---|---|---|
| `GET` | `/health` | `{ ok, loaded, loading, model, error, backend, device, context, requested_backend }` |
| `GET` | `/v1/models` | `{ object: "list", data: [ { id, object: "model" } ] }` |
| `POST` | `/v1/chat/completions` | OpenAI chat request → SSE `data:` deltas and a closing `data: [DONE]`, or one JSON body when `stream` is absent/false |

`backend` in `/health` is what the **binary was compiled with** (a cargo feature), never what was asked for
on the command line: llama.cpp keeps a layer budget on the CPU when the GPU backend is not there, and the
status line must not claim otherwise.

One generation runs at a time. A concurrent request gets `429` rather than two answers sharing one KV cache.

## Backends

The native backend is a **cargo feature**, not a runtime flag:

```sh
cargo build --release                 # CPU (OpenMP) — needs nothing beyond cmake and a C++ compiler
cargo build --release --features vulkan
cargo build --release --features cuda
cargo build --release --features metal   # macOS
```

The GPU builds are opt-in on purpose: each needs that platform's SDK at build time (Vulkan SDK / CUDA
toolkit / Xcode).

## Layout

| File | What it owns |
|---|---|
| `src/cli.rs` | the argv contract (mirrored in `src/ai/modelSpecs.ts` `sidecarArgs`) and the compiled-backend answer |
| `src/engine.rs` | the model, the context and one generation — the only place llama.cpp is touched |
| `src/openai.rs` | the request/response wire types |
| `src/api.rs` | the three endpoints, streaming, and the single-flight guard |
| `src/main.rs` | startup order: bind, print ready, serve, load in the background |
