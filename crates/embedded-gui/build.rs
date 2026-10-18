use std::{collections::HashMap, env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=EMBEDDED_GUI_FONT_DIR");
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));
    let out_file = out_dir.join("generated_ascii_3x5.rs");
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir missing"));

    let font_dir = env::var("EMBEDDED_GUI_FONT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| manifest_dir.join("assets").join("fonts"));
    // Without this, editing a glyph table changes nothing: the build script declares one
    // rerun-if-env-changed, and once any rerun-if-* is printed cargo stops scanning the package.
    // A font fix that never reached the board would be the worst kind of silent.
    println!("cargo:rerun-if-changed={}", font_dir.display());

    let map_3x5 = load_glyph_overrides(&font_dir.join("ascii_3x5.txt"));
    let map_4x7 = load_glyph_overrides(&font_dir.join("ascii_4x7.txt"));

    let mut src = String::from("pub static ASCII_3X5_GLYPHS: [[u8; 5]; 95] = [\n");
    for code in 32u8..=126u8 {
        let ch = code as char;
        let g = map_3x5.get(&ch).copied().unwrap_or_else(|| glyph_3x5(ch));
        src.push_str(&format!(
            "    [{:#05b}, {:#05b}, {:#05b}, {:#05b}, {:#05b}],\n",
            g[0], g[1], g[2], g[3], g[4]
        ));
    }
    src.push_str("];\n");
    src.push('\n');
    src.push_str("pub static ASCII_4X7_GLYPHS: [[u8; 5]; 95] = [\n");
    for code in 32u8..=126u8 {
        let ch = code as char;
        let g = map_4x7.get(&ch).copied().unwrap_or_else(|| glyph_3x5(ch));
        src.push_str(&format!(
            "    [{:#05b}, {:#05b}, {:#05b}, {:#05b}, {:#05b}],\n",
            g[0], g[1], g[2], g[3], g[4]
        ));
    }
    src.push_str("];\n");

    // The shape drawn for a character the face does not have, written out beside the table so the
    // crate (and its tests) can name the same thing the generator uses. An unsupported character must
    // not read as a real one: this used to be a hollow box, which is `0`'s own glyph.
    src.push_str("\npub static MISSING_GLYPH: [u8; 5] = [0b111, 0b111, 0b111, 0b111, 0b111];\n");

    // The bitmap faces -- the drawn 5x7 and the two rasterised ones. `BitmapFont` reads one byte per
    // row, the leftmost column in bit 7, so a glyph is `height` bytes and the table is the whole
    // printable-ASCII range end to end.
    push_bitmap_table(
        &mut src,
        "ASCII_5X7_GLYPHS",
        5,
        7,
        &font_dir.join("ascii_5x7.txt"),
    );
    push_bitmap_table(
        &mut src,
        "ASCII_6X10_GLYPHS",
        6,
        10,
        &font_dir.join("dejavu_6x10.txt"),
    );
    push_bitmap_table(
        &mut src,
        "ASCII_8X16_GLYPHS",
        8,
        16,
        &font_dir.join("dejavu_8x16.txt"),
    );

    fs::write(out_file, src).expect("failed writing generated ascii font");
}

/// Appends one `BitmapFont` table, read out of a `key:rows` file.
///
/// A character the file does not have is filled with the `?` glyph rather than left blank: a hole in
/// the middle of the range would be drawn as nothing, which reads as a broken font rather than as a
/// missing character.
fn push_bitmap_table(src: &mut String, name: &str, width: u8, height: u8, path: &PathBuf) {
    let rows = load_bitmap_glyphs(path, width, height);
    src.push_str(&format!(
        "\npub static {}: [u8; {}] = [\n",
        name,
        rows.len()
    ));
    for glyph in rows.chunks(height as usize) {
        src.push_str("    ");
        for byte in glyph {
            src.push_str(&format!("{:#010b}, ", byte));
        }
        src.push('\n');
    }
    src.push_str("];\n");
}

