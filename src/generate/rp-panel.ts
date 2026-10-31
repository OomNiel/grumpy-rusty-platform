/**
 * The `src/panel.rs` a Pico Designer project is born with -- and which the Designer rewrites on every save.
 *
 * Why a generated module rather than lines in `main.rs`: `src/main.rs` is written once and belongs to the
 * user from then on (its loop is where their own code goes). The pins, on the other hand, have to stay
 * changeable from the Designer for ever. So the hardware lives in a file the Designer owns, exactly as
 * `src/ui.kdl` and `src/ui.rs` are owned by it, and `main.rs` only ever says
 *
 *     let (mut hardware, rest) = panel::init(p);
 *
 * -- one call whose shape never changes when a GPIO moves.
 *
 * `panel::init` takes `Peripherals` **by value** rather than by reference. An exclusive `&mut Peripherals`
 * would be held for the life of the program (the display outlives setup), and that would make every other
 * peripheral unreachable -- including the wireless chip's own four pins. Taking it by value lets this
 * module take what it needs and hand the rest back in a generated `Rest` struct, so `main.rs` can still
 * bring the radio up without naming a single display pin.
 *
 * Everything here is pure text generation: no `vscode`, no filesystem. The emitter is asserted by the t1
 * layer and, for real, by compiling a generated project for thumbv6m and thumbv8m.
 */

import type { RpBoardProfile } from '../boards/types';
import {
    cardSharesPanelBus,
    panelModule,
    type PanelModule,
    type PanelWiring,
    spiIndexOf,
} from '../boards/panels';

export interface RpPanelOptions {
    board: RpBoardProfile;
    wiring: PanelWiring;
    /** Whether the project drives the module's touch controller (the `TOUCH` constant in main.rs). */
    touch: boolean;
    /** Whether the card module (`src/sd.rs`) is compiled in, i.e. the `sd` cargo feature. */
    sd: boolean;
}

/** The Rust model name for a controller, as `models::<name>`. */
function modelName(module: PanelModule): string {
    return `models::${module.controller}`;
}

/** `PIN_18` from 18, for the peripheral tokens the generated code moves out of `Peripherals`. */
function pinToken(pin: number): string {
    return `PIN_${pin}`;
}

/** `SPI0`/`SPI1` for a bus index. */
function spiToken(bus: 0 | 1): string {
    return `SPI${bus}`;
}

/** A number as Rust would write it: `_` between thousands, no separators that a compiler would refuse. */
function rustNumber(value: number): string {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}

/**
 * Text as the body of a Rust string literal.
 *
 * The module labels carry their own quote marks ("Generic 2.8\" TFT..."), and a label pasted into an
 * `info!` format string unescaped ends the literal -- which then reads as a run of unknown-prefix errors
 * several lines further on, in code that was fine.
 */
