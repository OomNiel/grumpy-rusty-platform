# AI coding assist — How to Use

Rusty Platform can carry its own coding assistant so a generated project can be written with help — with no
Copilot, no cloud key and no account. It is **off by default**: nothing is downloaded or started until you
switch it on.

Two things are worth knowing before the steps:

- **It talks to an OpenAI-compatible endpoint.** The intended target is a server on your own machine
  (LM Studio, Ollama, `llama-server`, or the runtime this extension builds itself). There is no API-key
  setting, so a remote service that needs one will not work.
- **It edits Rust, one function at a time, and never behind your back.** Every change is offered as a diff
  of the whole file; applying it is a normal edit that `Ctrl+Z` undoes.

---

## 1. Turn it on

1. Open the **AI Assist** view in the Rusty Platform sidebar, or run **Rusty AI: Open the Assistant Panel**.
2. In **Model & settings**, set **Backend** to one of:
   - **A server I run** — you already have an OpenAI-compatible server.
   - **The extension's own runtime** — the extension builds and runs its own local runtime.

Save. With **A server I run**, also fill in the **Endpoint** (for example `http://127.0.0.1:1234/v1`).

## 2. Get a model

- **A server you already run:** start LM Studio / Ollama / `llama-server` yourself. If it serves more than
  one model, put the model id in **Model id** — some servers (Ollama) refuse an unnamed request.
- **The extension's own runtime:** run **Rusty AI: Choose a Local Model…**. It downloads the weights
  (~4.4 GB, verified against the published SHA-256) into the extension's storage and builds the sidecar the
  first time — that first build compiles llama.cpp and needs `cargo`, `cmake`, a C++ compiler and
  `libclang`. Pick **CPU** unless you installed a GPU SDK; the GPU builds need Vulkan SDK / CUDA toolkit /
  Xcode at build time.

Not sure it worked? Run **Rusty AI: Status and Hardware Check**. It prints what is configured, what the
server offers, and what the model would run on. The same dialog explains it if this machine is too small for
local inference — and offers *Use it anyway*, which sets `rustyPlatform.assistant.ignoreHostCheck`.

## 3. Ask for a change

### In the function you are looking at

1. Put the caret **inside the function** you want changed (or where a new function should go).
2. Run **Rusty AI: Implement in Function…**. A block appears at the caret:

   ```rust
   // ✎ AI: begin — write what you want below, as many lines as you like
   |
   // ✎ AI: end
   ```

3. Type what you want as ordinary comments — as many lines as you like, in your own words.
4. Press **`Ctrl+Alt+Enter`** (**`Cmd+Alt+Enter`** on macOS), or click **Send to the AI assist** on the code
   lens above the block. To abandon it, press **`Ctrl+Alt+Escape`**, or click **Discard**.

The block is removed either way, so the file is byte-identical to how it was before.

### In the AI Assist view

Type a question or a request in the box at the bottom and press **Ask** (`Ctrl+Enter` also sends). The
assistant answers with the active Rust file, the board's own profile and your `Cargo.toml` crates as
context. Follow-up questions keep the thread.

**If an answer contains Rust code, a button appears under it: "Implement `fn flash_led` in the project…"**
(one per block, labelled by the item it defines). Pressing it writes that code into the Rust file you have
open — replacing the function of the same name where there is one, adding it to the file where there is not,
and replacing the file only when the answer is a whole file (it starts with `#![…]` or has `use` lines beside
`fn main`). Your file's own attributes and signature are kept, so a refactored `main` cannot lose
`#[embassy_executor::main]`. The result opens as a **diff** and nothing is written until you press **Apply**
— the same review step as §4. No Rust file open? It asks which file, or offers to create one.

## 4. Review and apply

The answer opens as a **diff** — your file on the left, the proposed file on the right. Then:

- Click **Apply** to write it (or run **Rusty AI: Apply the Proposed Change**).
- Click **Discard** to throw it away.
- Or edit the proposal in the diff before applying — nothing is written until you say so.

