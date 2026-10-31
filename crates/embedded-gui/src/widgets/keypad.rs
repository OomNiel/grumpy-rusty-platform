//! A touch keypad: a one-line entry box and a grid of keys beneath it.
//!
//! The widget is the whole keypad, not a set of keys: it owns the line being typed, which of the
//! three modes it is in (letters, digits, symbols), whether Shift is down, and the last line an
//! Enter submitted. That is what makes a mode or a Shift a single `ui_handlers` call away and keeps
//! the design from having to wire twenty buttons together.
//!
//! Two properties were asked for and are built in (2026-10-17):
//!
//! - the keypad fills the bottom of the panel -- a third of it in portrait, half in landscape -- so
//!   the designer pins its box there rather than leaving it to be dragged;
//! - the version it draws follows the *panel*, not the widget's own box: a box that spans the panel
//!   is wide in both orientations, so its own aspect cannot tell the two apart.
//!
//! The keys stretch to fill the width, in five rows whatever the mode, so the same face works at
//! 320x480 and 480x320 without a second layout table.

use embedded_graphics_core::pixelcolor::{Rgb565, RgbColor, WebColors};
use heapless::String;

#[cfg(not(feature = "std"))]
use crate::math::F32Ext as _;
use crate::{
    block::Block,
    font::Font as _,
    font::FontId,
    geometry::Rect,
    render::{Compositor, RenderCtx, TextStyle},
    style::{Border, Style, VisualState, WidgetStyle},
};

/// How long a line the keypad can hold, and how long a line it can pass to a handler.
///
/// The room is the panel's, not the text's: a longer line is refused key by key rather than
/// silently truncated, and the entry box scrolls to its end so what is being typed stays visible.
pub const KEYPAD_CAPACITY: usize = 64;

/// What the keypad is currently typing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeypadMode {
    /// Letters, with Shift choosing the case.
    Text,
    /// Digits and a decimal point.
    Numeric,
    /// Punctuation: `!@#$…` and the rest.
    Symbol,
}

impl KeypadMode {
    /// The mode the mode key moves to.
    ///
    /// Two pages, not three: the letters page carries its own row of digits, so a page of nothing but
    /// digits would be a second way to type the same ten keys. A design that sets `numeric` as its
    /// starting mode still gets that page, and the key takes it back to the letters.
    pub fn next(self) -> Self {
        match self {
            Self::Text => Self::Symbol,
            Self::Symbol | Self::Numeric => Self::Text,
        }
    }

    /// What the mode key says: the mode it moves *to*, so the key is a promise rather than a label.
    pub fn key_label(self) -> &'static str {
        match self {
            // The digits live on this page now, so the key that used to promise them promises the
            // symbols instead (asked for 2026-10-17: "change the text on the '123' key to '%%...'").
            Self::Text => "%%...",
            Self::Numeric => "ABC",
            Self::Symbol => "ABC",
        }
    }
}

/// What a key does when the finger comes off it.
///
/// The widget is the one place that knows, which is what keeps `ui_handlers` out of it: an app that
/// wants a key of its own reads `keypad_text` after a `submitted` event rather than chasing keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeypadKey {
    Char(char),
    /// One space.
    Space,
    /// Removes the character before the cursor.
    Backspace,
    /// Empties the line.
    Clear,
    /// Submits the line: the handler runs and the line is cleared.
    Enter,
    /// Toggles uppercase.
    Shift,
    /// Moves to the next mode.
    Mode,
    /// Moves the cursor one character left, so the next key overwrites *that* character.
    Left,
    /// Moves the cursor one character right.
    Right,
}

impl KeypadKey {
    /// True for the keys that act on the line rather than typing into it.
    fn is_control(self) -> bool {
        !matches!(self, Self::Char(_) | Self::Space)
    }
}

/// One key in a row, and how many columns of that row it takes.
type KeySpec = (KeypadKey, u8);

/// The digit row and the three letter rows, then the control rows -- ten keys wide.
///
/// The digits sit above `qwerty` rather than on a page of their own: a phone keypad's number row, and
/// the reason the mode key no longer offers a digits page (asked for 2026-10-17).
const TEXT_ROWS: &[&[KeySpec]] = &[
    &[
        (KeypadKey::Char('1'), 1),
        (KeypadKey::Char('2'), 1),
        (KeypadKey::Char('3'), 1),
        (KeypadKey::Char('4'), 1),
        (KeypadKey::Char('5'), 1),
        (KeypadKey::Char('6'), 1),
        (KeypadKey::Char('7'), 1),
        (KeypadKey::Char('8'), 1),
        (KeypadKey::Char('9'), 1),
        (KeypadKey::Char('0'), 1),
    ],
    &[
        (KeypadKey::Char('q'), 1),
        (KeypadKey::Char('w'), 1),
        (KeypadKey::Char('e'), 1),
        (KeypadKey::Char('r'), 1),
        (KeypadKey::Char('t'), 1),
        (KeypadKey::Char('y'), 1),
        (KeypadKey::Char('u'), 1),
        (KeypadKey::Char('i'), 1),
        (KeypadKey::Char('o'), 1),
        (KeypadKey::Char('p'), 1),
    ],
    &[
        (KeypadKey::Char('a'), 1),
        (KeypadKey::Char('s'), 1),
        (KeypadKey::Char('d'), 1),
        (KeypadKey::Char('f'), 1),
        (KeypadKey::Char('g'), 1),
        (KeypadKey::Char('h'), 1),
        (KeypadKey::Char('j'), 1),
        (KeypadKey::Char('k'), 1),
        (KeypadKey::Char('l'), 1),
        (KeypadKey::Char(';'), 1),
    ],
    &[
        (KeypadKey::Char('z'), 1),
        (KeypadKey::Char('x'), 1),
        (KeypadKey::Char('c'), 1),
        (KeypadKey::Char('v'), 1),
        (KeypadKey::Char('b'), 1),
        (KeypadKey::Char('n'), 1),
        (KeypadKey::Char('m'), 1),
        (KeypadKey::Char(','), 1),
        (KeypadKey::Char('.'), 1),
        (KeypadKey::Char('/'), 1),
    ],
    // Shift and the mode key are wide enough to hit with a thumb; the space bar takes the middle.
    &[
        (KeypadKey::Shift, 2),
        (KeypadKey::Mode, 2),
        (KeypadKey::Space, 4),
        (KeypadKey::Backspace, 2),
    ],
    &[
        (KeypadKey::Clear, 3),
        (KeypadKey::Left, 1),
        (KeypadKey::Right, 1),
        (KeypadKey::Enter, 5),
    ],
];

/// Digits in a telephone arrangement -- the order a thumb expects on a keypad -- and the controls.
const NUMERIC_ROWS: &[&[KeySpec]] = &[
    &[
        (KeypadKey::Char('1'), 1),
        (KeypadKey::Char('2'), 1),
        (KeypadKey::Char('3'), 1),
    ],
    &[
        (KeypadKey::Char('4'), 1),
        (KeypadKey::Char('5'), 1),
        (KeypadKey::Char('6'), 1),
    ],
    &[
        (KeypadKey::Char('7'), 1),
        (KeypadKey::Char('8'), 1),
        (KeypadKey::Char('9'), 1),
    ],
    &[
        (KeypadKey::Char('.'), 1),
        (KeypadKey::Char('0'), 1),
        (KeypadKey::Backspace, 1),
    ],
    &[
        (KeypadKey::Mode, 1),
        (KeypadKey::Clear, 1),
        (KeypadKey::Left, 1),
        (KeypadKey::Right, 1),
        (KeypadKey::Enter, 1),
    ],
];

