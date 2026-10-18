// sys-status — snapshot -> render model.
//
// Pure functions that turn a collector snapshot into lines of styled
// segments. The JSX layer only maps segment tones to theme tokens, so the
// exact sidebar text is fully testable without OpenTUI.

import {
  align,
  bar,
  displayWidth,
  formatAmps,
  formatBytes,
  formatBytesShort,
  formatPercent,
  formatRate,
  formatVolts,
  formatWatts,
  hasNumber,
  padStart,
  safeNumber,
  separator,
  toneForUsage,
  truncate,
} from "./format.mjs"

const SIDEBAR_WIDTH = 36
const VALUE_CELL = 5
const RATE_CELL = 9
const FRAME_CHARS = {
  rounded: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
  heavy: { topLeft: "┏", topRight: "┓", bottomLeft: "┗", bottomRight: "┛", horizontal: "━", vertical: "┃" },
}

function seg(text, tone = "base", bold = false) {
  return { text: String(text ?? ""), tone, bold }
}

function lineWidth(line) {
  return (line ?? []).reduce((width, item) => width + displayWidth(item.text), 0)
}

function clipLine(line, width) {
  const output = []
  let remaining = width
  for (const item of line ?? []) {
    if (remaining <= 0) break
    const text = truncate(item.text, remaining)
    if (!text) continue
    output.push({ ...item, text })
    remaining -= displayWidth(text)
  }
  return output
}

function clipAll(lines, width) {
  return lines.map((line) => clipLine(line, width))
}

function label(text, width = 6, tone = "muted") {
  return seg(text.padEnd(width), tone)
}

function barSegment(percentValue, width, tone, barStyle = "mole") {
  const value = bar(percentValue, width)
  if (barStyle === "solid") {
    return [seg(value.filled, tone), seg(" ".repeat(Math.max(0, value.width - value.filled.length)), "faint")]
  }
  return [seg(value.filled, tone), seg(value.empty, tone)]
}

function usageTone(percentValue) {
  return toneForUsage(percentValue, 50, 80)
}

/**
 * One label + meter + value row. The default layout uses a `width - 19`
 * meter; `opts.rightAlign` (full sidebar) widens the meter to the space left
 * next to the label and parks the value in a shared column.
 */
function meterRow(labelText, labelWidth, percentValue, tone, valueText, width, barStyle, opts = {}) {
  const barWidth = opts.rightAlign
    ? Math.max(8, Math.min(24, width - labelWidth - VALUE_CELL - 1))
    : Math.max(8, Math.min(24, width - 19))
  const meter = barSegment(percentValue, barWidth, tone, barStyle)
  if (opts.rightAlign) {
    return alignSegments(
      [label(labelText, labelWidth), ...meter],
      [valueSegment(padStart(valueText, VALUE_CELL), tone)],
      width,
    )
  }
  return [label(labelText, labelWidth), ...meter, valueSegment(` ${valueText}`, tone)]
}

function batteryTone(percentValue) {
  const value = safeNumber(percentValue, 0)
  if (value < 20) return "error"
  if (value < 50) return "warning"
  return "success"
}

function valueSegment(text, tone = "base") {
  return seg(text, tone)
}

function statusLine(snapshot, width) {
  const health = snapshot.health ?? {}
  const left = [seg("◈ System", "accent", true)]
  const right = [seg(`● ${health.score ?? "--"}`, health.tone ?? "muted", true)]
  const leftWidth = lineWidth(left)
  const rightWidth = lineWidth(right)
  const pad = Math.max(1, width - leftWidth - rightWidth)
  return clipLine([...left, seg(" ".repeat(pad)), ...right], width)
}

function alignSegments(left, right, width) {
  const leftWidth = lineWidth(left)
  const rightWidth = lineWidth(right)
  const pad = Math.max(1, width - leftWidth - rightWidth)
  return clipLine([...left, seg(" ".repeat(pad)), ...right], width)
}

/** Border row: `╭─ ◈ System ─────────────────────────╮`. */
function frameTop(total, chars) {
  const left = [
    seg(`${chars.topLeft}${chars.horizontal} `, "border"),
    seg("◈ System", "accent", true),
    seg(" ", "border"),
  ]
  const dashes = Math.max(1, total - lineWidth(left) - 1)
  return clipLine([...left, seg(`${chars.horizontal.repeat(dashes)}${chars.topRight}`, "border")], total)
}

