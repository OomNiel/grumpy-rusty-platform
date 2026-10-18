include!(concat!(env!("OUT_DIR"), "/generated_ascii_3x5.rs"));

/// Trait for custom font providers.
///
/// Consumers can implement this trait on custom font types (e.g. anti-aliased fonts,
/// vector text generators, external BDF/PSF font decoders, TTF parsers) and use
/// [`FontId::Dynamic`] or [`FontId::from`] to pass them to text styling.
pub trait Font: Send + Sync {
    /// Character horizontal advance in pixels.
    fn advance(&self) -> u32;

    /// Vertical line height in pixels.
    fn line_height(&self) -> u32;

    /// Render a single glyph by calling `draw_pixel(dx, dy)` for each active pixel
    /// in the glyph, where `(dx, dy)` are relative coordinates within the glyph bounding box.
    fn draw_glyph(&self, ch: char, draw_pixel: &mut dyn FnMut(i32, i32));
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PackedFont {
    pub first_char: u8,
    pub advance: u8,
    pub line_height: u8,
    pub glyphs: &'static [[u8; 5]],
}

impl Font for PackedFont {
    fn advance(&self) -> u32 {
        self.advance as u32
    }

    fn line_height(&self) -> u32 {
        self.line_height as u32
    }

    fn draw_glyph(&self, ch: char, draw_pixel: &mut dyn FnMut(i32, i32)) {
        let code = ch as u32;
        let rows = if code >= self.first_char as u32 {
            let idx = (code as usize).saturating_sub(self.first_char as usize);
            self.glyphs.get(idx).copied().unwrap_or([0; 5])
        } else {
            [0; 5]
        };
        for (row, bits) in rows.iter().enumerate() {
            for col in 0..3 {
                if bits & (1 << (2 - col)) != 0 {
                    draw_pixel(col, row as i32);
                }
            }
        }
    }
}

pub static ASCII_3X5_FONT: PackedFont = PackedFont {
    first_char: 32,
    advance: 4,
    line_height: 6,
    glyphs: &ASCII_3X5_GLYPHS,
};

pub static ASCII_4X7_FONT: PackedFont = PackedFont {
    first_char: 32,
    advance: 5,
    line_height: 8,
    glyphs: &ASCII_4X7_GLYPHS,
};

/// The hand-drawn 5x7 face: five columns, seven rows, a six-pixel advance.
///
/// Drawn rather than rasterised, and the size where that matters: an outline face below a nine-pixel em
/// loses its letters, while five by seven is what hand-made bitmap faces have always used -- the classic
/// LCD character set, which this is modelled on. It fits 80 characters across a 480-pixel panel and gives
/// a label a real lower case without the height of the rasterised faces.
pub static ASCII_5X7_FONT: BitmapFont = BitmapFont {
    width: 5,
    height: 7,
    advance: 6,
    line_height: 9,
    first_char: 32,
    bytes_per_row: 1,
    glyphs: &ASCII_5X7_GLYPHS,
};

/// The first of the two rasterised faces: DejaVu Sans Mono at 9 px, a 6x10 cell.
///
/// Generated, not drawn (`assets/fonts/from_truetype.py`), because 3x5 is as far as hand-drawn
/// glyphs go before text stops being readable at arm's length. The cell is 6 wide with a 7-pixel
/// advance, so a 480-pixel panel holds 68 characters a line, and the ink is 10 rows in a 12-row
/// line height.
pub static ASCII_6X10_FONT: BitmapFont = BitmapFont {
    width: 6,
    height: 10,
    advance: 7,
    line_height: 12,
    first_char: 32,
    bytes_per_row: 1,
    glyphs: &ASCII_6X10_GLYPHS,
};

/// The second rasterised face: DejaVu Sans Mono at 12 px, an 8x16 cell.
///
/// The one to read at a glance: 9-pixel advance (53 characters across the 480-pixel panel) and a
/// 19-pixel line height, so two lines of it fit a button with room to spare.
pub static ASCII_8X16_FONT: BitmapFont = BitmapFont {
    width: 8,
    height: 16,
    advance: 9,
    line_height: 19,
    first_char: 32,
    bytes_per_row: 1,
    glyphs: &ASCII_8X16_GLYPHS,
};

/// Bounding-box rendering operation for [`BitmapFont`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GlyphOp {
    /// Draw a single pixel at relative offset `(dx, dy)`.
    Pixel(i32, i32),
    /// Draw a contiguous horizontal span of `len` pixels starting at `(dx, dy)`.
    Span(i32, i32, u32),
}