/// Punctuation in four rows of eight, then the same control rows the other modes have.
///
/// The set is the one asked for on 2026-10-17: `~!@#$%^&*()-=_+[]\{}|;':",./<>?`. Thirty-one
/// characters, taken in that order and broken at eight, so the page keeps the same six rows as the
/// letters page and switching between them does not resize the keys under the finger.
const SYMBOL_ROWS: &[&[KeySpec]] = &[
    &[
        (KeypadKey::Char('~'), 1),
        (KeypadKey::Char('!'), 1),
        (KeypadKey::Char('@'), 1),
        (KeypadKey::Char('#'), 1),
        (KeypadKey::Char('$'), 1),
        (KeypadKey::Char('%'), 1),
        (KeypadKey::Char('^'), 1),
        (KeypadKey::Char('&'), 1),
    ],
    &[
        (KeypadKey::Char('*'), 1),
        (KeypadKey::Char('('), 1),
        (KeypadKey::Char(')'), 1),
        (KeypadKey::Char('-'), 1),
        (KeypadKey::Char('_'), 1),
        (KeypadKey::Char('='), 1),
        (KeypadKey::Char('+'), 1),
        (KeypadKey::Char('['), 1),
    ],
    &[
        (KeypadKey::Char(']'), 1),
        (KeypadKey::Char('\\'), 1),
        (KeypadKey::Char('{'), 1),
        (KeypadKey::Char('}'), 1),
        (KeypadKey::Char('|'), 1),
        (KeypadKey::Char(';'), 1),
        (KeypadKey::Char('\''), 1),
        (KeypadKey::Char(':'), 1),
    ],
    &[
        (KeypadKey::Char('"'), 1),
        (KeypadKey::Char(','), 1),
        (KeypadKey::Char('.'), 1),
        (KeypadKey::Char('/'), 1),
        (KeypadKey::Char('<'), 1),
        (KeypadKey::Char('>'), 1),
        (KeypadKey::Char('?'), 1),
    ],
    &[
        (KeypadKey::Mode, 2),
        (KeypadKey::Space, 4),
        (KeypadKey::Backspace, 2),
    ],
    &[
        (KeypadKey::Clear, 2),
        (KeypadKey::Left, 1),
        (KeypadKey::Right, 1),
        (KeypadKey::Enter, 4),
    ],
];

/// The most rows any mode has, which is the letters and the symbols: the digits-only page is shorter
/// because its keys are three to a row.
pub const KEYPAD_ROWS: usize = 6;

/// The rows a mode draws, top to bottom.
pub fn keypad_rows(mode: KeypadMode) -> &'static [&'static [KeySpec]] {
    match mode {
        KeypadMode::Text => TEXT_ROWS,
        KeypadMode::Numeric => NUMERIC_ROWS,
        KeypadMode::Symbol => SYMBOL_ROWS,
    }
}

/// How many rows a mode draws.
///
/// Not [`KEYPAD_ROWS`]: a mode's keys are laid out in the rows *it* has, so the digits page keeps its
/// roomy keys rather than being stretched into six rows it has nothing to fill.
pub fn keypad_row_count(mode: KeypadMode) -> usize {
    keypad_rows(mode).len()
}

/// Everything the design decides about a keypad, plus the line it is holding.
///
/// The colours are fields rather than one style colour each because the keypad has six surfaces a
/// design must be able to tell apart: the entry box (face and border), the key faces, the legends on
/// them, the key under a finger, and the keys that act instead of typing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeypadWidget {
    /// Which of the three key sets is showing.
    pub mode: KeypadMode,
    /// Whether letters are typed in upper case.
    pub shift: bool,
    /// The typed line.
    text_buf: [u8; KEYPAD_CAPACITY],
    text_len: u8,
    /// Where the next character is written, as a byte offset into `text_buf` (always on a character
    /// boundary). Typing overwrites the character under it rather than inserting, which is what makes
    /// the two cursor keys worth having: move back, type, and that one character is replaced.
    cursor: u8,
    /// The line the last Enter passed to the handler, which is what `keypad_submitted` reads.
    sent_buf: [u8; KEYPAD_CAPACITY],
    sent_len: u8,
    /// The key a finger is on, as an index into the mode's keys; `-1` for none.
    pub pressed: i16,
    pub text_color: Rgb565,
    pub key_color: Rgb565,
    pub legend_color: Rgb565,
    pub pressed_key_color: Rgb565,
    pub accent_color: Rgb565,
    pub entry_face: Rgb565,
    pub entry_border: Rgb565,
}

impl KeypadWidget {
    /// An empty keypad in text mode, in colours that read on a dark panel.
    pub const fn new() -> Self {
        Self {
            mode: KeypadMode::Text,
            shift: false,
            text_buf: [0; KEYPAD_CAPACITY],
            text_len: 0,
            cursor: 0,
            sent_buf: [0; KEYPAD_CAPACITY],
            sent_len: 0,
            pressed: -1,
            text_color: Rgb565::WHITE,
            key_color: Rgb565::new(6, 12, 16),
            legend_color: Rgb565::WHITE,
            pressed_key_color: Rgb565::new(12, 24, 31),
            accent_color: Rgb565::new(2, 16, 24),
            entry_face: Rgb565::new(1, 2, 4),
            entry_border: Rgb565::CSS_GRAY,
        }
    }

    pub const fn with_mode(mut self, mode: KeypadMode) -> Self {
        self.mode = mode;
        self
    }

    pub const fn with_shift(mut self, shift: bool) -> Self {
        self.shift = shift;
        self
    }

    pub const fn with_text_color(mut self, colour: Rgb565) -> Self {
        self.text_color = colour;
        self
    }

    pub const fn with_key_color(mut self, colour: Rgb565) -> Self {
        self.key_color = colour;
        self
    }

    pub const fn with_legend_color(mut self, colour: Rgb565) -> Self {
        self.legend_color = colour;
        self
    }

    pub const fn with_pressed_key_color(mut self, colour: Rgb565) -> Self {
        self.pressed_key_color = colour;
        self
    }

    pub const fn with_accent_color(mut self, colour: Rgb565) -> Self {
        self.accent_color = colour;
        self
    }

    pub const fn with_entry_face(mut self, colour: Rgb565) -> Self {
        self.entry_face = colour;
        self
    }

    pub const fn with_entry_border(mut self, colour: Rgb565) -> Self {
        self.entry_border = colour;
        self
    }

    /// The line as it stands.
    pub fn text(&self) -> &str {
        core::str::from_utf8(&self.text_buf[..self.text_len as usize]).unwrap_or("")
    }

    /// The line the last Enter submitted -- what the handler is given, since the line itself is
    /// cleared by submitting it.
    pub fn submitted(&self) -> &str {
        core::str::from_utf8(&self.sent_buf[..self.sent_len as usize]).unwrap_or("")
    }

    /// The byte length of the character that starts at `start` in the used part of the line.
    ///
    /// The line is UTF-8, so an overwrite has to know whether the character under the cursor is one,
    /// two, three or four bytes: replacing `é` with `e` shortens the line, and the tail has to move.
    fn char_len(text: &[u8], start: usize) -> usize {
        let lead = text[start];
        let len = match lead {
            byte if byte < 0x80 => 1,
            byte if byte >> 5 == 0b110 => 2,
            byte if byte >> 4 == 0b1110 => 3,
            _ => 4,
        };
        len.min(text.len() - start)
    }