/// Reads a whole table of `height`-row glyphs of `width` columns, in printable-ASCII order.
fn load_bitmap_glyphs(path: &PathBuf, width: u8, height: u8) -> Vec<u8> {
    let per_glyph = height as usize;
    let mut out = vec![0u8; per_glyph * 95];
    let mut seen = [false; 95];
    let contents = fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("cannot read the font table {}: {error}", path.display()));

    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // `rsplit_once`: a `:` row is written `::010,010,...`, and splitting on the first colon
        // would make its key empty.
        let Some((key, rows)) = line.rsplit_once(':') else {
            panic!("{}: no `key:rows` in {line:?}", path.display());
        };
        let Some(ch) = parse_key(key.trim()) else {
            panic!("{}: cannot read the key {key:?}", path.display());
        };
        let parts: Vec<&str> = rows.split(',').map(str::trim).collect();
        assert_eq!(
            parts.len(),
            per_glyph,
            "{}: {ch:?} has {} rows, expected {height}",
            path.display(),
            parts.len()
        );
        let slot = (ch as usize).wrapping_sub(32);
        assert!(
            slot < 95,
            "{}: {ch:?} is not printable ASCII",
            path.display()
        );
        for (idx, row) in parts.iter().enumerate() {
            assert_eq!(
                row.len(),
                width as usize,
                "{}: {ch:?} row {idx}",
                path.display()
            );
            for (col, c) in row.chars().enumerate() {
                match c {
                    '1' => out[slot * per_glyph + idx] |= 1 << (7 - col),
                    '0' => {}
                    other => panic!("{}: {ch:?} has {other:?} in a row", path.display()),
                }
            }
        }
        seen[slot] = true;
    }

    let question = (b'?' as usize) - 32;
    for slot in 0..95 {
        if !seen[slot] {
            let from = question * per_glyph;
            let to = slot * per_glyph;
            out.copy_within(from..from + per_glyph, to);
        }
    }
    out
}

fn load_glyph_overrides(path: &PathBuf) -> HashMap<char, [u8; 5]> {
    let mut out = HashMap::new();
    let Ok(contents) = fs::read_to_string(path) else {
        return out;
    };

    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // `rsplit_once`: a `:` row is written `::010,010,010,010,010`, and splitting on the first
        // colon would make its key empty.
        let Some((key, rows)) = line.rsplit_once(':') else {
            continue;
        };
        let Some(ch) = parse_key(key.trim()) else {
            continue;
        };
        let mut glyph = [0u8; 5];
        let mut ok = true;
        let parts: Vec<&str> = rows.split(',').collect();
        if parts.len() != 5 {
            continue;
        }
        for (idx, part) in parts.into_iter().enumerate() {
            let row = part.trim();
            if row.len() != 3 || row.chars().any(|c| c != '0' && c != '1') {
                ok = false;
                break;
            }
            let mut bits = 0u8;
            for c in row.chars() {
                bits = (bits << 1) | u8::from(c == '1');
            }
            glyph[idx] = bits;
        }
        if ok {
            out.insert(ch, glyph);
        }
    }

    out
}

fn parse_key(key: &str) -> Option<char> {
    if key.eq_ignore_ascii_case("space") {
        return Some(' ');
    }
    if key.chars().count() == 1 {
        return key.chars().next();
    }
    None
}