export function rustString(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * The PWM slice and channel a GPIO belongs to.
 *
 * embassy-rp implements `ChannelAPin<Slice>`/`ChannelBPin<Slice>` per pin, and the mapping wraps: GPIO16 is
 * slice 0 channel A again, GPIO22 slice 3 A, GPIO25 slice 4 B. Deriving the number here means the
 * generated code names the slice the HAL requires -- a wrong pair is a compile error rather than a dark
 * backlight.
 */
export function pwmSliceOf(pin: number): { slice: number; channel: 'a' | 'b' } {
    return { slice: Math.floor((pin % 16) / 2), channel: pin % 2 === 0 ? 'a' : 'b' };
}

/**
 * The `src/panel.rs` source for one project.
 *
 * Throws when the wiring names no module: a generated module that cannot say what it is driving would be a
 * file that compiles and shows a blank screen, which is worse than a refusal one layer up.
 */
export function emitPanelRs(options: RpPanelOptions): string {
    const module = panelModule(options.wiring.panel);
    if (module === undefined) {
        throw new Error(`emitPanelRs: "${options.wiring.panel}" is not a module this extension knows`);
    }
    const { board, wiring } = options;
    // The field is the choice; the clock pin is the fallback for a wiring written before the field existed. The
    // two agree whenever the wiring is legal -- `validateWiring` refuses them disagreeing -- so this only decides
    // which one is *trusted*.
    const bus = wiring.bus ?? spiIndexOf(wiring.sclk) ?? 0;
    const cardBus = wiring.sdCs === null ? undefined : spiIndexOf(wiring.sdSclk as number);
    const sharedBus = cardSharesPanelBus(wiring);
    const touch = options.touch && module.touch && wiring.touchCs !== null && wiring.touchIrq !== null;
    const card = options.sd && wiring.sdCs !== null && wiring.sdSclk !== null;
    const reset = wiring.rst !== null;
    const slice = wiring.backlight === null ? undefined : pwmSliceOf(wiring.backlight);

    // ------------------------------------------------------------------ pieces
    const touchTypes = touch
        ? `
/// The touch controller's device handle: the panel's bus, a second chip select.
pub type TouchDevice = CriticalSectionDevice<'static, PanelSpi, Output<'static>, Delay>;

/// The XPT2046, and the interrupt line that says a finger is somewhere on the glass.
///
/// The interrupt is reported rather than trusted: the sampling in \`sample\` is what a touch is actually
/// taken from, because a PENIRQ that floats (or that a module ties low) would otherwise claim a finger
/// held in one place for ever.
pub struct Touch {
    device: TouchDevice,
    /// The bus, so the clock can be slowed for a conversion and put back afterwards: the glass wants tens of
    /// megahertz and an XPT2046 wants one, and they share the pins.
    bus: &'static PanelBus,
    /// What the two axes read with nothing on the glass, measured once at start-up.
    ///
    /// A touch is how far the axes *move* from this, never a pressure channel: an XPT2046's first pressure
    /// reading sits near full scale whether or not anything is touching it, so a threshold on it either never
    /// fires or always does (bench, 2026-10-28 -- the calibration screen appeared and the glass did not
    /// answer, because the controller was reporting a "finger" that was not there).
    idle: (i32, i32),
    /// The controller's PENIRQ line, read by \`pressed\` and otherwise unused: the loop samples instead of
    /// trusting an interrupt that can float low on a module that ties it.
    #[allow(dead_code)]
    irq: Input<'static>,
    /// Whether the last reading was a touch, so a press and a release are logged once each rather than every
    /// sample: the numbers are what says whether the controller is really answering.
    down: bool,
}
`
        : '';

    const touchSetup = touch
        ? `
    // The touch controller: the same bus, a second chip select, and its interrupt line pulled up because
    // these modules' PENIRQ is open drain.
    let touch_cs = Output::new(p.${pinToken(wiring.touchCs as number)}, Level::High);
    let touch_device = CriticalSectionDevice::new(bus, touch_cs, Delay).expect("touch chip select");
    let touch_irq = Input::new(p.${pinToken(wiring.touchIrq as number)}, Pull::Up);
    let mut touch = Touch { device: touch_device, bus, irq: touch_irq, idle: (0, 0), down: false };
    // What "nothing is touching" reads like on this glass. Taken here, at the controller's own clock, so the
    // first sample of the run is already a baseline rather than a guess.
    touch.measure_idle();
    let touch = Some(touch);
    // The calibration, if this board has been calibrated before. A board that has not runs the four corner
    // screen on its first frame instead -- see \`calibrate\`.
    let mut flash = Flash::new_blocking(p.FLASH);
    let calibration = load_calibration(&mut flash);
`
        : `
    let touch = None;
`;

    const backlightSetup =
        slice === undefined
            ? `
    let backlight = None;
`
            : `
    // The backlight, dimmed from the first frame: BACKLIGHT_BRIGHTNESS is a compile-time number, so a
    // project that never mentions it is fully on and one switched off in the Designer comes up dark.
    let mut backlight_config = PwmConfig::default();
    backlight_config.top = BACKLIGHT_TOP;
    backlight_config.compare_${slice.channel} = brightness_compare(BACKLIGHT_PERCENT);
    let backlight = Some(Pwm::new_output_${slice.channel}(
        p.PWM_SLICE${slice.slice},
        p.${pinToken(wiring.backlight as number)},
        backlight_config,
    ));
`;

    // The card, behind the feature that compiles it: switching SD off in the Designer takes the module and
    // this call out together, which is what makes the switch worth having. `#[cfg]` on a block is the only
    // way to gate several statements and the values they define.
    const cardSetup = card
        ? `
    #[cfg(feature = "sd")]
    {
        let card_cs = Output::new(p.${pinToken(wiring.sdCs as number)}, Level::High);
${sharedBus
            ? '        let card_device = CriticalSectionDevice::new(bus, card_cs, Delay).expect("card chip select");'
            : `        let mut card_spi_config = SpiConfig::default();
        card_spi_config.frequency = CARD_CLOCK_HZ;
        let card_spi = Spi::new_blocking(
            p.${spiToken(cardBus ?? 1)},
            p.${pinToken(wiring.sdSclk as number)},
            p.${pinToken(wiring.sdMosi as number)},
            p.${pinToken(wiring.sdMiso as number)},
            card_spi_config,
        );
        let card_device = ExclusiveDevice::new(card_spi, card_cs, Delay).expect("card chip select");`}
        crate::sd::init(card_device, bus);
    }
`
        : '';

    const cardTypes =
        card && wiring.sdCs !== null
            ? `
/// The card's bus and device, as \`src/sd.rs\` receives them.
///
/// The mount and the filesystem live there, because a design reads a file through them, not through this
/// module; here is only the wiring, so one file owns every pin of the assembly.
#[cfg(feature = "sd")]
pub type CardSpi = ${sharedBus ? 'PanelSpi' : `Spi<'static, ${spiToken(cardBus ?? 1)}, Blocking>`};
#[cfg(feature = "sd")]
pub type CardDevice = ${sharedBus
                ? "CriticalSectionDevice<'static, PanelSpi, Output<'static>, Delay>"
                : "ExclusiveDevice<CardSpi, Output<'static>, Delay>"
            };
`
            : '';

    // -------------------------------------------------------------- the Rest struct
    const cyw43 = board.wireless === 'cyw43' ? board.cyw43 : undefined;
    const restFields =
        cyw43 === undefined
            ? ''
            : `
    /// The wireless chip's power switch.
    pub pin${cyw43.pwrPin.slice(4)}: Peri<'static, ${cyw43.pwrPin}>,
    /// The wireless chip's chip select.
    pub pin${cyw43.csPin.slice(4)}: Peri<'static, ${cyw43.csPin}>,
    /// The wireless chip's data line.
    pub pin${cyw43.dioPin.slice(4)}: Peri<'static, ${cyw43.dioPin}>,
    /// The wireless chip's clock.
    pub pin${cyw43.clkPin.slice(4)}: Peri<'static, ${cyw43.clkPin}>,
    /// The PIO block the CYW43's SPI is emulated on.
    pub pio0: Peri<'static, PIO0>,
    /// The DMA channel PIO SPI needs. One, not two: cyw43-pio 0.10 pumps every transfer through a single
    /// channel, and handing the radio a second one would be an idle peripheral pretending to be part of the
    /// wiring.
    pub dma_ch0: Peri<'static, DMA_CH0>,`;

    const restDoc =
        restFields === ''
            ? `/// What this module left of \`Peripherals\`.
///
/// Empty: a board with no wireless chip has nothing outside the panel that main.rs needs. It exists so
/// that \`init\` has the same shape on all four boards.
#[allow(dead_code)]
pub struct Rest;`
            : `/// What this module did *not* take from \`Peripherals\`.
///
/// The wireless chip's own four pins, the PIO block and the two DMA channels its SPI needs: main.rs brings
/// the radio up with these, which is why \`init\` takes the peripherals by value and hands them back. They
/// are listed here rather than in main.rs so that a wiring change never rewrites a line of it.
#[allow(dead_code)]
pub struct Rest {${restFields}
}`;

    const restBuild =
        cyw43 === undefined
            ? 'Rest'
            : `Rest {
        pin${cyw43.pwrPin.slice(4)}: p.${cyw43.pwrPin},
        pin${cyw43.csPin.slice(4)}: p.${cyw43.csPin},
        pin${cyw43.dioPin.slice(4)}: p.${cyw43.dioPin},
        pin${cyw43.clkPin.slice(4)}: p.${cyw43.clkPin},
        pio0: p.PIO0,
        dma_ch0: p.DMA_CH0,
    }`;

    // The rotation is a compile-time setting (`.cargo/config.toml`), so changing it is a rebuild and never
    // a rewrite of this file -- the same rule the ESP side follows with `LCD_ROTATION`.
    const orientation = [
        module.mirrorX ? '.flip_horizontal()' : '',
        module.mirrorY ? '.flip_vertical()' : '',
        '.rotate(ROTATION)',
    ]
        .filter((part) => part !== '')
        .join('');

    const busSetup =
        wiring.miso === null
            ? `    let spi = Spi::new_blocking_txonly(
        p.${spiToken(bus)},
        p.${pinToken(wiring.sclk)},
        p.${pinToken(wiring.mosi)},
        spi_config,
    );`
            : `    let spi = Spi::new_blocking(
        p.${spiToken(bus)},
        p.${pinToken(wiring.sclk)},
        p.${pinToken(wiring.mosi)},
        p.${pinToken(wiring.miso)},
        spi_config,
    );`;

    const misoNote =
        wiring.miso === null
            ? `
    // No data-in line: a write-only glass with nothing to read on this bus. \`new_blocking_txonly\` says so
    // to the HAL, and the pin the wiring does not have is simply not taken.`
            : '';

    return `// Generated by Grumpy's Rusty Platform for VS Code.
// Board: ${board.name} (${board.family}) -- module: ${module.label}
//
// The panel, its touch controller, the card and the backlight, brought up together. The Designer rewrites
// this file whenever the module or a GPIO changes, so your own code belongs in src/ui_handlers.rs (the
// widgets' events) or below the marker in src/main.rs -- not here.

use core::cell::RefCell;

use critical_section::Mutex;
use defmt::info;
use embassy_rp::gpio::{${touch ? 'Input, Level, Output, Pull' : 'Level, Output'
        }};
use embassy_rp::peripherals::*;${slice === undefined ? '' : '\nuse embassy_rp::pwm::{Config as PwmConfig, Pwm};'}
use embassy_rp::spi::{Blocking, Config as SpiConfig, Spi};${cyw43 === undefined ? '' : '\nuse embassy_rp::Peri;'}
use embassy_rp::Peripherals;
use embassy_time::${touch ? '{Duration, Timer}' : 'Duration'};
use embedded_hal::delay::DelayNs;
use embedded_hal_bus::spi::CriticalSectionDevice;
use mipidsi::interface::SpiInterface;
use mipidsi::models;
use mipidsi::options::{ColorOrder, Orientation, Rotation};
use mipidsi::Builder;
use static_cell::StaticCell;
${card && !sharedBus ? '#[cfg(feature = "sd")]\nuse embedded_hal_bus::spi::ExclusiveDevice;\n' : ''}${touch ? 'use embedded_hal::spi::{Operation, SpiDevice};\n' : ''}${touch ? TOUCH_SCREEN_IMPORTS : ''}${module.invertColors ? 'use mipidsi::options::ColorInversion;\n' : ''}
/// The panel's native size, in the module's own orientation. The design is laid out against this; the
/// drawing area follows the rotation.
pub const PANEL_WIDTH: u16 = ${module.width};
pub const PANEL_HEIGHT: u16 = ${module.height};

/// Whether the panel is turned to a landscape orientation.
///
/// The drawing area is the panel's *turned* size: mipidsi swaps the two itself for a vertical rotation, so
/// the design has to be laid out against what the panel will actually paint rather than its native size.
const LANDSCAPE: bool = matches!(ROTATION, Rotation::Deg90 | Rotation::Deg270);
pub const DRAW_WIDTH: u16 = if LANDSCAPE { PANEL_HEIGHT } else { PANEL_WIDTH };
pub const DRAW_HEIGHT: u16 = if LANDSCAPE { PANEL_WIDTH } else { PANEL_HEIGHT };

/// The GPIO numbers this project is wired to, as plain numbers.
///
/// The pins below are the same numbers as peripheral tokens; these are what the log prints, so a project
/// can be read without a debugger. A pin the module does not use is absent.
///
/// Every one is allowed to be unused: a generated project is a starting point, and a design that never
/// reads a touch pin should not warn about the constant that documents it.
#[allow(dead_code)]
pub const PIN_SCLK: u8 = ${wiring.sclk};
#[allow(dead_code)]
pub const PIN_MOSI: u8 = ${wiring.mosi};${wiring.miso === null ? '' : `\n#[allow(dead_code)]\npub const PIN_MISO: u8 = ${wiring.miso};`}
#[allow(dead_code)]
pub const PIN_CS: u8 = ${wiring.cs};
#[allow(dead_code)]
pub const PIN_DC: u8 = ${wiring.dc};${wiring.rst === null ? '' : `\n#[allow(dead_code)]\npub const PIN_RST: u8 = ${wiring.rst};`}${wiring.backlight === null ? '' : `\n#[allow(dead_code)]\npub const PIN_BACKLIGHT: u8 = ${wiring.backlight};`}${touch ? `\n#[allow(dead_code)]\npub const PIN_TOUCH_CS: u8 = ${wiring.touchCs as number};\n#[allow(dead_code)]\npub const PIN_TOUCH_IRQ: u8 = ${wiring.touchIrq as number};` : ''}${card && wiring.sdCs !== null ? `\n#[allow(dead_code)]\npub const PIN_CARD_CS: u8 = ${wiring.sdCs};` : ''}

/// The rotation the panel is built for, from \`.cargo/config.toml\`.
///
/// A compile-time value, so that turning the glass is a rebuild and never an edit of this file: the
/// Designer writes the number, the firmware reads it. Anything but "1", "2" or "3" leaves it upright, which
/// is what keeps a project generated before the setting existed working.
pub const ROTATION: Rotation = match option_env!("LCD_ROTATION") {
    Some(value) if value.len() == 1 && value.as_bytes()[0] == b'1' => Rotation::Deg90,
    Some(value) if value.len() == 1 && value.as_bytes()[0] == b'2' => Rotation::Deg180,
    Some(value) if value.len() == 1 && value.as_bytes()[0] == b'3' => Rotation::Deg270,
    _ => Rotation::Deg0,
};

/// Fully on unless the project says otherwise: a typo reads as 100 rather than as a dark screen.
#[allow(dead_code)]
const BACKLIGHT_PERCENT: u32 = match option_env!("BACKLIGHT_BRIGHTNESS") {
    Some(text) => match parse_percent(text) {
        Some(percent) => percent,
        None => 100,
    },
    None => 100,
};

/// The PWM counter's wrap point, and therefore the step of one brightness percent.
///
/// A divider of 1 (the HAL's default) and this top give about 5 kHz out of the RP2040's 125 MHz -- above
/// anything an eye notices as flicker, with ten bits of duty to dim in.
#[allow(dead_code)]
const BACKLIGHT_TOP: u16 = 25_000;

/// The panel's SPI clock, in Hz: the module's own number, the slow one on the 4 inch glass.
const PANEL_CLOCK_HZ: u32 = ${rustNumber(module.spiHz)};

/// The clock the card is *initialised* at. The SD specification requires the handshake at or below 400 kHz.
///
/// Both card clocks stay in the file whether or not the sd feature is on: the switch belongs to the
/// Designer, and a rebuild with the feature flipped must not need a regenerated file.
#[allow(dead_code)]
const CARD_CLOCK_HZ: u32 = 400_000;

/// The clock the card is read at once it has answered, in Hz.
///
/// The mount in src/sd.rs switches the bus up to this after the handshake; at 400 kHz even a small bitmap
/// takes long enough for the screen to look frozen.
#[allow(dead_code)]
pub const CARD_DATA_CLOCK_HZ: u32 = 10_000_000;

/// Parses the brightness setting, clamping what it finds instead of refusing it.
#[allow(dead_code)]
const fn parse_percent(text: &str) -> Option<u32> {
    let bytes = text.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    let mut value: u32 = 0;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte < b'0' || byte > b'9' {
            return None;
        }
        value = value * 10 + (byte - b'0') as u32;
        index += 1;
    }
    Some(if value > 100 { 100 } else { value })
}

/// The PWM compare value for a brightness percentage, honouring an active-low backlight transistor.
#[allow(dead_code)]
const fn brightness_compare(percent: u32) -> u16 {
    let percent = ${wiring.backlightActiveLow
            ? 'if percent > 100 { 0 } else { 100 - percent }'
            : 'if percent > 100 { 100 } else { percent }'
        };
    ((BACKLIGHT_TOP as u32 * percent) / 100) as u16
}

/// A blocking delay for mipidsi's reset and init timing.
///
/// \`embedded_hal\`'s \`DelayNs\` is the trait the driver asks for, and \`embassy_time\`'s blocking sleep is
/// already here, so no second timer driver is pulled in.
pub struct Delay;

impl DelayNs for Delay {
    fn delay_ns(&mut self, ns: u32) {
        embassy_time::block_for(Duration::from_nanos(u64::from(ns)));
    }
}

/// The panel's SPI bus. Shared rather than owned, so the panel, its touch controller and (when the socket
/// shares it) the card each hold their own chip select over one peripheral.
pub type PanelSpi = Spi<'static, ${spiToken(bus)}, Blocking>;
pub type PanelBus = Mutex<RefCell<PanelSpi>>;
pub type PanelDevice = CriticalSectionDevice<'static, PanelSpi, Output<'static>, Delay>;
pub type PanelInterface = SpiInterface<'static, PanelDevice, Output<'static>>;

/// The panel driver, in the exact shape this module's reset choice gives it.
pub type DisplayDriver = mipidsi::Display<PanelInterface, ${modelName(module)}, ${reset ? "Output<'static>" : 'mipidsi::NoResetPin'}>;
${touchTypes}${cardTypes}
/// The bus, a static because the panel's device borrows it and the panel travels back to main().
static BUS_CELL: StaticCell<PanelBus> = StaticCell::new();

/// mipidsi's batching buffer, for the same reason: the interface owns the borrow.
static BUFFER_CELL: StaticCell<[u8; 512]> = StaticCell::new();

${restDoc}

${slice === undefined ? '' : `/// The backlight's PWM channel.
///
/// embassy-rp's Pwm tracks the slice internally, so the type names no slice; each project gets one channel
/// of its own. Nothing needs to be called on it: the brightness is a compile-time setting
/// (BACKLIGHT_BRIGHTNESS), and the channel exists so that the slice and its pin outlive setup().
pub type Backlight = Pwm<'static>;
`}

/// What the panel bring-up hands back to main.rs.
pub struct Hardware {
    /// The panel, ready to draw on.
    pub display: DisplayDriver,
    /// The touch controller, when the module has one and the project wants it.
    #[allow(dead_code)]
    pub touch: ${touch ? 'Option<Touch>' : 'Option<()>'},
    /// The backlight channel, when the module wires BL. Nothing reads it: it is kept so the channel
    /// outlives setup(), which is what holds the panel lit. Its duty comes from BACKLIGHT_BRIGHTNESS, so
    /// the Designer's Brightness slider reaches the glass.
    #[allow(dead_code)]
    pub backlight: ${slice === undefined ? 'Option<()>' : 'Option<Backlight>'},
    /// The bus, for anything that needs to re-clock it -- the card's mount, and src/sd.rs when the socket
    /// shares it. Nothing reads it in a project without a card, which is not a mistake.
    #[allow(dead_code)]
    pub bus: &'static PanelBus,
${touch ? `    /// The flash the touch calibration is kept in -- the first sector of the region the board reserves, so a
    /// write can never reach the application.
    pub flash: PanelFlash,
    /// The measured touch mapping, once the glass has been calibrated. \`None\` until the corners have been
    /// touched, which is what makes a new board ask for them on its first run.
    pub calibration: Option<TouchCalibration>,
` : ''}}

/// Brings up the panel, its touch controller, the card and the backlight.
///
/// Called once from \`setup()\`. A failure here is a panic: a panel that did not initialise cannot be drawn
/// on, and a program that carries on without one is a blank screen with no explanation.
pub fn init(p: Peripherals) -> (Hardware, Rest) {
    // --- the bus. The panel's own clock from the start.
    let mut spi_config = SpiConfig::default();
    spi_config.frequency = PANEL_CLOCK_HZ;
${busSetup}${misoNote}
    let bus: &'static PanelBus = BUS_CELL.init(Mutex::new(RefCell::new(spi)));

    // --- the panel. Its chip select is held by the bus device, so CS stays asserted across a whole
    // transaction, which is what mipidsi's batched writes need.
    let panel_cs = Output::new(p.${pinToken(wiring.cs)}, Level::High);
    let panel_device = CriticalSectionDevice::new(bus, panel_cs, Delay).expect("panel chip select");
    let dc = Output::new(p.${pinToken(wiring.dc)}, Level::Low);
    let buffer = BUFFER_CELL.init([0u8; 512]);
    let di = SpiInterface::new(panel_device, dc, buffer);

    let mut delay = Delay;
    let display = Builder::new(${modelName(module)}, di)
        .display_size(PANEL_WIDTH, PANEL_HEIGHT)${reset
            ? `
        // The module's RESET is wired, so mipidsi drives it: a real reset pulse beats the soft-reset command
        // some of these glasses ignore.
        .reset_pin(Output::new(p.${pinToken(wiring.rst as number)}, Level::High))`
            : ''
        }
        // The glass, not the driver: a wrong colour order turns white into a colour, a missing flip puts
        // the origin in the wrong corner, and colour inversion turns white black. All three are catalogue
        // facts checked on real modules.
        .color_order(ColorOrder::${module.colorOrder === 'bgr' ? 'Bgr' : 'Rgb'})${module.invertColors ? '\n        .invert_colors(ColorInversion::Inverted)' : ''
        }
        .orientation(Orientation::new()${orientation})
        .init(&mut delay)
        .expect("panel initialisation");

    info!(
        "panel: ${rustString(module.label)} ready (sck {} mosi {} cs {} dc {})",
        PIN_SCLK,
        PIN_MOSI,
        PIN_CS,
        PIN_DC
    );
${touchSetup}${backlightSetup}${cardSetup}
    (
        Hardware {
            display,
            touch,
            backlight,
            bus,${touch ? '\n            flash,\n            calibration,' : ''}
        },
        ${restBuild},
    )
}${touch ? touchImplementation() : ''}${touch ? touchCalibration(flashLayout(board)) : ''}`;
}

/**
 * The imports the four corner screen needs.
 *
 * Only emitted for a module with a controller: a project without one would warn about every one of them.
 */
const TOUCH_SCREEN_IMPORTS =
    'use embassy_rp::flash::{Blocking as FlashBlocking, Flash};\n' +
    'use embedded_graphics::draw_target::DrawTarget;\n' +
    'use embedded_graphics::geometry::Point;\n' +
    'use embedded_graphics::mono_font::ascii::FONT_6X10;\n' +
    'use embedded_graphics::mono_font::MonoTextStyle;\n' +
    'use embedded_graphics::pixelcolor::{Rgb565, RgbColor};\n' +
    'use embedded_graphics::prelude::Primitive;\n' +
    'use embedded_graphics::primitives::{Circle, Line, PrimitiveStyle};\n' +
    'use embedded_graphics::text::Text;\n' +
    'use embedded_graphics::Drawable;\n';

/**
 * The reserved flash the calibration is kept in, and the size of the whole flash.
 *
 * Every Pico board profile reserves a region for storage -- 512 KB at 0x10180000 on a 2 MB board, 1 MB at
 * 0x10300000 on a 4 MB one -- so a record written at its start can never reach the application image. The
 * driver wants the whole capacity as a constant, which is the end of that region.
 */
function flashLayout(board: RpBoardProfile): { offset: number; bytes: number } {
    // The flash driver counts from the start of the chip, not from where the application is linked: a Pico's
    // memory.x begins at 0x10000100, behind the 256-byte second-stage bootloader, and the records are still
    // offsets from 0x10000000.
    const FLASH_BASE = 0x10000000;
    const reserve = board.memory.flashReserve;
    if (reserve === undefined) {
        throw new Error(
            `${board.name} reserves no flash region, so a touch calibration has nowhere to be kept`,
        );
    }
    const start = Number.parseInt(reserve.region.origin, 16);
    const length = Number.parseInt(reserve.region.length, 10) * (/k$/i.test(reserve.region.length) ? 1024 : 1);
    const offset = start - FLASH_BASE;
    if (offset % 4096 !== 0) {
        // A sector erase has to start on a sector boundary: a record written past one would be lost the next
        // time anything erased the sector beside it.
        throw new Error(`${board.name} reserves its flash at 0x${offset.toString(16)}, which is not a 4 KB boundary`);
    }
    return { offset, bytes: start + length - FLASH_BASE };
}

/**
 * The measured touch mapping, and the four corner screen that measures it.
 *
 * The defaults in the driver are one panel's guess: an XPT2046's raw counts differ from glass to glass, and
 * which of its two axes follows the design's X depends on how the module was wired. So the corners are
 * *measured* -- the first run asks for each one, the raw counts at those four places are what the mapping is
 * built from, and the result is kept in the reserved flash so a board asks once and never again.
 *
 * The corners are asked for in the drawing area, not in panel pixels, which is why the mapping needs no
 * rotation arithmetic: the numbers are measured where the design lives.
 */
function touchCalibration(layout: { offset: number; bytes: number }): string {
    return `
/// Where the calibration record lives: the first sector of the region the board reserves for storage, so a
/// write here can never reach the application image.
const TOUCH_CAL_OFFSET: u32 = 0x${layout.offset.toString(16)};
/// The whole flash, which the driver wants as a constant.
const FLASH_BYTES: usize = ${layout.bytes};
/// "GRTC": so a blank sector, or one holding something else, is not read as a calibration.
const TOUCH_CAL_MAGIC: u32 = 0x4752_5443;
/// One erase sector. The record is sixteen bytes; the flash erases in these.
const TOUCH_CAL_SECTOR: u32 = 4096;
/// How far inside the glass an asked-for corner sits, in drawing pixels.
const CAL_MARGIN: i32 = 24;
/// How many readings a corner finger has to hold still for before it is taken.
const CAL_HOLD: u32 = 5;
/// How close two readings have to be to count as still, in raw counts.
const CAL_STILL: i32 = 24;

/// The flash driver this module uses: blocking mode, over the whole chip so the driver can check its bounds.
pub type PanelFlash = Flash<'static, FLASH, FlashBlocking, FLASH_BYTES>;

/// A measured touch mapping: which raw axis follows the design's X, and the raw counts at two places on each
/// axis, taken at the four corners the screen asks for.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct TouchCalibration {
    /// The panel's rotation when the corners were measured. The corners map onto the *drawing area*, so a
    /// different rotation is a different area and these numbers no longer describe it.
    rotation: u8,
    /// 0 when the first raw axis follows the design's X, 1 when it is the second.
    x_axis: u8,
    x_from: i32,
    x_to: i32,
    y_from: i32,
    y_to: i32,
}