    /// Replaces the line, keeping as much of it as fits. The cursor goes to its end, which is where a
    /// field that was just filled in wants it.
    pub fn set_text(&mut self, text: &str) {
        let mut len = 0usize;
        for ch in text.chars() {
            if len + ch.len_utf8() > KEYPAD_CAPACITY {
                break;
            }
            let mut buf = [0u8; 4];
            let bytes = ch.encode_utf8(&mut buf).as_bytes();
            self.text_buf[len..len + bytes.len()].copy_from_slice(bytes);
            len += bytes.len();
        }
        self.text_len = len as u8;
        self.cursor = len as u8;
    }

    /// Where the next character will be written, as a byte offset into the line.
    pub fn cursor(&self) -> usize {
        self.cursor as usize
    }

    /// Types one character at the cursor, replacing the character that is already there.
    ///
    /// Overflow rather than insertion: the cursor is *on* a character, so a key replaces it and steps
    /// right. With no character under it (the end of the line) this is an append, which is the case
    /// every user meets first. A line that would grow past [`KEYPAD_CAPACITY`] is refused key by key,
    /// exactly as an append at the end always has been.
    pub fn push(&mut self, ch: char) {
        let mut buf = [0u8; 4];
        let bytes = ch.encode_utf8(&mut buf).as_bytes().len();
        let cursor = self.cursor as usize;
        let len = self.text_len as usize;
        let replaced = if cursor < len {
            Self::char_len(&self.text_buf[..len], cursor)
        } else {
            0
        };
        if len - replaced + bytes > KEYPAD_CAPACITY {
            return;
        }
        if bytes != replaced {
            // The tail moves by the difference; `copy_within` handles both directions.
            self.text_buf
                .copy_within(cursor + replaced..len, cursor + bytes);
        }
        self.text_buf[cursor..cursor + bytes].copy_from_slice(&buf[..bytes]);
        self.text_len = (len - replaced + bytes) as u8;
        self.cursor = (cursor + bytes) as u8;
    }

    /// Deletes the character *before* the cursor -- a whole character, not a byte, so a line set from
    /// the app survives a backspace intact. At the start of the line there is nothing to delete.
    pub fn backspace(&mut self) {
        let at = self.cursor as usize;
        if at == 0 {
            return;
        }
        // Walk back over the continuation bytes of the last character, then the lead byte: a
        // two-byte `é` is one item, not half of one.
        let mut start = at - 1;
        while start > 0 && (self.text_buf[start] & 0b1100_0000) == 0b1000_0000 {
            start -= 1;
        }
        let len = self.text_len as usize;
        self.text_buf.copy_within(at..len, start);
        self.text_len = (len - (at - start)) as u8;
        self.cursor = start as u8;
    }

    /// Moves the cursor one character left; a no-op at the start of the line.
    pub fn cursor_left(&mut self) {
        let at = self.cursor as usize;
        if at == 0 {
            return;
        }
        let mut start = at - 1;
        while start > 0 && (self.text_buf[start] & 0b1100_0000) == 0b1000_0000 {
            start -= 1;
        }
        self.cursor = start as u8;
    }

    /// Moves the cursor one character right; a no-op at the end of the line.
    pub fn cursor_right(&mut self) {
        let at = self.cursor as usize;
        let len = self.text_len as usize;
        if at >= len {
            return;
        }
        self.cursor = (at + Self::char_len(&self.text_buf[..len], at)) as u8;
    }

    /// Empties the line, and puts the cursor back at its start.
    pub fn clear(&mut self) {
        self.text_buf = [0; KEYPAD_CAPACITY];
        self.text_len = 0;
        self.cursor = 0;
    }

    /// Hands the line to [`Self::submitted`] and empties it, which is what Enter does.
    pub fn submit(&mut self) {
        self.sent_buf = self.text_buf;
        self.sent_len = self.text_len;
        self.clear();
    }

    /// Moves to the next mode; Shift survives, since a design may want capitals in both.
    pub fn cycle_mode(&mut self) {
        self.mode = self.mode.next();
    }

    /// Toggles upper case. Only letters change, which is what Shift does on a phone keypad.
    pub fn toggle_shift(&mut self) {
        self.shift = !self.shift;
    }

    /// The character a key types, after Shift.
    ///
    /// Shift is a *caps lock*: it stays on until it is pressed again, so every letter typed while it
    /// is on is upper case -- and every letter *key* says so, which is what makes the state visible
    /// without a second indicator.
    ///
    /// `None` for the keys that act rather than type: those are labelled with
    /// [`Self::key_label`], and a one-character stand-in for them would be a lie on the glass.
    ///
    /// The space bar is the one overlap: it types a character, so this returns it, but the
    /// character is a blank on the glass, so the key is also given [`Self::key_label`] "Space" --
    /// the word that is actually drawn by `render`.
    pub fn legend(&self, key: KeypadKey) -> Option<char> {
        match key {
            KeypadKey::Char(c) if self.shift && c.is_ascii_alphabetic() => {
                Some(c.to_ascii_uppercase())
            }
            KeypadKey::Char(c) => Some(c),
            KeypadKey::Space => Some(' '),
            KeypadKey::Backspace
            | KeypadKey::Clear
            | KeypadKey::Enter
            | KeypadKey::Shift
            | KeypadKey::Mode
            | KeypadKey::Left
            | KeypadKey::Right => None,
        }
    }