/// Flexible monospaced or packed raw bitmap font definition.
///
/// Unlike [`PackedFont`] (which is fixed to 3x5 5-row bitpacks), [`BitmapFont`]
/// supports arbitrary glyph dimensions (e.g., 8x8, 8x16, 12x16, 16x24),
/// configurable advance/line-height, and multi-byte row bit-masks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BitmapFont {
    /// Bounding box width in pixels.
    pub width: u8,
    /// Bounding box height in pixels.
    pub height: u8,
    /// Character horizontal advance in pixels.
    pub advance: u8,
    /// Vertical line height in pixels.
    pub line_height: u8,
    /// The ASCII character code of the first glyph in the buffer (usually 32 / space).
    pub first_char: u8,
    /// Number of bytes per row for each glyph (e.g. 1 byte for width <= 8, 2 bytes for width <= 16).
    pub bytes_per_row: u8,
    /// Contiguous byte slice containing glyph bitmaps stored row by row (MSB left-to-right).
    pub glyphs: &'static [u8],
}

impl BitmapFont {
    /// Creates a new `BitmapFont` for standard 8x8 glyphs (1 byte per row, 8 rows per glyph).
    pub const fn new_8x8(
        first_char: u8,
        advance: u8,
        line_height: u8,
        glyphs: &'static [u8],
    ) -> Self {
        Self {
            width: 8,
            height: 8,
            advance,
            line_height,
            first_char,
            bytes_per_row: 1,
            glyphs,
        }
    }

    /// Creates a new `BitmapFont` for standard 8x16 glyphs (1 byte per row, 16 rows per glyph).
    pub const fn new_8x16(
        first_char: u8,
        advance: u8,
        line_height: u8,
        glyphs: &'static [u8],
    ) -> Self {
        Self {
            width: 8,
            height: 16,
            advance,
            line_height,
            first_char,
            bytes_per_row: 1,
            glyphs,
        }
    }

    /// Get the raw byte slice for a character's row data.
    pub fn glyph_bytes(&self, ch: char) -> Option<&'static [u8]> {
        let code = ch as u32;
        if code < self.first_char as u32 {
            return None;
        }
        let idx = (code - self.first_char as u32) as usize;
        let bytes_per_glyph = self.height as usize * self.bytes_per_row as usize;
        let start = idx * bytes_per_glyph;
        let end = start + bytes_per_glyph;
        if end <= self.glyphs.len() {
            Some(&self.glyphs[start..end])
        } else {
            None
        }
    }

    /// Renders a glyph by emitting [`GlyphOp`] commands to a single closure callback.
    pub fn draw_glyph_to<F>(&self, ch: char, mut emit: F)
    where
        F: FnMut(GlyphOp),
    {
        if let Some(data) = self.glyph_bytes(ch) {
            let bpr = self.bytes_per_row as usize;
            for row in 0..(self.height as usize) {
                let row_data = &data[row * bpr..(row + 1) * bpr];
                let mut span_start: Option<usize> = None;
                let mut span_len = 0u32;

                for col in 0..(self.width as usize) {
                    let byte_idx = col / 8;
                    let bit_idx = 7 - (col % 8);
                    let is_set =
                        byte_idx < row_data.len() && (row_data[byte_idx] & (1 << bit_idx)) != 0;

                    if is_set {
                        if span_start.is_none() {
                            span_start = Some(col);
                            span_len = 1;
                        } else {
                            span_len += 1;
                        }
                    } else if let Some(start) = span_start {
                        if span_len == 1 {
                            emit(GlyphOp::Pixel(start as i32, row as i32));
                        } else {
                            emit(GlyphOp::Span(start as i32, row as i32, span_len));
                        }
                        span_start = None;
                        span_len = 0;
                    }
                }
                if let Some(start) = span_start {
                    if span_len == 1 {
                        emit(GlyphOp::Pixel(start as i32, row as i32));
                    } else {
                        emit(GlyphOp::Span(start as i32, row as i32, span_len));
                    }
                }
            }
        }
    }
}

impl Font for BitmapFont {
    fn advance(&self) -> u32 {
        self.advance as u32
    }

    fn line_height(&self) -> u32 {
        self.line_height as u32
    }

