# rusty-gui-widgets

The shapes `embedded-gui 0.2.7` parses but does not paint: `Circle`, `Rectangle`, `Line` and `Triangle` as
`CustomWidget` implementations, drawn through the `CustomCanvas` the engine hands a custom widget at render time.

Every dimension is derived from the cell `rect` the engine lays out — never from a parsed `radius` — so the board
paints what the designer's canvas shows. `CustomCanvas` has no `draw_circle`: a circle is a disc plus an annulus
by integer distance test, and a rounded rectangle's outline is the four straight runs plus a mid-point-circle arc
per corner. `stroke_width = 0` means *no outline*, matching the canvas.

Used by the Designer template through a vendored `embedded-gui-codegen` fork that calls `add_custom_widget`;
see `../embedded-gui-codegen/README.md`. Licence: MIT OR Apache-2.0.