    /// The word a key shows on its face, when a single character would not read on the glass.
    ///
    /// The keys that act are labelled rather than abbreviated to one letter: `CLR` and `ENT` were
    /// `C` and `E`, which read as letters of the alphabet on a keypad that has them, and the Shift
    /// key said `^`, which says nothing at all (asked for 2026-10-17). Backspace became `BKSP` when the
    /// two cursor keys arrived (2026-10-21): a lone `<` for 'delete backwards' next to `<-` and `->`
    /// would be three arrows meaning two different things.
    ///
    /// Space types a character -- the one [`Self::legend`] returns -- but on the glass it is a
    /// blank, and a one-character stand-in for it would be a blank lie just as much as it is for the
    /// acting keys above, so the bar wears the word "Space" instead (asked for 2026-10-29).
    pub fn key_label(&self, key: KeypadKey) -> Option<&'static str> {
        match key {
            KeypadKey::Clear => Some("CLR"),
            KeypadKey::Enter => Some("ENT"),
            KeypadKey::Shift => Some("SHIFT"),
            KeypadKey::Mode => Some(self.mode.key_label()),
            KeypadKey::Backspace => Some("BKSP"),
            // Two characters, so the cursor keys cannot be mistaken for the symbol page's own `<`
            // and `>`, which type those characters.
            KeypadKey::Left => Some("<-"),
            KeypadKey::Right => Some("->"),
            // It types a space, but a space shown on the glass is nothing to read, so the bar says
            // "Space": a one-character stand-in would be a blank lie.
            KeypadKey::Space => Some("Space"),
            KeypadKey::Char(_) => None,
        }
    }

    /// Whether a key is lit as if it were held down: the Shift key while caps lock is on.
    ///
    /// The face colour is the only room there is for a state on a keypad with no status line, and
    /// the letters say the same thing from the other direction.
    pub fn key_lit(&self, key: KeypadKey) -> bool {
        key == KeypadKey::Shift && self.shift
    }

    /// The entry box: the top `line_height + 5` of the widget, inset by two pixels.
    ///
    /// `font` is the face the keypad is drawn in, which is the style's rather than the widget's:
    /// the line is measured so the box fits it whatever face the design picked.
    pub fn entry_rect(&self, rect: Rect, font: FontId) -> Rect {
        let line = font.line_height();
        let height = (line + 5).min((rect.h / 2).max(1));
        Rect::new(
            rect.x + 2,
            rect.y + 2,
            rect.w.saturating_sub(4),
            height.min(rect.h.saturating_sub(2)),
        )
    }

    /// The area the keys share, below the entry box and one pixel of gap.
    pub fn key_area(&self, rect: Rect, font: FontId) -> Rect {
        let entry = self.entry_rect(rect, font);
        let top = entry.y + entry.h as i32 + 1;
        Rect::new(
            rect.x + 2,
            top,
            rect.w.saturating_sub(4),
            (rect.y + rect.h as i32 - top - 1).max(0) as u32,
        )
    }

    /// The rectangle of every key in the current mode, in reading order.
    ///
    /// Keys stretch to fill the row, so a key's width is its share of the row's weights rather than
    /// a fixed size: ten letter keys and three digit keys both fill the glass.
    pub fn key_rect_at(&self, rect: Rect, index: usize, font: FontId) -> Option<Rect> {
        let area = self.key_area(rect, font);
        let rows = keypad_rows(self.mode);
        let row_h = area.h / rows.len().max(1) as u32;
        let mut seen = 0usize;
        for (row, keys) in rows.iter().enumerate() {
            let weight: u8 = keys.iter().map(|(_, weight)| *weight).sum();
            if weight == 0 {
                continue;
            }
            let mut weight_so_far = 0u8;
            for (key_index, (_, key_weight)) in keys.iter().enumerate() {
                if seen == index {
                    let x = area.x + (area.w as u64 * weight_so_far as u64 / weight as u64) as i32;
                    let next_x = area.x
                        + (area.w as u64 * (weight_so_far + *key_weight) as u64 / weight as u64)
                            as i32;
                    let y = area.y + (row as u32 * row_h) as i32;
                    let height = if row + 1 == rows.len() {
                        // The last row takes the remainder, so the face never leaves an unpainted
                        // strip at the bottom of its own box.
                        (area.y + area.h as i32 - y).max(0) as u32
                    } else {
                        row_h
                    };
                    return Some(Rect::new(x, y, (next_x - x).max(0) as u32, height));
                }
                let _ = key_index;
                weight_so_far += *key_weight;
                seen += 1;
            }
        }
        None
    }

    /// Which key a point lands on, in the current mode.
    pub fn key_index_at(&self, rect: Rect, x: i32, y: i32, font: FontId) -> Option<usize> {
        let rows = keypad_rows(self.mode);
        let total: usize = rows.iter().map(|keys| keys.len()).sum();
        (0..total).find(|index| {
            self.key_rect_at(rect, *index, font)
                .is_some_and(|key| key.contains(x, y))
        })
    }

    /// The key a point lands on, in the current mode.
    pub fn key_at(&self, rect: Rect, x: i32, y: i32, font: FontId) -> Option<(usize, KeypadKey)> {
        let index = self.key_index_at(rect, x, y, font)?;
        let mut seen = 0usize;
        for keys in keypad_rows(self.mode) {
            if index < seen + keys.len() {
                return Some((index, keys[index - seen].0));
            }
            seen += keys.len();
        }
        None
    }

    pub fn render<D, C>(
        &self,
        ctx: &mut RenderCtx<'_, D, C>,
        rect: Rect,
        style: WidgetStyle,
        state: VisualState,
    ) -> Result<(), D::Error>
    where
        D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
        C: Compositor<D>,
    {
        let resolved = style.resolve(state);
        // The widget's own face: a flat panel in the style's colours, so it sits on a design like
        // any other widget rather than punching a hole in it.
        let block = Block::styled(resolved);
        block.render(rect, ctx)?;
        let inner = block.inner(rect);
        if inner.w < 8 || inner.h < 8 {
            return Ok(());
        }

        let font = resolved.font;
        self.draw_entry(ctx, rect, font)?;
        for index in 0..self.key_count() {
            let Some(cell) = self.key_rect_at(rect, index, font) else {
                continue;
            };
            let Some(key) = self.key_for_index(index) else {
                continue;
            };
            let pressed = self.pressed >= 0 && self.pressed as usize == index;
            let lit = pressed || self.key_lit(key);
            let face = if lit {
                self.pressed_key_color
            } else if key.is_control() {
                self.accent_color
            } else {
                self.key_color
            };
            ctx.fill_rect(cell.inset(crate::geometry::EdgeInsets::all(1)), face)?;
            let colour = if key.is_control() && !lit {
                self.text_color
            } else {
                self.legend_color
            };
            // No capital-drawing here any more: the built-in face has its own lower case and its own
            // capitals, so `legend` naming the right letter is all a key needs (see `build.rs`).
            let mut buf = [0u8; 4];
            let text = match self.key_label(key) {
                Some(label) => label,
                None => self.legend(key).unwrap_or(' ').encode_utf8(&mut buf),
            };
            self.draw_legend(ctx, cell, text, colour, font)?;
        }
        Ok(())
    }

    /// The key at a flat index into the current mode's keys.
    pub fn key_for_index(&self, index: usize) -> Option<KeypadKey> {
        let mut seen = 0usize;
        for keys in keypad_rows(self.mode) {
            if index < seen + keys.len() {
                return Some(keys[index - seen].0);
            }
            seen += keys.len();
        }
        None
    }

    /// How many keys the current mode has.
    pub fn key_count(&self) -> usize {
        keypad_rows(self.mode).iter().map(|keys| keys.len()).sum()
    }

    fn draw_legend<D, C>(
        &self,
        ctx: &mut RenderCtx<'_, D, C>,
        cell: Rect,
        text: &str,
        colour: Rgb565,
        font: FontId,
    ) -> Result<(), D::Error>
    where
        D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
        C: Compositor<D>,
    {
        ctx.draw_text_in(
            cell.inset(crate::geometry::EdgeInsets::all(1)),
            text,
            TextStyle::new(colour).with_font(font).centered(),
        )
    }

    /// The typed line, scrolled so the caret stays in view, with the caret drawn under the character
    /// the next key will overwrite.
    fn draw_entry<D, C>(
        &self,
        ctx: &mut RenderCtx<'_, D, C>,
        rect: Rect,
        font: FontId,
    ) -> Result<(), D::Error>
    where
        D: embedded_graphics_core::draw_target::DrawTarget<Color = Rgb565>,
        C: Compositor<D>,
    {
        let entry = self.entry_rect(rect, font);
        if entry.w == 0 || entry.h == 0 {
            return Ok(());
        }
        ctx.fill_rect(entry, self.entry_face)?;
        ctx.stroke_rect(entry, Border::one(self.entry_border))?;
        let advance = font.advance().max(1) as i32;
        let usable = entry.w.saturating_sub(6) as i32;
        let fits = (usable / advance).max(1) as usize;
        let line = self.text();
        // The cursor is a byte offset and the box scrolls by characters, so the two are counted
        // separately. The window follows the caret now rather than the end of the line: moving left
        // in a full line has to bring the character under the cursor back into view.
        let cursor = (self.cursor as usize).min(line.len());
        let cursor_column = line[..cursor].chars().count();
        let skip = (cursor_column + 1).saturating_sub(fits);
        let mut visible: String<KEYPAD_CAPACITY> = String::new();
        for ch in line.chars().skip(skip) {
            let _ = visible.push(ch);
        }
        // The typed line is set in the face the keys are drawn in, not the library default, or the
        // box would hold a full-size line of keys over a line of text half their size.
        //
        // Left-justified, and centred between the box's top and bottom edges (2026-10-17: "The text
        // must be left-justified in the box (just centred between the top and bottom edges)"). A line
        // that grows from the left does not move the letters already typed, which is what a field
        // wants.
        let top = entry.y + (entry.h as i32 - font.line_height() as i32) / 2;
        ctx.draw_text_with_font(entry.x + 3, top, visible.as_str(), self.text_color, font)?;

        // The caret is an underline under the character the next key will overwrite -- and under the
        // empty cell after the last character, where it used to be a drawn `_` glyph. It is painted
        // rather than appended as a glyph so the line's own characters stay where they are: an
        // underscore between two letters would push the tail a cell to the right.
        let column = (cursor_column - skip) as i32;
        let caret_x = entry.x + 3 + column * advance;
        let caret_w = advance.min(entry.x + entry.w as i32 - 3 - caret_x).max(0) as u32;
        let baseline = top + font.line_height() as i32;
        ctx.fill_rect(
            Rect::new(caret_x, baseline - 2, caret_w, 2),
            self.text_color,
        )?;
        Ok(())
    }
}