function frameBottom(total, chars) {
  return [seg(`${chars.bottomLeft}${chars.horizontal.repeat(Math.max(0, total - 2))}${chars.bottomRight}`, "border")]
}

/** Pad a content line to exactly `width` cells so the right border aligns. */
function padLine(line, width) {
  const clipped = clipLine(line, width)
  const missing = width - lineWidth(clipped)
  if (missing <= 0) return clipped
  return [...clipped, seg(" ".repeat(missing), "base")]
}

function frameContentLine(line, inner, chars) {
  return [seg(`${chars.vertical} `, "border"), ...padLine(line, inner), seg(` ${chars.vertical}`, "border")]
}

export function buildSidebarModel(snapshot, options = {}) {
  const total = Math.max(16, Math.round(options.width ?? SIDEBAR_WIDTH))
  const frame = options.frame === "heavy" ? "heavy" : options.frame === "none" ? "none" : "rounded"
  const framed = frame !== "none"
  const width = framed ? Math.max(12, total - 4) : total
  const spacing = options.spacing === "normal" || options.spacing === "airy" ? options.spacing : "compact"
  const barStyle = options.barStyle === "solid" ? "solid" : "mole"
  if (!snapshot || snapshot.updatedAt === 0) {
    return { lines: [[seg("◈ System", "accent", true)], [seg("starting…", "muted")]] }
  }
  if (snapshot.unsupported) {
    return {
      lines: [
        [seg("◈ System", "accent", true)],
        [seg("macOS / Windows only", "warning")],
      ],
    }
  }

  if (options.mode === "full") {
    const rowSpacing =
      options.rowSpacing === "compact" || options.rowSpacing === "normal" || options.rowSpacing === "airy"
        ? options.rowSpacing
        : spacing
    return buildSidebarFullModel(snapshot, {
      total,
      width,
      framed,
      frame,
      barStyle,
      rowSpacing,
      cores: options.cores === "all" ? "all" : "p",
    })
  }

  const lines = []
  if (!framed) {
    lines.push(statusLine(snapshot, width))
    lines.push([seg(separator(width), "faint")])
  }

  const gapAfterCpu = spacing === "normal" || spacing === "airy"
  const gapAfterMem = spacing === "airy"
  const gapAfterDisk = spacing === "normal" || spacing === "airy"
  const gapAfterPower = spacing === "airy"

  const cpuPercent = snapshot.cpu?.usage
  const cpuTone = usageTone(cpuPercent)
  const cpuChip = snapshot.hardware?.chip ?? null
  const cpuSpeed = snapshot.cpu?.speedGhz
  const cpuSpeedText =
    hasNumber(cpuSpeed) && cpuSpeed > 0 && !/\bghz\b/i.test(cpuChip ?? "") ? `${cpuSpeed.toFixed(1)} GHz` : null
  const cpuLeft = [
    seg("◉ CPU", "muted"),
    ...(cpuChip ? [seg(` ${cpuChip}`, "base")] : []),
    ...(cpuSpeedText ? [seg(` · ${cpuSpeedText}`, "faint")] : []),
  ]
  lines.push(alignSegments(cpuLeft, [seg(formatPercent(cpuPercent), cpuTone, true)], width))
  lines.push([...barSegment(cpuPercent, width, cpuTone, barStyle)])
  if (gapAfterCpu) lines.push([seg(" ")])

  const memoryPercent = snapshot.memory?.usedPercent
  const memoryTone = usageTone(memoryPercent)
  const ram = formatBytes(snapshot.memory?.total ?? snapshot.hardware?.totalRam)
  const ramLeft = [seg("◫ RAM", "muted"), ...(ram !== "--" ? [seg(` ${ram}`, "faint")] : [])]
  lines.push(alignSegments(ramLeft, [seg(formatPercent(memoryPercent), memoryTone, true)], width))
  lines.push([...barSegment(memoryPercent, width, memoryTone, barStyle)])
  if (gapAfterMem) lines.push([seg(" ")])

  const diskPercent = snapshot.disk?.usedPercent
  const diskTone = usageTone(diskPercent)
  lines.push(alignSegments([seg("▥ DSK", "muted")], [seg(formatPercent(diskPercent, 0), diskTone, true)], width))
  lines.push([...barSegment(diskPercent, width, diskTone, barStyle)])
  lines.push([seg(separator(width, "─"), "border")])
  if (gapAfterDisk) lines.push([seg(" ")])

  const power = snapshot.power ?? {}
  if (power.present) {
    const drawWatts =
      hasNumber(power.systemWatts) && power.systemWatts > 0
        ? power.systemWatts
        : hasNumber(power.batteryWatts) && power.batteryWatts > 0
          ? power.batteryWatts
          : null
    if (drawWatts != null) {
      const scale = hasNumber(power.adapterWatts) && power.adapterWatts > 0 ? power.adapterWatts : 100
      const loadPercent = Math.min(100, (drawWatts / scale) * 100)
      const loadTone = usageTone(loadPercent)
      lines.push(alignSegments([seg("◪ PWR", "muted")], [seg(formatWatts(drawWatts, 1), loadTone, true)], width))
      lines.push([...barSegment(loadPercent, width, loadTone, barStyle)])
    } else {
      lines.push(alignSegments([seg("◪ PWR", "muted")], [seg("--", "muted")], width))
    }
  } else {
    lines.push(alignSegments([seg("◪ PWR", "muted")], [seg("AC Power", "muted")], width))
  }
  if (gapAfterPower) lines.push([seg(" ")])

  const network = snapshot.network ?? {}
  const rxRate = network.rxRate
  const txRate = network.txRate
  const networkText =
    rxRate == null && txRate == null
      ? "--"
      : `↓ ${formatRate(rxRate)}  ↑ ${formatRate(txRate)}`
  lines.push(alignSegments([seg("⇅ NET", "muted")], [seg(networkText, "muted")], width))

  if (!framed) return { lines: clipAll(lines, width) }
  const chars = FRAME_CHARS[frame]
  return {
    lines: [
      frameTop(total, chars),
      ...lines.map((line) => frameContentLine(line, width, chars)),
      frameBottom(total, chars),
    ],
  }
}