    fn draw_glyph(&self, ch: char, draw_pixel: &mut dyn FnMut(i32, i32)) {
        self.draw_glyph_to(ch, |op| match op {
            GlyphOp::Pixel(dx, dy) => draw_pixel(dx, dy),
            GlyphOp::Span(dx, dy, len) => {
                for col in 0..len {
                    draw_pixel(dx + col as i32, dy);
                }
            }
        });
    }
}

#[cfg(feature = "embedded-graphics")]
impl Font for embedded_graphics::mono_font::MonoFont<'static> {
    fn advance(&self) -> u32 {
        self.character_size.width + self.character_spacing
    }

    fn line_height(&self) -> u32 {
        self.character_size.height
    }

    fn draw_glyph(&self, ch: char, draw_pixel: &mut dyn FnMut(i32, i32)) {
        use embedded_graphics::draw_target::DrawTarget;
        use embedded_graphics::geometry::{OriginDimensions, Point, Size};
        use embedded_graphics::mono_font::MonoTextStyle;
        use embedded_graphics::pixelcolor::BinaryColor;
        use embedded_graphics::text::Text;
        use embedded_graphics::Drawable;

        struct Collector<'a> {
            f: &'a mut dyn FnMut(i32, i32),
        }

        impl OriginDimensions for Collector<'_> {
            fn size(&self) -> Size {
                Size::new(u32::MAX, u32::MAX)
            }
        }

        impl DrawTarget for Collector<'_> {
            type Color = BinaryColor;
            type Error = core::convert::Infallible;

            fn draw_iter<I>(&mut self, pixels: I) -> Result<(), Self::Error>
            where
                I: IntoIterator<Item = embedded_graphics::Pixel<Self::Color>>,
            {
                for embedded_graphics::Pixel(pos, color) in pixels {
                    if color.is_on() {
                        (self.f)(pos.x, pos.y);
                    }
                }
                Ok(())
            }
        }

        let text_style = MonoTextStyle::new(self, BinaryColor::On);
        let mut buf = [0u8; 4];
        let ch_str = ch.encode_utf8(&mut buf);
        let mut collector = Collector { f: draw_pixel };
        let _ = Text::new(ch_str, Point::zero(), text_style).draw(&mut collector);
    }
}

#[derive(Clone, Copy)]
pub enum FontId {
    Tiny3x5,
    Medium4x7,
    Scaled6x10,
    /// The hand-drawn 5x7 face (advance 6, line height 9).
    Medium5x7,
    /// DejaVu Sans Mono rasterised into a 6x10 cell (advance 7, line height 12).
    Mono6x10,
    /// DejaVu Sans Mono rasterised into an 8x16 cell (advance 9, line height 19).
    Mono8x16,
    Vector(u8),
    Custom(&'static PackedFont),
    Bitmap(&'static BitmapFont),
    Dynamic(&'static dyn Font),
    #[cfg(feature = "embedded-graphics")]
    MonoFont(&'static embedded_graphics::mono_font::MonoFont<'static>),
}

impl core::fmt::Debug for FontId {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Tiny3x5 => write!(f, "Tiny3x5"),
            Self::Medium4x7 => write!(f, "Medium4x7"),
            Self::Scaled6x10 => write!(f, "Scaled6x10"),
            Self::Medium5x7 => write!(f, "Medium5x7"),
            Self::Mono6x10 => write!(f, "Mono6x10"),
            Self::Mono8x16 => write!(f, "Mono8x16"),
            Self::Vector(scale) => f.debug_tuple("Vector").field(scale).finish(),
            Self::Custom(font) => f.debug_tuple("Custom").field(font).finish(),
            Self::Bitmap(font) => f.debug_tuple("Bitmap").field(font).finish(),
            Self::Dynamic(_) => f.write_str("Dynamic"),
            #[cfg(feature = "embedded-graphics")]
            Self::MonoFont(font) => f.debug_tuple("MonoFont").field(font).finish(),
        }
    }
}

impl PartialEq for FontId {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Tiny3x5, Self::Tiny3x5) => true,
            (Self::Medium4x7, Self::Medium4x7) => true,
            (Self::Scaled6x10, Self::Scaled6x10) => true,
            (Self::Medium5x7, Self::Medium5x7) => true,
            (Self::Mono6x10, Self::Mono6x10) => true,
            (Self::Mono8x16, Self::Mono8x16) => true,
            (Self::Vector(a), Self::Vector(b)) => a == b,
            (Self::Custom(a), Self::Custom(b)) => core::ptr::eq(*a, *b),
            (Self::Bitmap(a), Self::Bitmap(b)) => core::ptr::eq(*a, *b),
            (Self::Dynamic(a), Self::Dynamic(b)) => core::ptr::eq(
                *a as *const dyn Font as *const (),
                *b as *const dyn Font as *const (),
            ),
            #[cfg(feature = "embedded-graphics")]
            (Self::MonoFont(a), Self::MonoFont(b)) => core::ptr::eq(*a, *b),
            _ => false,
        }
    }
}