impl TouchCalibration {
    /// A raw reading in drawing-area pixels, or \`None\` when this calibration was measured on another
    /// rotation than the one this project is built for.
    pub fn pixel(&self, raw_a: i32, raw_b: i32) -> Option<(i32, i32)> {
        if self.rotation != rotation_degrees() {
            return None;
        }
        let raw_x = if self.x_axis == 0 { raw_a } else { raw_b };
        let raw_y = if self.x_axis == 0 { raw_b } else { raw_a };
        Some((
            touch_linear(raw_x, self.x_from, self.x_to, DRAW_WIDTH as i32),
            touch_linear(raw_y, self.y_from, self.y_to, DRAW_HEIGHT as i32),
        ))
    }

    fn to_bytes(self) -> [u8; 16] {
        let mut bytes = [0u8; 16];
        bytes[0..4].copy_from_slice(&TOUCH_CAL_MAGIC.to_le_bytes());
        bytes[4] = self.rotation;
        bytes[5] = self.x_axis;
        bytes[8..10].copy_from_slice(&(self.x_from as i16).to_le_bytes());
        bytes[10..12].copy_from_slice(&(self.x_to as i16).to_le_bytes());
        bytes[12..14].copy_from_slice(&(self.y_from as i16).to_le_bytes());
        bytes[14..16].copy_from_slice(&(self.y_to as i16).to_le_bytes());
        bytes
    }

