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

import type { DesignFontPixels } from './bitmapFont';
import type { RasterisedFont } from './fontImport';
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
    /** True when the board has an SD-card socket, which is what makes an SD switch a choice. */
    sdBoard: boolean;
    /**
     * Whether this project is built with the `sd` cargo feature -- i.e. whether the SD card and its FAT
     * filesystem (embedded-sdmmc) are compiled in. The toolbar shows and writes it (see `../designer/editor`).
     */
    sdEnabled: boolean;
    /**
     * Whether the project has an `src/smtp.rs`, i.e. whether the SMTP wizard has been run.
     *
     * The switch is offered disabled until it does: there is no module for the feature to compile in.
     */
    smtpAvailable: boolean;
    /** Whether the project is built with the `smtp` cargo feature -- the keep-alive client is complied in. */
    smtpEnabled: boolean;
    /**
     * True when the chosen panel has a backlight pin wired, which is what makes a Brightness setting possible.
     *
     * Optional like the load fields: the panel tests build `init` messages by hand, and a missing flag has to
     * read as "no backlight" rather than crash the toolbar.
     */
    backlight?: boolean;
    /**
     * Whether this project's `src/main.rs` already drives the backlight by PWM.
     *
     * A project generated before the brightness setting existed holds the pin on with an `Output`, so writing
     * the config line would change nothing on the glass. The control is offered disabled until the firmware
     * can act on it, rather than appearing to work.
     */
    backlightPwm?: boolean;
    /** The brightness the project's `.cargo/esp-config.toml` asks for, 0-100. */
    brightness?: number;
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
    /**
     * The pixels of every BDF font the design declares, by the name the design gives it.
     *
     * The panel cannot read a file, and a font's glyphs are not in the design -- only the path to them. So
     * the extension parses each one (the same conversion the crate does, see `./bitmapFont`) and sends the
     * result, which is what lets the canvas draw a declared font instead of approximating it. Absent when
     * the design declares nothing, or when a font could not be read -- `fontNotes` says which.
     */
    fonts?: Record<string, DesignFontPixels>;
    /** Why a declared font is not among the pixels above, in the panel's own words. */
    fontNotes?: string[];
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
    /**
     * The declared fonts' pixels, sent again when the declarations change.
     *
     * Only on a change: a report follows every edit, and shipping a hundred glyph bitmaps per keystroke
     * would be work done for nothing.
     */
    fonts?: Record<string, DesignFontPixels>;
    /** Why a declared font is not among the pixels above. */
    fontNotes?: string[];
    /**
     * The project's authoritative `sd` feature state after this report.
     *
     * Sent with a switch result so the toolbar follows the *manifest* rather than its own optimistic click:
     * a project generated before the card became a feature has no `[features]` table to edit, and the switch
     * there is refused instead of pretending to have written it.
     */
    sdEnabled?: boolean;
    /** The project's authoritative `smtp` feature state after this report, for the same reason as above. */
    smtpEnabled?: boolean;
    /** Whether `src/smtp.rs` exists -- the switch is enabled by it as soon as the wizard has run. */
    smtpAvailable?: boolean;
    /** The brightness the project's config carries after this report, so the slider follows the file. */
    brightness?: number;
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
    /**
     * What a font field's answer brings with it.
     *
     * A system font asked for from the Font field is drawn into a BDF first, and the declaration has to know
     * both the file that was picked and the size it became -- otherwise the field could not offer to redraw it
     * at another size later.
     */
    font?: { source: string; size: number };
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

/**
 * The panel asking for a backlight brightness.
 *
 * A compile-time setting like the rotation and the touch switch -- the firmware reads it with `option_env!`
 * -- so this writes `.cargo/esp-config.toml` and says that a rebuild is what makes it real. The firmware does
 * the inversion for a panel whose transistor switches on with a LOW level, so the number here is always the
 * brightness a person sees.
 */
export interface DesignerSetBrightness {
    type: 'setBrightness';
    /** 0-100. Clamped, not refused: a slider cannot produce anything else, and a hand-sent value should not
     * lose the setting altogether. */
    percent: number;
}

