use super::*;

#[test]
fn test_parse_tracks() {
    let tracks = parse_tracks("140px, 1fr 2fr auto").unwrap();
    assert_eq!(
        tracks,
        vec![
            GridTrackDef::Px(140),
            GridTrackDef::Fr(1),
            GridTrackDef::Fr(2),
            GridTrackDef::Auto,
        ]
    );
}

#[test]
fn test_compile_full_widget_suite_to_rust() {
    let kdl = r#"
screen id="FullSuite" width=320 height=240 theme="dark" {
    grid cols="100px 1fr 100px" rows="24px 1fr 1fr 40px" gap=4 padding=6 {
        status_bar id="StatusBar" col=0 row=0 col_span=3 time="10:42"
        banner col=0 row=1 text="Smart Climate"
        spinbox id="Temp" col=1 row=1 min=100 max=350 value=215
        scale id="Tach" col=2 row=1 mode="radial" min=0.0 max=120.0 value=65.0
        
        dropdown id="ModeSelect" col=0 row=2 {
            option "Auto"
            option "Cool"
            option "Heat"
        }
        number_picker id="BpmPicker" col=1 row=2 min=40 max=200 value=135 unit="BPM"
        sweeping_arc id="Sweep" col=2 row=2 start_angle=0 end_angle=180
        
        button id="SaveBtn" col=0 row=3 text="SAVE"
        toggle id="EcoTog" col=1 row=3 label="ECO" checked=true
        checkbox id="SyncChk" col=2 row=3 label="SYNC" checked=false
    }
}
"#;
    let rust_code = compile_kdl_to_rust(kdl).unwrap();
    assert!(rust_code.contains("pub struct FullSuiteWidgets {"));
    assert!(rust_code.contains("pub status_bar: WidgetId,"));
    assert!(rust_code.contains("pub temp: WidgetId,"));
    assert!(rust_code.contains("pub tach: WidgetId,"));
    assert!(rust_code.contains("pub mode_select: WidgetId,"));
    assert!(rust_code.contains("pub bpm_picker: WidgetId,"));
    assert!(rust_code.contains("pub sweep: WidgetId,"));
    assert!(rust_code.contains("pub save_btn: WidgetId,"));
    assert!(rust_code.contains("pub eco_tog: WidgetId,"));
    assert!(rust_code.contains("pub sync_chk: WidgetId,"));
    assert!(rust_code.contains("pub struct FullSuiteApp {"));
    assert!(rust_code.contains("pub const NODE_COUNT: usize = 10;"));
}

#[test]
fn test_serialize_kdl_roundtrip() {
    let original_kdl = r#"screen id="Thermostat" width=320 height=240 theme="dark" {
    grid cols="1fr 1fr" rows="36px 1fr 48px" gap=6 padding=8 {
        status_bar id="status" time="14:32" col=0 row=0 col_span=2
        scale id="temp_gauge" mode="radial" min=15.0 max=35.0 value=22.5 major_ticks=4 minor_ticks=2 col=0 row=1
        slider id="target_slider" min=10 max=40 value=23 col=1 row=1
        button id="btn_heat" text="Heat Mode" style="accent" col=0 row=2
        toggle id="power_switch" label="Power" checked=true col=1 row=2
    }
}
"#;
    let screen = parse_kdl_screen(original_kdl).unwrap();
    let serialized = serialize_kdl_screen(&screen);
    let parsed_again = parse_kdl_screen(&serialized).unwrap();
    assert_eq!(screen, parsed_again);
}

#[test]
fn roundtrips_widget_animation_and_screen_transition() {
    let kdl = r#"screen id="Motion" width=320 height=240 transition="window_push" transition_duration=420 transition_easing="moook" transition_origin="right" {
    grid cols="1fr" rows="1fr" gap=0 padding=0 {
        button id="launch" text="Launch" animation="fade_in_up" animation_trigger="screen_enter" animation_duration=500 animation_delay=80 animation_easing="out_back" animation_repeat=2 col=0 row=0
    }
}"#;
    let screen = parse_kdl_screen(kdl).unwrap();
    let transition = screen.transition.as_ref().unwrap();
    assert_eq!(transition.preset, "window_push");
    assert_eq!(transition.duration_ms, 420);

    let animation = screen.grid.children[0].0.animation.as_ref().unwrap();
    assert_eq!(animation.preset, "fade_in_up");
    assert_eq!(animation.delay_ms, 80);
    assert_eq!(animation.repeat, 2);

    let reparsed = parse_kdl_screen(&serialize_kdl_screen(&screen)).unwrap();
    assert_eq!(screen, reparsed);

    let generated = generate_rust_code(&screen);
    assert!(generated.contains("pub const TRANSITION: ScreenTransitionSpec"));
    assert!(generated.contains("ScreenTransitionEffect::PushMoook"));
    assert!(generated.contains("ScreenTransitionOrigin::Right"));
    assert!(generated.contains("start_screen_enter_animations"));
    assert!(generated.contains("AnimatedProperty::WidgetY"));
    assert!(generated.contains("Easing::OutBack"));
}

