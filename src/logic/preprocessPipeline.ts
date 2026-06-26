// 前処理パイプライン（設定フォームの値で実適用）
//
// 設計の要点:
//   - **OCRへ渡す画像の範囲・座標・アスペクト比は変えない。** ここで変えるのは
//     切り出し済み画像「にかける前処理」だけ（範囲はフック側 runOcrCycle が決める）。
//   - 領域レベルの「幾何を変えない」処理（grayscale〜threshold）と、行(バンド)レベルの
//     「幾何を変える」処理（deskew / crop_margin / resize）を分けて適用する。
//     これにより行検出（安定グレースケール上で実施）との座標対応が崩れない。
//   - OpenCV.js があれば clahe / bilateral / morph 等も適用。無い/失敗時は素の
//     グレースケール＋JSで可能な処理（gamma / hist_equalize / sharpen / threshold）に
//     フォールバックし、検査を止めない。
//
// 適用順（領域レベル）:
//   grayscale → denoise → bilateral → clahe → local_contrast → hist_equalize →
//   gamma → sharpen → unsharp → morph → stroke_boost → threshold
// 行(バンド)レベル（finishBandCanvas）:
//   deskew → crop_margin → resize（keep_ratio：縦横比を歪めない）

import type { PreprocessSettings } from '../types'
import type { Band, GrayImage } from './vision'
import { grayscale } from './vision'

// OpenCV の cv オブジェクトは型定義を持たないため any 扱い
type Cv = any

/** 奇数カーネルサイズへ補正（OpenCV のぼかし/モルフォロジは奇数 or 正値が必要） */
function oddKsize(k: number): number {
  const v = Math.max(1, Math.round(k))
  return v % 2 === 0 ? v + 1 : v
}

/** 1チャンネル(CV_8UC1) Mat を GrayImage へ変換 */
function matToGray(m: Cv): GrayImage {
  const width = m.cols
  const height = m.rows
  const data = new Uint8ClampedArray(width * height)
  data.set(m.data.subarray(0, width * height))
  return { data, width, height }
}

// ===== 領域レベル前処理（幾何を変えない） =====

/**
 * OpenCV を使った領域前処理。cv が使えないときは null を返し、呼び出し側で
 * JSフォールバックへ切り替える。
 */
