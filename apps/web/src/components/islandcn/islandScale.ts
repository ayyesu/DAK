/**
 * How large the island's UI is on the desktop, as a share of the phone design it was drawn at.
 *
 * The island's type, tiles and buttons are sized for a phone held at arm's length: a 17 pt title,
 * a 44 pt button, a 52 pt tile. Beside the app's own 13 px chat text that reads as oversized, and a
 * button that tall dwarfs the card it sits in. 0.82 brings them to the app's density (a 14 px
 * title, a 12 px subtitle, a 36 px button, a 43 px tile, a 30 px resting pill that sits inside the
 * 40 px title bar with room to spare) while every proportion stays as calibrated.
 *
 * It is one number applied to the whole island, not to each size, so nothing can drift out of
 * proportion. 1 gives the phone's own size back.
 */
export const ISLAND_UI_SCALE = 0.82;

/**
 * Tallest the expanded card may grow, in the island's own (unscaled) units. The default 180 is
 * what a phone card needs; a goal with a two-line title, a two-line status and a button needs
 * about 195, and a cap below that squeezes the button.
 */
export const ISLAND_EXPANDED_MAX_HEIGHT = 200;