impl Default for KeypadWidget {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::GuiContext;
    use crate::test_buffer::TestBuffer;

    const RECT: Rect = Rect::new(0, 0, 320, 158);

    fn keypad() -> KeypadWidget {
        KeypadWidget::new()
    }

    #[test]
    fn a_key_lays_out_from_the_row_weights_and_fills_the_width() {
        let pad = keypad();
        let area = pad.key_area(RECT, FontId::Tiny3x5);
        // Ten letters across the full width: every one of them is a tenth, to within the pixel the
        // integer division rounds.
        let first = pad.key_rect_at(RECT, 0, FontId::Tiny3x5).unwrap();
        let last = pad.key_rect_at(RECT, 9, FontId::Tiny3x5).unwrap();
        assert_eq!(first.x, area.x, "the first key starts at the left edge");
        assert_eq!(
            last.x + last.w as i32,
            area.x + area.w as i32,
            "the last ends at the right"
        );
        assert!((first.w as i32 - area.w as i32 / 10).abs() <= 1);
        // The space bar of the control row is wider than the letters, and Enter is wider still.
        // The letters page is the digit row, three letter rows, then Shift, mode, space and
        // backspace: 40 typed keys before the control row starts.
        let space = pad
            .key_rect_at(RECT, 40 + 2, FontId::Tiny3x5)
            .expect("the space bar");
        assert!(space.w > first.w, "space is a wide key, not a letter");
        // Six rows, and the last one ends at the bottom of the key area.
        let last_row_first = pad
            .key_rect_at(RECT, 44, FontId::Tiny3x5)
            .expect("the clear key");
        assert_eq!(
            last_row_first.y + last_row_first.h as i32,
            area.y + area.h as i32
        );
    }

    #[test]
    fn the_modes_differ_in_keys_and_cycle_back_to_text() {
        let mut pad = keypad();
        assert_eq!(pad.mode, KeypadMode::Text);
        assert_eq!(
            pad.key_count(),
            48,
            "ten digits, thirty letters, four controls and the last row of four"
        );
        // The digits are part of the letters page now, above `qwerty` (asked for 2026-10-17).
        assert_eq!(pad.key_for_index(0), Some(KeypadKey::Char('1')));
        assert_eq!(pad.key_for_index(9), Some(KeypadKey::Char('0')));
        assert_eq!(pad.key_for_index(10), Some(KeypadKey::Char('q')));
        // One press, and it is the symbols: a page of nothing but digits would be a second way to
        // type the ten keys this page already has.
        pad.cycle_mode();
        assert_eq!(pad.mode, KeypadMode::Symbol);
        assert_eq!(
            pad.key_count(),
            38,
            "thirty-one symbols and the seven control keys"
        );
        assert_eq!(pad.key_for_index(0), Some(KeypadKey::Char('~')));
        assert_eq!(pad.key_for_index(30), Some(KeypadKey::Char('?')));
        pad.cycle_mode();
        assert_eq!(
            pad.mode,
            KeypadMode::Text,
            "the second press comes back round"
        );
        // A design that starts on the digits page is taken back to the letters, not round a cycle
        // that no longer exists through it.
        let mut digits = keypad();
        digits.mode = KeypadMode::Numeric;
        assert_eq!(
            digits.key_count(),
            17,
            "the digits, the controls and the two cursor keys"
        );
        digits.cycle_mode();
        assert_eq!(digits.mode, KeypadMode::Text);
    }

    /// The symbol page is the set asked for, in the order asked for.
    #[test]
    fn the_symbol_page_types_every_symbol_that_was_asked_for() {
        let asked: [char; 31] = [
            '~', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '-', '_', '=', '+', '[', ']',
            '\\', '{', '}', '|', ';', '\'', ':', '"', ',', '.', '/', '<', '>', '?',
        ];
        let mut pad = keypad();
        pad.mode = KeypadMode::Symbol;
        let typed: heapless::Vec<char, 64> = (0..pad.key_count())
            .filter_map(|index| match pad.key_for_index(index) {
                Some(KeypadKey::Char(ch)) => Some(ch),
                _ => None,
            })
            .collect();
        assert_eq!(
            typed.as_slice(),
            &asked[..],
            "every symbol, in the order given"
        );
    }

    #[test]
    fn a_point_lands_on_the_key_that_is_drawn_there() {
        let pad = keypad();
        for index in 0..pad.key_count() {
            let cell = pad.key_rect_at(RECT, index, FontId::Tiny3x5).unwrap();
            let (found, key) = pad
                .key_at(
                    RECT,
                    cell.x + cell.w as i32 / 2,
                    cell.y + cell.h as i32 / 2,
                    FontId::Tiny3x5,
                )
                .unwrap_or_else(|| panic!("no key at the centre of key {index}"));
            assert_eq!(found, index);
            assert_eq!(key, pad.key_for_index(index).unwrap());
        }
        // The entry box is not a key, and neither is the gap outside the face.
        let entry = pad.entry_rect(RECT, FontId::Tiny3x5);
        assert_eq!(
            pad.key_index_at(RECT, entry.x + 3, entry.y + 3, FontId::Tiny3x5),
            None
        );
    }

    #[test]
    fn shift_capitalises_letters_and_leaves_everything_else_alone() {
        let mut pad = keypad();
        assert_eq!(pad.legend(KeypadKey::Char('a')), Some('a'));
        pad.toggle_shift();
        assert_eq!(pad.legend(KeypadKey::Char('a')), Some('A'));
        assert_eq!(pad.legend(KeypadKey::Char('1')), Some('1'));
        assert_eq!(pad.legend(KeypadKey::Char(',')), Some(','));
        // The keys that act have words, not a character standing in for them.
        assert_eq!(pad.legend(KeypadKey::Clear), None);
    }