    fn from_bytes(bytes: &[u8; 16]) -> Option<Self> {
        if u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) != TOUCH_CAL_MAGIC {
            return None;
        }
        let word = |at: usize| i32::from(i16::from_le_bytes([bytes[at], bytes[at + 1]]));
        Some(Self {
            rotation: bytes[4],
            x_axis: bytes[5],
            x_from: word(8),
            x_to: word(10),
            y_from: word(12),
            y_to: word(14),
        })
    }
}

/// The rotation as the record stores it: degrees.
fn rotation_degrees() -> u8 {
    ROTATION.degree() as u8
}

/// One calibrated axis onto the drawing area, clamped to the glass.
///
/// The corners were touched \`CAL_MARGIN\` inside the glass, so the raw counts map onto the space between
/// those targets rather than onto the whole screen: a finger outside the outermost target reads past it and
/// is clamped, which is what keeps a coordinate on the panel.
fn touch_linear(raw: i32, from: i32, to: i32, size: i32) -> i32 {
    if to == from || size <= 2 * CAL_MARGIN + 2 {
        return size / 2;
    }
    let travel = size - 1 - 2 * CAL_MARGIN;
    (CAL_MARGIN + (raw - from) * travel / (to - from)).clamp(0, size - 1)
}

/// The stored calibration, when there is one and it was measured for this project's rotation.
pub fn load_calibration(flash: &mut PanelFlash) -> Option<TouchCalibration> {
    let mut bytes = [0u8; 16];
    if flash.blocking_read(TOUCH_CAL_OFFSET, &mut bytes).is_err() {
        return None;
    }
    let calibration = TouchCalibration::from_bytes(&bytes)?;
    if calibration.rotation != rotation_degrees() {
        // Measured on a turned panel: the drawing area has changed shape since, so the numbers describe
        // somewhere that is no longer on the screen.
        info!(
            "touch: a calibration was stored for rotation {}, but this project is built for {}",
            calibration.rotation,
            rotation_degrees()
        );
        return None;
    }
    info!(
        "touch: calibration loaded (axis{}, x {}..{}, y {}..{})",
        calibration.x_axis, calibration.x_from, calibration.x_to, calibration.y_from, calibration.y_to
    );
    Some(calibration)
}

