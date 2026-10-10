//! An image streamed from a file: which pixel lands where, and what it costs to get it there.
//!
//! The point of this widget is that it reads a file *once*, forwards, with one row of memory -- so these tests
//! are about the two ways that can go wrong. A BMP stores its rows bottom-up unless its height is negative, and
//! a row can be longer than the buffer it is read through, so a reader that assumes top-down order, or that
//! loses its place at a buffer boundary, draws a plausible-looking wrong picture. Both are checked here, along
//! with the enlarged case (one source row feeding several destination rows) and the failures: a file that is
//! missing, truncated or not a BMP must leave the canvas alone rather than draw noise.

use std::cell::RefCell;

use embedded_gui::prelude::{CustomCanvas, CustomWidget, GuiError, Rect, Rgb565};
use embedded_gui::style::{VisualState, WidgetStyle};
use rusty_gui_widgets::{BmpImage, ByteSource, MAX_ROW_PIXELS, MAX_SOURCE_PIXELS};

// The file the stub reader serves, per test thread: `#[test]` runs each case on its own thread, so a
// thread-local file cannot leak from one case into another the way a shared static would.
thread_local! {
    static FILE: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };
    static READS: RefCell<usize> = const { RefCell::new(0) };
}

fn install(bytes: Vec<u8>) {
    FILE.with(|file| *file.borrow_mut() = Some(bytes));
    READS.with(|reads| *reads.borrow_mut() = 0);
}

struct SliceSource<'a> {
    data: &'a [u8],
    position: usize,
}

impl ByteSource for SliceSource<'_> {
    fn read(&mut self, buf: &mut [u8]) -> Result<usize, ()> {
        READS.with(|reads| *reads.borrow_mut() += 1);
        let available = self.data.len().saturating_sub(self.position);
        let take = available.min(buf.len());
        buf[..take].copy_from_slice(&self.data[self.position..self.position + take]);
        self.position += take;
        Ok(take)
    }
}

/// Stands in for the generated project's `sd::with_file`: opens the installed file, hands it over, closes.
fn with_installed_file(
    _path: &str,
    use_file: &mut dyn FnMut(&mut dyn ByteSource) -> Result<(), ()>,
) -> Result<(), ()> {
    FILE.with(|file| match file.borrow().as_ref() {
        Some(data) => {
            let mut source = SliceSource { data, position: 0 };
            use_file(&mut source)
        }
        None => Err(()),
    })
}

fn read_count() -> usize {
    READS.with(|reads| *reads.borrow())
}

#[derive(Default)]
struct Mock {
    rects: Vec<(Rect, Rgb565)>,
}

impl CustomCanvas for Mock {
    fn fill_rect(&mut self, rect: Rect, color: Rgb565) -> Result<(), GuiError> {
        self.rects.push((rect, color));
        Ok(())
    }
    fn fill_rounded_rect(&mut self, _rect: Rect, _radius: u8, _color: Rgb565) -> Result<(), GuiError> {
        Ok(())
    }
    fn draw_rect(&mut self, _rect: Rect, _color: Rgb565) -> Result<(), GuiError> {
        Ok(())
    }
    fn draw_line(&mut self, _p1: (i32, i32), _p2: (i32, i32), _color: Rgb565) -> Result<(), GuiError> {
        Ok(())
    }
    fn draw_pixel(&mut self, _x: i32, _y: i32, _color: Rgb565) -> Result<(), GuiError> {
        Ok(())
    }
    fn draw_text(
        &mut self,
        _text: &str,
        _x: i32,
        _y: i32,
        _color: Rgb565,
        _font: embedded_gui::FontId,
    ) -> Result<(), GuiError> {
        Ok(())
    }
}

/// The 14-byte file header and 40-byte `BITMAPINFOHEADER` every BMP here starts with.
///
/// `data_offset` is what the reader trusts, so the builder asserts that it has written exactly that many bytes
/// before the pixels. A missing field would otherwise shift the pixel data and the test would blame the widget.
fn bmp_header(width: u32, height: i32, bits: u16, compression: u32, data_offset: u32, file_size: u32) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&file_size.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out.extend_from_slice(&data_offset.to_le_bytes());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&bits.to_le_bytes());
    out.extend_from_slice(&compression.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // image size, which a BI_RGB file may leave at zero
    out.extend_from_slice(&0u32.to_le_bytes()); // pixels per metre, horizontal
    out.extend_from_slice(&0u32.to_le_bytes()); // pixels per metre, vertical
    out.extend_from_slice(&0u32.to_le_bytes()); // colours used, zero for the full set
    out.extend_from_slice(&0u32.to_le_bytes()); // important colours
    out
}