    /// Asked for 2026-10-17: "replace 'C' with CLR, 'E' with ENT and shift with SHIFT". A keypad
    /// that types letters cannot label a key `C` and call it Clear.
    #[test]
    fn the_keys_that_act_say_what_they_do() {
        let mut pad = keypad();
        assert_eq!(pad.key_label(KeypadKey::Clear), Some("CLR"));
        assert_eq!(pad.key_label(KeypadKey::Enter), Some("ENT"));
        assert_eq!(pad.key_label(KeypadKey::Shift), Some("SHIFT"));
        // The mode key still says where it goes, and a key that types has no word.
        assert_eq!(pad.key_label(KeypadKey::Mode), Some("%%..."));
        assert_eq!(pad.key_label(KeypadKey::Char('q')), None);
        // Backspace is a word now, not a `<`: the cursor keys beside it are arrows.
        assert_eq!(pad.key_label(KeypadKey::Backspace), Some("BKSP"));
        // Two-character arrows, so neither can be mistaken for the symbol page's own `<` and `>`.
        assert_eq!(pad.key_label(KeypadKey::Left), Some("<-"));
        assert_eq!(pad.key_label(KeypadKey::Right), Some("->"));
        assert_eq!(
            pad.legend(KeypadKey::Left),
            None,
            "a cursor key types nothing"
        );
        pad.cycle_mode();
        assert_eq!(
            pad.key_label(KeypadKey::Mode),
            Some("ABC"),
            "the mode key follows the mode"
        );
    }

    /// The space bar types a space, but a space on the glass is nothing to read, so the bar wears
    /// the word "Space": `legend` still reports the blank it types, and `key_label` supplies the
    /// word `render` draws.
    #[test]
    fn the_space_bar_wears_the_word_space_because_its_character_is_invisible() {
        let pad = keypad();
        // It still types a space, so the handler gets the right character.
        assert_eq!(pad.legend(KeypadKey::Space), Some(' '));
        // ...but what the finger reads on the glass is the word, not a blank glyph.
        assert_eq!(pad.key_label(KeypadKey::Space), Some("Space"));
    }

    /// The space bar is blank no longer: its face carries the word "Space" in the legend colour.
    #[test]
    fn the_space_bar_carries_the_word_space_on_its_face() {
        use crate::context::GuiContext;
        use crate::test_buffer::TestBuffer;

        let mut ctx: GuiContext<16, 8, 8> = GuiContext::new(Rect::new(0, 0, 320, 158));
        let mut pad = keypad();
        pad.legend_color = Rgb565::WHITE;
        ctx.add_keypad_styled(RECT, pad, Style::panel().with_font(FontId::Tiny3x5))
            .unwrap();
        let mut buffer = TestBuffer::new(320, 158);
        ctx.render(&mut buffer).unwrap();

        let space_index = (0..pad.key_count())
            .find(|index| pad.key_for_index(*index) == Some(KeypadKey::Space))
            .expect("the letters page has a space bar");
        let cell = pad.key_rect_at(RECT, space_index, FontId::Tiny3x5).unwrap();
        // The bar's face and borders are dark; the only white ink in its cell is the word.
        let mut ink = 0u32;
        for y in cell.y..(cell.y + cell.h as i32) {
            for x in cell.x..(cell.x + cell.w as i32) {
                if buffer.pixel_at(x, y) == Some(Rgb565::WHITE) {
                    ink += 1;
                }
            }
        }
        assert!(ink > 0, "the space bar shows the word Space, not a blank");
    }

    /// "The shift key must be a toggle key - caps lock": the state outlives the key press and
    /// changes what every letter key says.
    #[test]
    fn caps_lock_stays_on_and_the_letters_say_so() {
        let mut pad = keypad();
        assert!(!pad.key_lit(KeypadKey::Shift), "shift is off to begin with");
        assert_eq!(pad.legend(KeypadKey::Char('q')), Some('q'));
        pad.toggle_shift();
        assert!(pad.shift);
        assert!(
            pad.key_lit(KeypadKey::Shift),
            "and the key is lit while it is on"
        );
        assert!(
            !pad.key_lit(KeypadKey::Char('q')),
            "only the Shift key is lit by caps lock"
        );
        assert_eq!(pad.legend(KeypadKey::Char('q')), Some('Q'));
        // Typing does not consume it: a caps lock is not a sticky shift.
        pad.push(pad.legend(KeypadKey::Char('q')).unwrap());
        pad.push(pad.legend(KeypadKey::Char('w')).unwrap());
        assert_eq!(pad.text(), "QW");
        assert!(pad.shift, "still on after two letters");
        pad.toggle_shift();
        assert!(!pad.key_lit(KeypadKey::Shift));
        assert_eq!(pad.legend(KeypadKey::Char('q')), Some('q'));
    }

    /// The lit Shift key is the only visible sign of caps lock, so it has to be drawn.
    #[test]
    fn a_lit_shift_key_wears_the_pressed_face() {
        use crate::context::GuiContext;
        use crate::test_buffer::TestBuffer;

        let mut ctx: GuiContext<16, 8, 8> = GuiContext::new(Rect::new(0, 0, 320, 158));
        let mut pad = keypad();
        pad.accent_color = Rgb565::BLUE;
        pad.pressed_key_color = Rgb565::RED;
        let id = ctx.add_keypad_styled(RECT, pad, Style::panel()).unwrap();

        let shift_index = (0..pad.key_count())
            .find(|index| pad.key_for_index(*index) == Some(KeypadKey::Shift))
            .expect("the text mode has a Shift key");
        let cell = pad.key_rect_at(RECT, shift_index, FontId::Tiny3x5).unwrap();

        let mut off = TestBuffer::new(320, 158);
        ctx.render(&mut off).unwrap();
        assert_eq!(off.pixel_at(cell.x + 2, cell.y + 2), Some(Rgb565::BLUE));

        ctx.set_keypad_shift(id, true).unwrap();
        let mut on = TestBuffer::new(320, 158);
        ctx.render(&mut on).unwrap();
        assert_eq!(
            on.pixel_at(cell.x + 2, cell.y + 2),
            Some(Rgb565::RED),
            "caps lock lights its own key"
        );
    }

    /// Caps lock has to reach the *glass*, not only the string: the legend of a letter key is
    /// drawn in the other case when Shift is on.
    #[test]
    fn a_letter_key_is_drawn_in_the_case_it_will_type() {
        use crate::context::GuiContext;
        use crate::test_buffer::TestBuffer;

        let mut ctx: GuiContext<16, 8, 8> = GuiContext::new(Rect::new(0, 0, 320, 158));
        let mut pad = keypad();
        pad.legend_color = Rgb565::WHITE;
        let id = ctx.add_keypad_styled(RECT, pad, Style::panel()).unwrap();
        // The first letter key: the digits are above `qwerty` on this page.
        let cell = pad
            .key_rect_at(RECT, 10, FontId::Tiny3x5)
            .expect("the q key");
        // The *places* the glyph covers, not how many pixels it has: `q` and `Q` are both ten
        // pixels of this face, so a count would call two different letters the same drawing.
        let ink = |buffer: &TestBuffer| {
            let mut places = heapless::Vec::<(i32, i32), 64>::new();
            for y in cell.y..(cell.y + cell.h as i32) {
                for x in cell.x..(cell.x + cell.w as i32) {
                    if buffer.pixel_at(x, y) == Some(Rgb565::WHITE) {
                        let _ = places.push((x, y));
                    }
                }
            }
            places
        };

        let mut lower = TestBuffer::new(320, 158);
        ctx.render(&mut lower).unwrap();
        ctx.set_keypad_shift(id, true).unwrap();
        let mut upper = TestBuffer::new(320, 158);
        ctx.render(&mut upper).unwrap();

        assert!(
            !ink(&lower).is_empty(),
            "the key has a legend to begin with"
        );
        assert!(
            !ink(&upper).is_empty(),
            "and an upper-case one is drawn, not nothing"
        );
        assert_ne!(
            ink(&lower),
            ink(&upper),
            "the two cases are two glyphs, so the same key cannot draw both"
        );
    }