impl Eq for FontId {}

impl FontId {
    pub fn advance(self) -> u32 {
        match self {
            Self::Tiny3x5 => 4,
            Self::Medium4x7 => 5,
            Self::Scaled6x10 => 7,
            Self::Medium5x7 => ASCII_5X7_FONT.advance as u32,
            Self::Mono6x10 => ASCII_6X10_FONT.advance as u32,
            Self::Mono8x16 => ASCII_8X16_FONT.advance as u32,
            Self::Vector(scale) => (8 * scale) as u32,
            Self::Custom(font) => font.advance as u32,
            Self::Bitmap(font) => font.advance as u32,
            Self::Dynamic(font) => font.advance(),
            #[cfg(feature = "embedded-graphics")]
            Self::MonoFont(font) => font.character_size.width + font.character_spacing,
        }
    }

    pub fn line_height(self) -> u32 {
        match self {
            Self::Tiny3x5 => 6,
            Self::Medium4x7 => 8,
            Self::Scaled6x10 => 11,
            Self::Medium5x7 => ASCII_5X7_FONT.line_height as u32,
            Self::Mono6x10 => ASCII_6X10_FONT.line_height as u32,
            Self::Mono8x16 => ASCII_8X16_FONT.line_height as u32,
            Self::Vector(scale) => (12 * scale) as u32,
            Self::Custom(font) => font.line_height as u32,
            Self::Bitmap(font) => font.line_height as u32,
            Self::Dynamic(font) => font.line_height(),
            #[cfg(feature = "embedded-graphics")]
            Self::MonoFont(font) => font.character_size.height,
        }
    }
}

pub const fn packed_font(font: FontId) -> &'static PackedFont {
    match font {
        FontId::Tiny3x5 => &ASCII_3X5_FONT,
        FontId::Medium4x7 => &ASCII_4X7_FONT,
        FontId::Scaled6x10 => &ASCII_3X5_FONT,
        // Not packed at all: `glyph_rows` is the 3x5 API, and these two are `BitmapFont`s. They draw
        // through `Bitmap`'s own path (see `for_each_glyph_pixel`), and this answer is only what a
        // caller that insists on the 3x5 shape gets.
        FontId::Medium5x7 | FontId::Mono6x10 | FontId::Mono8x16 => &ASCII_3X5_FONT,
        FontId::Vector(_) => &ASCII_3X5_FONT,
        FontId::Custom(font) => font,
        FontId::Bitmap(_) => &ASCII_3X5_FONT,
        FontId::Dynamic(_) => &ASCII_3X5_FONT,
        #[cfg(feature = "embedded-graphics")]
        FontId::MonoFont(_) => &ASCII_3X5_FONT,
    }
}

impl From<&'static PackedFont> for FontId {
    fn from(font: &'static PackedFont) -> Self {
        FontId::Custom(font)
    }
}

impl From<&'static BitmapFont> for FontId {
    fn from(font: &'static BitmapFont) -> Self {
        FontId::Bitmap(font)
    }
}

impl From<&'static dyn Font> for FontId {
    fn from(font: &'static dyn Font) -> Self {
        FontId::Dynamic(font)
    }
}

#[cfg(feature = "embedded-graphics")]
impl From<&'static embedded_graphics::mono_font::MonoFont<'static>> for FontId {
    fn from(font: &'static embedded_graphics::mono_font::MonoFont<'static>) -> Self {
        FontId::MonoFont(font)
    }
}