function preprocessRegionCv(
  img: ImageData,
  s: PreprocessSettings,
  cv: Cv,
): GrayImage | null {
  const mats: Cv[] = []
  const track = <T>(m: T): T => {
    mats.push(m as unknown as Cv)
    return m
  }
  try {
    const src = track(cv.matFromImageData(img))
    let g: Cv = track(new cv.Mat())
    cv.cvtColor(src, g, cv.COLOR_RGBA2GRAY)
    const op = s.operations

    // denoise
    if (op.denoise.method !== 'none') {
      const k = oddKsize(op.denoise.ksize)
      if (k >= 3) {
        if (op.denoise.method === 'gaussian') {
          cv.GaussianBlur(g, g, new cv.Size(k, k), 0, 0, cv.BORDER_DEFAULT)
        } else if (op.denoise.method === 'median') {
          cv.medianBlur(g, g, k)
        } else if (op.denoise.method === 'bilateral') {
          const d = track(new cv.Mat())
          cv.bilateralFilter(g, d, k, 50, 50, cv.BORDER_DEFAULT)
          g = d
        }
      }
    }

    // bilateral（独立項目・有効時）
    if (op.bilateral.enabled) {
      const d = track(new cv.Mat())
      cv.bilateralFilter(
        g,
        d,
        Math.max(1, Math.round(op.bilateral.diameter)),
        op.bilateral.sigma_color,
        op.bilateral.sigma_space,
        cv.BORDER_DEFAULT,
      )
      g = d
    }

    // clahe（常時適用）
    {
      const t = Math.max(1, Math.round(op.clahe.tile_grid_size))
      const clahe = new cv.CLAHE(op.clahe.clip_limit, new cv.Size(t, t))
      clahe.apply(g, g)
      clahe.delete()
    }

    // local_contrast（有効時・CLAHE で実現）
    if (op.local_contrast.enabled) {
      const t = Math.max(1, Math.round(op.local_contrast.tile_grid_size))
      const c2 = new cv.CLAHE(op.local_contrast.clip_limit, new cv.Size(t, t))
      c2.apply(g, g)
      c2.delete()
    }

    // hist_equalize（有効時）
    if (op.hist_equalize.enabled) cv.equalizeHist(g, g)

    // gamma（有効時）
    if (op.gamma.enabled && op.gamma.value > 0 && op.gamma.value !== 1) {
      const lut = track(new cv.Mat(1, 256, cv.CV_8UC1))
      const inv = 1 / op.gamma.value
      for (let i = 0; i < 256; i++) {
        lut.data[i] = Math.min(255, Math.round(Math.pow(i / 255, inv) * 255))
      }
      cv.LUT(g, lut, g)
    }

    // sharpen（有効時・アンシャープマスク）
    if (op.sharpen.enabled && op.sharpen.amount > 0) {
      g = track(unsharpMaskCv(cv, g, op.sharpen.amount, op.sharpen.sigma))
    }
    // unsharp（有効時）
    if (op.unsharp.enabled && op.unsharp.amount > 0) {
      g = track(unsharpMaskCv(cv, g, op.unsharp.amount, Math.max(0.3, op.unsharp.radius)))
    }

    // morph（有効時）
    if (op.morph.enabled) applyMorphCv(cv, g, op.morph.method, op.morph.ksize, op.morph.iterations)
    // stroke_boost（有効時）
    if (op.stroke_boost.enabled)
      applyMorphCv(cv, g, op.stroke_boost.method, op.stroke_boost.ksize, op.stroke_boost.iterations)

    // threshold（有効時）
    if (op.threshold.type !== 'none') {
      if (op.threshold.type === 'binary') {
        cv.threshold(g, g, op.threshold.value, 255, cv.THRESH_BINARY)
      } else if (op.threshold.type === 'binary_inv') {
        cv.threshold(g, g, op.threshold.value, 255, cv.THRESH_BINARY_INV)
      } else if (op.threshold.type === 'otsu') {
        cv.threshold(g, g, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)
      } else if (op.threshold.type === 'adaptive') {
        const bs = oddKsize(Math.max(3, op.threshold.value | 0))
        cv.adaptiveThreshold(
          g,
          g,
          255,
          cv.ADAPTIVE_THRESH_GAUSSIAN_C,
          cv.THRESH_BINARY,
          bs,
          5,
        )
      }
    }

    return matToGray(g)
  } catch {
    return null
  } finally {
    for (const m of mats) {
      try {
        m.delete()
      } catch {
        /* 解放失敗は無視 */
      }
    }
  }
}

/** アンシャープマスク（新しい Mat を返す。呼び出し側で delete 管理する） */
function unsharpMaskCv(cv: Cv, g: Cv, amount: number, sigma: number): Cv {
  const blur = new cv.Mat()
  const out = new cv.Mat()
  try {
    const s = Math.max(0.3, sigma)
    cv.GaussianBlur(g, blur, new cv.Size(0, 0), s, s, cv.BORDER_DEFAULT)
    // out = g*(1+amount) + blur*(-amount)
    cv.addWeighted(g, 1 + amount, blur, -amount, 0, out)
  } finally {
    blur.delete()
  }
  return out
}

/** モルフォロジ（in-place） */
function applyMorphCv(
  cv: Cv,
  g: Cv,
  method: string,
  ksize: number,
  iterations: number,
): void {
  const k = oddKsize(ksize)
  const it = Math.max(1, Math.round(iterations))
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k))
  const anchor = new cv.Point(-1, -1)
  try {
    if (method === 'dilate') {
      cv.dilate(g, g, kernel, anchor, it)
    } else if (method === 'erode') {
      cv.erode(g, g, kernel, anchor, it)
    } else {
      const opType = method === 'open' ? cv.MORPH_OPEN : cv.MORPH_CLOSE
      cv.morphologyEx(g, g, opType, kernel, anchor, it)
    }
  } finally {
    kernel.delete()
  }
}

