// 映像前処理・行分割モジュール（OpenCV 非依存・純粋 canvas / 配列処理）
// 役割:
//   - 切り出し領域の前処理（グレースケール化・二値化）
//   - 行検出（自動: 水平投影 / 固定: 縦等分）
//   - 行ごとの画像切り出し（OCR入力用 canvas）
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
 * OCR・表示で共通の「軽い」前処理。
 *
 * 方針（重要）:
 *   - **二値化（Otsu）は行わない。** Otsu は画像全体で単一しきい値を取るため、
 *     照明ムラ・反射で破綻し文字を消してしまう。近年の Tesseract(LSTM) は
 *     無理に二値化した画像よりグレースケールの方が認識が良い。
 *   - グレースケール化 ＋ 端1%をクリップする**軽いコントラスト補正**のみ。
 *     階調を保ったまま見やすさを少し上げる（強い強調や閾値処理で文字を潰さない）。
 *   - 背景が暗い（明文字・暗地）場合のみ控えめに反転し、Tesseract が読みやすい
 *     「暗文字・明地」へ寄せる（階調は保持。これも軽い補正の範囲）。
 *
 * 解像度は入力 ImageData のまま（縮小しない）。表示用に縮小するかどうかは
 * 呼び出し側の責務で、この関数自体は解像度を変えない。
 */
export function preprocess(img: ImageData): GrayImage {
  const { width, height, data } = img
  const total = width * height
  const gray = new Uint8ClampedArray(total)
  const hist = new Array<number>(256).fill(0)
  let sum = 0
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0
    gray[p] = g
    hist[g]++
    sum += g
  }

  // 端1%をクリップして軽くコントラストを伸長（ヒストグラムの外れ値に強い）
  const clip = Math.max(1, Math.floor(total * 0.01))
  let lo = 0
  for (let acc = 0; lo < 255; lo++) {
    acc += hist[lo]
    if (acc >= clip) break
  }
  let hi = 255
  for (let acc = 0; hi > 0; hi--) {
    acc += hist[hi]
    if (acc >= clip) break
  }

  const out = new Uint8ClampedArray(total)
  const range = hi - lo
  if (range > 10) {
    const scale = 255 / range
    for (let p = 0; p < total; p++) {
      out[p] = (gray[p] - lo) * scale // Uint8ClampedArray が 0〜255 へクランプ
    }
  } else {
    // ほぼ単調な画像は伸長しない（過補正で潰さない）
    out.set(gray)
  }

  // 背景が暗いときだけ控えめに反転（暗文字・明地へ正規化）。階調は保持。
  const mean = sum / total
  if (mean < 100) {
    for (let p = 0; p < total; p++) out[p] = 255 - out[p]
  }

  return { data: out, width, height }
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

/**
 * グレースケール画像の1帯を OCR 入力用の canvas に切り出す。
 * 入力解像度は落とさず、小さい行を読みやすくするため拡大（補間OFF）して返す。
 * 縮小はしない（拡大のみ）ので、OCR入力の解像度低下は起きない。
 */
export function bandToCanvas(
  gray: GrayImage,
  band: Band,
  scale = 2,
): HTMLCanvasElement {
  const { data, width, height } = gray
  const by = Math.max(0, Math.min(height - 1, band.y))
  const bh = Math.max(1, Math.min(height - by, band.height))

  // 等倍の一時 canvas に描画
  const tmp = document.createElement('canvas')
  tmp.width = width
  tmp.height = bh
  const tctx = tmp.getContext('2d')!
  const imgData = tctx.createImageData(width, bh)
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < width; x++) {
      const v = data[(by + y) * width + x]
      const o = (y * width + x) * 4
      imgData.data[o] = v
      imgData.data[o + 1] = v
      imgData.data[o + 2] = v
      imgData.data[o + 3] = 255
    }
  }
  tctx.putImageData(imgData, 0, 0)

  // 拡大して返す
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(bh * scale))
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height)
  return canvas
}