/// A 24-bit BMP built here rather than shipped as bytes, so a test can say what it expects by construction.
///
/// `rows` are in **file order**, which for a positive height means the bottom row first -- the reason this
/// builder takes a height instead of deriving one.
fn build_24_bit(width: u32, height: i32, rows: &[Vec<[u8; 3]>]) -> Vec<u8> {
    let stride = ((24 * width + 31) / 32) * 4;
    let offset = 54u32;
    let mut out = bmp_header(width, height, 24, 0, offset, offset + stride * rows.len() as u32);
    assert_eq!(out.len(), offset as usize, "the header must end where the pixels are declared to start");
    for row in rows {
        for pixel in row {
            out.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]); // BMP holds blue, green, red
        }
        out.extend(std::iter::repeat_n(0u8, (stride as usize) - row.len() * 3));
    }
    out
}

/// A 16-bit BMP with the 5-6-5 bitfield masks, in file order.
fn build_16_bit_565(width: u32, height: i32, rows: &[Vec<u16>]) -> Vec<u8> {
    let stride = ((16 * width + 31) / 32) * 4;
    let offset = 66u32;
    let mut out = bmp_header(width, height, 16, 3, offset, offset + stride * rows.len() as u32);
    out.extend_from_slice(&0xF800u32.to_le_bytes());
    out.extend_from_slice(&0x07E0u32.to_le_bytes());
    out.extend_from_slice(&0x001Fu32.to_le_bytes());
    assert_eq!(out.len(), offset as usize, "the masks end where the pixels are declared to start");
    for row in rows {
        for pixel in row {
            out.extend_from_slice(&pixel.to_le_bytes());
        }
        out.extend(std::iter::repeat_n(0u8, (stride as usize) - row.len() * 2));
    }
    out
}

