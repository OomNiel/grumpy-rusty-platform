//! Prints the crate's own glyph tables, for the designer canvas to draw text with.
//!
//! The canvas has to show what the board shows, and the board draws text with embedded-gui's bitmap fonts. A
//! browser font of a similar size is *nearly* right, which is exactly the kind of nearly that makes a WYSIWYG
//! canvas untrustworthy -- so the glyphs are read out of the crate itself, through the public `glyph_rows`, and
//! committed as a table the webview uses. `tests/tools/glyph-table.js` runs this and writes the table.
//!
//! Output format, one font per section, plain text so the tool does not need a JSON library:
//!
//!     font <name> advance=<n> line_height=<n>
//!     <code> <b0> <b1> <b2> <b3> <b4>
//!
//! Each entry is five row bytes; bit `1 << (2 - col)` is set when the pixel at column `col` (0 = left) is ink.

use embedded_gui::font::glyph_rows;
use embedded_gui::prelude::FontId;

/// The fonts a design can ask for, in the order the picker offers them. `Vector` carries its scale in the
/// variant, and the scale is part of what the advance is computed from, so each scale is its own section.
const FONTS: [(&str, FontId); 5] = [
    ("Tiny3x5", FontId::Tiny3x5),
    ("Medium4x7", FontId::Medium4x7),
    ("Scaled6x10", FontId::Scaled6x10),
    ("Vector(2)", FontId::Vector(2)),
    ("Vector(3)", FontId::Vector(3)),
];

fn main() {
    for (name, font) in FONTS {
        println!("font {name} advance={} line_height={}", font.advance(), font.line_height());
        for code in 32u32..=126 {
            let ch = char::from_u32(code).unwrap_or('?');
            let rows = glyph_rows(font, ch);
            println!("{code} {} {} {} {} {}", rows[0], rows[1], rows[2], rows[3], rows[4]);
        }
    }
}
