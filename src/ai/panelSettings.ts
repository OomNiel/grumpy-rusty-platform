/* Which settings a form is allowed to write, and what happens to the ones it may not.
 *
 * WHY THIS EXISTS (reported 2026-10-13). *"This is the endpoint for Agnes … It is not in the hand-off agent
 * list."* The endpoint had been typed into the panel and saved — and the save wrote **nothing**. The panel's
 * `save()` listed the keys it would write **by hand**, five of them, and every field added afterwards
 * (`contextSize`, `maxTokens`, the whole hand-off group, the cloud provider) was silently dropped: the form sent
 * them, the panel refreshed from settings that had never been written, and the field quietly reverted to empty.
 *
 * A hand-maintained list of keys is a list that goes stale, and the failure is invisible in the worst way — the
 * form looks like it worked, and the feature it configures simply never sees the value. So the list is gone: the
 * **manifest** is the authority on which settings exist and what type each one is, and this decides what a form's
 * payload means against it. A key the manifest does not declare is reported, never guessed at and never written.
 *
 * PURE, which is the point: what a payload means is testable without an editor, and the suite drives this with
 * the project's own `package.json` — so a form field that is not a setting fails a test rather than failing
 * quietly in front of a developer.
 */

/** What the manifest declares about one contributed setting. */
export interface SettingSpec {
    /** `string`, `number`, `boolean`, `array` — as contributed. */
    type?: string;
}

/** The settings to write, and the payload's problems. */
export interface WritePlan {
    /** Keys to write, with values that match the declared type. */
    write: Record<string, unknown>;
    /** Keys the manifest does not declare: form/manifest drift, reported rather than written. */
    unknown: string[];
    /** Keys whose value does not match the declared type: refused rather than written. */
    wrongType: string[];
}

/** True when `value` is of the type the manifest declares. An undeclared type accepts anything. */
function matches(value: unknown, type: string | undefined): boolean {
    switch (type) {
        case 'string':
            return typeof value === 'string';
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'array':
            return Array.isArray(value);
        default:
            // The manifest declares nothing (or something this does not know): the value is taken as sent,
            // because inventing a rule here would refuse perfectly good settings.
            return true;
    }
}

/**
 * Turns a form's payload into the writes it is allowed to make.
 *
 * `properties` is the manifest's own `contributes.configuration.properties`, keyed by full setting id. Only
 * settings in the assistant's namespace are considered writable from this panel — a payload cannot rename
 * somebody else's setting, however it was built.
 */
export function planWrites(
    sent: Record<string, unknown>,
    properties: Record<string, SettingSpec>,
    prefix = 'rustyPlatform.assistant.'
): WritePlan {
    const write: Record<string, unknown> = {};
    const unknown: string[] = [];
    const wrongType: string[] = [];
    for (const [key, value] of Object.entries(sent ?? {})) {
        const spec = properties[`${prefix}${key}`];
        if (!spec) {
            unknown.push(key);
            continue;
        }
        if (!matches(value, spec.type)) {
            wrongType.push(key);
            continue;
        }
        write[key] = value;
    }
    return { write, unknown, wrongType };
}

/** One line for the log: what was written, and what was refused. */
export function describeWrites(plan: WritePlan): string {
    const written = Object.keys(plan.write);
    const parts = [`${written.length} setting(s) written${written.length ? `: ${written.join(', ')}` : ''}`];
    if (plan.unknown.length) parts.push(`refused (not a setting): ${plan.unknown.join(', ')}`);
    if (plan.wrongType.length) parts.push(`refused (wrong type): ${plan.wrongType.join(', ')}`);
    return parts.join('; ');
}