/// Keeps a measured calibration in the reserved flash, and says whether it stuck.
fn save_calibration(flash: &mut PanelFlash, calibration: &TouchCalibration) -> bool {
    let bytes = calibration.to_bytes();
    flash.blocking_erase(TOUCH_CAL_OFFSET, TOUCH_CAL_OFFSET + TOUCH_CAL_SECTOR).is_ok()
        && flash.blocking_write(TOUCH_CAL_OFFSET, &bytes).is_ok()
}

/// Throws the stored calibration away, so the next run asks for the corners again.
///
/// The sector is erased rather than overwritten: an erased sector has no magic, which is what \`load\`
/// reads as "never calibrated".
pub fn forget_calibration(flash: &mut PanelFlash) -> bool {
    flash.blocking_erase(TOUCH_CAL_OFFSET, TOUCH_CAL_OFFSET + TOUCH_CAL_SECTOR).is_ok()
}

/// The one place the design's pointer comes from: a raw reading through the measured mapping.
///
/// \`None\` when nothing is pressing, and also when this board has never been calibrated -- there is no
/// honest guess to fall back on, and a pointer in the wrong place is worse than none.
pub fn touch_point(hardware: &mut Hardware) -> Option<(i32, i32)> {
    let calibration = hardware.calibration?;
    let (raw_a, raw_b) = hardware.touch.as_mut()?.read_raw()?;
    calibration.pixel(raw_a, raw_b)
}

