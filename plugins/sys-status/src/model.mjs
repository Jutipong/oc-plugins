// sys-status — snapshot -> render model.
//
// Pure functions that turn a collector snapshot into lines of styled
// segments. The JSX layer only maps segment tones to theme tokens, so the
// exact sidebar/panel text is fully testable without OpenTUI.

import {
  align,
  bar,
  displayWidth,
  formatAmps,
  formatBytes,
  formatBytesShort,
  formatDuration,
  formatPercent,
  formatRate,
  formatVolts,
  formatWatts,
  hasNumber,
  safeNumber,
  separator,
  sparkline,
  toneForUsage,
  truncate,
} from "./format.mjs"

const SIDEBAR_WIDTH = 36
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
  return toneForUsage(percentValue, 60, 85)
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

export function buildPanelModel(snapshot, options = {}) {
  const width = options.width ?? 100
  const contentWidth = Math.max(24, width - 4)
  const coresMode = options.cores ?? "p"
  const barStyle = options.barStyle === "solid" ? "solid" : "mole"
  const twoColumn = contentWidth >= 96
  const columnWidth = twoColumn ? Math.floor((contentWidth - 3) / 2) : contentWidth

  if (!snapshot || snapshot.updatedAt === 0) {
    return {
      header: [[seg("Status", "accent", true)], [seg("starting…", "muted")]],
      left: [],
      right: [],
      full: [],
      footer: [],
      twoColumn,
    }
  }
  if (snapshot.unsupported) {
    return {
      header: [[seg("Status", "accent", true)], [seg("This platform is not supported yet", "warning")]],
      left: [],
      right: [],
      full: [[seg(snapshot.errors?.[0] ?? "", "muted")]],
      footer: [],
      twoColumn,
    }
  }

  const hardware = snapshot.hardware ?? {}
  const health = snapshot.health ?? {}
  const healthLine = [
    seg("Status", "accent", true),
    seg("  Health ", "muted"),
    seg(`● ${health.score ?? "--"}`, health.tone ?? "muted", true),
    seg(`  ${health.label ?? ""}${health.message ? `: ${health.message}` : ""}`, "muted"),
  ]
  const gpu = hardware.gpuCores ? `, ${hardware.gpuCores}GPU` : hardware.gpuName ? `, ${hardware.gpuName}` : ""
  const refresh = hasNumber(hardware.refreshRate) && hardware.refreshRate > 0 ? ` · ${Math.round(hardware.refreshRate)}Hz` : ""
  const identity = [
    hardware.name,
    hardware.chip ? `${hardware.chip}${gpu}` : gpu ? gpu.replace(/^, /, "") : null,
    hardware.totalRam ? `RAM ${formatBytes(hardware.totalRam)}` : null,
    hardware.diskSize ? `Disk ${formatBytes(hardware.diskSize)}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
  const meta = [
    hardware.osVersion,
    snapshot.uptimeSec ? `up ${formatDuration(snapshot.uptimeSec)}` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  const header = clipAll(
    [
      healthLine,
      [seg(truncate(identity, contentWidth), "muted")],
      [seg(meta, "faint")],
      [seg(separator(contentWidth), "faint")],
    ],
    contentWidth,
  )

  const left = clipAll([...cpuCard(snapshot, columnWidth, coresMode, barStyle), [seg(" ")], ...diskCard(snapshot, columnWidth, barStyle)], columnWidth)
  const right = clipAll([...memoryCard(snapshot, columnWidth, barStyle), [seg(" ")], ...powerCard(snapshot, columnWidth, barStyle)], columnWidth)
  const full = clipAll(networkCard(snapshot, contentWidth), contentWidth)
  const age = snapshot.updatedAt ? Math.max(0, Math.round((Date.now() - snapshot.updatedAt) / 1000)) : null
  const footer = clipAll(
    [
      [
        seg("r", "base", true),
        seg(" restart · ", "muted"),
        seg("f", "base", true),
        seg(" fullscreen · ", "muted"),
        seg("c", "base", true),
        seg(` cores (${coresMode === "all" ? "all" : "summary"}) · `, "muted"),
        seg("q", "base", true),
        seg(" close", "muted"),
      ],
      [seg(`native collector · updated ${age == null ? "--" : `${age}s`} ago`, "faint")],
    ],
    contentWidth,
  )

  return { header, left, right, full, footer, twoColumn, columnWidth }
}

function cpuCard(snapshot, width, coresMode, barStyle) {
  const cpu = snapshot.cpu ?? {}
  const barWidth = Math.max(8, Math.min(24, width - 19))
  const usage = cpu.usage
  const tone = usageTone(usage)
  const lines = [
    [seg("◉ CPU", "accent", true)],
    [label("Total", 7), ...barSegment(usage, barWidth, tone, barStyle), valueSegment(` ${formatPercent(usage)}`, tone)],
  ]
  const perCore = Array.isArray(cpu.perCore) ? cpu.perCore : []
  const summaryCount = cpu.pCores && cpu.pCores > 0 ? cpu.pCores : Math.min(4, perCore.length)
  const show = coresMode === "all" ? perCore : perCore.slice(0, Math.max(1, summaryCount))
  show.forEach((value, index) => {
    const coreTone = usageTone(value)
    lines.push([
      label(`Core${index + 1}`, 7),
      ...barSegment(value, barWidth, coreTone, barStyle),
      valueSegment(` ${formatPercent(value)}`, coreTone),
    ])
  })
  if (cpu.detail) {
    lines.push([seg(`  ${truncate(cpu.detail, width - 2)}`, "muted")])
  } else if (cpu.logical) {
    lines.push([
      label("Cores", 7),
      seg(`${cpu.logical} logical${cpu.physical ? ` · ${cpu.physical} physical` : ""}`, "muted"),
    ])
  }
  return lines
}

function memoryCard(snapshot, width, barStyle) {
  const memory = snapshot.memory ?? {}
  const barWidth = Math.max(8, Math.min(24, width - 19))
  const usedPercent = memory.usedPercent
  const freePercent = hasNumber(usedPercent) ? Math.max(0, 100 - usedPercent) : null
  const usedTone = usageTone(usedPercent)
  const freeTone = usageTone(freePercent)
  const lines = [
    [seg("◫ Memory", "accent", true)],
    [label("Used", 7), ...barSegment(usedPercent, barWidth, usedTone, barStyle), valueSegment(` ${formatPercent(usedPercent)}`, usedTone)],
    [label("Free", 7), ...barSegment(freePercent, barWidth, freeTone, barStyle), valueSegment(` ${formatPercent(freePercent)}`, freeTone)],
    [
      label("Total", 7),
      seg(`${formatBytes(memory.used)} / ${formatBytes(memory.total)}`, "base"),
    ],
  ]
  const cache = []
  if (hasNumber(memory.cached)) cache.push(`Cache ${formatBytes(memory.cached)}`)
  if (hasNumber(memory.available)) cache.push(`Avail ${formatBytes(memory.available)}`)
  if (hasNumber(memory.swapUsed) && memory.swapUsed > 0) cache.push(`Swap ${formatBytes(memory.swapUsed)}`)
  if (cache.length) lines.push([label("", 7), seg(cache.join(" · "), "muted")])
  return lines
}

function diskCard(snapshot, width, barStyle) {
  const disk = snapshot.disk ?? {}
  const barWidth = Math.max(8, Math.min(24, width - 19))
  const usedPercent = disk.usedPercent
  const tone = usageTone(usedPercent)
  const lines = [
    [seg("▥ Disk", "accent", true)],
    [label("INTR", 7), ...barSegment(usedPercent, barWidth, tone, barStyle), valueSegment(` ${formatPercent(usedPercent, 0)}`, tone)],
    [label("Total", 7), seg(formatBytes(disk.total), "base")],
    [
      label("Used", 7),
      seg(`${formatBytesShort(disk.used)} used · ${formatBytesShort(disk.free)} free`, "muted"),
    ],
  ]
  if (hasNumber(disk.readRate) || hasNumber(disk.writeRate)) {
    lines.push([
      label("I/O", 7),
      seg(`R ${formatRate(disk.readRate)} · W ${formatRate(disk.writeRate)}`, "muted"),
    ])
  }
  return lines
}

function powerCard(snapshot, width, barStyle) {
  const power = snapshot.power ?? {}
  const barWidth = Math.max(8, Math.min(24, width - 19))
  const lines = [[seg("◪ Power", "accent", true)]]
  if (power.present) {
    const levelTone = batteryTone(power.percent)
    lines.push([label("Level", 8), ...barSegment(power.percent, barWidth, levelTone, barStyle), valueSegment(` ${formatPercent(power.percent, 0)}`, levelTone)])
    if (hasNumber(power.healthPercent)) {
      const healthTone = batteryTone(power.healthPercent)
      lines.push([
        label("Health", 8),
        ...barSegment(power.healthPercent, barWidth, healthTone, barStyle),
        valueSegment(` ${formatPercent(power.healthPercent, 0)}`, healthTone),
      ])
    }
    const input = powerFlow(power, "system")
    if (input) lines.push([label("Input", 8), seg(input, "base")])
    const battery = powerFlow(power, "battery")
    if (battery) lines.push([label("Battery", 8), seg(battery, "muted")])
    const adapter = []
    const adapterWatts = hasNumber(power.adapterWatts) ? power.adapterWatts : power.acWatts
    if (hasNumber(adapterWatts)) adapter.push(`${formatWatts(adapterWatts, 0)} max`)
    if (hasNumber(power.cycles)) adapter.push(`${power.cycles} cycles`)
    if (adapter.length) lines.push([label("Adapter", 8), seg(adapter.join(" · "), "muted")])
    if (!input && !battery && power.status) lines.push([seg(power.status, "muted")])
  } else {
    lines.push([label("Source", 8), seg("AC Power", "base")])
    const adapterWatts = hasNumber(power.adapterWatts) ? power.adapterWatts : power.acWatts
    lines.push([label("Adapter", 8), seg(hasNumber(adapterWatts) ? `${formatWatts(adapterWatts, 0)} max` : "--", "muted")])
  }
  return lines
}

function powerFlow(power, kind) {
  const watts = kind === "system" ? power.systemWatts : power.batteryWatts
  const amps = kind === "system" ? power.systemAmps : power.batteryAmps
  const volts = kind === "system" ? power.systemVolts : power.batteryVolts
  const parts = []
  if (hasNumber(watts)) parts.push(formatWatts(watts, watts === 0 ? 0 : 1))
  if (hasNumber(amps)) parts.push(`· ${formatAmps(amps)}`)
  if (hasNumber(volts)) parts.push(`@ ${formatVolts(volts)}`)
  if (kind === "battery" && power.status) parts.push(`· ${power.status}`)
  return parts.filter(Boolean).join(" ") || null
}

function networkCard(snapshot, width) {
  const network = snapshot.network ?? {}
  const sparkWidth = Math.max(8, Math.min(20, width - 23))
  const name = network.tunnel ? "Tunnel" : network.name
  return [
    [seg("⇅ Network", "accent", true)],
    [
      label("Down", 7),
      seg(sparkline(network.rxHistory ?? [], sparkWidth), "accent"),
      valueSegment(` ${formatRate(network.rxRate)}`, "base"),
    ],
    [
      label("Up", 7),
      seg(sparkline(network.txHistory ?? [], sparkWidth), "accent"),
      valueSegment(` ${formatRate(network.txRate)}`, "base"),
    ],
    [seg([name, network.ip].filter(Boolean).join(" · ") || "--", "muted")],
  ]
}

/** Zip two card columns into full panel lines with a gap. */
export function combineColumns(leftLines, rightLines, leftWidth, gap = 3) {
  const rows = Math.max(leftLines.length, rightLines.length)
  const output = []
  for (let index = 0; index < rows; index += 1) {
    const left = leftLines[index] ?? []
    const right = rightLines[index] ?? []
    const pad = Math.max(0, leftWidth - lineWidth(left))
    output.push([...left, seg(" ".repeat(pad + gap)), ...right])
  }
  return output
}

export { align, lineWidth }