    /// "A 'shift' keeps the numericals unchanged": caps lock is for letters, and the digit row above
    /// `qwerty` has to stay as it is -- in the string and on the glass.
    #[test]
    fn caps_lock_leaves_the_digit_row_alone() {
        use crate::context::GuiContext;
        use crate::test_buffer::TestBuffer;

        let mut ctx: GuiContext<16, 8, 8> = GuiContext::new(Rect::new(0, 0, 320, 158));
        let mut pad = keypad();
        pad.legend_color = Rgb565::WHITE;
        let id = ctx.add_keypad_styled(RECT, pad, Style::panel()).unwrap();
        // The *places* the glyph covers, so a digit that drew the same ink somewhere else still
        // reads as a change.
        let ink = |buffer: &TestBuffer, cell: Rect| {
            let mut places = heapless::Vec::<(i32, i32), 128>::new();
            for y in cell.y..(cell.y + cell.h as i32) {
                for x in cell.x..(cell.x + cell.w as i32) {
                    if buffer.pixel_at(x, y) == Some(Rgb565::WHITE) {
                        let _ = places.push((x, y));
                    }
                }
            }
            places
        };

        let mut off = TestBuffer::new(320, 158);
        ctx.render(&mut off).unwrap();
        ctx.set_keypad_shift(id, true).unwrap();
        let mut on = TestBuffer::new(320, 158);
        ctx.render(&mut on).unwrap();

        for index in 0..10 {
            let cell = pad.key_rect_at(RECT, index, FontId::Tiny3x5).unwrap();
            let key = pad.key_for_index(index).unwrap();
            let mut shifted = pad;
            shifted.toggle_shift();
            assert_eq!(
                shifted.legend(key),
                pad.legend(key),
                "digit {index} says the same thing either way"
            );
            assert_eq!(
                ink(&off, cell),
                ink(&on, cell),
                "digit {index} is drawn the same with caps lock on"
            );
        }
        // The letters beside them do change, or this test would pass on a keypad that ignores Shift.
        let letter = pad.key_rect_at(RECT, 10, FontId::Tiny3x5).unwrap();
        assert_ne!(
            ink(&off, letter),
            ink(&on, letter),
            "the q key must follow Shift"
        );
    }

