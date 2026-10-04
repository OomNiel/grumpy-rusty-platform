/* Chats that outlive the window.
 *
 * WHY THIS EXISTS. The AI Assist transcript lived in a module-level array, so reloading the window — or
 * simply reopening the view — threw the conversation away and the developer started again from nothing
 * (asked 2026-10-04: *"make the chat engine remember chats … so the user can continue where he left off"*).
 *
 * WHAT A CHAT IS BOUND TO. The workspace folder, not the machine: a conversation is about the project it
 * was had in, so the picker shows the chats of the folder you are in and nothing else. A chat with no
 * workspace (an empty window) is its own group, and `chatsFor` treats "no workspace" as an exact value
 * rather than a wildcard, so those never leak into a project's list.
 *
 * NOTHING HERE TOUCHES THE DISK OR VS CODE. These are the data decisions — what a title is, what survives
 * parsing, what gets pruned and in what order — so the suite pins them with strings and numbers. The view
 * does the reading and writing (`aiChatView.ts`), because that is the part that needs an editor.
 */

/** One turn, exactly as the webview renders it. */
export interface ChatTurn {
    role: 'user' | 'assistant';
    text: string;
}

export interface StoredChat {
    id: string;
    /** One line from the first thing the user asked — what a picker shows. */
    title: string;
    /** The workspace folder this chat belongs to, when there was one. */
    workspace?: string;
    updatedAt: number;
    turns: ChatTurn[];
}

/** The whole file. `version` is written so a future shape can migrate instead of guessing. */
export interface ChatStoreFile {
    version: 1;
    chats: StoredChat[];
}

/** The most conversations kept, newest first. Beyond this the oldest are dropped, not archived. */
export const MAX_CHATS = 50;

/** The most turns kept in one conversation — about 200 exchanges is far more than anyone scrolls back. */
export const MAX_TURNS = 200;

/** A title longer than this is cut; the picker is one line wide. */
const MAX_TITLE = 60;

export function emptyStore(): ChatStoreFile {
    return { version: 1, chats: [] };
}

/**
 * Whatever the file holds → a store this code can use.
 *
 * Deliberately forgiving: a truncated write (a crash mid-save), a hand-edited file, or a future version's
 * extra fields must not take the AI panel down with them, so anything unrecognisable is dropped rather than
 * thrown over. A chat with no id cannot be addressed and goes; a turn with an unknown role goes; the rest is
 * kept.
 */
export function parseStore(raw: string | undefined): ChatStoreFile {
    const text = String(raw ?? '').trim();
    if (!text) return emptyStore();
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return emptyStore();
    }
    const chats = (parsed as { chats?: unknown } | undefined)?.chats;
    if (!Array.isArray(chats)) return emptyStore();
    const kept: StoredChat[] = [];
    for (const entry of chats) {
        const chat = normaliseChat(entry);
        if (chat) kept.push(chat);
    }
    return prune({ version: 1, chats: kept });
}

function normaliseChat(entry: unknown): StoredChat | undefined {
    if (!entry || typeof entry !== 'object') return undefined;
    const candidate = entry as {
        id?: unknown;
        title?: unknown;
        workspace?: unknown;
        updatedAt?: unknown;
        turns?: unknown;
    };
    if (typeof candidate.id !== 'string' || !candidate.id) return undefined;
    const turns: ChatTurn[] = [];
    if (Array.isArray(candidate.turns)) {
        for (const raw of candidate.turns) {
            const turn = raw as { role?: unknown; text?: unknown };
            if ((turn?.role === 'user' || turn?.role === 'assistant') && typeof turn.text === 'string') {
                turns.push({ role: turn.role, text: turn.text });
            }
        }
    }
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
    return {
        id: candidate.id,
        title: title && title !== 'New chat' ? title.slice(0, MAX_TITLE) : titleFor(turns),
        workspace: typeof candidate.workspace === 'string' && candidate.workspace ? candidate.workspace : undefined,
        updatedAt:
            typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
                ? candidate.updatedAt
                : 0,
        turns: turns.slice(-MAX_TURNS)
    };
}

/**
 * What the picker calls a chat: the first question, first line, cut to fit.
 *
 * The question is the right title because it is the only part of a conversation that says what it was about,
 * and the first one is the one that was worth asking. Before it, the chat is honestly called "New chat".
 */
export function titleFor(turns: readonly ChatTurn[]): string {
    const first = turns.find((turn) => turn.role === 'user' && turn.text.trim());
    if (!first) return 'New chat';
    const line = first.text
        .split(/\r?\n/)
        .map((part) => part.trim())
        .find((part) => part.length > 0);
    if (!line) return 'New chat';
    return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1)}…` : line;
}

/** A fresh, empty chat. The id is chosen by the caller (the view needs the clock, this module does not). */
export function newChat(id: string, workspace: string | undefined, now: number): StoredChat {
    return { id, title: 'New chat', workspace, updatedAt: now, turns: [] };
}

/** Adds or replaces a chat, newest first, with its title kept in step with its turns and the file bounded. */
export function upsertChat(store: ChatStoreFile, chat: StoredChat): ChatStoreFile {
    const title = chat.title && chat.title !== 'New chat' ? chat.title : titleFor(chat.turns);
    const bounded: StoredChat = { ...chat, title, turns: chat.turns.slice(-MAX_TURNS) };
    return prune({ version: 1, chats: [bounded, ...store.chats.filter((c) => c.id !== bounded.id)] });
}

/**
 * The chats for one workspace, newest first.
 *
 * `undefined` means "no workspace folder" and is compared as an exact value: an empty window's chats and a
 * project's chats are different lists, and a chat made in a project must not appear in another one.
 */
export function chatsFor(store: ChatStoreFile, workspace: string | undefined): StoredChat[] {
    return store.chats
        .filter((chat) => (chat.workspace ?? undefined) === (workspace ?? undefined))
        .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function removeChat(store: ChatStoreFile, id: string): ChatStoreFile {
    return { version: 1, chats: store.chats.filter((chat) => chat.id !== id) };
}

/** Keeps the newest `MAX_CHATS`, each with at most `MAX_TURNS`. */
export function prune(store: ChatStoreFile): ChatStoreFile {
    const newest = [...store.chats]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_CHATS)
        .map((chat) => ({ ...chat, turns: chat.turns.slice(-MAX_TURNS) }));
    return { version: 1, chats: newest };
}
