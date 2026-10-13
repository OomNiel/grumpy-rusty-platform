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

### Turning it off, and the server that comes back at login

Turning the switch **off** unloads the models and stops the `llama-server` serving your endpoint. A server this
window did not start is stopped only after a dialog says what it is and what stopping it costs.

If that server is a **systemd user unit** that is enabled, the dialog has a third button: **Disable it so it
doesn't come back**. It stops the server *and* takes the unit out of your login target
(`systemctl --user disable llama-server`), so it no longer starts by itself when you log in — which matters,
because an idle `llama-server` is not free: with `-c 16384` the KV cache alone is pre-allocated at roughly
1.6 GB whether or not anything is being asked of it. The switch still starts the unit on demand when you turn the
assistant on.

Nothing is guessed: the button is offered only for a *user* unit that `systemctl` reports as enabled. A system
unit cannot be disabled without root, and the dialog says so instead.

## 2. Get a model

Three ways, and none of them need you to have installed anything first:

* **Your own llama-server** (the fastest of the three, and the one a developer usually wants). If llama.cpp is
  not on the machine, the extension **offers to download its prebuilt server** for your platform, verifies the
  checksum and installs it into its own storage; if the known **27B** (Qwen3.8-27B Q4_K_M) is not on disk it
  offers to fetch that too. Once both are known, *Rusty AI: Start My llama-server…* starts it and loads the
  weights with nothing to answer.
* **Any model from Hugging Face.** *Rusty AI: Add a Model from Hugging Face…* takes `owner/repo` or a Hub link,
  lists the `.gguf` files with their sizes, quantisation and whether they fit **this** machine, and adds the one
  you pick. Sizes and thread/context/offload defaults are worked out from the hardware in front of you, and a
  model that may not fit is a warning, not a refusal. *Rusty AI: Remove a Model I Added…* takes it off the list.
* **This extension's own runtime**, or LM Studio if you use it — both still there, both unchanged.

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

