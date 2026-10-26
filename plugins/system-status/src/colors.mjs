// Mole's status palette (fixed colors). Used when colorMode = "mole".
// Values are RGB triplets; ui/line.tsx converts them to OpenTUI RGBA.

export const MOLE_PALETTE = {
  success: [165, 214, 167], // #A5D6A7
  warning: [255, 169, 77], // #FFA94D (orange)
  error: [255, 95, 95], // #FF5F5F
  accent: [199, 159, 215], // #C79FD7
  border: [64, 64, 64], // #404040
  muted: [115, 115, 115], // #737373
  keyboard: [233, 30, 99], // #E91E63 — background of the keyboard badge
  onKeyboard: [255, 255, 255], // white text on the badge
}