/// Asks for the four corners, measures them, and keeps the result.
///
/// Runs on the first frame of a board that has never been calibrated, and again whenever the top-left corner
/// is held -- see the loop in main.rs. Each corner waits for a finger that has *stopped*: a reading taken
/// while the finger is still sliding is a reading from somewhere between two corners.
pub async fn calibrate(hardware: &mut Hardware) -> Option<TouchCalibration> {
    info!("touch: no calibration stored -- touch each corner when it is marked");
    let targets = [
        ("top-left", Point::new(CAL_MARGIN, CAL_MARGIN)),
        ("top-right", Point::new(DRAW_WIDTH as i32 - 1 - CAL_MARGIN, CAL_MARGIN)),
        (
            "bottom-right",
            Point::new(DRAW_WIDTH as i32 - 1 - CAL_MARGIN, DRAW_HEIGHT as i32 - 1 - CAL_MARGIN),
        ),
        ("bottom-left", Point::new(CAL_MARGIN, DRAW_HEIGHT as i32 - 1 - CAL_MARGIN)),
    ];
    let mut measured = [(0i32, 0i32); 4];
    {
        let Hardware { display, touch, .. } = hardware;
        let touch = touch.as_mut()?;
        for (index, (name, target)) in targets.iter().enumerate() {
            measured[index] = ask_corner(display, touch, *target, name).await?;
        }
        let _ = display.clear(Rgb565::BLACK);
    }
    let (top_left, top_right, _bottom_right, bottom_left) = (measured[0], measured[1], measured[2], measured[3]);
    // Which raw axis follows the design's X: the one that moves more between the left corners and the right.
    // Asking the glass beats assuming the wiring, which is what this replaces.
    let x_axis = if (top_right.0 - top_left.0).abs() >= (top_right.1 - top_left.1).abs() {
        0u8
    } else {
        1u8
    };
    let (x_from, x_to, y_from, y_to) = if x_axis == 0 {
        (top_left.0, top_right.0, top_left.1, bottom_left.1)
    } else {
        (top_left.1, top_right.1, top_left.0, bottom_left.0)
    };
    if (x_to - x_from).abs() < 200 || (y_to - y_from).abs() < 200 {
        // The four readings are all much the same, which means nothing was really touched, or the controller
        // is returning the same number everywhere. Saying so beats keeping a mapping that cannot work.
        info!(
            "touch: the corners read too alike to calibrate from (x {}..{}, y {}..{})",
            x_from, x_to, y_from, y_to
        );
        return None;
    }
    let calibration = TouchCalibration {
        rotation: rotation_degrees(),
        x_axis,
        x_from,
        x_to,
        y_from,
        y_to,
    };
    if save_calibration(&mut hardware.flash, &calibration) {
        info!(
            "touch: calibrated (axis{}, x {}..{}, y {}..{}) and kept in flash",
            x_axis, x_from, x_to, y_from, y_to
        );
    } else {
        info!("touch: calibrated, but the record could not be written -- this run only");
    }
    hardware.calibration = Some(calibration);
    Some(calibration)
}