**On a second monitor.** The same conversation can be an **editor tab**: *Rusty AI: Open the Assistant in an
Editor Tab* (or the **In Editor Tab…** button in the view's footer). Drag that tab out of the VS Code window and
it becomes its own OS window you can put wherever you like; it returns there after a reload. Both surfaces show
one conversation — asking a question in either streams into both.

Type a question or a request in the box at the bottom and press **Ask** (`Ctrl+Enter` also sends). The
assistant answers with the active Rust file, the board's own profile and your `Cargo.toml` crates as
context. Follow-up questions keep the thread.

**If an answer contains Rust code, a button appears under it: "Implement `fn flash_led` in the project…"**
(one per block, labelled by the item it defines). Pressing it writes that code into the Rust file you have
open — replacing the function of the same name where there is one, adding it to the file where there is not,
and replacing the file only when the answer is a whole file (it starts with `#![…]` or has `use` lines beside
`fn main`) — which asks first, in a dialog that names the file, because that shape is exactly how a file
silently loses everything the model did not reproduce. An answer that elides anything (`...`, `// ...`) is
refused outright rather than spliced: what is not in the answer cannot be applied.
Your file's own attributes and signature are kept, so a refactored `main` cannot lose
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
ones you tick. Accepted rules go into **every** prompt afterwards — the local model's and every hand-off's,
which matters most for a hand-off to a cloud agent: it never sees your project, so the rules in the prompt are
the only ones it can be given. They live in `rustyPlatform.assistant.conventions`, and you can add rules by hand
in the same setting (or in the panel's own rules editor) alongside the measured ones. Nothing reads `AGENTS.md`:
if you want a rule followed, it has to be in this setting.

## 7. When the local model cannot do what you asked

**Every request is checked before it is sent.** A small local model has a window, and a prompt that does not
fit in it is not a hard question — it is an impossible one: what the model cannot read it invents, and an
answer produced that way looks exactly like a good one. So the six things below are checked *first*, and when
one of them fires **nothing is sent** and the view says why, with the numbers.

| Check | What it means |
|---|---|
| **The prompt does not fit** | The request is bigger than the space the window leaves for a prompt (the answer gets its share first). Ask for less at once, raise `contextSize`, or lower `maxTokens`. |
| **The file is too big** | The answer would have to be written into a file that does not fit either. A 41 KB `main.rs` is ~10,386 tokens against ~4,032 of prompt room — no wording of the request changes that. |
| **The item is too long** | One function is past the ~120 lines a model this size can rewrite reliably. Ask for a smaller helper beside it. |
| **A whole file was asked for** | "rewrite the whole file", "give me the entire file". An answer of that shape loses every item the model did not reproduce. |
| **The work spans files** | "refactor the whole project", "add a crate", "write me a complete app". |
| **The answer has no room** | The prompt took nearly the whole window, so what is left cannot hold a function. |

The four size checks are arithmetic, so the numbers in the message are the evidence. The two sentence checks
are **heuristics** — they quote what they read (*"read as: refactor the whole project"*) and they can be wrong
in both directions, which is why every refusal offers **Send it anyway** as well as Cancel. In the chat the
refusal appears as its own block in the conversation, so a request that was not sent does not look like a
reply that never came; in the editor's own flows it is a dialog.

### Handing the job to another agent instead

When a request is beyond the local model, the refusal offers a hand-off, and **the button names the agent it
will really use** — nothing here is hard-wired to one of them. The extension scans this machine — CLI agents on
your `PATH`, plus OpenAI-compatible servers answering on the usual local ports — and *Which agent a hand-off
uses* lists what it found, each entry saying what that agent can do. Your own choice wins; *Automatic* takes the
best available, preferring an agent that can work in the project over one that can only answer.

| The agent the extension can drive | What it does |
|---|---|
| **Poolside CLI agent** (`pool`) | Works in your project with Poolside's own model. Needs `pool` on your `PATH`, logged in (`pool login`). |
| **Agnes Code CLI** (`jcode`) | Works in your project the same way — it reads, writes and runs commands. Which provider and model it talks to is jcode's own business; `jcodeProvider` and `jcodeModel` pass its `-p` and `-m` when you want to be explicit. |
| **A cloud OpenAI-compatible API** | *Answers* rather than acts: it has no files, so its result comes back to you as code to review and apply. Set `cloudEndpoint` and `cloudModel`; the API key is stored in **VS Code's secret storage**, never in `settings.json`. |

Anything else the scan finds is listed too, marked as unusable **with the reason** — an agent that is installed
without a verified way to run it unattended says exactly that, rather than being hidden.

What happens when you press the hand-off button:

1. **A consent dialog**, every time, naming the agent and what will be sent: your request as you wrote it, the
   file in focus in full, the facts about the board and the crates, your measured house rules, and the rough
   token count. It also says what the agent will be allowed to do. For the two CLI agents that is *"it will read,
   write and run commands without asking you first"* — true of both, and for the Agnes Code CLI there is no
   auto-allow setting to turn off, so the dialog says so instead of promising a brake that does not exist. For a
   cloud API it says the opposite: *"nothing in your project is touched by the hand-off itself"*.
2. **The agent works in your project** with a scripted prompt that carries the request, why it came to the agent
   instead of the local model, your house rules, and an instruction to *build it and fix what the compiler
   reports* rather than assert success. Every tool call is reported on the progress line as it happens, and
   Cancel stops the run (the whole process group, so nothing is left running behind it).
3. **What it did comes back into the conversation**: the steps it took, its closing paragraph, and the outcome —
   *done*, *it reported it could not finish*, *it failed*, *it timed out*, or *you stopped it*. **The code in
   that answer can be implemented** exactly like a local model's: the button under the answer (or **Review and
   implement…** on the notification, which appears where you are already looking) opens a diff against the file,
   and nothing is written until you apply it. A whole-file answer is confirmed by name first, and an answer that
   left parts of the file out is refused with the reason.

A second hand-off **continues the same conversation** (`poolResume`, on by default), per agent: pool's run ID and
jcode's session ID are remembered separately for this workspace, so switching agents does not continue the wrong
one. jcode's session is matched to *this project* by the directory it recorded, so a conversation about another
folder is never picked up. **Rusty AI: Forget the Handed-off Conversation** starts a fresh one.

Two differences between the agents are worth knowing:

- **The prompt is delivered differently.** `pool` reads it on **stdin** (never as an argument, so your code never
  appears in the process list); `jcode` takes it as its one positional argument, which is its own measured
  contract.
- **`pool exec` has no model flag** (its `-m` is obsolete and points at `--agent-name`), so pool's settings name
  an **agent**, not a model. jcode's `-m` is real, and `jcodeProvider`/`jcodeModel` are passed through.

A cloud hand-off's answer is **not** capped at the local answer budget: no `max_tokens` is sent, so the
provider's own maximum applies. Capping the agent that was handed the job the local model could not fit is the
last thing anyone wants.

---

## Commands

The two that matter outside this document: **Rusty AI: Open the Assistant in an Editor Tab** (see §3) and
**Rusty AI: Add a Model from Hugging Face…** (see §2).

| Command (Command Palette → `Rusty AI:`) | What it does |
|---|---|
| **Open the Assistant Panel** | Focus the AI Assist view |
| **Open the AI Assist Settings** | Focus the view **and expand its settings section** |
| **Implement in Function…** | Insert the `✎ AI` block at the caret |
| **Fix the Build…** | `cargo check`, then fix the errors one at a time |
| **Check the Project (cargo check)** | Compile and publish the diagnostics |
| **Learn the House Rules from My Code…** | Measure the project's idioms and keep the ones you choose |
| **Choose a Local Model…** | Pick and set up a model (downloads if needed) |
| **Unload the Loaded Model** | Free the model's memory |
| **Status and Hardware Check** | What is configured, and what this machine can run |
| **Forget the Handed-off Conversation** | The next hand-off starts a fresh conversation instead of continuing the last one |
| **Choose the Hand-off Agent…** | Scan this machine again and pick from the full list, with the reason next to anything that cannot be used |
| **Set the Hand-off API Key…** | Store the cloud API key (asks for the endpoint and model, then stores the key in secret storage and reads it back to be sure) |

Two commands have no palette entry because they are offered where you need them — **Send the Prompt in the
✎ AI Block** (`Ctrl+Alt+Enter`) and **Discard the ✎ AI Block** (`Ctrl+Alt+Escape`), plus **Apply/Discard the
Proposed Change** on the diff.

## Settings (`rustyPlatform.assistant.*`)

Beyond the model and endpoint, these decide the *engine*: `llamaServerPath` (your `llama-server` binary, empty
= find it), `llamaServerModelPath` (the `.gguf` **your** server runs — kept apart from `modelPath`, which is the
built-in runtime's), `llamaServerArgs`, `llamaServerService` and `llamaServerStartTarget` (systemd unit on Linux
by default, a child process elsewhere), plus `gpuVramGb` for a card the extension cannot detect and
`loadContextLength` / `loadGpu` / `loadTtlSeconds` for what **Load Model** asks for.

| Setting | Default | What it decides |
|---|---|---|
| `backend` | `off` | `off`, `external` (a server you run) or `bundled` (the extension's own runtime) |
| `endpoint` | `http://127.0.0.1:1234/v1` | The OpenAI-compatible base URL used with `external` |
| `model` | *(empty)* | Model id to ask for; empty lets the server pick |
| `showDiff` | `true` | Review the proposal before it is written |
| `verifyAfterApply` | `true` | Offer a `cargo check` after a proposal is applied |
| `maxTokens` | `4096` | The longest answer, for the **local** model. A hand-off is not capped by it: a cloud agent is sent no `max_tokens` at all, so its own maximum applies |
| `temperature` | `0.2` | Sampling temperature — low is right for code |
| `timeoutSeconds` | `60` | How long the model may go **without producing anything** before the request is treated as dead |
| `conventions` | `[]` | The house rules you accepted |
| `ignoreHostCheck` | `false` | Run local inference even when the hardware check says this machine is too small |
| `handoff` | `pool` | Whether a request the local model cannot take may be handed off at all: `off` warns and stops. The stored value is `pool` for "hand it to an agent" — the *agent* is chosen by `handoffAgent`, not here |
| `handoffAgent` | *(empty)* | Which agent a hand-off uses, by id (`cli:pool`, `cli:jcode`, `openai:1234`, …). Empty means the best available one, preferring an agent that can work in the project |
| `poolCommand` | `pool` | The Poolside CLI executable — a name on the PATH or a full path |
| `poolAgent` | *(empty)* | Which Poolside agent to ask for (`-a`); empty uses pool's own default |
| `poolAutoAllow` | `true` | Let the Poolside agent use its tools **without asking you first**. A non-interactive run cannot answer an approval prompt, so with this off a hand-off that needs to edit a file stops and does nothing |
| `poolTimeoutSeconds` | `900` | How long a handed-off run may take. Whatever it changed up to then stays on disk, and continuing picks up from there |
| `poolResume` | `true` | Continue the last handed-off conversation (`pool --continue`, `jcode --resume`) instead of starting a fresh one. Each agent's own conversation is remembered separately |
| `jcodeCommand` | `jcode` | The Agnes Code CLI executable |
| `jcodeProvider` | *(empty)* | Passed to `jcode run` as `-p`; empty lets jcode's own configuration decide (`openai-compatible` is how the Agnes endpoint is reached) |
| `jcodeModel` | *(empty)* | Passed to `jcode run` as `-m`; empty lets jcode's own configuration decide (e.g. `agnes-2.5-flash`) |
| `cloudEndpoint`, `cloudModel` | *(empty)* | An OpenAI-compatible cloud API offered as a hand-off provider, and the model to ask it for. Its key is **not** here — it lives in VS Code's secret storage |
| `modelPath`, `threads`, `contextSize`, `gpuLayers`, `bundledBackend` | | The bundled runtime's model and how it is started |

## What leaves your machine

Worth being plain about, because "a local model" is a promise and a hand-off is not:

- **The local model never sends anything anywhere.** The bundled runtime runs on this machine, and a server you
  point `endpoint` at is one you chose.
- **A hand-off does send your code away.** For the Poolside CLI that is Poolside's service (the API in *your*
  `pool` configuration — `inference.poolside.ai` by default). For the Agnes Code CLI it is whatever provider and
  model that CLI is configured for — run `jcode provider current` to see which, because it is jcode's
  configuration that decides, not this extension. For a cloud API it is the endpoint you typed in. In every
  case it happens only when you press the hand-off button and confirm the dialog that names what is being sent,
  and there is no setting that makes it happen silently. If you would rather it never be offered, set `handoff`
  to `off`: the scope checks still run and still warn, and the warning is then the end of it.
- **The two CLI agents change files in your project, and they do not ask first.** That is what makes them
  useful here — they can build what they change — and it is disclosed on every single hand-off.

## Two things the assistant will not do

- **Change a function's attributes or signature.** `#[embassy_executor::main]`, `#[embassy_executor::task]`,
  the parameters and the return type come from your function, not from the model. Only the body is rewritten
  — which is why a dropped attribute cannot silently break your firmware.
- **Invent hardware.** The prompt carries the board profile (the LED really is on the CYW43 on a Pico W, and
  a Sunton board's panel really is on those SPI pins) and the crates your `Cargo.toml` lists. A pin or a
  crate that is not in there does not exist as far as the model is told.