pub fn get_vector_glyph(ch: char) -> &'static [(u8, u8)] {
    match ch {
        ' ' => &[],
        '0' => &[
            (2, 0),
            (6, 0),
            (6, 10),
            (2, 10),
            (2, 0),
            (0xFF, 0xFF),
            (2, 10),
            (6, 0),
        ],
        '1' => &[
            (4, 0),
            (4, 10),
            (0xFF, 0xFF),
            (2, 2),
            (4, 0),
            (0xFF, 0xFF),
            (2, 10),
            (6, 10),
        ],
        '2' => &[(2, 0), (6, 0), (6, 5), (2, 5), (2, 10), (6, 10)],
        '3' => &[
            (2, 0),
            (6, 0),
            (6, 10),
            (2, 10),
            (0xFF, 0xFF),
            (2, 5),
            (6, 5),
        ],
        '4' => &[(2, 0), (2, 5), (6, 5), (0xFF, 0xFF), (6, 0), (6, 10)],
        '5' => &[(6, 0), (2, 0), (2, 5), (6, 5), (6, 10), (2, 10)],
        '6' => &[(6, 0), (2, 0), (2, 10), (6, 10), (6, 5), (2, 5)],
        '7' => &[(2, 0), (6, 0), (2, 10)],
        '8' => &[
            (2, 0),
            (6, 0),
            (6, 10),
            (2, 10),
            (2, 0),
            (0xFF, 0xFF),
            (2, 5),
            (6, 5),
        ],
        '9' => &[(6, 5), (2, 5), (2, 0), (6, 0), (6, 10), (2, 10)],
        'A' | 'a' => &[(2, 10), (4, 0), (6, 10), (0xFF, 0xFF), (3, 5), (5, 5)],
        'B' | 'b' => &[
            (2, 0),
            (5, 0),
            (6, 2),
            (6, 4),
            (5, 5),
            (2, 5),
            (5, 5),
            (6, 6),
            (6, 8),
            (5, 10),
            (2, 10),
            (2, 0),
        ],
        'C' | 'c' => &[(6, 0), (2, 0), (2, 10), (6, 10)],
        'D' | 'd' => &[(2, 0), (5, 0), (6, 3), (6, 7), (5, 10), (2, 10), (2, 0)],
        'E' | 'e' => &[
            (6, 0),
            (2, 0),
            (2, 10),
            (6, 10),
            (0xFF, 0xFF),
            (2, 5),
            (5, 5),
        ],
        'F' | 'f' => &[(6, 0), (2, 0), (2, 10), (0xFF, 0xFF), (2, 5), (5, 5)],
        'G' | 'g' => &[(6, 2), (6, 0), (2, 0), (2, 10), (6, 10), (6, 5), (4, 5)],
        'H' | 'h' => &[
            (2, 0),
            (2, 10),
            (0xFF, 0xFF),
            (6, 0),
            (6, 10),
            (0xFF, 0xFF),
            (2, 5),
            (6, 5),
        ],
        'I' | 'i' => &[
            (4, 0),
            (4, 10),
            (0xFF, 0xFF),
            (2, 0),
            (6, 0),
            (0xFF, 0xFF),
            (2, 10),
            (6, 10),
        ],
        'J' | 'j' => &[(6, 0), (6, 8), (4, 10), (2, 8)],
        'K' | 'k' => &[(2, 0), (2, 10), (0xFF, 0xFF), (6, 0), (2, 5), (6, 10)],
        'L' | 'l' => &[(2, 0), (2, 10), (6, 10)],
        'M' | 'm' => &[(2, 10), (2, 0), (4, 5), (6, 0), (6, 10)],
        'N' | 'n' => &[(2, 10), (2, 0), (6, 10), (6, 0)],
        'O' | 'o' => &[(2, 0), (6, 0), (6, 10), (2, 10), (2, 0)],
        'P' | 'p' => &[(2, 10), (2, 0), (6, 0), (6, 5), (2, 5)],
        'Q' | 'q' => &[
            (2, 0),
            (6, 0),
            (6, 10),
            (2, 10),
            (2, 0),
            (0xFF, 0xFF),
            (4, 7),
            (7, 10),
        ],
        'R' | 'r' => &[
            (2, 10),
            (2, 0),
            (6, 0),
            (6, 5),
            (2, 5),
            (0xFF, 0xFF),
            (4, 5),
            (6, 10),
        ],
        'S' | 's' => &[(6, 0), (2, 0), (2, 5), (6, 5), (6, 10), (2, 10)],
        'T' | 't' => &[(2, 0), (6, 0), (0xFF, 0xFF), (4, 0), (4, 10)],
        'U' | 'u' => &[(2, 0), (2, 10), (6, 10), (6, 0)],
        'V' | 'v' => &[(2, 0), (4, 10), (6, 0)],
        'W' | 'w' => &[(2, 0), (2, 10), (4, 5), (6, 10), (6, 0)],
        'X' | 'x' => &[(2, 0), (6, 10), (0xFF, 0xFF), (6, 0), (2, 10)],
        'Y' | 'y' => &[(2, 0), (4, 5), (6, 0), (0xFF, 0xFF), (4, 5), (4, 10)],
        'Z' | 'z' => &[(2, 0), (6, 0), (2, 10), (6, 10)],
        '-' => &[(2, 5), (6, 5)],
        '+' => &[(2, 5), (6, 5), (0xFF, 0xFF), (4, 2), (4, 8)],
        '.' => &[(4, 9), (4, 10)],
        ':' => &[(4, 2), (4, 3), (0xFF, 0xFF), (4, 7), (4, 8)],
        '/' => &[(2, 10), (6, 0)],
        _ => &[(2, 0), (6, 0), (6, 10), (2, 10), (2, 0), (2, 0), (6, 10)],
    }
}