/** Card title: accent label, with an optional muted value aligned right. */
function cardTitle(text, value, width, opts = {}) {
  const title = [seg(text, "accent", true)]
  if (!opts.rightAlign || !value) return title
  return alignSegments(title, [seg(value, "muted")], width)
}

/** Join ` · `-separated fields, keeping only the ones that fit into `width`. */
function packFields(fields, width) {
  const kept = []
  let used = 0
  for (const field of fields) {
    if (!field) continue
    const add = kept.length === 0 ? displayWidth(field) : displayWidth(field) + 3
    if (kept.length > 0 && used + add > width) break
    kept.push(field)
    used += add
  }
  return kept.join(" · ")
}

/** Trim a ` · `-joined detail line to its longest fitting leading part. */
function fittingDetail(detail, width) {
  const value = String(detail ?? "")
  if (displayWidth(value) <= width) return value
  const head = value.split(" · ")[0]
  return displayWidth(head) <= width ? head : value
}

/** Full dashboard cards stacked into the narrow sidebar. */
function buildSidebarFullModel(snapshot, { total, width, framed, frame, barStyle, rowSpacing, cores }) {
  const layout = { tight: true, rightAlign: true }
  const cards = [
    cpuCard(snapshot, width, cores, barStyle, layout),
    memoryCard(snapshot, width, barStyle, layout),
    diskCard(snapshot, width, barStyle, layout),
    powerCard(snapshot, width, barStyle, layout),
    networkCard(snapshot, width, layout),
  ]
  const lines = []
  cards.forEach((card, index) => {
    if (index > 0) {
      if (rowSpacing === "normal") lines.push([seg(" ")])
      else if (rowSpacing === "airy") lines.push([seg(separator(width), "faint")])
    }
    lines.push(...card)
  })
  if (!framed) return { lines: clipAll(lines, width) }
  const chars = FRAME_CHARS[frame]
  return {
    lines: [
      frameTop(total, chars),
      ...lines.map((line) => frameContentLine(line, width, chars)),
      frameBottom(total, chars),
    ],
  }
}