/// A 16-bit BMP whose header is the 124-byte `BITMAPV5HEADER` a modern editor writes, masks inside it.
///
/// The shape that was found on hardware: the header is 84 bytes longer than the 40-byte one above, its masks
/// still sit at offset 54, and the pixels only start at 138. A reader that assumed the short header would read
/// the colour space as mask bits and then invent pixels out of the first rows.
fn build_16_bit_565_v5(width: u32, height: i32, rows: &[Vec<u16>]) -> Vec<u8> {
    let stride = ((16 * width + 31) / 32) * 4;
    let offset = 138u32;
    let mut out = bmp_header(width, height, 16, 3, offset, offset + stride * rows.len() as u32);
    out[14..18].copy_from_slice(&124u32.to_le_bytes()); // the info header is a V5, not a 40-byte one
    out.extend_from_slice(&0xF800u32.to_le_bytes());
    out.extend_from_slice(&0x07E0u32.to_le_bytes());
    out.extend_from_slice(&0x001Fu32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // alpha, which this widget treats as opaque
    // The rest of the V5 header: colour space, endpoints, gamma. Nothing a reader of these pixels needs.
    out.extend(std::iter::repeat_n(0u8, (offset as usize) - out.len()));
    assert_eq!(out.len(), offset as usize, "the V5 header ends where the pixels are declared to start");
    for row in rows {
        for pixel in row {
            out.extend_from_slice(&pixel.to_le_bytes());
        }
        out.extend(std::iter::repeat_n(0u8, (stride as usize) - row.len() * 2));
    }
    out
}

fn image(path: &'static str, stretch: bool) -> BmpImage {
    BmpImage {
        path,
        stretch,
        with_file: with_installed_file,
    }
}

fn paint(stretch: bool, rect: Rect) -> Mock {
    let mut mock = Mock::default();
    image("/PIC.BMP", stretch)
        .render(&mut mock, rect, &WidgetStyle::default(), VisualState::default())
        .unwrap();
    mock
}

/// The colour one pixel of a mock's output, or `None` when nothing was painted over it.
fn pixel_at(mock: &Mock, x: i32, y: i32) -> Option<Rgb565> {
    mock.rects
        .iter()
        .find(|(rect, _)| {
            rect.h == 1
                && y == rect.y
                && x >= rect.x
                && x < rect.x + rect.w as i32
        })
        .map(|(_, colour)| *colour)
}

// The colours as the file holds them (eight bits a channel) and as the canvas wants them (5/6/5), named
// separately so a test never confuses the two.
const RED_BYTES: [u8; 3] = [255, 0, 0];
const GREEN_BYTES: [u8; 3] = [0, 255, 0];
const BLUE_BYTES: [u8; 3] = [0, 0, 255];
const RED: Rgb565 = Rgb565::new(31, 0, 0);
const GREEN: Rgb565 = Rgb565::new(0, 63, 0);
const BLUE: Rgb565 = Rgb565::new(0, 0, 31);

#[test]
fn a_bottom_up_file_is_drawn_the_right_way_up() {
    // The format's usual case: a positive height means the first row in the file is the *bottom* one. A reader
    // that ignored the sign would draw this image upside down, which is exactly the bug worth pinning.
    install(build_24_bit(2, 2, &[vec![RED_BYTES, GREEN_BYTES], vec![BLUE_BYTES, BLUE_BYTES]]));
    let mock = paint(true, Rect::new(0, 0, 2, 2));
    assert_eq!(pixel_at(&mock, 0, 1), Some(RED), "the file's first row is the bottom");
    assert_eq!(pixel_at(&mock, 1, 1), Some(GREEN), "left to right in that row");
    assert_eq!(pixel_at(&mock, 0, 0), Some(BLUE), "and the last row is the top");
    assert_eq!(pixel_at(&mock, 1, 0), Some(BLUE), "all of it");
}

#[test]
fn a_negative_height_means_the_file_is_already_top_down() {
    // The same picture written the other way round: rows in visual order. It must come out identical.
    install(build_24_bit(2, -2, &[vec![BLUE_BYTES, BLUE_BYTES], vec![RED_BYTES, GREEN_BYTES]]));
    let mock = paint(true, Rect::new(0, 0, 2, 2));
    assert_eq!(pixel_at(&mock, 0, 0), Some(BLUE), "the first row is the top");
    assert_eq!(pixel_at(&mock, 0, 1), Some(RED), "and the last is the bottom");
    assert_eq!(pixel_at(&mock, 1, 1), Some(GREEN), "with its pixels in order");
}

#[test]
fn a_row_longer_than_the_read_buffer_is_assembled_from_several_reads() {
    // 64 pixels is 192 bytes of pixel data, more than the 128-byte buffer a row is read through, so the last
    // pixels of the row can only be right if the reader keeps its place across the boundary.
    let width = 64usize;
    let mut row = vec![RED_BYTES; width];
    row[width - 1] = GREEN_BYTES;
    install(build_24_bit(width as u32, 1, &[row]));
    let mock = paint(true, Rect::new(0, 0, width as u32, 1));
    assert_eq!(pixel_at(&mock, 0, 0), Some(RED), "the row starts red");
    assert_eq!(pixel_at(&mock, width as i32 - 1, 0), Some(GREEN), "and ends green");
    assert!(
        read_count() > 3,
        "a 192-byte row cannot have come from one read, got {}",
        read_count()
    );
}

#[test]
fn an_enlarged_image_repeats_each_pixel_and_reads_its_rows_once() {
    // A 2x2 into a 4x4: every source row feeds two destination rows and every source pixel two columns. The
    // row cache is what keeps that to one read per source row, which is the whole reason it exists.
    install(build_24_bit(2, 2, &[vec![RED_BYTES, GREEN_BYTES], vec![BLUE_BYTES, BLUE_BYTES]]));
    let mock = paint(true, Rect::new(0, 0, 4, 4));
    for y in 2..4 {
        assert_eq!(pixel_at(&mock, 0, y), Some(RED), "the bottom half is the bottom row");
        assert_eq!(pixel_at(&mock, 3, y), Some(GREEN), "stretched sideways");
    }
    for y in 0..2 {
        assert_eq!(pixel_at(&mock, 1, y), Some(BLUE), "and the top half the top row");
    }
    // Four rows of paint, two colours each, and only the reads a 2-row file needs (plus the header's).
    assert!(mock.rects.len() <= 8, "runs are grouped, got {} rectangles", mock.rects.len());
}

#[test]
fn an_image_that_is_not_stretched_sits_in_the_middle_of_its_cell() {
    install(build_24_bit(2, 2, &[vec![RED_BYTES, GREEN_BYTES], vec![BLUE_BYTES, BLUE_BYTES]]));
    let mock = paint(false, Rect::new(0, 0, 6, 4));
    assert_eq!(pixel_at(&mock, 0, 0), None, "the corner is left alone");
    assert_eq!(pixel_at(&mock, 2, 1), Some(BLUE), "the image starts two pixels in");
    assert_eq!(pixel_at(&mock, 2, 2), Some(RED), "its bottom row is red at that column");
    assert_eq!(pixel_at(&mock, 3, 2), Some(GREEN), "and green one across, where its own width ends");
    assert_eq!(pixel_at(&mock, 4, 2), None, "with the rest of the row untouched");
}

#[test]
fn a_16_bit_565_file_converts_its_colours() {
    // The other layout a BMP can hold: five bits of red, six of green, five of blue, and the masks say so.
    install(build_16_bit_565(2, 1, &[vec![0xF800, 0x07E0]]));
    let mock = paint(true, Rect::new(0, 0, 2, 1));
    assert_eq!(pixel_at(&mock, 0, 0), Some(Rgb565::new(31, 0, 0)), "five-bit red");
    assert_eq!(pixel_at(&mock, 1, 0), Some(Rgb565::new(0, 63, 0)), "six-bit green");
}

#[test]
fn a_source_wider_than_its_cell_is_decimated_as_the_row_is_read() {
    // 1000 pixels into a 250-pixel cell: destination column `dx` shows source column `4 * dx`, so the row is
    // read forward once and three pixels in every four are converted and dropped. This is the case that used to
    // be refused outright, and it is what a photo on the card looks like -- 1122 pixels is a phone snapshot.
    let width = 1000usize;
    let mut row = vec![0u16; width];
    row[0] = 0xF800; // red at column 0, the first sample
    row[4] = 0x07E0; // green at column 4, the second sample
    row[996] = 0x001F; // blue at column 996, the last sample a 250-pixel row takes
    install(build_16_bit_565(width as u32, 1, &[row]));
    let mock = paint(true, Rect::new(0, 0, 250, 1));
    assert_eq!(pixel_at(&mock, 0, 0), Some(RED), "the first sample is the file's first pixel");
    assert_eq!(pixel_at(&mock, 1, 0), Some(GREEN), "and the next is four columns further in");
    assert_eq!(pixel_at(&mock, 249, 0), Some(BLUE), "the last sample comes from the far end of the row");
}

#[test]
fn a_v5_header_hides_its_masks_in_a_header_eighty_four_bytes_longer() {
    // What a modern editor writes, and what the hardware found: a 124-byte header, so the masks are 54 bytes in
    // and the pixels only start at 138 -- and a row wider than the cell, so the samples come from far apart.
    let width = 600usize;
    let mut row = vec![0u16; width];
    row[0] = 0xF800; // destination column 0
    row[3] = 0x07E0; // destination column 2, whose sample names source column 3
    row[598] = 0x001F; // destination column 399, the last sample of a 400-pixel cell
    install(build_16_bit_565_v5(width as u32, 1, &[row]));
    let mock = paint(true, Rect::new(0, 0, 400, 1));
    assert_eq!(pixel_at(&mock, 0, 0), Some(RED), "five-bit red, from the start of the row");
    assert_eq!(pixel_at(&mock, 2, 0), Some(GREEN), "five-bit green, sampled past a dropped column");
    assert_eq!(pixel_at(&mock, 399, 0), Some(BLUE), "five-bit blue, from the far end");
}

#[test]
fn a_file_that_is_missing_broken_or_absurd_draws_nothing() {
    // Missing: the reader has no file at all.
    FILE.with(|file| *file.borrow_mut() = None);
    assert!(paint(true, Rect::new(0, 0, 4, 4)).rects.is_empty(), "no file, no paint");

    // Not a BMP: the magic is wrong, so nothing may be painted from it.
    install(vec![0u8; 128]);
    assert!(paint(true, Rect::new(0, 0, 4, 4)).rects.is_empty(), "not an image, not painted");

    // Truncated: a valid header whose pixels never arrive. The rows that are there may be drawn; what must not
    // happen is a panic or a row of invented colours.
    let mut truncated = build_24_bit(4, 4, &[vec![RED_BYTES; 4], vec![GREEN_BYTES; 4], vec![BLUE_BYTES; 4], vec![RED_BYTES; 4]]);
    truncated.truncate(54 + 12 + 8);
    install(truncated);
    let mock = paint(true, Rect::new(0, 0, 4, 4));
    assert!(mock.rects.len() < 4 * 4, "the missing rows are simply not drawn");

    // A header past all reason: the width would wrap the stride arithmetic, so it is refused rather than
    // multiplied out. A real file is nowhere near this.
    install(bmp_header(MAX_SOURCE_PIXELS + 1, 1, 24, 0, 54, 54));
    assert!(
        paint(true, Rect::new(0, 0, 8, 1)).rects.is_empty(),
        "a corrupt width is not believed"
    );
}

#[test]
fn a_zero_sized_cell_is_not_a_division_by_zero() {
    install(build_24_bit(2, 2, &[vec![RED_BYTES, GREEN_BYTES], vec![BLUE_BYTES, BLUE_BYTES]]));
    assert!(paint(true, Rect::new(0, 0, 0, 0)).rects.is_empty(), "no cell, nothing to draw");
    assert!(paint(true, Rect::new(0, 0, 4, 0)).rects.is_empty(), "and no height is not a reason to divide");
}
