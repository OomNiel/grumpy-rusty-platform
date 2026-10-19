'use strict';

/**
 * A minimal DOM, so the designer's frontend can be run and checked without a browser.
 *
 * The panel is the one part of this feature that no test touched: it is a browser bundle, and it cannot be
 * clicked from a terminal. But its logic is ordinary code -- build a Toolbox from the catalogue, turn a
 * pointer event into hit testing and a drag, rebuild a property panel, post the document back -- and all of
 * that runs perfectly well against a stub with a dozen methods on it.
 *
 * This is deliberately not a DOM implementation. It has what the panel uses and nothing more, and it fails
 * loudly (a method that does not exist is a TypeError) rather than pretending: a stub that swallowed
 * everything would make the test pass for the wrong reason.
 */

/** A 2D context that accepts every drawing call and remembers nothing. */
function context2d() {
    const calls = [];
    const state = {};
    return new Proxy(state, {
        get(target, property) {
            if (property === 'calls') {
                return calls;
            }
            if (property in target) {
                return target[property];
            }
            // Every drawing method: record it and do nothing.
            return (...args) => {
                calls.push({ method: String(property), args });
            };
        },
        set(target, property, value) {
            target[property] = value;
            return true;
        },
    });
}

class ClassList {
    constructor(element) {
        this.element = element;
        this.classes = new Set();
    }
    add(...names) {
        for (const name of names) this.classes.add(name);
    }
    remove(...names) {
        for (const name of names) this.classes.delete(name);
    }
    contains(name) {
        return this.classes.has(name);
    }
    toggle(name, force) {
        const want = force === undefined ? !this.classes.has(name) : force;
        if (want) this.classes.add(name);
        else this.classes.delete(name);
        return want;
    }
    get value() {
        return [...this.classes].join(' ');
    }
}

class Element {
    constructor(tagName) {
        this.tagName = String(tagName).toUpperCase();
        this.children = [];
        this.listeners = new Map();
        this.classList = new ClassList(this);
        this.style = {};
        this.textContent = '';
        this.attributes = {};
        this.value = '';
        this.checked = false;
        this.disabled = false;
        this.draggable = false;
        this.title = '';
        this.rows = 0;
        this.type = '';
        this.width = 0;
        this.height = 0;
        this.id = '';
        this.context = undefined;
    }

    get className() {
        return this.classList.value;
    }

    set className(value) {
        this.classList.classes = new Set(
            String(value)
                .split(/\s+/)
                .filter((name) => name !== ''),
        );
    }

    append(...nodes) {
        for (const node of nodes) {
            this.children.push(node);
        }
    }

    replaceChildren(...nodes) {
        this.children = [...nodes];
    }

    removeChild(node) {
        this.children = this.children.filter((child) => child !== node);
        return node;
    }

    addEventListener(type, handler) {
        const list = this.listeners.get(type) ?? [];
        list.push(handler);
        this.listeners.set(type, list);
    }

    removeEventListener(type, handler) {
        const list = (this.listeners.get(type) ?? []).filter((candidate) => candidate !== handler);
        this.listeners.set(type, list);
    }

    /** Fires the handlers this element registered, which is how a test drives a click or a drag. */
    emit(type, event = {}) {
        for (const handler of this.listeners.get(type) ?? []) {
            handler({ preventDefault() {}, stopPropagation() {}, ...event });
        }
    }

    getBoundingClientRect() {
        return { left: 0, top: 0, right: this.width, bottom: this.height, width: this.width, height: this.height };
    }

    /** Attributes the panel sets for the sake of a screen reader or a test; nothing else reads them. */
    setAttribute(name, value) {
        this.attributes[String(name)] = String(value);
    }

    getAttribute(name) {
        return this.attributes[String(name)] ?? null;
    }

    getContext(kind) {
        if (this.context === undefined) {
            this.context = kind === '2d' ? context2d() : null;
        }
        return this.context;
    }

    setPointerCapture() {}
    releasePointerCapture() {}

    /** Only the one selector the panel uses: a class lookup among direct children. */
    querySelector(selector) {
        const wanted = selector.startsWith('.') ? selector.slice(1) : undefined;
        if (wanted === undefined) {
            return null;
        }
        return this.children.find((child) => child.classList?.contains(wanted)) ?? null;
    }

    /** Everything below this element, for assertions. */
    descendants() {
        return this.children.flatMap((child) => [child, ...(child.descendants?.() ?? [])]);
    }
}

/** The elements the panel looked up by id, and the ones it created: both are searchable afterwards. */
class Document {
    constructor() {
        this.byId = new Map();
        this.title = '';
        this.listeners = new Map();
    }

    createElement(tagName) {
        return new Element(tagName);
    }

    getElementById(id) {
        // The panel's shell is written by the extension; a test provides the same root element.
        return this.byId.get(id) ?? null;
    }

    /** Registers an element as present in the document, as the extension's HTML would. */
    mount(id) {
        const element = new Element('div');
        element.id = id;
        this.byId.set(id, element);
        return element;
    }

    addEventListener(type, handler) {
        const list = this.listeners.get(type) ?? [];
        list.push(handler);
        this.listeners.set(type, list);
    }

    emit(type, event = {}) {
        for (const handler of this.listeners.get(type) ?? []) {
            handler({ preventDefault() {}, ...event });
        }
    }
}

/**
 * Installs the stub on the global object and returns the handles a test needs.
 *
 * Returns the messages the panel posted, so a test can assert on what a drag or a keystroke told the
 * extension -- which is the contract that matters, since the extension is what writes the files.
 */
function install() {
    const document = new Document();
    const root = document.mount('designer');
    const messages = [];
    const windowListeners = new Map();

    const window = {
        addEventListener(type, handler) {
            const list = windowListeners.get(type) ?? [];
            list.push(handler);
            windowListeners.set(type, list);
        },
        removeEventListener(type, handler) {
            const list = (windowListeners.get(type) ?? []).filter((candidate) => candidate !== handler);
            windowListeners.set(type, list);
        },
        setTimeout: global.setTimeout,
        clearTimeout: global.clearTimeout,
        emit(type, event = {}) {
            for (const handler of windowListeners.get(type) ?? []) {
                handler({ preventDefault() {}, ...event });
            }
        },
    };

    global.document = document;
    global.window = window;
    global.acquireVsCodeApi = () => ({
        postMessage(message) {
            messages.push(message);
        },
        getState: () => undefined,
        setState: () => {},
    });

    return { document, root, messages, window };
}

module.exports = { install, Element, Document };