#[test]
fn roundtrips_carousel_icon_mesh_and_fonts() {
    let kdl = r#"screen id="Advanced" width=96 height=64 {
    font id="sevenseg" src="assets/fonts/sevenseg30.bdf" chars="0123456789"
    grid cols="1fr 26px" rows="12px 1fr" gap=0 padding=0 {
        label id="count" text="042" font="sevenseg" col=0 row=0
        carousel id="items" selected=1 item_step=16 visible=7 mask_top=14 mask_bottom=12 indicator=true pulse=96 style="body" col=0 row=1 {
            option "ONE"
            option "TWO"
        }
        icon id="battery" scale=2 align="top_left" tint="success" threshold=100 invert=true col=1 row=1 {
            part src="assets/icons/shell.bmp" x=0 y=0
            part src="assets/icons/bolt.bmp" x=3 y=1 visible=false tint="accent"
        }
        mesh id="gem" src="assets/meshes/gem.obj" shading="lit" color="accent" scale=1.5 roll=0.4 pitch=0.7 yaw=0 camera_distance=3.5 fov=1.2 col=1 row=0
    }
}
"#;
    let screen = parse_kdl_screen(kdl).unwrap();
    assert_eq!(screen.fonts.len(), 1);
    assert_eq!(screen.fonts[0].chars, "0123456789");

    let reparsed = parse_kdl_screen(&serialize_kdl_screen(&screen)).unwrap();
    assert_eq!(screen, reparsed);
}

#[test]
fn generates_carousel_builder_calls() {
    let kdl = r#"screen id="Menu" width=96 height=64 {
    grid cols="1fr" rows="1fr" gap=0 padding=0 {
        carousel id="items" selected=2 item_step=16 visible=7 mask_top=14 indicator=true pulse=96 col=0 row=0 {
            option "ONE"
            option "TWO"
            option "THREE"
        }
    }
}"#;
    let rust_code = compile_kdl_to_rust(kdl).unwrap();
    assert!(rust_code.contains("gui.add_carousel(cells[0], &[\"ONE\", \"TWO\", \"THREE\"], 2,"));
    assert!(rust_code.contains("item_step: 16"));
    assert!(rust_code.contains("mask_top: 14"));
    assert!(rust_code.contains("indicator: true"));
    assert!(rust_code.contains("indicator_pulse: 96"));
}

#[test]
fn embeds_fonts_icons_and_meshes_into_generated_code() {
    let kdl = r##"screen id="Advanced" width=96 height=64 {
    font id="sevenseg" src="assets/fonts/sevenseg30.bdf"
    grid cols="1fr" rows="1fr 1fr 1fr" gap=0 padding=0 {
        label id="count" text="42" font="sevenseg" col=0 row=0
        icon id="battery" scale=2 col=0 row=1 {
            part src="assets/icons/shell.bmp" x=1 y=2
        }
        mesh id="gem" src="assets/meshes/gem.obj" shading="lit" color="#00FF00" col=0 row=2
    }
}"##;
    let screen = parse_kdl_screen(kdl).unwrap();
    let assets = ProjectAssets {
        fonts: vec![FontBinaryDef {
            name: "sevenseg".into(),
            font: assets::BitmapFontData {
                width: 8,
                height: 8,
                advance: 8,
                line_height: 8,
                first_char: b'0',
                bytes_per_row: 1,
                glyphs: vec![0xFF; 16],
            },
        }],
        icons: vec![IconAssetDef {
            source: "assets/icons/shell.bmp".into(),
            bitmap: assets::MonoBitmapData {
                width: 8,
                height: 2,
                bits: vec![0b1010_1010, 0b0101_0101],
            },
        }],
        meshes: vec![MeshAssetDef {
            source: "assets/meshes/gem.obj".into(),
            mesh: assets::MeshData {
                vertices: vec![[0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
                faces: vec![[0, 1, 2]],
                normals: vec![[0.0, 0.0, 1.0]],
            },
        }],
        ..ProjectAssets::default()
    };

    let rust_code = generate_rust_code_with_assets(&screen, &assets);
    assert!(rust_code.contains("static __FONT_SEVENSEG: BitmapFont = BitmapFont {"));
    assert!(rust_code.contains("FontId::Bitmap(&__FONT_SEVENSEG)"));
    assert!(rust_code.contains("pub static __ICON_1_PARTS: [IconPart<'static>; 1]"));
    assert!(rust_code.contains("pub static BATTERY_PARTS: [IconPart<'static>; 1]"));
    assert!(rust_code.contains("gui.add_composite_icon(cells[1], &__ICON_1_PARTS"));
    assert!(rust_code.contains("scale: 2"));
    assert!(rust_code.contains("pub fn gem_mesh_panel() -> MeshPanel<'static>"));
    assert!(rust_code.contains("panel.shading = MeshShading::Lit;"));
    assert!(rust_code.contains("Rgb565::new(0, 63, 0)"));
}

#[test]
fn test_svg_path_d_parsing_and_codegen() {
    let svg_d = "M 10 20 L 30 40 Q 50 60 70 80 C 10 20 30 40 50 60 Z";
    let verbs = parse_svg_path_d(svg_d);
    assert_eq!(verbs.len(), 5);
    assert_eq!(verbs[0], PathVerbDef::MoveTo(10, 20));
    assert_eq!(verbs[1], PathVerbDef::LineTo(30, 40));
    assert_eq!(verbs[2], PathVerbDef::QuadTo(50, 60, 70, 80));
    assert_eq!(verbs[3], PathVerbDef::CubicTo(10, 20, 30, 40, 50, 60));
    assert_eq!(verbs[4], PathVerbDef::Close);

    let kdl = r#"screen id="VectorApp" width=320 height=240 {
    grid cols="1fr" rows="1fr" {
        path id="my_curve" d="M 0 10 C 20 0, 40 40, 60 10 Z" stroke_width=2 col=0 row=0
    }
}"#;
    let rust_code = compile_kdl_to_rust(kdl).unwrap();
    assert!(rust_code.contains("pub struct VectorAppWidgets {"));
    assert!(rust_code.contains("pub my_curve: WidgetId,"));
    // The path is a `rusty_gui_widgets::VectorPath` custom widget whose verbs are struct variants
    // with named fields -- the enum has no tuple variants, which is what the old arm emitted.
    assert!(
        rust_code.contains(
            "static __shape_my_curve: rusty_gui_widgets::VectorPath = rusty_gui_widgets::VectorPath { \
             stroke_width: 2, colour: None, verbs: &[rusty_gui_widgets::PathVerb::MoveTo { x: 0, y: 10 }, \
             rusty_gui_widgets::PathVerb::CubicTo { c1x: 20, c1y: 0, c2x: 40, c2y: 40, x: 60, y: 10 }, \
             rusty_gui_widgets::PathVerb::Close] };"
        ),
        "the parsed verbs must reach the path widget as struct-variant literals: {rust_code}"
    );
    assert!(
        rust_code.contains(
            "let my_curve = gui.add_custom_widget(cells[0], &__shape_my_curve, Style::default())?;"
        ),
        "the path must be added as a custom widget: {rust_code}"
    );
}