/// The ink box of one glyph, in pixels: `(width, height)`.
///
/// The 3x5 faces are three columns by five rows whatever the glyph; a rasterised face says so in its
/// own table. Anything that centres text by its ink -- the clock's numerals -- needs this rather than
/// an assumption, or a numeral is centred on the wrong box on a face it was not measured for.
pub fn glyph_ink_box(font: FontId, _ch: char) -> (u8, u8) {
    match font {
        FontId::Medium5x7 => (ASCII_5X7_FONT.width, ASCII_5X7_FONT.height),
        FontId::Mono6x10 => (ASCII_6X10_FONT.width, ASCII_6X10_FONT.height),
        FontId::Mono8x16 => (ASCII_8X16_FONT.width, ASCII_8X16_FONT.height),
        FontId::Bitmap(bitmap) => (bitmap.width, bitmap.height),
        _ => (3, 5),
    }
}

/// Walks the set pixels of one glyph, relative to its top-left, whatever kind of face it is.
///
/// The 3x5 shapes, the scaled and the vector variants answer through `packed_font`; the rasterised
/// faces answer through their own `BitmapFont`. A caller that draws text by hand -- the clock's
/// numerals, scaled up by the design's `label_scale` -- uses this so it draws what the face really has.
pub fn for_each_glyph_pixel(font: FontId, ch: char, draw: &mut dyn FnMut(i32, i32)) {
    match font {
        FontId::Medium5x7 => ASCII_5X7_FONT.draw_glyph(ch, draw),
        FontId::Mono6x10 => ASCII_6X10_FONT.draw_glyph(ch, draw),
        FontId::Mono8x16 => ASCII_8X16_FONT.draw_glyph(ch, draw),
        FontId::Bitmap(bitmap) => bitmap.draw_glyph(ch, draw),
        FontId::Dynamic(dyn_font) => dyn_font.draw_glyph(ch, draw),
        _ => packed_font(font).draw_glyph(ch, draw),
    }
}