/// One corner: draw it, wait for the finger to come off, then wait for it to come back and stop moving.
async fn ask_corner(
    display: &mut DisplayDriver,
    touch: &mut Touch,
    target: Point,
    name: &str,
) -> Option<(i32, i32)> {
    draw_corner(display, target, name).ok()?;
    // A finger still down from the corner before would be read as this one. Bounded, so a stuck reading
    // cannot hold the calibration for ever without saying anything.
    let mut released = 0;
    while touch.read_raw().is_some() {
        released += 1;
        if released > 100 {
            info!("touch: the glass reads as pressed with nothing on it -- check the touch wiring");
            return None;
        }
        Timer::after(Duration::from_millis(20)).await;
    }
    let mut held: Option<((i32, i32), u32)> = None;
    // A calibration that waits for ever says nothing; a minute without a reading says what is wrong.
    let mut waited: u32 = 0;
    loop {
        waited += 1;
        if waited > 3_000 {
            info!("touch: no reading at the {} corner after a minute -- the controller is not answering", name);
            return None;
        }
        match touch.read_raw() {
            Some((a, b)) => {
                held = match held {
                    Some(((was_a, was_b), count))
                        if (was_a - a).abs() <= CAL_STILL && (was_b - b).abs() <= CAL_STILL =>
                    {
                        if count + 1 >= CAL_HOLD {
                            return Some(((a + was_a) / 2, (b + was_b) / 2));
                        }
                        Some(((a, b), count + 1))
                    }
                    _ => Some(((a, b), 0)),
                };
            }
            None => held = None,
        }
        Timer::after(Duration::from_millis(20)).await;
    }
}

/// The corner screen: a dark field, a crosshair where the finger goes, and the corner's name.
fn draw_corner<D: DrawTarget<Color = Rgb565>>(
    display: &mut D,
    target: Point,
    name: &str,
) -> Result<(), D::Error> {
    display.clear(Rgb565::new(0, 0, 0))?;
    let stroke = PrimitiveStyle::with_stroke(Rgb565::new(31, 63, 31), 2);
    let arm = 14;
    Line::new(Point::new(target.x - arm, target.y), Point::new(target.x + arm, target.y))
        .into_styled(stroke)
        .draw(display)?;
    Line::new(Point::new(target.x, target.y - arm), Point::new(target.x, target.y + arm))
        .into_styled(stroke)
        .draw(display)?;
    Circle::new(Point::new(target.x - 3, target.y - 3), 7)
        .into_styled(PrimitiveStyle::with_fill(Rgb565::new(31, 63, 31)))
        .draw(display)?;
    let text = MonoTextStyle::new(&FONT_6X10, Rgb565::new(31, 63, 31));
    let centre_x = DRAW_WIDTH as i32 / 2;
    let centre_y = DRAW_HEIGHT as i32 / 2;
    Text::new("Touch the cross", Point::new(centre_x, centre_y - 6), text).draw(display)?;
    Text::new(name, Point::new(centre_x, centre_y + 10), text).draw(display)?;
    Ok(())
}
`;
}

/** The XPT2046 read path: only generated for a module that has one, so no project pays for it unused. */
function touchImplementation(): string {
    return `
impl Touch {
    /// Whether the controller's interrupt line is currently low, i.e. it thinks a finger is down.
    ///
    /// A convenience for the app rather than something the designer loop needs: it samples the axes instead,
    /// because this line can float (or be tied) low on a module that does not drive it.
    #[allow(dead_code)]
    pub fn pressed(&self) -> bool {
        self.irq.is_low()
    }

    /// Both raw axes, and only while a finger is pressing: what a calibration is measured from.
    ///
    /// Nothing is mapped here. The raw counts are the controller's own and differ from panel to panel, which
    /// is exactly what the four corner screen measures -- see \`TouchCalibration\`.
    ///
    /// The bus is slowed for the transaction and put back afterwards. An XPT2046 converts in its own time
    /// and cannot be clocked faster than about 2 MHz, while the panel it shares pins with runs at tens of
    /// megahertz: at panel speed every conversion came back as noise, the pressure reading never reached the
    /// threshold and a working controller looked like a dead one (bench, 2026-10-28). Only the transaction is
    /// slowed, so the glass keeps its speed.
    ///
    /// Pressure is the test rather than the axis values: an untouched XPT2046 still returns numbers for
    /// both axes, so "these coordinates look plausible" is not the same as "a finger is there".
    pub fn read_raw(&mut self) -> Option<(i32, i32)> {
        critical_section::with(|cs| self.bus.borrow_ref_mut(cs).set_frequency(TOUCH_CLOCK_HZ));
        let reading = self.read_raw_at_speed();
        critical_section::with(|cs| self.bus.borrow_ref_mut(cs).set_frequency(PANEL_CLOCK_HZ));
        reading
    }

    fn read_raw_at_speed(&mut self) -> Option<(i32, i32)> {
        let raw_a = i32::from(touch_axis(&mut self.device, TOUCH_AXIS_A));
        let raw_b = i32::from(touch_axis(&mut self.device, TOUCH_AXIS_B));
        // A touch is the axes having moved away from where they rest. One axis is enough: a finger anywhere on
        // a four-wire panel pulls at least one of them hundreds of counts off the baseline.
        let pressed =
            (raw_a - self.idle.0).abs() > TOUCH_MOVE || (raw_b - self.idle.1).abs() > TOUCH_MOVE;
        if pressed != self.down {
            // One line per edge, not per sample: on the bench this is what shows whether the controller is
            // reporting anything at all, and where its "at rest" numbers actually are.
            info!(
                "touch: {} a={} b={} (idle a={} b={})",
                if pressed { "pressed" } else { "released" },
                raw_a,
                raw_b,
                self.idle.0,
                self.idle.1
            );
            self.down = pressed;
        }
        if pressed {
            Some((raw_a, raw_b))
        } else {
            None
        }
    }

    /// Measures what the two axes read with nothing on the glass, and logs it.
    ///
    /// Called once, from \`init\`: a baseline taken while a finger happened to be resting would make the
    /// whole run deaf, so it is taken as early as the panel is ready.
    fn measure_idle(&mut self) {
        critical_section::with(|cs| self.bus.borrow_ref_mut(cs).set_frequency(TOUCH_CLOCK_HZ));
        let idle_a = i32::from(touch_axis(&mut self.device, TOUCH_AXIS_A));
        let idle_b = i32::from(touch_axis(&mut self.device, TOUCH_AXIS_B));
        critical_section::with(|cs| self.bus.borrow_ref_mut(cs).set_frequency(PANEL_CLOCK_HZ));
        self.idle = (idle_a, idle_b);
        info!("touch: idle baseline a={} b={}", idle_a, idle_b);
        // Both axes pegged at a rail is not a resting panel, it is a controller that is not being read: the
        // data line is not coming back from it. On these modules the touch controller has its *own* clock,
        // data in and data out pins, and they have to be jumpered to the panel's SCK, MOSI and MISO.
        if (idle_a == 0 && idle_b == 0) || (idle_a >= 0x0FFF && idle_b >= 0x0FFF) {
            // One literal: defmt's format string is a single argument, not a concatenation.
            info!(
                "touch: the controller reads {}/{} with nothing touching -- it is not answering. Check that T_CLK, T_DIN and T_DO are jumpered to the panel's SCK (GPIO{}), MOSI (GPIO{}) and MISO (GPIO{}), and that T_CS is GPIO{}.",
                idle_a,
                idle_b,
                PIN_SCLK,
                PIN_MOSI,
                PIN_MISO,
                PIN_TOUCH_CS
            );
        }
    }
}

