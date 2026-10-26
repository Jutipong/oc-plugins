// system-status — the keyboard language currently in use.
//
// macOS keeps the active input source in the HIToolbox preferences; reading
// that key through `defaults` needs no Accessibility permission and follows
// every layout switch. Windows has no equivalent key, so the probe asks user32
// for the keyboard layout of the foreground window — the terminal you are
// typing in. Both probes return a short code (`TH`, `EN`, …).
//
// Everything here is pure (the command tables are data) so the harness can
// assert the mapping without spawning a process.

export const MAC_INPUT_SOURCE_BIN = "/usr/bin/defaults"
export const MAC_INPUT_SOURCE_ARGS = [
  "read",
  "com.apple.HIToolbox",
  "AppleCurrentKeyboardLayoutInputSourceID",
]

/** Windows: foreground-window HKL -> the two-letter language name of its LCID. */
export const WINDOWS_INPUT_SOURCE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class OpenCodeKb{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr hWnd,IntPtr thread);[DllImport(\"user32.dll\")]public static extern IntPtr GetKeyboardLayout(uint thread);}'",
  "try{$hkl=[OpenCodeKb]::GetKeyboardLayout([OpenCodeKb]::GetWindowThreadProcessId([OpenCodeKb]::GetForegroundWindow(),[IntPtr]::Zero));$id=[int]($hkl.ToInt64() -band 0xFFFF);[System.Globalization.CultureInfo]::GetCultureInfo($id).TwoLetterISOLanguageName}catch{(Get-Culture).TwoLetterISOLanguageName}",
].join(" ")

export const WINDOWS_POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_INPUT_SOURCE_SCRIPT]

/** Absolute PowerShell path on Windows, else the bare name for PATH lookup. */
export function windowsPowerShellPath(env = {}) {
  const root = env.SystemRoot ?? env.windir
  return root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : "powershell"
}

/**
 * macOS keyboard-layout names -> language code. Layouts that are missing fall
 * back to the first three letters of their name instead of a guessed code.
 */
const LAYOUT_CODES = new Map(
  Object.entries({
    abc: "EN",
    us: "EN",
    usextended: "EN",
    usinternational: "EN",
    british: "EN",
    britishpc: "EN",
    australian: "EN",
    canadian: "EN",
    canadacsa: "EN",
    dvorak: "EN",
    dvorakleft: "EN",
    dvorakright: "EN",
    colemak: "EN",
    irish: "EN",
    newzealand: "EN",
    thai: "TH",
    thaipatachote: "TH",
    thaipattachote: "TH",
    french: "FR",
    frenchpc: "FR",
    canadianfrench: "FR",
    swissfrench: "FR",
    german: "DE",
    swissgerman: "DE",
    spanish: "ES",
    spanishiso: "ES",
    italian: "IT",
    portuguese: "PT",
    brazilian: "PT",
    dutch: "NL",
    belgian: "NL",
    swedish: "SV",
    swedishpro: "SV",
    norwegian: "NB",
    danish: "DA",
    finnish: "FI",
    icelandic: "IS",
    polish: "PL",
    polishpro: "PL",
    czech: "CS",
    slovak: "SK",
    hungarian: "HU",
    romanian: "RO",
    croatian: "HR",
    slovenian: "SL",
    serbian: "SR",
    serbianlatin: "SR",
    bulgarian: "BG",
    bulgarianphonetic: "BG",
    russian: "RU",
    russianphonetic: "RU",
    ukrainian: "UK",
    greek: "EL",
    greekpolytonic: "EL",
    turkish: "TR",
    turkishq: "TR",
    hebrew: "HE",
    arabic: "AR",
    persian: "FA",
    urdu: "UR",
    hindi: "HI",
    tamil: "TA",
    telugu: "TE",
    malayalam: "ML",
    bengali: "BN",
    gujarati: "GU",
    gurmukhi: "PA",
    kannada: "KN",
    sinhala: "SI",
    burmese: "MY",
    khmer: "KM",
    lao: "LO",
    tibetan: "BO",
    mongolian: "MN",
    amharic: "AM",
    armenian: "HY",
    georgian: "KA",
    azerbaijani: "AZ",
    kazakh: "KK",
    uzbek: "UZ",
    indonesian: "ID",
    vietnamese: "VI",
    japanese: "JA",
    korean: "KO",
  }),
)

/** Input-method bundles carry their language in the bundle id, not the last segment. */
const METHOD_CODES = [
  ["kotoeri", "JA"],
  ["scim", "ZH"],
  ["tcim", "ZH"],
  ["korean", "KO"],
  ["thai", "TH"],
  ["vietnamese", "VI"],
  ["arabic", "AR"],
  ["hebrew", "HE"],
  ["persian", "FA"],
  ["urdu", "UR"],
  ["hindi", "HI"],
  ["tamil", "TA"],
  ["telugu", "TE"],
  ["malayalam", "ML"],
  ["bengali", "BN"],
]

/** Letters only, upper-cased, at most three cells — `"Klingon"` -> `"KLI"`. */
function deriveCode(name) {
  const letters = String(name ?? "")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase()
  return letters ? letters.slice(0, 3) : null
}

/** macOS layout name -> code, or a derived code when the name is unknown. */
export function codeForLayoutName(name) {
  const key = String(name ?? "").trim().toLowerCase()
  if (!key) return null
  return LAYOUT_CODES.get(key) ?? deriveCode(name)
}

/** `defaults read … AppleCurrentKeyboardLayoutInputSourceID` -> `"TH"` / null. */
export function parseMacInputSource(text) {
  const id = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (!id || !id.startsWith("com.apple.")) return null
  const lower = id.toLowerCase()
  if (!lower.includes("keylayout.")) {
    for (const [token, code] of METHOD_CODES) {
      if (lower.includes(token)) return code
    }
  }
  return codeForLayoutName(id.slice(id.lastIndexOf(".") + 1))
}

/** PowerShell culture name (`th`, `en-US`, `fil`) -> `"TH"` / null. */
export function parseWindowsLanguage(text) {
  const value =
    String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  const match = value.match(/^([A-Za-z]{2,3})(?:[-_].*)?$/)
  return match ? match[1].toUpperCase() : null
}