After applying, the extension offers **Check (cargo check)**. Run **Rusty AI: Check the Project (cargo
check)** at any time; the errors land on the lines the compiler meant.

If you would rather skip the review, turn off **Show a diff before applying**
(`rustyPlatform.assistant.showDiff`). The edit is still a normal, undoable edit.

## 5. Fix build errors with it

Run **Rusty AI: Fix the Build…**. It:

1. runs `cargo check` and takes the **first** error,
2. rewrites the function the error points at (the error text is the instruction),
3. rebuilds, keeps the fix if the project got closer to compiling, and **undoes it if it did not**,
4. skips what nothing can fix, tries the next error, and lists what is left.

Alternatively, put the caret on a squiggle and pick **Fix with the AI assist** from the Quick Fix menu.

## 6. Teach it your house rules

Run **Rusty AI: Learn the House Rules from My Code…**. The extension counts this project's own idioms
(indentation, `pub` on helpers, `?` versus `.unwrap()`, `defmt` logging, doc comments, constant and type
naming, `#[cfg(test)]` modules), shows the evidence next to each one (*"41 of 41 functions"*), and keeps the
ones you tick. Accepted rules go into every prompt afterwards. They live in
`rustyPlatform.assistant.conventions`.

---

## Commands

| Command (Command Palette → `Rusty AI:`) | What it does |
|---|---|
| **Open the Assistant Panel** | Focus the AI Assist view |
| **Implement in Function…** | Insert the `✎ AI` block at the caret |
| **Fix the Build…** | `cargo check`, then fix the errors one at a time |
| **Check the Project (cargo check)** | Compile and publish the diagnostics |
| **Learn the House Rules from My Code…** | Measure the project's idioms and keep the ones you choose |
| **Choose a Local Model…** | Pick and set up a model (downloads if needed) |
| **Unload the Loaded Model** | Free the model's memory |
| **Status and Hardware Check** | What is configured, and what this machine can run |

Two commands have no palette entry because they are offered where you need them — **Send the Prompt in the
✎ AI Block** (`Ctrl+Alt+Enter`) and **Discard the ✎ AI Block** (`Ctrl+Alt+Escape`), plus **Apply/Discard the
Proposed Change** on the diff.

## Settings (`rustyPlatform.assistant.*`)

| Setting | Default | What it decides |
|---|---|---|
| `backend` | `off` | `off`, `external` (a server you run) or `bundled` (the extension's own runtime) |
| `endpoint` | `http://127.0.0.1:1234/v1` | The OpenAI-compatible base URL used with `external` |
| `model` | *(empty)* | Model id to ask for; empty lets the server pick |
| `showDiff` | `true` | Review the proposal before it is written |
| `verifyAfterApply` | `true` | Offer a `cargo check` after a proposal is applied |
| `maxTokens` | `4096` | The longest answer. Raise it for thinking models |
| `temperature` | `0.2` | Sampling temperature — low is right for code |
| `timeoutSeconds` | `60` | How long the model may go **without producing anything** before the request is treated as dead |
| `conventions` | `[]` | The house rules you accepted |
| `ignoreHostCheck` | `false` | Run local inference even when the hardware check says this machine is too small |
| `modelPath`, `threads`, `contextSize`, `gpuLayers`, `bundledBackend` | | The bundled runtime's model and how it is started |

## Two things the assistant will not do

- **Change a function's attributes or signature.** `#[embassy_executor::main]`, `#[embassy_executor::task]`,
  the parameters and the return type come from your function, not from the model. Only the body is rewritten
  — which is why a dropped attribute cannot silently break your firmware.
- **Invent hardware.** The prompt carries the board profile (the LED really is on the CYW43 on a Pico W, and
  a Sunton board's panel really is on those SPI pins) and the crates your `Cargo.toml` lists. A pin or a
  crate that is not in there does not exist as far as the model is told.
