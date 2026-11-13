#!/usr/bin/env node
// Derives every app icon from the web app's icon (../src/dashboard/icon.png) so the phone and the
// web share one mark. Writes 1024px iOS light/dark/tinted variants (iOS 18+ appearance icons) and
// Android adaptive-icon layers. Run `pnpm generate-icons` after the web icon changes.
const { readFileSync, writeFileSync } = require("node:fs")
const { resolve } = require("node:path")
const { PNG } = require("pngjs")
const { SOURCE: CSS, buildTheme } = require("./sync-web-theme")

const SOURCE = resolve(__dirname, "../../src/dashboard/icon.png")
const ASSETS = resolve(__dirname, "../assets")
const SIZE = 1024

const hex = value => [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16))

/** Bilinear resample to SIZE x SIZE. */
function resize(source) {
  const out = new PNG({ width: SIZE, height: SIZE })
  const scaleX = (source.width - 1) / (SIZE - 1)
  const scaleY = (source.height - 1) / (SIZE - 1)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const sx = x * scaleX, sy = y * scaleY
      const x0 = Math.floor(sx), y0 = Math.floor(sy)
      const x1 = Math.min(x0 + 1, source.width - 1), y1 = Math.min(y0 + 1, source.height - 1)
      const fx = sx - x0, fy = sy - y0
      for (let channel = 0; channel < 4; channel++) {
        const at = (px, py) => source.data[(py * source.width + px) * 4 + channel]
        const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx
        const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx
        out.data[(y * SIZE + x) * 4 + channel] = Math.round(top * (1 - fy) + bottom * fy)
      }
    }
  }
  return out
}

/**
 * Maps every pixel to [r, g, b, a] via `transform`, after keying out the flat background colour.
 * Edge pixels are un-premultiplied against the background so no navy fringe survives.
 */
function variant(image, background, transform) {
  const out = new PNG({ width: SIZE, height: SIZE })
  for (let index = 0; index < image.data.length; index += 4) {
    const rgb = [image.data[index], image.data[index + 1], image.data[index + 2]]
    const distance = Math.hypot(...rgb.map((value, channel) => value - background[channel]))
    const alpha = Math.max(0, Math.min(1, (distance - 14) / 46))
    const color = alpha === 0 ? rgb : rgb.map((value, channel) => Math.max(0, Math.min(255, (value - background[channel] * (1 - alpha)) / alpha)))
    const [r, g, b, a] = transform(color, alpha)
    out.data.set([r, g, b, Math.round(a * 255)].map(Math.round), index)
  }
  return out
}

function main() {
  const tokens = buildTheme(readFileSync(CSS, "utf8")).tokens
  const paper = hex(tokens.text) // the web's light text tone, used for the page in dark mode
  const image = resize(PNG.sync.read(readFileSync(SOURCE)))
  const background = [0, 1, 2].map(channel => image.data[channel]) // flat corner colour
  const write = (name, png) => writeFileSync(resolve(ASSETS, name), PNG.sync.write(png))

  write("icon.png", image)
  // Dark: transparent background (iOS supplies its own dark backdrop); the bright page is
  // softened to the web's text tone so it doesn't glare on a dark Home Screen.
  write("icon-dark.png", variant(image, background, (color, alpha) => {
    const whiteness = Math.min(...color) / 255
    return [...color.map((value, channel) => value + (paper[channel] - value) * Math.max(0, whiteness - 0.75) * 4), alpha]
  }))
  // Tinted: grayscale luminance on transparent; iOS applies the user's tint.
  write("icon-tinted.png", variant(image, background, (color, alpha) => {
    const luminance = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]
    return [luminance, luminance, luminance, alpha]
  }))
  // Android adaptive icon: the mark on a transparent foreground over the web's ink background.
  write("android-icon-foreground.png", variant(image, background, (color, alpha) => [...color, alpha]))
  write("android-icon-monochrome.png", variant(image, background, (_, alpha) => [255, 255, 255, alpha]))
  const solid = new PNG({ width: SIZE, height: SIZE })
  const ink = hex(tokens.ink)
  for (let index = 0; index < solid.data.length; index += 4) solid.data.set([...ink, 255], index)
  write("android-icon-background.png", solid)
  console.log("Wrote icons to", ASSETS)
}

main()
