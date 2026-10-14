/**
 * The conversation between the designer's panel and the extension.
 *
 * A webview is a separate JavaScript context with no shared memory, so every edit crosses this channel as a
 * message. The shapes are defined once, here, and both sides import them -- which is the only way the two
 * cannot drift into a disagreement that shows up as a silently ignored edit.
 *
 * The division of labour: the *panel* owns the editing state, because dragging must be immediate and undo
 * belongs next to the thing being undone. The *extension* owns the disk, because that is where a webview
 * cannot reach: it validates, writes the document, regenerates the markup, and reports problems back.
 */

import type { DesignerDocument } from './model';

/** Everything the panel needs to draw itself, sent once when it is ready and again on every change. */
export interface DesignerInit {
    type: 'init';
    document: DesignerDocument;
    /** The designed area after the rotation, which is the canvas the panel draws. */
    canvas: { width: number; height: number };
    /** Where the document and the markup are written, shown in the panel's footer. */
    paths: { document: string; kdl: string };
    /** True when the board has a touch controller at all, which is what makes touch a choice. */
    touchBoard: boolean;
    /** True when this project is built with touch enabled -- the setting the toolbar shows and writes. */
    touchEnabled: boolean;
    /** The document as it was read, when it could not be parsed -- shown instead of a blank canvas. */
    loadError?: string;
    /**
     * What the load had to change to make an older design current -- a property this version has no place for,
     * dropped by `dropUnknownProps`.
     *
     * Shown where the file paths are shown, because the load that had to tidy something up is also the load
     * that may have unblocked the markup: until then the board was compiling an older design than the canvas.
     */
    loadNotes?: string[];
    /**
     * Everything wrong with the design as it was opened.
     *
     * Sent at once rather than left for the first edit to reveal: a design that does not validate is a design
     * whose markup is *not* written, so the board is compiling an older design than the one on screen, and the
     * user has no reason to touch the canvas to find that out. Absent, like `loadError`, when there is nothing
     * to say.
     */
    loadProblems?: string[];
}

/** The panel's answer to every edit: it sends the whole document back rather than a diff. */
export interface DesignerChanged {
    type: 'changed';
    document: DesignerDocument;
}

/** The extension's verdict on a document, after validating it and writing it out. */
export interface DesignerReport {
    type: 'report';
    /** Problems that stop the markup from being written, in the validator's own words. */
    problems: string[];
    /** The markup, when there is one, for the panel's preview. */
    kdl?: string;
    /** Set when the document was written but the markup was not, e.g. it does not build. */
    wroteDocument?: boolean;
    /** Something the panel should say that is not a problem, e.g. that a setting changed. */
    note?: string;
}

/** The panel has finished loading and is ready for its document. */
export interface DesignerReady {
    type: 'ready';
}

/**
 * Which kind of asset is being chosen, which is only about the file dialog's filter.
 *
 * `icon` is an image too, but a separate name because an icon composes several of them and the wording differs.
 */
export type DesignerAssetKind = 'font' | 'image' | 'mesh' | 'icon';

/**
 * The panel asking the extension to choose a file.
 *
 * The extension does the choosing -- only it can open a native dialog and only it knows the project folder --
 * and the panel does the *editing*, when the answer comes back. That keeps the document and its undo history in
 * one place, which is the arrangement the whole channel is built on.
 */
export interface DesignerPickAsset {
    type: 'pickAsset';
    /** Matches the answer to the request, since a dialog can take as long as the user takes. */
    requestId: string;
    kind: DesignerAssetKind;
}

/** The extension's answer: a project-relative path, a cancellation, or why it failed. */
export interface DesignerAssetPicked {
    type: 'assetPicked';
    requestId: string;
    path?: string;
    error?: string;
}

/**
 * The panel asking for touch to be switched on or off.
 *
 * It is a *project* setting rather than part of the design -- flipping it changes the firmware, not the markup --
 * so the panel asks and the extension writes `.cargo/esp-config.toml`, exactly as the rotation control does.
 */
export interface DesignerSetTouch {
    type: 'setTouch';
    enabled: boolean;
}

export type DesignerToHost = DesignerChanged | DesignerReady | DesignerPickAsset | DesignerSetTouch;
export type HostToDesigner = DesignerInit | DesignerReport | DesignerAssetPicked;

/**
 * The buttons the panel offers beyond editing.
 *
 * Kind to the host because two of them cannot be done in the webview: revealing the generated markup in the
 * editor, and asking the extension to build the project.
 */
export type DesignerAction =
    | { type: 'action'; action: 'revealKdl' | 'revealDocument' | 'build' | 'revealProject' }
    /**
     * A middle-click on a widget that has code behind it.
     *
     * The panel knows which widget was clicked and the extension knows where the handlers are written, so the
     * message carries the id and the extension does the opening.
     */
    | { type: 'action'; action: 'revealHandler'; widgetId: string };

export type DesignerInbound = DesignerToHost | DesignerAction;