/** JS フォールバック（OpenCV 不在/失敗時）。素のグレースケール＋可能な処理のみ */
function preprocessRegionJs(img: ImageData, s: PreprocessSettings): GrayImage {
  const g = grayscale(img)
  const op = s.operations
  const data = g.data

  // hist_equalize（有効時）
  if (op.hist_equalize.enabled) {
    const hist = new Array<number>(256).fill(0)
    for (let i = 0; i < data.length; i++) hist[data[i]]++
    const cdf = new Array<number>(256).fill(0)
    let acc = 0
    for (let i = 0; i < 256; i++) {
      acc += hist[i]
      cdf[i] = acc
    }
    const total = data.length || 1
    const lut = new Uint8ClampedArray(256)
    for (let i = 0; i < 256; i++) lut[i] = Math.round((cdf[i] / total) * 255)
    for (let i = 0; i < data.length; i++) data[i] = lut[data[i]]
  }

  // gamma（有効時）
  if (op.gamma.enabled && op.gamma.value > 0 && op.gamma.value !== 1) {
    const inv = 1 / op.gamma.value
    const lut = new Uint8ClampedArray(256)
    for (let i = 0; i < 256; i++)
      lut[i] = Math.min(255, Math.round(Math.pow(i / 255, inv) * 255))
    for (let i = 0; i < data.length; i++) data[i] = lut[data[i]]
  }

  // sharpen（有効時・簡易3x3アンシャープ）
  if (op.sharpen.enabled && op.sharpen.amount > 0) {
    sharpenJs(g, op.sharpen.amount)
  }

  // threshold（有効時・binary系のみJSで対応。otsu/adaptiveはbinary相当へ簡略化）
  if (op.threshold.type !== 'none') {
    const inv = op.threshold.type === 'binary_inv'
    let th = op.threshold.value
    if (op.threshold.type === 'otsu' || op.threshold.type === 'adaptive') {
      th = otsu(data)
    }
    for (let i = 0; i < data.length; i++) {
      const on = data[i] > th
      data[i] = (inv ? !on : on) ? 255 : 0
    }
  }

  return g
}

/** 簡易シャープ（3x3 アンシャープ）。in-place 風に新配列で置換 */
function sharpenJs(g: GrayImage, amount: number): void {
  const { data, width, height } = g
  const src = Uint8ClampedArray.from(data)
  const a = amount
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const c = src[i]
      const up = y > 0 ? src[i - width] : c
      const dn = y < height - 1 ? src[i + width] : c
      const lf = x > 0 ? src[i - 1] : c
      const rt = x < width - 1 ? src[i + 1] : c
      const lap = c * 4 - up - dn - lf - rt
      data[i] = Math.max(0, Math.min(255, c + a * lap))
    }
  }
}

/** Otsu しきい値（JSフォールバック用） */
function otsu(data: Uint8ClampedArray): number {
  const total = data.length || 1
  const hist = new Array<number>(256).fill(0)
  for (let i = 0; i < data.length; i++) hist[data[i]]++
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0
  let wB = 0
  let maxVar = -1
  let threshold = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > maxVar) {
      maxVar = between
      threshold = t
    }
  }
  return threshold
}

/**
 * 領域レベル前処理。cv があれば OpenCV、無ければ JS フォールバック。
 * 出力は入力と同じ幅・高さ（幾何は変えない）。
 */
export function preprocessRegion(
  img: ImageData,
  s: PreprocessSettings,
  cv: Cv | null,
): GrayImage {
  if (cv && cv.Mat) {
    const r = preprocessRegionCv(img, s, cv)
    if (r) return r
  }
  return preprocessRegionJs(img, s)
}

// ===== 行(バンド)レベルの仕上げ（幾何を変える） =====

/** GrayImage の指定帯を切り出す（full width × band height） */
function cropBand(gray: GrayImage, band: Band): GrayImage {
  const { data, width, height } = gray
  const by = Math.max(0, Math.min(height - 1, Math.round(band.y)))
  const bh = Math.max(1, Math.min(height - by, Math.round(band.height)))
  const out = new Uint8ClampedArray(width * bh)
  out.set(data.subarray(by * width, (by + bh) * width))
  return { data: out, width, height: bh }
}

