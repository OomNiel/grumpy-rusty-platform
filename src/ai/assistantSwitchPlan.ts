/**
 * What the AI Assistant's switch means, as data.
 *
 * The switch itself is one boolean; what makes it more than a setting is that each position changes the state
 * of *other people's processes* — a `llama-server` this window started, one the user runs as a systemd unit,
 * models LM Studio is holding. So the decision "what does turning this off stop?" is written down here as a
 * list of steps that can be computed, described and asserted without a machine, a server or a dialog. The
 * doing is in `assistantSwitch.ts`; this file has no `vscode` import at all, which is also what lets the test
 * suite pin it.
 *
 * The consent rule (asked 2026-10-09): **a server this window did not start is stopped only after the user
 * says so — once per window.** That is why a step carries `needsConsent`: the caller checks it, asks about
 * that one thing (naming it, and what stopping it costs), and remembers the answer for the rest of the
 * window, whichever way it went. Without the memory, every reload would ask again; with it, a "leave it"
 * would be silently ignored the next time.
 */

/** What is answering the configured endpoint, in the shape this file needs (see `llamaService.ServerOwner`). */
export type EndpointOwner =
    | { kind: 'ours'; pid?: number; model?: string }
    | { kind: 'unit'; unit: string; scope: 'user' | 'system'; pid?: number; enabled?: boolean }
    | { kind: 'process'; pid?: number; command?: string }
    | { kind: 'unknown'; why: string }
    | { kind: 'none' };

/** Everything the off-decision depends on, gathered by the caller. */
export interface OffFacts {
    /** Models a local runtime is holding right now (`lms ps` / the LM Studio API). */
    loadedModelIds: readonly string[];
    /** True when this window has a `llama-server` child process of its own. */
    ownServer: boolean;
    /** Whatever answers the configured endpoint. */
    owner: EndpointOwner;
}

/** One thing turning the assistant off has to do. */
export type OffStep =
    | { kind: 'unloadModels'; modelIds: readonly string[] }
    | { kind: 'stopOwn' }
    | {
          kind: 'stopForeign';
          /** Stable across a window, so consent is remembered per server rather than per attempt. */
          key: string;
          /** The owner, for a dialog and for the report. */
          owner: EndpointOwner;
          /** True when the user has not decided about this server yet in this window. */
          needsConsent: boolean;
      }
    /** Something is answering but nothing here can stop it honestly; the report says where to stop it. */
    | { kind: 'cannotStop'; reason: string };

/**
 * A stable name for a server this window might stop, used to remember consent.
 *
 * `none` has no key — there is nothing to consent to — and `ours` does not either: this window started it, so
 * stopping it is not a question anyone else can answer. A foreign process is keyed by its pid, which is
 * enough for a window's lifetime and cannot collide with a unit of the same name.
 */
export function ownerKey(owner: EndpointOwner): string | undefined {
    switch (owner.kind) {
        case 'unit':
            return `unit:${owner.scope}:${owner.unit}`;
        case 'process':
            return `process:${owner.pid ?? 'unknown'}`;
        default:
            return undefined;
    }
}

/**
 * The steps turning the assistant off should take, in the order that frees memory first.
 *
 * `decided` is what the user has already said about a foreign server in this window: `true` = stop it without
 * asking, `false` = leave it alone without asking again, absent = ask. Unloading models and stopping this
 * window's own server are never questions.
 */
export function offPlan(facts: OffFacts, decided: ReadonlyMap<string, boolean> = new Map()): OffStep[] {
    const steps: OffStep[] = [];
    if (facts.loadedModelIds.length > 0) {
        steps.push({ kind: 'unloadModels', modelIds: facts.loadedModelIds });
    }
    if (facts.ownServer) {
        steps.push({ kind: 'stopOwn' });
    }

    const owner = facts.owner;
    if (owner.kind === 'unit' || owner.kind === 'process') {
        // Our own server is `ours`, so this branch is only ever somebody else's. A system unit needs root:
        // asking here would end in a refusal, and the honest step is to say so without pretending.
        if (owner.kind === 'unit' && owner.scope === 'system') {
            steps.push({
                kind: 'cannotStop',
                reason: `${owner.unit} is a system unit, which needs root: stop it with "sudo systemctl stop ${owner.unit}"`,
            });
            return steps;
        }
        const key = ownerKey(owner) ?? `${owner.kind}:unknown`;
        const answer = decided.get(key);
        if (answer === false) {
            return steps; // "Leave it running" — and do not ask again in this window.
        }
        steps.push({ kind: 'stopForeign', key, owner, needsConsent: answer === undefined });
        return steps;
    }
    if (owner.kind === 'unknown') {
        steps.push({ kind: 'cannotStop', reason: owner.why });
    }
    return steps;
}

/** True when the plan has nothing left to do but report. */
export function isNoopPlan(steps: readonly OffStep[]): boolean {
    return steps.length === 0;
}

/** One line naming what a step does, for the progress line and the panel's message. */
export function describeOffStep(step: OffStep): string {
    switch (step.kind) {
        case 'unloadModels':
            return `unloading ${step.modelIds.length === 1 ? step.modelIds[0] : `${step.modelIds.length} models`}`;
        case 'stopOwn':
            return 'stopping the server this window started';
        case 'stopForeign': {
            if (step.owner.kind === 'unit') {
                return `stopping ${step.owner.unit}`;
            }
            if (step.owner.kind === 'process') {
                return `stopping the process holding the port${step.owner.pid ? ` (pid ${step.owner.pid})` : ''}`;
            }
            return 'stopping the server answering the endpoint';
        }
        case 'cannotStop':
            return step.reason;
        default:
            return '';
    }
}

/**
 * Whether a window that starts with the switch off should enforce that — unload the models and stop the
 * server — rather than merely refusing to start one.
 *
 * The user's choice, and the default is to enforce: the switch says the assistant is off, and leaving a
 * seventeen-gigabyte server running is not what "off" means. It is a setting because the alternative reading
 * is legitimate too — someone who starts their own `llama-server` for other work does not want an editor to
 * stop it at every launch — and the panel puts that setting next to the switch.
 */
export function startupShouldStop(cfg: { enabled: boolean; stopServersAtStartup: boolean }): boolean {
    return cfg.enabled === false && cfg.stopServersAtStartup === true;
}
