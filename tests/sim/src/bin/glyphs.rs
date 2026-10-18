//! Prints the crate's own glyph tables, for the designer canvas to draw text with.
//!
//! The canvas has to show what the board shows, and the board draws text with embedded-gui's bitmap fonts. A
//! browser font of a similar size is *nearly* right, which is exactly the kind of nearly that makes a WYSIWYG
//! canvas untrustworthy -- so the glyphs are read out of the crate itself, through the public `glyph_rows`, and
//! committed as a table the webview uses. `tests/tools/glyph-table.js` runs this and writes the table.
//!
//! Output format, one font per section, plain text so the tool does not need a JSON library:
//!
//!     font <name> advance=<n> line_height=<n> width=<n> height=<n>
//!     <code> <r0> <r1> ... <r(height-1)>
//!
//! Each entry is `height` row numbers. In row `r`, bit `1 << (width - 1 - col)` is set when the pixel at
//! column `col` (0 = left) is ink -- the 3x5 faces are three columns, the rasterised ones six or eight.

use embedded_gui::font::{
    get_vector_glyph, glyph_rows, ASCII_5X7_FONT, ASCII_6X10_FONT, ASCII_8X16_FONT,
};
use embedded_gui::prelude::FontId;

/// The fonts a design can ask for, in the order the picker offers them. `Vector` carries its scale in the
/// variant, and the scale is part of what the advance is computed from, so each scale is its own section.
const FONTS: [(&str, FontId); 8] = [
    ("Tiny3x5", FontId::Tiny3x5),
    ("Medium4x7", FontId::Medium4x7),
    ("Scaled6x10", FontId::Scaled6x10),
    ("Medium5x7", FontId::Medium5x7),
    ("Mono6x10", FontId::Mono6x10),
    ("Mono8x16", FontId::Mono8x16),
    ("Vector(2)", FontId::Vector(2)),
    ("Vector(3)", FontId::Vector(3)),
];

/// One glyph as `height` row numbers of `width` bits, whichever kind of face it came from.
///
/// The 3x5 shapes are already that; a rasterised face stores whole bytes with the leftmost column in
/// bit 7, so its rows are shifted down to `width` bits and the canvas indexes them the same way.
fn rows_of(font: FontId, ch: char) -> (u8, u8, Vec<u8>) {
    let unpack = |bitmap: &'static embedded_gui::font::BitmapFont| {
        let width = bitmap.width;
        let height = bitmap.height;
        let rows = bitmap
            .glyph_bytes(ch)
            .unwrap_or(&[])
            .iter()
            .map(|byte| byte >> (8 - width))
            .collect::<Vec<u8>>();
        (width, height, rows)
    };
    match font {
        FontId::Medium5x7 => unpack(&ASCII_5X7_FONT),
        FontId::Mono6x10 => unpack(&ASCII_6X10_FONT),
        FontId::Mono8x16 => unpack(&ASCII_8X16_FONT),
        other => (3, 5, glyph_rows(other, ch).to_vec()),
    }
}

fn main() {
    // The vector face is not a bitmap at all: the engine strokes a polyline through these points, scaled by
    // `Vector(n)`'s scale, and breaks the line at the crate's own `(255, 255)` pen-up marker
    // (`render/mod.rs`, the `FontId::Vector(scale)` arm). The points do not depend on the scale, so they are
    // printed once rather than per variant.
    let vector = || {
        println!("vector");
        for code in 32u32..=126 {
            let ch = char::from_u32(code).unwrap_or('?');
            let mut line = format!("v {code}");
            for (x, y) in get_vector_glyph(ch) {
                line.push_str(&format!(" {x} {y}"));
            }
            println!("{line}");
        }
    };

    vector();
    for (name, font) in FONTS {
        let (width, height, _) = rows_of(font, 'A');
        println!(
            "font {name} advance={} line_height={} width={width} height={height}",
            font.advance(),
            font.line_height()
        );
        for code in 32u32..=126 {
            let ch = char::from_u32(code).unwrap_or('?');
            let (_, _, rows) = rows_of(font, ch);
            let numbers = rows
                .iter()
                .map(|row| row.to_string())
                .collect::<Vec<_>>()
                .join(" ");
            println!("{code} {numbers}");
        }
    }
}
