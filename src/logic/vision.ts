// 行分割モジュール（OpenCV 非依存・純粋 canvas / 配列処理）
// 役割:
//   - 行検出用の安定グレースケール化（前処理設定に左右されない中間画像）
//   - 行検出（自動: 水平投影 / 固定: 縦等分）
// 実際のOCR前処理パイプラインは logic/preprocessPipeline.ts 側で行う。
// OpenCV が読み込めない環境でも、ここはそのまま動作する。

/** 検出された1行の帯（領域内の相対座標） */
export interface Band {
  /** 領域内での上端Y */
  y: number
  /** 帯の高さ */
  height: number
}

/** 前処理後のグレースケール画像（1チャンネル・0=黒〜255=白） */
export interface GrayImage {
  data: Uint8ClampedArray
  width: number
  height: number
}

/**
 * ImageData を単純グレースケール化する（補正なし）。
 * 行検出は前処理設定（二値化ON/OFF等）に左右されず安定している必要があるため、
 * 行検出専用の「安定した中間画像」としてこの素のグレースケールを使う。
 */
export function grayscale(img: ImageData): GrayImage {
  const { width, height, data } = img
  const total = width * height
  const out = new Uint8ClampedArray(total)
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    out[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0
  }
  return { data: out, width, height }
}

/** グレースケール配列に対する Otsu しきい値（行検出の投影にのみ内部使用） */
function otsuThreshold(gray: Uint8ClampedArray, total: number): number {
  const hist = new Array<number>(256).fill(0)
  for (let p = 0; p < total; p++) hist[gray[p]]++
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
 * 自動行検出。水平方向の投影（行ごとの「暗い画素」数）の山を行として分割する。
 * 1〜4行を想定し、小さすぎる帯は除外、近接する帯は結合する。
 *
 * 二値化は廃止したため、グレースケール画像に対して **行検出の投影にのみ**
 * Otsu しきい値を内部的に求め、それより暗い画素を文字(ink)として数える
 * （前処理で文字は暗側へ正規化済み）。OCR入力はグレースケールのまま渡す。
 */
export function detectLinesAuto(gray: GrayImage): Band[] {
  const { data, width, height } = gray
  const threshold = otsuThreshold(data, width * height)
  const rowDark = new Array<number>(height).fill(0)
  for (let y = 0; y < height; y++) {
    const off = y * width
    let c = 0
    for (let x = 0; x < width; x++) if (data[off + x] <= threshold) c++
    rowDark[y] = c
  }

  let maxc = 1
  for (let y = 0; y < height; y++) if (rowDark[y] > maxc) maxc = rowDark[y]
  const thr = Math.max(2, maxc * 0.12)

  // しきい値以上の連続行を帯にする
  const raw: Band[] = []
  let start = -1
  for (let y = 0; y < height; y++) {
    if (rowDark[y] > thr) {
      if (start < 0) start = y
    } else if (start >= 0) {
      raw.push({ y: start, height: y - start })
      start = -1
    }
  }
  if (start >= 0) raw.push({ y: start, height: height - start })

  // 近接帯の結合
  const gapMerge = Math.max(2, Math.round(height * 0.02))
  const merged: Band[] = []
  for (const b of raw) {
    const last = merged[merged.length - 1]
    if (last && b.y - (last.y + last.height) < gapMerge) {
      last.height = b.y + b.height - last.y
    } else {
      merged.push({ ...b })
    }
  }

  // 小さすぎる帯を除外し、大きい順に最大4行、最後にY順へ
  const minH = Math.max(6, Math.round(height * 0.06))
  const filtered = merged
    .filter((b) => b.height >= minH)
    .sort((a, b) => b.height - a.height)
    .slice(0, 4)
    .sort((a, b) => a.y - b.y)

  return filtered.length > 0 ? filtered : [{ y: 0, height }]
}

/** 固定行検出。領域の縦を n（1〜4）で等分する。 */
export function detectLinesFixed(height: number, rows: number): Band[] {
  const k = Math.max(1, Math.min(4, Math.floor(rows)))
  const h = height / k
  const bands: Band[] = []
  for (let i = 0; i < k; i++) {
    const y = Math.round(i * h)
    const next = i === k - 1 ? height : Math.round((i + 1) * h)
    bands.push({ y, height: next - y })
  }
  return bands
}