pub fn glyph_rows(font: FontId, ch: char) -> [u8; 5] {
    let packed = packed_font(font);
    let code = ch as u32;
    if code >= packed.first_char as u32 {
        let idx = (code as usize).saturating_sub(packed.first_char as usize);
        if idx < packed.glyphs.len() {
            return packed.glyphs[idx];
        }
    }
    let fallback = b'?'.saturating_sub(packed.first_char) as usize;
    packed.glyphs.get(fallback).copied().unwrap_or([0; 5])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::vec::Vec;

    static MY_CUSTOM_GLYPHS: [[u8; 5]; 2] = [
        [0b111, 0b101, 0b111, 0b101, 0b101], // Space / 'A'
        [0b111, 0b111, 0b111, 0b111, 0b111],
    ];

    static MY_CUSTOM_FONT: PackedFont = PackedFont {
        first_char: 32,
        advance: 8,
        line_height: 12,
        glyphs: &MY_CUSTOM_GLYPHS,
    };

    static MY_BITMAP_GLYPHS: [u8; 16] = [
        // 'A' (8x16)
        0b00111100, 0b01100110, 0b01100110, 0b01111110, 0b01100110, 0b01100110, 0b01100110,
        0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000, 0b00000000,
        0b00000000, 0b00000000,
    ];

    static MY_BITMAP_FONT: BitmapFont =
        BitmapFont::new_8x16(65 /* 'A' */, 8, 16, &MY_BITMAP_GLYPHS);

    struct CustomFontImpl;
    impl Font for CustomFontImpl {
        fn advance(&self) -> u32 {
            10
        }
        fn line_height(&self) -> u32 {
            14
        }
        fn draw_glyph(&self, _ch: char, draw_pixel: &mut dyn FnMut(i32, i32)) {
            draw_pixel(0, 0);
            draw_pixel(1, 1);
        }
    }

    static DYN_FONT_INSTANCE: CustomFontImpl = CustomFontImpl;

    #[test]
    fn test_custom_font_id() {
        let font_id = FontId::Custom(&MY_CUSTOM_FONT);
        assert_eq!(font_id.advance(), 8);
        assert_eq!(font_id.line_height(), 12);
        assert_eq!(packed_font(font_id).first_char, 32);
        assert_eq!(
            glyph_rows(font_id, ' '),
            [0b111, 0b101, 0b111, 0b101, 0b101]
        );
    }

    #[test]
    fn test_bitmap_font() {
        let font_id = FontId::from(&MY_BITMAP_FONT);
        assert_eq!(font_id.advance(), 8);
        assert_eq!(font_id.line_height(), 16);

        let mut pixels = Vec::new();
        MY_BITMAP_FONT.draw_glyph('A', &mut |x, y| pixels.push((x, y)));
        assert!(!pixels.is_empty());
        assert!(pixels.contains(&(2, 0))); // 0b00111100 has bit at col 2
    }

    #[test]
    fn test_dynamic_font() {
        let font_id = FontId::from(&DYN_FONT_INSTANCE as &'static dyn Font);
        assert_eq!(font_id.advance(), 10);
        assert_eq!(font_id.line_height(), 14);
    }

    #[test]
    fn test_font_id_all_variants_and_glyph_rows() {
        assert_eq!(FontId::Tiny3x5.advance(), 4);
        assert_eq!(FontId::Tiny3x5.line_height(), 6);
        assert_eq!(FontId::Medium4x7.advance(), 5);
        assert_eq!(FontId::Medium4x7.line_height(), 8);
        assert_eq!(FontId::Scaled6x10.advance(), 7);
        assert_eq!(FontId::Scaled6x10.line_height(), 11);
        assert_eq!(FontId::Vector(2).advance(), 16);
        assert_eq!(FontId::Vector(2).line_height(), 24);
        assert_eq!(FontId::Bitmap(&MY_BITMAP_FONT).advance(), 8);
        assert_eq!(FontId::Dynamic(&DYN_FONT_INSTANCE).line_height(), 14);

        let rows = glyph_rows(FontId::Tiny3x5, 'A');
        assert_eq!(rows.len(), 5);
        let missing = glyph_rows(FontId::Tiny3x5, '\u{10FFFF}');
        assert_eq!(missing.len(), 5);
    }

    #[test]
    fn test_packed_font_draw_and_missing_glyph() {
        let mut pixels = Vec::new();
        ASCII_3X5_FONT.draw_glyph('A', &mut |x, y| pixels.push((x, y)));
        assert!(!pixels.is_empty());

        let mut zero = Vec::new();
        ASCII_3X5_FONT.draw_glyph('\u{10FFFF}', &mut |_, _| zero.push(()));
        assert!(zero.is_empty());
    }

    #[test]
    fn test_bitmap_font_glyph_bytes_and_spans() {
        static SINGLE_GLYPHS: [u8; 16] = [0b10000000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        static SINGLE_BITMAP: BitmapFont = BitmapFont::new_8x16(65, 8, 16, &SINGLE_GLYPHS);

        assert!(MY_BITMAP_FONT.glyph_bytes('A').is_some());
        assert!(MY_BITMAP_FONT.glyph_bytes('\u{10FFFF}').is_none());
        assert!(MY_BITMAP_FONT.glyph_bytes(' ').is_none());

        let mut ops = Vec::new();
        MY_BITMAP_FONT.draw_glyph_to('A', |op| ops.push(op));
        assert!(ops.iter().any(|op| matches!(op, GlyphOp::Span(..))));

        let mut single_ops = Vec::new();
        SINGLE_BITMAP.draw_glyph_to('A', |op| single_ops.push(op));
        assert!(single_ops.iter().any(|op| matches!(op, GlyphOp::Pixel(..))));
    }

    #[test]
    fn test_get_vector_glyph_covers_ascii_and_fallback() {
        for ch in (32u8..=126).map(|c| c as char) {
            let _ = get_vector_glyph(ch);
        }
        let fallback = get_vector_glyph('é');
        assert!(!fallback.is_empty());
    }

    /// The face the keypad and every label is drawn in has a glyph for every printable character.
    ///
    /// Found 2026-10-17: "it seems that the fonts does not support symbols". They did not -- all but
    /// nine punctuation marks fell through to the fallback, so a symbol page of keys each showed the
    /// same box. This walks the whole range so the next gap is a failing test rather than a page of
    /// boxes on the glass.
    #[test]
    fn every_printable_character_has_a_glyph_of_its_own() {
        for font in [FontId::Tiny3x5, FontId::Medium4x7, FontId::Scaled6x10] {
            for code in 32u8..=126u8 {
                let ch = code as char;
                assert_ne!(
                    glyph_rows(font, ch),
                    MISSING_GLYPH,
                    "{font:?} has no glyph for {ch:?} ({code})"
                );
            }
        }
    }

    /// The rasterised faces are really there: bigger ink than 3x5, and their own metrics.
    ///
    /// A generated table can be empty, or shifted off its own cell, without anything failing to
    /// compile -- so the shape is checked against what the design was told it would get.
    #[test]
    fn the_rasterised_faces_have_their_own_shape() {
        assert_eq!(glyph_ink_box(FontId::Medium5x7, 'M'), (5, 7));
        assert_eq!(FontId::Medium5x7.advance(), 6);
        assert_eq!(FontId::Medium5x7.line_height(), 9);
        assert_eq!(glyph_ink_box(FontId::Mono6x10, 'M'), (6, 10));
        assert_eq!(glyph_ink_box(FontId::Mono8x16, 'M'), (8, 16));
        assert_eq!(FontId::Mono6x10.advance(), 7);
        assert_eq!(FontId::Mono6x10.line_height(), 12);
        assert_eq!(FontId::Mono8x16.advance(), 9);
        assert_eq!(FontId::Mono8x16.line_height(), 19);

        // Every printable character is drawn, and drawn inside its cell.
        for font in [FontId::Medium5x7, FontId::Mono6x10, FontId::Mono8x16] {
            let (width, height) = glyph_ink_box(font, 'M');
            for code in 33u8..=126u8 {
                let ch = code as char;
                let mut ink = 0usize;
                let mut outside = 0usize;
                for_each_glyph_pixel(font, ch, &mut |dx, dy| {
                    ink += 1;
                    if dx < 0 || dy < 0 || dx >= i32::from(width) || dy >= i32::from(height) {
                        outside += 1;
                    }
                });
                assert!(ink > 0, "{font:?} draws nothing for {ch:?}");
                assert_eq!(outside, 0, "{font:?} draws {ch:?} outside its cell");
            }
        }

        // The ink of a capital is taller than a 3x5 face's whole cell, which is the reason for the
        // exercise: at 8x16 a line of text is legible at arm's length.
        let mut top = i32::MAX;
        let mut bottom = i32::MIN;
        for_each_glyph_pixel(FontId::Mono8x16, 'M', &mut |_, dy| {
            top = top.min(dy);
            bottom = bottom.max(dy);
        });
        assert!(
            bottom - top + 1 > 5,
            "the 8x16 capital is {} rows",
            bottom - top + 1
        );
    }

    /// The two faces draw lower case differently from upper -- the same property the 3x5 table has.
    #[test]
    fn the_rasterised_faces_have_both_cases() {
        for font in [FontId::Medium5x7, FontId::Mono6x10, FontId::Mono8x16] {
            for (lower, upper) in [('a', 'A'), ('e', 'E'), ('g', 'G'), ('q', 'Q')] {
                let real = |ch: char| {
                    let mut pixels = Vec::new();
                    for_each_glyph_pixel(font, ch, &mut |dx, dy| pixels.push((dx, dy)));
                    pixels
                };
                assert_ne!(
                    real(lower),
                    real(upper),
                    "{font:?}: {lower:?} is drawn as {upper:?}"
                );
            }
        }
    }

    /// Lower case is its own drawing, which is what makes a Shift key a thing you can see.
    ///
    /// The table used to fold case with `to_ascii_uppercase`, so a keypad's `q` and `Q` were the same
    /// pixels and pressing Shift changed nothing on the glass.
    #[test]
    fn lower_case_is_drawn_differently_from_upper_case() {
        for (lower, upper) in [('a', 'A'), ('g', 'G'), ('m', 'M'), ('q', 'Q'), ('z', 'Z')] {
            for font in [FontId::Tiny3x5, FontId::Scaled6x10] {
                assert_ne!(
                    glyph_rows(font, lower),
                    glyph_rows(font, upper),
                    "{font:?}: {lower:?} and {upper:?} are the same pixels"
                );
            }
        }
    }
}