/**
 * The panel asking the extension to switch the SD card on or off for the project.
 *
 * Like touch it is a *project* setting rather than part of the design -- flipping it changes the firmware, not
 * the markup -- but where touch is a `.cargo/esp-config.toml` key, the card is a cargo `feature`: enabling it
 * is what adds the FAT filesystem (`embedded-sdmmc`) to the build, so the extension edits `Cargo.toml`'s
 * `default = [...]` list and says as much.
 */
export interface DesignerSetSd {
    type: 'setSd';
    enabled: boolean;
}

/**
 * The panel asking the extension to switch the SMTP keep-alive client on or off.
 *
 * It is the `smtp` cargo feature, which gates both `mod smtp;` and its task, so switching it off takes the
 * client out of the build without deleting `src/smtp.rs` -- and the switch can turn it back on later.
 */
export interface DesignerSetSmtp {
    type: 'setSmtp';
    enabled: boolean;
}

/**
 * The extension asking the panel to rasterise a font file.
 *
 * Only the webview can draw a face -- it is the one renderer in this extension -- so adapting a system font
 * is a round trip: the extension picks the file and reads it, the panel draws it at the size asked for, and
 * the extension writes the result out as a BDF the crate already parses.
 */
export interface DesignerRasteriseFont {
    type: 'rasteriseFont';
    requestId: string;
    /** The name to hand `FontFace`; the file's own name is fine, it is never shown. */
    name: string;
    /** The em size to draw at, in pixels. */
    pixelSize: number;
    /** The file itself, base64 -- a TTF is a few hundred kilobytes, and JSON numbers would treble that. */
    bytes: string;
}

/** The panel's answer to {@link DesignerRasteriseFont}. */
export interface DesignerFontRasterised {
    type: 'fontRasterised';
    requestId: string;
    font?: RasterisedFont;
    error?: string;
}

/** The font file is written; declare it in the design. A document edit, so it stays the panel's. */
export interface DesignerDeclareFont {
    type: 'declareFont';
    /** Project-relative path of the file to declare. */
    path: string;
    /** Something to say in the panel, e.g. which face was imported. */
    note?: string;
    /** The face it was drawn from, when it is an imported system font. */
    source?: string;
    /** The pixel size it was drawn at. */
    size?: number;
}

export type DesignerToHost =
    | DesignerChanged
    | DesignerReady
    | DesignerPickAsset
    | DesignerSetTouch
    | DesignerSetSd
    | DesignerSetSmtp
    | DesignerSetBrightness
    | DesignerFontRasterised;
export type HostToDesigner =
    | DesignerInit
    | DesignerReport
    | DesignerAssetPicked
    | DesignerRasteriseFont
    | DesignerDeclareFont;

/**
 * The buttons the panel offers beyond editing.
 *
 * Kind to the host because two of them cannot be done in the webview: revealing the generated markup in the
 * editor, and asking the extension to build the project.
 */
export type DesignerActionId =
    | 'revealKdl'
    | 'revealDocument'
    | 'build'
    | 'revealProject'
    | 'setupSmtp'
    /**
     * Set the module's RTC to this PC's time, over the console.
     *
     * Offered from the clock widget's own pane, because it is the clock the time is for -- and refused
     * when the design holds no clock or no board is on a port (see `../flash/clockSync`). Only the
     * extension can write to a serial port, so the panel asks and does not wait on the answer.
     */
    | 'updateClockTime'
    /**
     * Keep the serial port open and answer the board's own `TIME?` requests.
     *
     * The firmware asks for the time when its RTC has never been set and a host is visible; this is
     * the host's half (see `../flash/clockHost`). It holds the port, so Monitor cannot run beside it,
     * and it is offered from the clock's pane because that is the widget the answer is for.
     */
    | 'serveClockTime';

export type DesignerAction =
    | { type: 'action'; action: DesignerActionId }
    /**
     * A middle-click on a widget that has code behind it.
     *
     * The panel knows which widget was clicked and the extension knows where the handlers are written, so the
     * message carries the id and the extension does the opening.
     */
    | { type: 'action'; action: 'revealHandler'; widgetId: string };

export type DesignerInbound = DesignerToHost | DesignerAction;
