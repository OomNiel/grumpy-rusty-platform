/* Grumpy's Rusty Platform -- the LVGL configuration for this project.
 *
 * This file is at the project root rather than in src/ because that is where LVGL looks: the build passes
 * `-DLV_CONF_INCLUDE_SIMPLE -I<project>` (see the README), and without that flag LVGL looks for
 * `lv_conf.h` inside its own library folder instead.
 *
 * Anything not set here is LVGL's own default. */
#ifndef LV_CONF_H
#define LV_CONF_H

/* The panels this extension drives are RGB565. LV_COLOR_DEPTH is deprecated in LVGL 9 and kept only so that
 * an older 9.x still agrees with a newer one. */
#define LV_COLOR_FORMAT_DEFAULT LV_COLOR_FORMAT_RGB565
#define LV_COLOR_DEPTH 16

/* 64 KB: a full 320x240 screen is 150 KB, so LVGL renders through the display buffer and never holds a whole
 * frame. This is the heap for objects, styles and strings. */
#define LV_MEM_SIZE (64 * 1024U)

#define LV_USE_OS LV_OS_NONE
#define LV_USE_LOG 0

/* The font a label starts with. Every other size is off, which is most of LVGL's code size. */
#define LV_FONT_MONTSERRAT_14 1
#define LV_FONT_MONTSERRAT_16 1
#define LV_FONT_DEFAULT &lv_font_montserrat_14

#endif /* LV_CONF_H */