/// The built-in 3x5 face: every printable ASCII character, in both cases.
///
/// Three columns and five rows, bit 2 the leftmost pixel, so a row is a number from 0 to 7 and `0b101`
/// is `#.#`. A glyph the table does not have falls back to a box, which reads as "this face has no
/// such character" rather than as nothing at all.
///
/// Lower case is **its own drawing**, not the capital again: `build.rs` used to fold case with
/// `to_ascii_uppercase`, and on the glass that made a keypad's Shift key change nothing a finger
/// could see -- the letters were capitals either way, and the widget grew a private capital table to
/// work around it (found 2026-10-17: "The shift key is not toggling uppercase/lowercase"). The same
/// pass filled in the punctuation, which had been falling back to boxes: a symbol page of keys each
/// labelled with a box is not a symbol page ("it seems that the fonts does not support symbols").
fn glyph_3x5(ch: char) -> [u8; 5] {
    match ch {
        ' ' => [0b000, 0b000, 0b000, 0b000, 0b000],
        '!' => [0b010, 0b010, 0b010, 0b000, 0b010],
        '"' => [0b101, 0b101, 0b000, 0b000, 0b000],
        '#' => [0b101, 0b111, 0b101, 0b111, 0b101],
        '$' => [0b011, 0b110, 0b011, 0b011, 0b110],
        '%' => [0b101, 0b001, 0b010, 0b100, 0b101],
        '&' => [0b010, 0b101, 0b010, 0b101, 0b011],
        '\'' => [0b010, 0b010, 0b000, 0b000, 0b000],
        '(' => [0b001, 0b010, 0b010, 0b010, 0b001],
        ')' => [0b100, 0b010, 0b010, 0b010, 0b100],
        '*' => [0b000, 0b101, 0b010, 0b101, 0b000],
        '+' => [0b000, 0b010, 0b111, 0b010, 0b000],
        ',' => [0b000, 0b000, 0b000, 0b010, 0b100],
        '-' => [0b000, 0b000, 0b111, 0b000, 0b000],
        '.' => [0b000, 0b000, 0b000, 0b000, 0b010],
        '/' => [0b001, 0b001, 0b010, 0b100, 0b100],
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b110, 0b001, 0b010, 0b100, 0b111],
        '3' => [0b110, 0b001, 0b010, 0b001, 0b110],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b110, 0b001, 0b110],
        '6' => [0b011, 0b100, 0b110, 0b101, 0b010],
        '7' => [0b111, 0b001, 0b010, 0b010, 0b010],
        '8' => [0b010, 0b101, 0b010, 0b101, 0b010],
        '9' => [0b010, 0b101, 0b011, 0b001, 0b110],
        ':' => [0b000, 0b010, 0b000, 0b010, 0b000],
        ';' => [0b000, 0b010, 0b000, 0b010, 0b100],
        '<' => [0b001, 0b010, 0b100, 0b010, 0b001],
        '=' => [0b000, 0b111, 0b000, 0b111, 0b000],
        '>' => [0b100, 0b010, 0b001, 0b010, 0b100],
        '?' => [0b111, 0b001, 0b010, 0b000, 0b010],
        '@' => [0b111, 0b101, 0b111, 0b100, 0b011],
        'A' => [0b010, 0b101, 0b111, 0b101, 0b101],
        'B' => [0b110, 0b101, 0b110, 0b101, 0b110],
        'C' => [0b011, 0b100, 0b100, 0b100, 0b011],
        'D' => [0b110, 0b101, 0b101, 0b101, 0b110],
        'E' => [0b111, 0b100, 0b110, 0b100, 0b111],
        'F' => [0b111, 0b100, 0b110, 0b100, 0b100],
        'G' => [0b011, 0b100, 0b101, 0b101, 0b011],
        'H' => [0b101, 0b101, 0b111, 0b101, 0b101],
        'I' => [0b111, 0b010, 0b010, 0b010, 0b111],
        'J' => [0b001, 0b001, 0b001, 0b101, 0b010],
        'K' => [0b101, 0b101, 0b110, 0b101, 0b101],
        'L' => [0b100, 0b100, 0b100, 0b100, 0b111],
        'M' => [0b101, 0b111, 0b111, 0b101, 0b101],
        'N' => [0b101, 0b111, 0b111, 0b111, 0b101],
        'O' => [0b010, 0b101, 0b101, 0b101, 0b010],
        'P' => [0b110, 0b101, 0b110, 0b100, 0b100],
        'Q' => [0b010, 0b101, 0b101, 0b111, 0b011],
        'R' => [0b110, 0b101, 0b110, 0b101, 0b101],
        'S' => [0b011, 0b100, 0b010, 0b001, 0b110],
        'T' => [0b111, 0b010, 0b010, 0b010, 0b010],
        'U' => [0b101, 0b101, 0b101, 0b101, 0b111],
        'V' => [0b101, 0b101, 0b101, 0b101, 0b010],
        'W' => [0b101, 0b101, 0b111, 0b111, 0b101],
        'X' => [0b101, 0b101, 0b010, 0b101, 0b101],
        'Y' => [0b101, 0b101, 0b010, 0b010, 0b010],
        'Z' => [0b111, 0b001, 0b010, 0b100, 0b111],
        '[' => [0b011, 0b010, 0b010, 0b010, 0b011],
        '\\' => [0b100, 0b100, 0b010, 0b001, 0b001],
        ']' => [0b110, 0b010, 0b010, 0b010, 0b110],
        '^' => [0b010, 0b101, 0b000, 0b000, 0b000],
        '_' => [0b000, 0b000, 0b000, 0b000, 0b111],
        '`' => [0b010, 0b001, 0b000, 0b000, 0b000],
        // Lower case. The short letters sit between rows 1 and 4 -- three rows of body with a row for
        // a descender below -- and the tall ones use the full height, which is what makes `b` and `d`
        // read as letters rather than as capitals.
        'a' => [0b000, 0b011, 0b101, 0b101, 0b011],
        'b' => [0b100, 0b110, 0b101, 0b101, 0b110],
        'c' => [0b000, 0b011, 0b100, 0b100, 0b011],
        'd' => [0b001, 0b011, 0b101, 0b101, 0b011],
        'e' => [0b000, 0b011, 0b100, 0b111, 0b011],
        'f' => [0b001, 0b010, 0b111, 0b010, 0b010],
        'g' => [0b000, 0b011, 0b101, 0b011, 0b110],
        'h' => [0b100, 0b110, 0b101, 0b101, 0b101],
        'i' => [0b010, 0b000, 0b010, 0b010, 0b010],
        'j' => [0b001, 0b000, 0b001, 0b001, 0b110],
        'k' => [0b100, 0b101, 0b110, 0b101, 0b101],
        'l' => [0b010, 0b010, 0b010, 0b010, 0b011],
        'm' => [0b000, 0b101, 0b111, 0b101, 0b101],
        'n' => [0b000, 0b110, 0b101, 0b101, 0b101],
        'o' => [0b000, 0b010, 0b101, 0b101, 0b010],
        'p' => [0b000, 0b110, 0b101, 0b110, 0b100],
        'q' => [0b000, 0b011, 0b101, 0b011, 0b001],
        'r' => [0b000, 0b101, 0b110, 0b100, 0b100],
        's' => [0b000, 0b011, 0b100, 0b001, 0b110],
        't' => [0b010, 0b111, 0b010, 0b010, 0b001],
        'u' => [0b000, 0b101, 0b101, 0b101, 0b011],
        'v' => [0b000, 0b101, 0b101, 0b101, 0b010],
        'w' => [0b000, 0b101, 0b101, 0b111, 0b101],
        'x' => [0b000, 0b101, 0b010, 0b101, 0b000],
        'y' => [0b000, 0b101, 0b101, 0b011, 0b100],
        'z' => [0b000, 0b111, 0b001, 0b100, 0b111],
        '{' => [0b001, 0b010, 0b110, 0b010, 0b001],
        '|' => [0b010, 0b010, 0b010, 0b010, 0b010],
        '}' => [0b100, 0b010, 0b011, 0b010, 0b100],
        '~' => [0b000, 0b010, 0b101, 0b000, 0b000],
        // Not a character this face has: a solid block, emitted as `MISSING_GLYPH` with the table so
        // the crate and its tests can name it. Not the old hollow box -- that was `0`'s own shape, so
        // an unsupported character was drawn as a row of noughts.
        _ => [0b111, 0b111, 0b111, 0b111, 0b111],
    }
}