#[test]
fn image_assets_round_trip_and_generate_static_rgb565() {
    let kdl = r##"screen id="Assets" width=96 height=64 {
    grid cols="1fr" rows="1fr" {
        image id="logo" src="assets/logo.png" fit="center" mode="mask" tint="#00FFFF" col=0 row=0
    }
}"##;
    let screen = parse_kdl_screen(kdl).unwrap();
    assert_eq!(
        parse_kdl_screen(&serialize_kdl_screen(&screen)).unwrap(),
        screen
    );

    let generated = generate_rust_code_with_image_assets(
        &screen,
        &[ImageAssetDef {
            source: "assets/logo.png".into(),
            width: 2,
            height: 1,
            pixels: vec![0x0000, 0xFFFF],
        }],
    );
    assert!(generated.contains("const __IMAGE_ASSET_0_PIXELS: &[u16]"));
    assert!(generated.contains("ImageRef::new(2, 1, __IMAGE_ASSET_0_PIXELS)"));
    assert!(generated.contains("ImageFit::Center"));
}

#[test]
fn test_custom_button_styling_declarative_and_named_colors() {
    let kdl = r##"screen id="HackswellScreen" width=320 height=240 {
    grid cols="1fr" rows="1fr" {
        button id="Opt1" text="Hackswell" bg="#0A1A06" pressed_bg="#19170B" disabled_bg="forestgreen" disabled_text="crimson" col=0 row=0
    }
}"##;
    let _screen = parse_kdl_screen(kdl).unwrap();
    let rust_code = compile_kdl_to_rust(kdl).unwrap();
    assert!(rust_code.contains("gui.add_button"));
    assert!(rust_code.contains("WidgetStyle::button()"));
    assert!(rust_code.contains(".with_bg(Rgb565::new(1, 6, 0))"));
    assert!(rust_code.contains(".with_pressed_bg(Rgb565::new(3, 5, 1))"));
    assert!(rust_code.contains(".with_disabled_bg(Rgb565::new(4, 34, 4))")); // forestgreen
    assert!(rust_code.contains(".with_disabled_text(Rgb565::new(27, 5, 7))")); // crimson
}

#[test]
fn default_defs_parse_tracks_errors_and_relative_svg_paths() {
    assert_eq!(GridPlacementDef::default().col_span, 1);
    let anim = WidgetAnimationDef::default();
    assert_eq!(anim.repeat, 1);
    let transition = ScreenTransitionDef::default();
    assert_eq!(transition.duration_ms, 300);

    assert!(parse_tracks("badfr").is_err());
    assert!(parse_tracks("bogus").is_err());
    assert_eq!(parse_tracks("").unwrap(), vec![GridTrackDef::Fr(1)]);
    assert_eq!(
        parse_tracks("64 1fr auto").unwrap(),
        vec![
            GridTrackDef::Px(64),
            GridTrackDef::Fr(1),
            GridTrackDef::Auto
        ]
    );

    let rel = parse_svg_path_d("m 10 10 l 5 0 h -2 v 3 c 1 1 2 2 3 0 z");
    assert!(rel.iter().any(|v| matches!(v, PathVerbDef::LineTo(15, 10))));
    assert!(rel.iter().any(|v| matches!(v, PathVerbDef::Close)));

    let with_separators = parse_svg_path_d("M0,0 5,5 Z");
    assert_eq!(with_separators.len(), 3);
}