function cpuCard(snapshot, width, coresMode, barStyle, opts = {}) {
  const cpu = snapshot.cpu ?? {}
  const usage = cpu.usage
  const tone = usageTone(usage)
  const chip = snapshot.hardware?.chip ?? null
  const speed = cpu.speedGhz
  const speedText = hasNumber(speed) && speed > 0 && !/\bghz\b/i.test(chip ?? "") ? `${speed.toFixed(1)} GHz` : null
  const chipText = [chip, speedText].filter(Boolean).join(" · ")
  const lines = [
    cardTitle("◉ CPU", chipText, width, opts),
    meterRow("Total", 7, usage, tone, formatPercent(usage), width, barStyle, opts),
  ]
  const perCore = Array.isArray(cpu.perCore) ? cpu.perCore : []
  const summaryCount = cpu.pCores && cpu.pCores > 0 ? cpu.pCores : Math.min(4, perCore.length)
  const show = coresMode === "all" ? perCore : perCore.slice(0, Math.max(1, summaryCount))
  show.forEach((value, index) => {
    const coreTone = usageTone(value)
    lines.push(meterRow(`Core${index + 1}`, 7, value, coreTone, formatPercent(value), width, barStyle, opts))
  })
  if (cpu.detail) {
    lines.push([seg(`  ${truncate(opts.tight ? fittingDetail(cpu.detail, width - 2) : cpu.detail, width - 2)}`, "muted")])
  } else if (cpu.logical) {
    lines.push([
      label("Cores", 7),
      seg(`${cpu.logical} logical${cpu.physical ? ` · ${cpu.physical} physical` : ""}`, "muted"),
    ])
  }
  return lines
}

function memoryCard(snapshot, width, barStyle, opts = {}) {
  const memory = snapshot.memory ?? {}
  const usedPercent = memory.usedPercent
  const freePercent = hasNumber(usedPercent) ? Math.max(0, 100 - usedPercent) : null
  const usedTone = usageTone(usedPercent)
  const freeTone = usageTone(freePercent)
  const total = formatBytes(memory.total ?? snapshot.hardware?.totalRam)
  let titleValue = total === "--" ? null : total
  if (opts.rightAlign && hasNumber(memory.used) && hasNumber(memory.total)) {
    titleValue = `${formatBytes(memory.used)} / ${formatBytes(memory.total)}`
  }
  const lines = [
    cardTitle("◫ Memory", titleValue, width, opts),
    meterRow("Used", 7, usedPercent, usedTone, formatPercent(usedPercent), width, barStyle, opts),
  ]
  if (!opts.rightAlign) {
    lines.push(meterRow("Free", 7, freePercent, freeTone, formatPercent(freePercent), width, barStyle, opts))
    lines.push([label("Total", 7), seg(`${formatBytes(memory.used)} / ${formatBytes(memory.total)}`, "base")])
  }
  const cache = []
  if (hasNumber(memory.cached)) cache.push(`Cache ${formatBytes(memory.cached)}`)
  if (hasNumber(memory.available)) cache.push(`Avail ${formatBytes(memory.available)}`)
  if (hasNumber(memory.swapUsed) && memory.swapUsed > 0) cache.push(`Swap ${formatBytes(memory.swapUsed)}`)
  if (cache.length) {
    if (opts.tight) lines.push([seg(packFields(cache, width), "muted")])
    else lines.push([label("", 7), seg(cache.join(" · "), "muted")])
  }
  return lines
}

function diskCard(snapshot, width, barStyle, opts = {}) {
  const disk = snapshot.disk ?? {}
  const usedPercent = disk.usedPercent
  const tone = usageTone(usedPercent)
  const total = formatBytes(disk.total)
  let titleValue = total === "--" ? null : total
  if (opts.rightAlign && hasNumber(disk.used) && hasNumber(disk.total)) {
    titleValue = `${formatBytes(disk.used)} / ${formatBytes(disk.total)}`
  }
  const lines = [
    cardTitle("▥ Disk", titleValue, width, opts),
    meterRow("INTR", 7, usedPercent, tone, formatPercent(usedPercent, 0), width, barStyle, opts),
  ]
  if (!opts.rightAlign) {
    lines.push([label("Total", 7), seg(total, "base")])
    lines.push([
      label("Used", 7),
      seg(`${formatBytesShort(disk.used)} used · ${formatBytesShort(disk.free)} free`, "muted"),
    ])
  }
  if (hasNumber(disk.readRate) || hasNumber(disk.writeRate)) {
    lines.push([
      label("I/O", 7),
      seg(`R ${formatRate(disk.readRate)} · W ${formatRate(disk.writeRate)}`, "muted"),
    ])
  }
  return lines
}