    /// The typed line starts at the box's left edge and is centred between its top and bottom.
    ///
    /// Asked for 2026-10-17: "The text must be left-justified in the box (just centred between the top
    /// and bottom edges)" and "change the cursor to an underscore character". The measurement is the
    /// ink's own box, so a line drawn off-centre or floating in the middle still fails.
    #[test]
    fn the_typed_line_is_left_justified_and_centred_between_the_edges() {
        use crate::context::GuiContext;
        use crate::test_buffer::TestBuffer;

        let mut ctx: GuiContext<16, 8, 8> = GuiContext::new(Rect::new(0, 0, 320, 158));
        let mut pad = keypad();
        pad.text_color = Rgb565::WHITE;
        pad.push('1');
        pad.push('2');
        let entry = pad.entry_rect(RECT, FontId::Scaled6x10);
        ctx.add_keypad_styled(RECT, pad, Style::panel().with_font(FontId::Scaled6x10))
            .unwrap();
        let mut buffer = TestBuffer::new(320, 158);
        ctx.render(&mut buffer).unwrap();

        let mut bounds: Option<(i32, i32, i32, i32)> = None;
        for y in entry.y..(entry.y + entry.h as i32) {
            for x in entry.x..(entry.x + entry.w as i32) {
                if buffer.pixel_at(x, y) == Some(Rgb565::WHITE) {
                    bounds = Some(match bounds {
                        None => (x, y, x, y),
                        Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x), y1.max(y)),
                    });
                }
            }
        }
        let (x0, y0, x1, y1) = bounds.expect("the typed line is drawn in its own box");
        // Left-justified: the first glyph's ink starts three pixels inside the box's left edge...
        assert_eq!(
            x0,
            entry.x + 3,
            "the line starts at the box's left edge, not in the middle"
        );
        // ... and the line reads left to right, so its right end is the caret's, not the box's.
        assert!(
            x1 < entry.x + entry.w as i32 - 6,
            "a two-character line does not fill the box"
        );
        // Centred between the top and bottom edges, compared as whole pixels doubled.
        let ink_y2 = y0 + y1;
        let box_y2 = 2 * entry.y + entry.h as i32 - 1;
        assert!(
            (ink_y2 - box_y2).abs() <= 4,
            "the line is not in the middle of the box vertically: {} against {}",
            ink_y2 as f32 / 2.0,
            box_y2 as f32 / 2.0
        );
    }

    /// The caret is an underscore, not a bar: it sits on the line's own baseline.
    #[test]
    fn the_caret_is_an_underscore_after_the_last_character() {
        use crate::context::GuiContext;
        use crate::test_buffer::TestBuffer;

        let mut ctx: GuiContext<16, 8, 8> = GuiContext::new(Rect::new(0, 0, 320, 158));
        let mut pad = keypad();
        pad.text_color = Rgb565::WHITE;
        let empty = pad.entry_rect(RECT, FontId::Scaled6x10);
        ctx.add_keypad_styled(RECT, pad, Style::panel().with_font(FontId::Scaled6x10))
            .unwrap();
        let mut buffer = TestBuffer::new(320, 158);
        ctx.render(&mut buffer).unwrap();

        // An empty line is the caret alone, on the bottom row of the glyph's box and below the
        // middle of it: a bar would run the whole height instead.
        let (mut top, mut bottom) = (i32::MAX, i32::MIN);
        for y in empty.y..(empty.y + empty.h as i32) {
            for x in empty.x..(empty.x + empty.w as i32) {
                if buffer.pixel_at(x, y) == Some(Rgb565::WHITE) {
                    top = top.min(y);
                    bottom = bottom.max(y);
                }
            }
        }
        assert!(top <= bottom, "the caret is drawn");
        assert!(
            bottom >= empty.y + empty.h as i32 - 6,
            "the underscore sits at the foot of the box, not across it: {top}..{bottom}"
        );
        assert!(
            bottom - top <= 3,
            "an underscore is two rows of an 2x-scaled face, not a vertical bar: {top}..{bottom}"
        );
    }

    #[test]
    fn the_line_types_deletes_and_clears() {
        let mut pad = keypad();
        pad.push('h');
        pad.push('i');
        pad.push('é');
        assert_eq!(pad.text(), "hié");
        pad.backspace();
        assert_eq!(
            pad.text(),
            "hi",
            "a backspace takes the whole character, not a byte"
        );
        pad.clear();
        assert_eq!(pad.text(), "");
    }

    /// Asked for 2026-10-21: "add buttons to steer the cursor (left or right) in the text input box.
    /// The next key touch overwrite the character with the cursor under it."
    #[test]
    fn typing_overwrites_the_character_under_the_cursor_and_keeps_the_tail() {
        let mut pad = keypad();
        for ch in ['a', 'b', 'c'] {
            pad.push(ch);
        }
        assert_eq!(pad.cursor(), 3, "typing leaves the cursor after the line");

        pad.cursor_left();
        assert_eq!(pad.cursor(), 2, "one character back, not one byte");
        pad.push('X');
        assert_eq!(
            pad.text(),
            "abX",
            "the character under the cursor is replaced"
        );
        assert_eq!(pad.cursor(), 3, "and the cursor steps past what it wrote");

        // Mid-line, the tail is untouched: only the character under the cursor changes.
        pad.cursor_left();
        pad.cursor_left();
        pad.push('Y');
        assert_eq!(pad.text(), "aYX");
    }

    #[test]
    fn the_cursor_stops_at_both_ends() {
        let mut pad = keypad();
        pad.cursor_left();
        assert_eq!(pad.cursor(), 0, "an empty line has nowhere to go");
        pad.push('a');
        pad.push('b');
        for _ in 0..10 {
            pad.cursor_left();
        }
        assert_eq!(pad.cursor(), 0, "the start of the line is the last stop");
        for _ in 0..10 {
            pad.cursor_right();
        }
        assert_eq!(pad.text().len(), pad.cursor(), "and so is its end");
        pad.push('c');
        assert_eq!(pad.text(), "abc", "past the end a key appends again");
    }

    #[test]
    fn an_overwrite_keeps_a_multibyte_line_aligned() {
        let mut pad = keypad();
        pad.set_text("aécd");
        assert_eq!(
            pad.cursor(),
            5,
            "set_text leaves the cursor at the end, in bytes"
        );
        pad.cursor_left();
        pad.cursor_left();
        pad.cursor_left();
        assert_eq!(
            pad.cursor(),
            1,
            "one character back is one byte for a, two for é"
        );
        // A one-byte character over a two-byte one: the tail moves left with it.
        pad.push('E');
        assert_eq!(pad.text(), "aEcd");
        assert_eq!(pad.cursor(), 2);
        pad.push('X');
        assert_eq!(pad.text(), "aEXd");
        // And back the other way: a two-byte character over a one-byte one shifts the tail right.
        pad.cursor_left();
        pad.cursor_left();
        assert_eq!(pad.cursor(), 1);
        pad.push('é');
        assert_eq!(pad.text(), "aéXd");
        assert_eq!(pad.cursor(), 3);
        pad.push('!');
        assert_eq!(pad.text(), "aé!d");
    }

    #[test]
    fn backspace_takes_the_character_before_the_cursor() {
        let mut pad = keypad();
        pad.set_text("abc");
        pad.cursor_left();
        pad.backspace();
        assert_eq!(
            pad.text(),
            "ac",
            "the character before the cursor goes, not the last one"
        );
        assert_eq!(pad.cursor(), 1);
        pad.cursor_left();
        pad.backspace();
        assert_eq!(
            pad.text(),
            "ac",
            "at the start of the line there is nothing to take"
        );
        assert_eq!(pad.cursor(), 0);
    }

    #[test]
    fn clear_and_enter_put_the_cursor_back_at_the_start() {
        let mut pad = keypad();
        pad.set_text("42");
        pad.cursor_left();
        pad.clear();
        assert_eq!(pad.cursor(), 0);
        pad.set_text("7");
        pad.submit();
        assert_eq!(pad.submitted(), "7");
        assert_eq!(pad.cursor(), 0, "the next line starts at its left edge");
    }

    /// The caret is painted where the cursor is, not always after the last character.
    #[test]
    fn the_caret_follows_the_cursor() {
        use crate::context::GuiContext;
        use crate::test_buffer::TestBuffer;

        // A line of spaces, so the only ink in the box is the caret itself.
        let caret_x = |pad: KeypadWidget| -> i32 {
            let mut ctx: GuiContext<16, 8, 8> = GuiContext::new(Rect::new(0, 0, 320, 158));
            let entry = pad.entry_rect(RECT, FontId::Scaled6x10);
            ctx.add_keypad_styled(RECT, pad, Style::panel().with_font(FontId::Scaled6x10))
                .unwrap();
            let mut buffer = TestBuffer::new(320, 158);
            ctx.render(&mut buffer).unwrap();
            let mut min = i32::MAX;
            for y in entry.y..entry.y + entry.h as i32 {
                for x in entry.x..entry.x + entry.w as i32 {
                    if buffer.pixel_at(x, y) == Some(Rgb565::WHITE) {
                        min = min.min(x);
                    }
                }
            }
            assert!(min != i32::MAX, "the caret is drawn");
            min
        };

        let mut pad = keypad();
        pad.text_color = Rgb565::WHITE;
        pad.set_text("   ");
        let at_end = caret_x(pad);
        pad.cursor_left();
        pad.cursor_left();
        let two_back = caret_x(pad);
        assert_eq!(
            two_back,
            at_end - 2 * FontId::Scaled6x10.advance() as i32,
            "the caret moved with the cursor, one character cell per press"
        );
    }

    #[test]
    fn enter_hands_the_line_over_and_empties_it() {
        let mut pad = keypad();
        pad.push('4');
        pad.push('2');
        pad.submit();
        assert_eq!(pad.submitted(), "42", "the handler is given what was typed");
        assert_eq!(pad.text(), "", "and the box is ready for the next line");
    }

    #[test]
    fn a_line_longer_than_the_buffer_is_refused_a_key_at_a_time() {
        let mut pad = keypad();
        for _ in 0..KEYPAD_CAPACITY + 10 {
            pad.push('x');
        }
        assert_eq!(pad.text().len(), KEYPAD_CAPACITY);
    }

    #[test]
    fn the_entry_box_is_drawn_above_the_keys_in_the_colours_it_was_given() {
        let mut ctx: GuiContext<16, 8, 8> = GuiContext::new(Rect::new(0, 0, 320, 158));
        let mut pad = keypad();
        pad.text_color = Rgb565::WHITE;
        pad.key_color = Rgb565::BLUE;
        pad.entry_face = Rgb565::GREEN;
        pad.entry_border = Rgb565::RED;
        pad.push('7');
        ctx.add_keypad_styled(RECT, pad, Style::panel()).unwrap();
        let mut buffer = TestBuffer::new(320, 158);
        ctx.render(&mut buffer).unwrap();

        let entry = pad.entry_rect(RECT, FontId::Tiny3x5);
        // The face of the entry box, and the border around it.
        assert_eq!(
            buffer.pixel_at(entry.x + 2, entry.y + 2),
            Some(Rgb565::GREEN)
        );
        assert_eq!(buffer.pixel_at(entry.x, entry.y), Some(Rgb565::RED));
        // A key face below it, and something drawn on every one of them.
        let key = pad.key_rect_at(RECT, 0, FontId::Tiny3x5).unwrap();
        assert_eq!(buffer.pixel_at(key.x + 2, key.y + 2), Some(Rgb565::BLUE));
        assert!(
            buffer.count_color(Rgb565::WHITE) > 0,
            "the legends and the typed line are drawn in the text colour"
        );
    }

    #[test]
    fn the_typed_line_is_set_in_the_face_the_keys_are_drawn_in() {
        let mut ctx: GuiContext<16, 8, 8> = GuiContext::new(Rect::new(0, 0, 320, 158));
        let mut pad = keypad();
        pad.text_color = Rgb565::WHITE;
        pad.push('1');
        // Ink only, inside the entry box: the glyph and the caret, both in the keys' face. A line
        // set in the library default would be a 3x5 glyph, five rows of it at most.
        let entry = pad.entry_rect(RECT, FontId::Scaled6x10);
        ctx.add_keypad_styled(RECT, pad, Style::panel().with_font(FontId::Scaled6x10))
            .unwrap();
        let mut buffer = TestBuffer::new(320, 158);
        ctx.render(&mut buffer).unwrap();

        let mut rows = 0u32;
        for y in entry.y..entry.y + entry.h as i32 {
            let row_has_ink = (entry.x..entry.x + entry.w as i32)
                .any(|x| buffer.pixel_at(x, y) == Some(Rgb565::WHITE));
            if row_has_ink {
                rows += 1;
            }
        }
        assert!(
            rows >= 8,
            "the typed line is as tall as the keys' own capitals, not the default face: {rows} rows"
        );
    }
}