#[test]
fn test_column_row_stack_and_screen_render_impl() {
    let kdl = r#"
screen id="MenuScreen" width=240 height=320 {
    column gap=6 padding=8 {
        label id="title" text="Settings"
        button id="btn_save" text="Save"
    }
}
"#;
    let screen = parse_kdl_screen(kdl).unwrap();
    assert_eq!(screen.grid.children.len(), 2);
    assert_eq!(screen.grid.children[0].0.row, 0);
    assert_eq!(screen.grid.children[1].0.row, 1);

    let code = compile_kdl_to_rust(kdl).unwrap();
    assert!(code.contains("impl<'a, const N: usize, const E: usize, const D: usize> Screen<'a, N, E, D> for MenuScreenApp"));
    assert!(code.contains("impl Render for MenuScreenApp"));
    assert!(code.contains("pub fn apply_theme"));
    assert!(code.contains("pub fn set_language"));
    assert!(code.contains("gui.set_theme(theme)"));
    assert!(code.contains("gui.set_translation_table(table)"));
}

#[test]
fn test_table_cells_reach_the_generated_code() {
    // The emitter used to pass `&[]` for every table, so the rows a design declares were parsed and then
    // dropped: the board painted the table's panel and none of its contents. The header becomes the first row,
    // because the renderer has no separate header concept.
    let kdl = r#"
screen id="T" width=200 height=120 theme="dark" {
    grid cols="180px 1fr" rows="100px 1fr" gap=0 padding=0 {
        table id="Grid" col=0 row=0 col_span=1 row_span=1 {
            headers "Name" "Value"
            row "A" "1"
            row "B" "2"
        }
    }
}
"#;
    let rust_code = compile_kdl_to_rust(kdl).unwrap();
    assert!(
        rust_code.contains(r#"gui.add_table(cells[0], &[&["Name", "Value"], &["A", "1"], &["B", "2"]], Style::panel())"#),
        "the header and rows reach add_table; got:\n{rust_code}"
    );

    // A table with no cells still compiles, exactly as it used to.
    let empty = r#"
screen id="T" width=200 height=120 theme="dark" {
    grid cols="180px 1fr" rows="100px 1fr" gap=0 padding=0 {
        table id="Grid" col=0 row=0 col_span=1 row_span=1
    }
}
"#;
    let rust_code = compile_kdl_to_rust(empty).unwrap();
    assert!(rust_code.contains("gui.add_table(cells[0], &[], Style::panel())"));
}

#[test]
fn triangle_points_reach_the_generated_code() {
    // The designer's six offsets are the only thing that makes a triangle any shape but isosceles, and they
    // travel designer -> KDL -> parser -> AST -> emitter -> `rusty_gui_widgets::Triangle`. A field dropped
    // anywhere along that line still compiles and still paints *a* triangle, so nothing but an assertion on
    // the generated text catches it.
    let kdl = r##"
screen id="Shapes" width=320 height=240 theme="dark" {
    grid cols="1fr" rows="1fr" {
        triangle id="pyr" stroke_width=2 fill="#ff0000" stroke="#00ff00" p1x=1000 p1y=0 p2x=0 p2y=1000 p3x=1000 p3y=1000 col=0 row=0
    }
}
"##;
    let generated = compile_kdl_to_rust(kdl).unwrap();
    assert!(
        generated.contains(
            "rusty_gui_widgets::Triangle { stroke_width: 2, fill: Some(Rgb565::new(31, 0, 0)), \
             stroke: Some(Rgb565::new(0, 63, 0)), points: [1000, 0, 0, 1000, 1000, 1000] }"
        ),
        "the design's three points must reach the widget: {generated}"
    );

    // A design written before the points existed says nothing, and the parser's own default is the isosceles
    // triangle the designer used to drop -- so an old design keeps the shape it always had.
    let old = r##"
screen id="Old" width=320 height=240 theme="dark" {
    grid cols="1fr" rows="1fr" {
        triangle id="pyr" stroke_width=1 fill="#ff0000" col=0 row=0
    }
}
"##;
    let generated = compile_kdl_to_rust(old).unwrap();
    assert!(
        generated.contains("points: [500, 0, 0, 1000, 1000, 1000]"),
        "an old design falls back to the default triangle: {generated}"
    );

    // Out-of-range offsets are clamped rather than passed through: a vertex outside its cell would paint
    // outside the widget, where the engine clips it and the designer's handle cannot reach it.
    let wild = r##"
screen id="Wild" width=320 height=240 theme="dark" {
    grid cols="1fr" rows="1fr" {
        triangle id="pyr" p1x=-40 p1y=4000 p2x=0 p2y=1000 p3x=1000 p3y=1000 col=0 row=0
    }
}
"##;
    let generated = compile_kdl_to_rust(wild).unwrap();
    assert!(
        generated.contains("points: [0, 1000, 0, 1000, 1000, 1000]"),
        "out-of-range points are clamped to the cell: {generated}"
    );
}

#[test]
fn appearance_attributes_reach_the_generated_code() {
    // Six widgets now carry appearance and value fields the designer writes. Dropping one anywhere
    // along KDL -> parser -> AST -> emitter still compiles and still draws *a* widget, so only an
    // assertion on the generated text catches the loss.
    let kdl = r##"
screen id="Styled" width=320 height=240 theme="dark" {
    grid cols="1fr" rows="1fr 1fr 1fr 1fr 1fr 1fr" gap=0 padding=0 {
        toggle id="t" label="x" checked=true off_color="#ff0000" style="Style::panel()" col=0 row=0
        checkbox id="c" label="x" checked=true box_width=14 box_height=10 label_position="left" box_color="#ff0000" style="{ let mut style = Style::panel(); style.border.width = 2; style }" col=0 row=1
        progress id="p" value=0.25 style="Style::panel()" col=0 row=2
        roller id="r" selected=1 style="Style::panel()" col=0 row=3 {
            option "a"
            option "b"
        }
        spinbox id="s" min=1 max=9 value=5 digits=2 decimals=1 accent_color="#ff0000" chevron_color="#00ff00" style="Style::panel()" col=0 row=4
        scale id="g" mode="radial" min=0.0 max=10.0 value=5.0 major_ticks=4 minor_ticks=3 start_angle=90 end_angle=270 show_labels=false show_needle=false tick_color="#ff0000" needle_color="#00ff00" style="Style::panel()" col=0 row=5
    }
}
"##;
    let screen = parse_kdl_screen(kdl).unwrap();
    let generated = compile_kdl_to_rust(kdl).unwrap();

    assert!(
        generated.contains(
            "gui.add_toggle_colored(cells[0], \"x\", true, Rgb565::new(31, 0, 0), None, 0, Style::panel())"
        ),
        "the toggle's off colour, track border and style must reach the board: {generated}"
    );
    assert!(
        generated.contains(
            "gui.add_checkbox_sized(cells[1], \"x\", true, 14, 10, CheckboxLabelPosition::Left, Some(Rgb565::new(31, 0, 0)), { let mut style = Style::panel(); style.border.width = 2; style })"
        ),
        "the checkbox's box size, label side, outline colour and style expression must reach the board: {generated}"
    );
    assert!(
        generated.contains("gui.add_progress_bar(cells[2], 0.25, Style::panel())"),
        "the progress bar's style must replace the hard-coded default: {generated}"
    );
    assert!(
        generated.contains("gui.add_roller(cells[3], &[\"a\", \"b\"], 1, Style::panel())"),
        "the roller's style must replace the hard-coded panel: {generated}"
    );
    assert!(
        generated.contains(
            "gui.add_spinbox_styled(cells[4], 1, 9, 5, 2, 1, Rgb565::new(31, 0, 0), Rgb565::new(0, 63, 0), Style::panel())"
        ),
        "the spinbox's accent/chevron colours must reach the board: {generated}"
    );
    assert!(
        generated.contains(
            "gui.add_scale_styled(cells[5], ScaleMode::Radial, 0.0, 10.0, 5.0, 4, 3, 90, 270, false, false, Rgb565::new(31, 0, 0), Rgb565::new(0, 63, 0), Style::panel())"
        ),
        "the scale's sweep, tick counts and colours must reach the board: {generated}"
    );

    // The serializer has to write these fields back, or a designer's next save silently reverts them.
    assert_eq!(
        parse_kdl_screen(&serialize_kdl_screen(&screen)).unwrap(),
        screen
    );

    // A design that names no appearance keeps the literals the runtime used to hard-code: the
    // toggle's near-black off track and `Style::default()`, and the scale's old sweep and palette.
    let plain = r#"
screen id="Plain" width=320 height=240 {
    grid cols="1fr" rows="1fr 1fr" gap=0 padding=0 {
        toggle id="t" label="x" checked=true col=0 row=0
        scale id="g" mode="radial" min=0.0 max=10.0 value=5.0 major_ticks=3 minor_ticks=1 col=0 row=1
    }
}
"#;
    let generated = compile_kdl_to_rust(plain).unwrap();
    assert!(
        generated.contains(
            "gui.add_toggle_colored(cells[0], \"x\", true, Rgb565::new(7, 10, 10), None, 0, Style::default())"
        ),
        "an unstyled toggle keeps its old default: {generated}"
    );
    assert!(
        generated.contains(
            "gui.add_scale_styled(cells[1], ScaleMode::Radial, 0.0, 10.0, 5.0, 3, 1, 135, 45, true, true, Rgb565::new(16, 32, 16), Rgb565::new(31, 0, 0), Style::panel())"
        ),
        "tick counts are passed through and the sweep keeps its old defaults: {generated}"
    );
}

#[test]
fn a_roller_asked_for_by_touch_reaches_the_builder_that_takes_a_selection() {
    // Asked 2026-10-15: *"A touch on one of the three visible bars, selects the touched bar. Put an option
    // property in the settings bar to select between the older flick selection method or the touch method."*
    // The attribute is what carries that choice from the design to the board, so it has to reach the one
    // builder that takes it -- and survive a round trip, or the designer's next save would revert it.
    let kdl = r#"
screen id="Touch" width=100 height=100 {
    grid cols="1fr" rows="1fr" gap=0 padding=0 {
        roller id="r" selected=1 selection="touch" style="Style::panel()" col=0 row=0 {
            option "a"
            option "b"
        }
    }
}
"#;
    let generated = compile_kdl_to_rust(kdl).unwrap();
    assert!(
        generated.contains(
            "gui.add_roller_with_selection(cells[0], &[\"a\", \"b\"], 1, RollerSelection::Touch, Style::panel())"
        ),
        "the roller's selection must reach the board: {generated}"
    );

    let screen = parse_kdl_screen(kdl).unwrap();
    let written = serialize_kdl_screen(&screen);
    assert!(
        written.contains("selection=\"touch\""),
        "and the markup it was written in must survive: {written}"
    );
    assert_eq!(
        parse_kdl_screen(&written).unwrap(),
        screen,
        "a roller picked by touch round-trips"
    );
}

#[test]
fn a_roller_that_says_nothing_keeps_the_flick_and_upstreams_builder() {
    // The default is the point: every design written before the choice existed names no selection, so it has
    // to keep the gesture it already had -- and the generated call has to stay the one it already had, or
    // every project's `ui.rs` would be rewritten for nothing.
    let kdl = r#"
screen id="Flick" width=100 height=100 {
    grid cols="1fr" rows="1fr" gap=0 padding=0 {
        roller id="r" selected=0 style="Style::panel()" col=0 row=0 {
            option "a"
            option "b"
        }
    }
}
"#;
    let generated = compile_kdl_to_rust(kdl).unwrap();
    assert!(
        generated.contains("gui.add_roller(cells[0], &[\"a\", \"b\"], 0, Style::panel())"),
        "a design that names nothing keeps the flick: {generated}"
    );
    assert!(
        !generated.contains("add_roller_with_selection"),
        "and not the builder that would say something about it: {generated}"
    );

    // A name the crate does not know is *normalised* rather than passed through, because a name that reached
    // the runtime would be Rust: a typo has to mean the default, not a compile error.
    let typo = kdl.replace("selected=0", "selected=0 selection=\"swipe\"");
    let generated = compile_kdl_to_rust(&typo).unwrap();
    assert!(
        !generated.contains("RollerSelection"),
        "an unknown selection is the default, not a variant: {generated}"
    );
    assert!(
        serialize_kdl_screen(&parse_kdl_screen(&typo).unwrap()).contains("selection=\"flick\""),
        "and it is written back as the name the crate knows"
    );
}

#[test]
fn every_refused_tag_now_generates_a_call_that_compiles() {
    // The designer refused these tags because their generated code did not compile: the emitter
    // passed the wrong arguments, the wrong types, or an inlined `VectorPath` built from tuple
    // variants the runtime does not have. Each assertion below is one frozen builder signature.
    let kdl = r##"
screen id="Refused" width=320 height=240 {
    column gap=0 padding=0 {
        toggle id="tog" label="PWR" checked=true off_color="#ff0000" track_border="#00ff00" track_border_width=3 style="panel"
        slider id="sld" min=5.0 max=45.0 value=22.5
        sweeping_arc id="arc" progress=0.25 clockwise=false arc_radius=0 frame_inset=6 corner_radius=2 bg_color="#ff0000" arc_color="#00ff00" frame_color="#0000ff" style="panel"
        busy_wheel id="spin" phase=0.75 style="panel"
        chart id="cht" values="2,5,3,8" min=1.0 max=9.0 style="panel"
        plotter id="plt" values="2 5 3" head=2 min=1.0 max=9.0 style="panel"
        status_bar id="stb" time="07:45" style="panel"
        time_picker id="tp" hour=7 minute=45 is_12h=false is_pm=true style="panel"
        number_picker id="np" min=3 max=17 value=11 unit="kPa" style="panel"
        content_indicator id="ci" count=5 active=2 style="panel"
        crumbs id="cr" count=4 active=1 style="panel"
        path id="pv" stroke_width=3 colour="#00ff00" d="M 0 0 L 32 32 Q 1 2 3 4 C 1 2 3 4 5 6 Z"
    }
}
"##;
    let generated = compile_kdl_to_rust(kdl).unwrap();

    assert!(
        generated.contains(
            "gui.add_toggle_colored(cells[0], \"PWR\", true, Rgb565::new(31, 0, 0), Some(Rgb565::new(0, 63, 0)), 3, Style::panel())"
        ),
        "toggle: track border is the 5th argument and its width the 6th: {generated}"
    );
    assert!(
        generated.contains("gui.add_slider(cells[1], 22.5, 5.0, 45.0, Style::default())"),
        "slider: value comes before min and max, and all three are floats: {generated}"
    );
    assert!(
        generated.contains(
            "gui.add_sweeping_arc(cells[2], 0.25, false, ((cells[2].w.min(cells[2].h) / 2).saturating_sub(8)), 6, 2, Rgb565::new(31, 0, 0), Rgb565::new(0, 63, 0), Rgb565::new(0, 0, 31), Style::panel())"
        ),
        "arc: progress, direction, cell-derived radius, frame, corners and three colours: {generated}"
    );
    assert!(
        generated.contains("gui.add_spinner(cells[3], 0.75, Style::panel())"),
        "busy_wheel becomes add_spinner with a phase: {generated}"
    );
    assert!(
        generated.contains("gui.add_chart(cells[4], &[2.0, 5.0, 3.0, 8.0], 1.0, 9.0, Style::panel())"),
        "chart: its comma-separated series reaches add_chart: {generated}"
    );
    assert!(
        generated.contains("gui.add_plotter(cells[5], &[2.0, 5.0, 3.0], 2, 1.0, 9.0, Style::panel())"),
        "plotter: its space-separated series and head reach add_plotter: {generated}"
    );
    assert!(
        generated.contains("gui.add_status_bar(cells[6], \"07:45\", Style::panel())"),
        "status_bar takes a parsed style: {generated}"
    );
    assert!(
        generated.contains("gui.add_time_picker(cells[7], 7, 45, false, true, Style::panel())"),
        "time_picker takes a parsed style: {generated}"
    );
    assert!(
        generated.contains(
            "gui.add_number_picker(cells[8], 3, 17, 11, \"kPa\", Style::panel())"
        ),
        "number_picker takes a parsed style: {generated}"
    );
    assert!(
        generated.contains("gui.add_content_indicator(cells[9], 5, 2, Style::panel())"),
        "content_indicator takes a parsed style: {generated}"
    );
    assert!(
        generated.contains("gui.add_crumbs_indicator(cells[10], 4, 1, Style::panel())"),
        "crumbs takes a parsed style: {generated}"
    );
    assert!(
        generated.contains(
            "static __shape_pv: rusty_gui_widgets::VectorPath = rusty_gui_widgets::VectorPath { \
             stroke_width: 3, colour: Some(Rgb565::new(0, 63, 0)), \
             verbs: &[rusty_gui_widgets::PathVerb::MoveTo { x: 0, y: 0 }, \
             rusty_gui_widgets::PathVerb::LineTo { x: 32, y: 32 }, \
             rusty_gui_widgets::PathVerb::QuadTo { cx: 1, cy: 2, x: 3, y: 4 }, \
             rusty_gui_widgets::PathVerb::CubicTo { c1x: 1, c1y: 2, c2x: 3, c2y: 4, x: 5, y: 6 }, \
             rusty_gui_widgets::PathVerb::Close] };"
        ),
        "path: struct-variant verbs and a non-optional colour reach the custom widget: {generated}"
    );
    assert!(
        generated.contains(
            "let pv = gui.add_custom_widget(cells[11], &__shape_pv, Style::default())?;"
        ),
        "path is a custom widget, not an inline VectorPath: {generated}"
    );

    // Every new field has to survive a save: parse, serialize and parse again must agree.
    let screen = parse_kdl_screen(kdl).unwrap();
    assert_eq!(
        parse_kdl_screen(&serialize_kdl_screen(&screen)).unwrap(),
        screen,
        "the serializer must write the new fields back"
    );

    // A design that says nothing keeps the behaviour the runtime had before the fields existed.
    let defaults = r##"
screen id="Defaults" width=320 height=240 {
    column gap=0 padding=0 {
        slider id="dsl"
        sweeping_arc id="darc"
        busy_wheel id="dspin"
        chart id="dcht"
        plotter id="dplt"
        status_bar id="dstb"
        time_picker id="dtp"
        number_picker id="dnp"
        content_indicator id="dci"
        crumbs id="dcr"
        path id="dpv" d="M 0 0 L 1 1"
    }
}
"##;
    let generated = compile_kdl_to_rust(defaults).unwrap();
    assert!(
        generated.contains("gui.add_slider(cells[0], 0.0, 0.0, 100.0, Style::default())"),
        "slider defaults are min 0.0, max 100.0, value 0.0 and Style::default(): {generated}"
    );
    assert!(
        generated.contains(
            "gui.add_sweeping_arc(cells[1], 0.50, true, ((cells[1].w.min(cells[1].h) / 2).saturating_sub(8)), 14, 4, Rgb565::new(1, 3, 1), Rgb565::new(0, 39, 31), Rgb565::new(7, 15, 7), Style::panel())"
        ),
        "arc defaults are 0.5 clockwise, fit-cell radius, 4/4 and the old three colours: {generated}"
    );
    assert!(
        generated.contains("gui.add_spinner(cells[2], 0.00, Style::panel())"),
        "spinner default phase is 0.0: {generated}"
    );
    assert!(
        generated.contains("gui.add_chart(cells[3], &[], 0.0, 10.0, Style::panel())"),
        "chart with no values is an empty series with min 0.0 max 10.0: {generated}"
    );
    assert!(
        generated.contains("gui.add_plotter(cells[4], &[], 0, 0.0, 10.0, Style::panel())"),
        "plotter with no values is an empty series with head 0: {generated}"
    );
    assert!(
        generated.contains("gui.add_status_bar(cells[5], \"12:00\", Style::panel())"),
        "status_bar default style is panel: {generated}"
    );
    assert!(
        generated.contains("gui.add_time_picker(cells[6], 12, 0, true, false, Style::panel())"),
        "time_picker defaults and style are unchanged: {generated}"
    );
    assert!(
        generated.contains("gui.add_number_picker(cells[7], 0, 100, 0, \"\", Style::panel())"),
        "number_picker defaults and style are unchanged: {generated}"
    );
    assert!(
        generated.contains("gui.add_content_indicator(cells[8], 3, 0, Style::panel())"),
        "content_indicator defaults and style are unchanged: {generated}"
    );
    assert!(
        generated.contains("gui.add_crumbs_indicator(cells[9], 3, 0, Style::panel())"),
        "crumbs defaults and style are unchanged: {generated}"
    );
    assert!(
        generated.contains(
            "static __shape_dpv: rusty_gui_widgets::VectorPath = rusty_gui_widgets::VectorPath { \
             stroke_width: 1, colour: None, verbs: &[rusty_gui_widgets::PathVerb::MoveTo { x: 0, y: 0 }, \
             rusty_gui_widgets::PathVerb::LineTo { x: 1, y: 1 }] };"
        ),
        "path defaults to stroke_width 1 and no colour: {generated}"
    );
}

#[test]
fn an_image_on_the_card_is_read_at_runtime_rather_than_embedded() {
    // The `sd:` prefix is the design saying the file lives on the card the firmware mounts. That is a different
    // kind of thing from an asset: the `include_gui!` macro reads every `Image`'s file off the build machine and
    // refuses a path outside the project, so an SD image must not be an `Image` at all -- it is emitted as a
    // custom widget over `rusty_gui_widgets::BmpImage`, which streams the rows as it draws them.
    let kdl = r##"screen id="Card" width=320 height=240 theme="dark" {
    grid cols="1fr" rows="1fr" {
        image id="pic" src="sd:/PIC1.BMP" fit="stretch" col=0 row=0
        image id="fitted" src="sd:/PIC2.BMP" fit="center" col=0 row=0
        image id="shouted" src="SD:PIC3.BMP" fit="stretch" col=0 row=0
    }
}
"##;
    let generated = compile_kdl_to_rust(kdl).unwrap();
    assert!(
        generated.contains(
            "rusty_gui_widgets::BmpImage { path: \"PIC1.BMP\", stretch: true, with_file: crate::sd::with_file }"
        ),
        "the card path and the reader must reach the widget: {generated}"
    );
    assert!(
        generated.contains(
            "rusty_gui_widgets::BmpImage { path: \"PIC2.BMP\", stretch: false, with_file: crate::sd::with_file }"
        ),
        "and a centred image is not stretched: {generated}"
    );
    // A card's name in a file manager is upper case, and a prefix that missed this would ask the build machine
    // for a file that only exists on the card: a different feature with a different failure.
    assert!(
        generated.contains(
            "rusty_gui_widgets::BmpImage { path: \"PIC3.BMP\", stretch: true, with_file: crate::sd::with_file }"
        ),
        "and the prefix is matched without regard to case: {generated}"
    );
    assert!(
        generated.contains("gui.add_custom_widget(cells[0], &__shape_pic, Style::default())?"),
        "the widget is added as a custom widget: {generated}"
    );
    assert!(
        !generated.contains("asset data is supplied by include_gui!"),
        "nothing is left for the macro to embed: {generated}"
    );

    // An ordinary `src` keeps the build-time route, which is the spacer the macro replaces with the pixels.
    let embedded = r##"screen id="Flash" width=320 height=240 theme="dark" {
    grid cols="1fr" rows="1fr" {
        image id="logo" src="assets/logo.bmp" col=0 row=0
    }
}
"##;
    let generated = compile_kdl_to_rust(embedded).unwrap();
    assert!(
        generated.contains("asset data is supplied by include_gui!"),
        "an embedded image is still handed to the macro: {generated}"
    );
    assert!(
        !generated.contains("BmpImage"),
        "and is not read from a card: {generated}"
    );

    // The design is written back the way it was written, so a round trip through the serializer is lossless.
    let screen = parse_kdl_screen(kdl).unwrap();
    let serialized = serialize_kdl_screen(&screen);
    assert!(
        serialized.contains("image id=\"pic\" src=\"sd:PIC1.BMP\" fit=\"stretch\""),
        "the prefix survives serialization, written the way the driver wants it: {serialized}"
    );
    assert_eq!(screen, parse_kdl_screen(&serialized).unwrap());
}