impl Touch {
    /// One reading, in drawing-area pixels, using the wiring's default numbers.
    ///
    /// The diagnostic templates read the glass once this way, before any design exists and before anything
    /// has been calibrated. A design uses \`touch_point\`, which goes through the measured calibration
    /// instead: these defaults are one panel's guess, and a different one lands wherever it lands.
    #[allow(dead_code)]
    pub fn sample(&mut self) -> Option<(i32, i32)> {
        let (raw_a, raw_b) = self.read_raw()?;
        let (raw_a, raw_b) = (raw_a as u16, raw_b as u16);
        let (raw_x, raw_y) = if TOUCH_SWAP { (raw_b, raw_a) } else { (raw_a, raw_b) };
        // In panel pixels first -- the glass is glued on in its native orientation and knows nothing about
        // the rotation -- and then into the drawing area, which is what the design is laid out in and what
        // the pointer takes.
        let column = touch_map(raw_x, TOUCH_X_MIN, TOUCH_X_MAX, PANEL_WIDTH as i32);
        let row = touch_map(raw_y, TOUCH_Y_MIN, TOUCH_Y_MAX, PANEL_HEIGHT as i32);
        Some(touch_to_draw_area(column, row))
    }
}

/// A panel pixel as the design sees it, for the rotation this project is built for.
///
/// The controller is told to turn the picture (MADCTL swaps and mirrors its addressing), so a design laid
/// out in the drawing area is *not* laid out where the touch panel physically is: on a landscape build the
/// glass's columns are the design's rows. Without this a touch on a turned panel landed transposed, which
/// looks exactly like a dead touchscreen (bench, 2026-10-28).
///
/// Each arm is the inverse of the addressing the panel driver sets for that rotation, with the sizes taken
/// from the panel rather than written out.
#[allow(dead_code)]
fn touch_to_draw_area(column: i32, row: i32) -> (i32, i32) {
    let last_column = PANEL_WIDTH as i32 - 1;
    let last_row = PANEL_HEIGHT as i32 - 1;
    if ROTATION == Rotation::Deg0 {
        (column, row)
    } else if ROTATION == Rotation::Deg90 {
        (row, last_column - column)
    } else if ROTATION == Rotation::Deg180 {
        (last_column - column, last_row - row)
    } else {
        (last_row - row, column)
    }
}

/// Control bytes from the XPT2046 datasheet: S=1 | channel | 12-bit | single-ended | power-down bits.
///
/// 0xD1 reads one panel axis, 0x91 the other. PD=01 powers the controller down between conversions, which is
/// also the only setting that re-enables PENIRQ.
const TOUCH_AXIS_A: u8 = 0xD1;
const TOUCH_AXIS_B: u8 = 0x91;

/// The clock the controller is read at.
///
/// An XPT2046 converts at a few tens of kilohertz and clocks out at 2 MHz at most; the panel on the same pins
/// runs at tens of megahertz. Reading the controller at panel speed returns noise (bench, 2026-10-28), so the
/// bus is dropped to this for a conversion and put back to \`PANEL_CLOCK_HZ\` after it.
const TOUCH_CLOCK_HZ: u32 = 1_000_000;

/// The controller's conversion time, and then some: too short and the first sample after a channel change
/// comes back as zero.
const TOUCH_SETTLE_NS: u32 = 20_000;

/// How many conversions an axis reading averages.
const TOUCH_SAMPLES: u32 = 3;

/// How far an axis has to move from its idle baseline to count as a touch.
///
/// The same figure the ESP32 boards use on the same modules: a resting panel jitters by tens of counts, a
/// finger moves one axis by hundreds.
const TOUCH_MOVE: i32 = 200;

/// Whether this module's two controller axes are the other way round.
///
/// Only the diagnostic templates use these five: a design goes through the measured calibration, which
/// works the axis order and the ranges out from the corners instead of assuming them.
#[allow(dead_code)]
const TOUCH_SWAP: bool = false;

/// The raw counts the glass's edges give, per axis. A resistive panel is not a fixed-geometry device, so
/// these four are the calibration; the Designer keeps them beside the wiring once it offers them.
#[allow(dead_code)]
const TOUCH_X_MIN: u16 = 300;
#[allow(dead_code)]
const TOUCH_X_MAX: u16 = 3_800;
#[allow(dead_code)]
const TOUCH_Y_MIN: u16 = 300;
#[allow(dead_code)]
const TOUCH_Y_MAX: u16 = 3_800;

/// One command, and the two bytes that come back with it.
///
/// The command and its data are separated by the controller's conversion time instead of being clocked
/// back to back: a plain two-byte transfer reads mid-scale and never moves. An \`Operation::DelayNs\` keeps
/// CS asserted across the gap, which is what the conversion needs.
fn touch_frame(device: &mut TouchDevice, command: u8) -> u16 {
    let mut frame = [0u8; 2];
    if device
        .transaction(&mut [
            Operation::Write(&[command]),
            Operation::DelayNs(TOUCH_SETTLE_NS),
            Operation::Read(&mut frame),
        ])
        .is_err()
    {
        return 0;
    }
    (u16::from(frame[0]) << 8) | u16::from(frame[1])
}

/// The 12 bits of the *previous* command's conversion: the high byte, then the low nibble in the top half
/// of the second byte.
fn touch_value(frame: u16) -> u16 {
    ((((frame >> 8) & 0x00FF) << 4) | ((frame & 0x00FF) >> 4)) & 0x0FFF
}

/// One axis, averaged over a few conversions.
///
/// Two frames are consumed before the samples are taken: the first is whatever the previous channel left
/// behind, the second is the same channel's own previous conversion. Averaging from the third on gives
/// settled values -- without this the average is dragged towards zero.
fn touch_axis(device: &mut TouchDevice, command: u8) -> u16 {
    let _ = touch_frame(device, command);
    let _ = touch_frame(device, command);
    let mut total: u32 = 0;
    for _ in 0..TOUCH_SAMPLES {
        total += u32::from(touch_value(touch_frame(device, command)));
    }
    (total / TOUCH_SAMPLES) as u16
}

/// One raw axis onto pixels, clamped to the glass.
///
/// A finger at the very edge reads slightly past the calibration value, and a coordinate outside the panel
/// is a widget nobody can reach, so both ends are clamped rather than trusted.
#[allow(dead_code)]
fn touch_map(raw: u16, min: u16, max: u16, size: i32) -> i32 {
    if max <= min || size <= 1 {
        return 0;
    }
    let span = i32::from(max - min);
    let offset = i32::from(raw.saturating_sub(min));
    ((offset * (size - 1)) / span).clamp(0, size - 1)
}
`;
}