function powerCard(snapshot, width, barStyle, opts = {}) {
  const power = snapshot.power ?? {}
  const level = power.present ? (hasNumber(power.percent) ? formatPercent(power.percent, 0) : null) : "AC"
  const lines = [cardTitle("◪ Power", level, width, opts)]
  if (power.present) {
    if (!(opts.rightAlign && hasNumber(power.percent))) {
      const levelTone = batteryTone(power.percent)
      lines.push(meterRow("Level", 8, power.percent, levelTone, formatPercent(power.percent, 0), width, barStyle, opts))
    }
    if (hasNumber(power.healthPercent)) {
      const healthTone = batteryTone(power.healthPercent)
      lines.push(
        meterRow("Health", 8, power.healthPercent, healthTone, formatPercent(power.healthPercent, 0), width, barStyle, opts),
      )
    }
    const inputActive =
      (hasNumber(power.systemWatts) && power.systemWatts > 0) || (hasNumber(power.systemAmps) && power.systemAmps > 0)
    const input = inputActive ? powerFlow(power, "system") : null
    if (input) lines.push([label("Input", 8), seg(input, "base")])
    let battery = powerFlow(power, "battery")
    if (battery && opts.tight && displayWidth(battery) > width - 8) {
      battery = powerFlow(power, "battery", false) || battery
    }
    if (battery) lines.push([label("Battery", 8), seg(battery, "muted")])
    const adapterWatts = hasNumber(power.adapterWatts) ? power.adapterWatts : power.acWatts
    if (hasNumber(adapterWatts)) {
      const adapter = [`${formatWatts(adapterWatts, 0)} max`]
      if (hasNumber(power.cycles)) adapter.push(`${power.cycles} cycles`)
      lines.push([label("Adapter", 8), seg(adapter.join(" · "), "muted")])
    } else if (hasNumber(power.cycles)) {
      lines.push([label("Cycles", 8), seg(`${power.cycles}`, "muted")])
    }
    if (!input && !battery && power.status) lines.push([seg(power.status, "muted")])
  } else {
    lines.push([label("Source", 8), seg("AC Power", "base")])
    const adapterWatts = hasNumber(power.adapterWatts) ? power.adapterWatts : power.acWatts
    lines.push([label("Adapter", 8), seg(hasNumber(adapterWatts) ? `${formatWatts(adapterWatts, 0)} max` : "--", "muted")])
  }
  return lines
}

function powerFlow(power, kind, includeStatus = true) {
  const watts = kind === "system" ? power.systemWatts : power.batteryWatts
  const amps = kind === "system" ? power.systemAmps : power.batteryAmps
  const volts = kind === "system" ? power.systemVolts : power.batteryVolts
  const parts = []
  if (hasNumber(watts)) parts.push(formatWatts(watts, watts === 0 ? 0 : 1))
  if (hasNumber(amps)) parts.push(`· ${formatAmps(amps)}`)
  if (hasNumber(volts)) parts.push(`@ ${formatVolts(volts)}`)
  if (kind === "battery" && includeStatus && power.status) parts.push(`· ${power.status}`)
  return parts.filter(Boolean).join(" ") || null
}

function networkCard(snapshot, width, opts = {}) {
  const network = snapshot.network ?? {}
  const name = network.tunnel ? "Tunnel" : network.name
  const lines = [
    cardTitle("⇅ Network", network.ip, width, opts),
    networkRow("Up", network.txRate, width, opts),
    networkRow("Down", network.rxRate, width, opts),
  ]
  // The sidebar carries the IP in the title; the footer survives only when
  // the title has nothing to show.
  if (!(opts.rightAlign && network.ip)) {
    const footer = (opts.rightAlign ? name : [name, network.ip].filter(Boolean).join(" · ")) || "--"
    lines.push([seg(footer, "muted")])
  }
  return lines
}

function networkRow(labelText, rate, width, opts = {}) {
  const left = [label(labelText, 7)]
  if (opts.rightAlign) {
    return alignSegments(left, [valueSegment(padStart(formatRate(rate), RATE_CELL), "base")], width)
  }
  return [...left, valueSegment(` ${formatRate(rate)}`, "base")]
}

export { align, lineWidth }