/** 余白クロップ：背景(明)を除き内容(暗)の外接矩形＋margin で切り出す */
function cropMargin(g: GrayImage, threshold: number, margin: number): GrayImage {
  const { data, width, height } = g
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // threshold 以下（暗い）＝内容とみなす
      if (data[y * width + x] < threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return g // 内容なし → そのまま
  const m = Math.max(0, Math.round(margin))
  minX = Math.max(0, minX - m)
  minY = Math.max(0, minY - m)
  maxX = Math.min(width - 1, maxX + m)
  maxY = Math.min(height - 1, maxY + m)
  const w = maxX - minX + 1
  const h = maxY - minY + 1
  const out = new Uint8ClampedArray(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = data[(minY + y) * width + (minX + x)]
    }
  }
  return { data: out, width: w, height: h }
}

/** GrayImage を canvas（RGBA・グレー）へ */
function grayToCanvas(g: GrayImage): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = g.width
  c.height = g.height
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(g.width, g.height)
  for (let p = 0; p < g.data.length; p++) {
    const v = g.data[p]
    const o = p * 4
    img.data[o] = v
    img.data[o + 1] = v
    img.data[o + 2] = v
    img.data[o + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return c
}

/** deskew（傾き補正）。cv 必須・失敗時は元 canvas を返す */
function deskewCanvas(cv: Cv | null, src: HTMLCanvasElement): HTMLCanvasElement {
  if (!cv || !cv.Mat) return src
  const mats: Cv[] = []
  const track = <T>(m: T): T => {
    mats.push(m as unknown as Cv)
    return m
  }
  try {
    const rgba = track(cv.imread(src)) // RGBA（warp 元としても使う）
    const gray = track(new cv.Mat())
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY)
    const bin = track(new cv.Mat())
    // 文字を白(前景)にして座標を集める
    cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU)
    const pts = track(new cv.Mat())
    cv.findNonZero(bin, pts)
    if (pts.rows < 10) return src
    const rect = cv.minAreaRect(pts)
    let angle = rect.angle
    if (angle < -45) angle += 90
    if (Math.abs(angle) < 0.5 || Math.abs(angle) > 30) return src // 微小/異常はスキップ
    const center = new cv.Point(src.width / 2, src.height / 2)
    const M = track(cv.getRotationMatrix2D(center, angle, 1))
    const dst = track(new cv.Mat())
    cv.warpAffine(
      rgba,
      dst,
      M,
      new cv.Size(src.width, src.height),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(255, 255, 255, 255),
    )
    const out = document.createElement('canvas')
    out.width = src.width
    out.height = src.height
    cv.imshow(out, dst)
    return out
  } catch {
    return src
  } finally {
    for (const m of mats) {
      try {
        m.delete()
      } catch {
        /* 解放失敗は無視 */
      }
    }
  }
}

/**
 * バンド（1行）を OCR 入力 canvas へ仕上げる。
 * deskew → crop_margin → resize（keep_ratio：縦横比を歪めない）の順で適用。
 * resize の目標高さは ratio_threshold で単一行(single)/横長(wide_height)を切替。
 */
export function finishBandCanvas(
  processed: GrayImage,
  band: Band,
  s: PreprocessSettings,
  cv: Cv | null,
): HTMLCanvasElement {
  const op = s.operations
  // 1) 帯を切り出し
  let g = cropBand(processed, band)
  // 2) crop_margin（有効時）
  if (op.crop_margin.enabled) {
    g = cropMargin(g, op.crop_margin.threshold, op.crop_margin.margin)
  }
  let canvas = grayToCanvas(g)
  // 3) deskew（有効時）
  if (op.deskew.enabled) {
    canvas = deskewCanvas(cv, canvas)
  }
  // 4) resize（常時。縦横比は歪めない＝目標高さに合わせ等倍スケール）
  const srcW = canvas.width
  const srcH = canvas.height
  const ratio = srcW / Math.max(1, srcH)
  const targetH = Math.max(
    8,
    Math.round(ratio > s.ratio_threshold ? op.resize.wide_height : op.resize.single),
  )
  // keep_ratio が false でも、過去の「潰れ」防止のため縦横比は常に保持する
  const scale = targetH / Math.max(1, srcH)
  const targetW = Math.max(1, Math.round(srcW * scale))
  if (targetH === srcH && targetW === srcW) return canvas
  const out = document.createElement('canvas')
  out.width = targetW
  out.height = targetH
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, 0, 0, targetW, targetH)
  return out
}
