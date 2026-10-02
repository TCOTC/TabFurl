/**
 * 生成占位图标（纯 Node，无第三方依赖）。
 *
 *   node tools/generate-icons.mjs
 *
 * 图形是一枚书签飘带叠在圆角方块上，配色走主色 indigo→violet。
 * 这只是占位，正式发布前应替换成设计稿；替换后可以删掉这个脚本。
 */
import {deflateSync} from 'node:zlib'
import {mkdirSync, writeFileSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(HERE, '../src/images')
const SIZES = [16, 32, 48, 64, 128]

/** 超采样倍率，用来获得抗锯齿边缘。 */
const SS = 4

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)

  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)

  return Buffer.concat([length, typed, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型：RGBA

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // 过滤器：none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, {level: 9})),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function insideRoundedSquare(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius)
  const cy = Math.min(Math.max(y, radius), size - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

function insidePolygon(x, y, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (crosses) inside = !inside
  }
  return inside
}

function lerp(from, to, t) {
  return Math.round(from + (to - from) * t)
}

/** 书签飘带的相对坐标（相对画布边长）。 */
const RIBBON = [
  [0.355, 0.205],
  [0.645, 0.205],
  [0.645, 0.795],
  [0.5, 0.655],
  [0.355, 0.795]
]

function render(size) {
  const canvas = size * SS
  const radius = 0.22 * canvas
  const ribbon = RIBBON.map(([px, py]) => [px * canvas, py * canvas])

  const big = Buffer.alloc(canvas * canvas * 4)
  for (let y = 0; y < canvas; y++) {
    for (let x = 0; x < canvas; x++) {
      const px = x + 0.5
      const py = y + 0.5
      if (!insideRoundedSquare(px, py, canvas, radius)) continue

      const t = py / canvas
      let r = lerp(79, 124, t)
      let g = lerp(70, 58, t)
      let b = lerp(229, 237, t)

      if (insidePolygon(px, py, ribbon)) {
        r = 255
        g = 255
        b = 255
      }

      const offset = (y * canvas + x) * 4
      big[offset] = r
      big[offset + 1] = g
      big[offset + 2] = b
      big[offset + 3] = 255
    }
  }

  // 下采样：按 alpha 加权平均，避免边缘出现黑边。
  const out = Buffer.alloc(size * size * 4)
  const samples = SS * SS
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let alpha = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const offset = ((y * SS + sy) * canvas + (x * SS + sx)) * 4
          const a = big[offset + 3] / 255
          r += big[offset] * a
          g += big[offset + 1] * a
          b += big[offset + 2] * a
          alpha += a
        }
      }

      const target = (y * size + x) * 4
      out[target] = alpha > 0 ? Math.round(r / alpha) : 0
      out[target + 1] = alpha > 0 ? Math.round(g / alpha) : 0
      out[target + 2] = alpha > 0 ? Math.round(b / alpha) : 0
      out[target + 3] = Math.round((alpha / samples) * 255)
    }
  }

  return out
}

mkdirSync(OUT_DIR, {recursive: true})
for (const size of SIZES) {
  const file = resolve(OUT_DIR, `icon-${size}.png`)
  writeFileSync(file, encodePng(size, size, render(size)))
  console.log(`wrote ${file}`)
}
