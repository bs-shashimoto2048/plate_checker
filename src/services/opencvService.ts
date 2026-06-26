// OpenCV.js サービス
// 役割は「銘板の輪郭検出」だけに限定する（前処理・行分割は OpenCV 非依存の
// logic/vision.ts 側で行う）。これにより OpenCV の読み込みに失敗しても、
// ガイド枠フォールバックで映像検査を継続できる。
//
// 読み込み: OpenCV.js は npm 配布が扱いづらく数MB と大きいため、CDN から
// <script> タグで動的読み込みする。WASM 初期化完了まで待つ必要がある
// （onRuntimeInitialized）。初回はネットワーク接続が必要。

/** OpenCV.js の取得元（バージョン固定） */
const OPENCV_URL = 'https://docs.opencv.org/4.10.0/opencv.js'

// OpenCV の cv オブジェクトは型定義を持たないため any 扱いとする
type Cv = any

declare global {
  interface Window {
    cv?: Cv
  }
}

let cvPromise: Promise<Cv> | null = null

/** 検出された矩形（画像ピクセル座標） */
export interface DetectedRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * OpenCV.js を読み込む。多重呼び出しは同一Promiseを返す。
 * @param timeoutMs 初期化タイムアウト（既定30秒）
 */
export function loadOpenCv(timeoutMs = 30000): Promise<Cv> {
  if (cvPromise) return cvPromise

  cvPromise = new Promise<Cv>((resolve, reject) => {
    // すでに初期化済み
    if (window.cv && window.cv.Mat) {
      resolve(window.cv)
      return
    }

    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error('OpenCV.js の初期化がタイムアウトしました'))
      }
    }, timeoutMs)

    const finish = (cv: Cv) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      window.cv = cv
      resolve(cv)
    }

    const script = document.createElement('script')
    script.src = OPENCV_URL
    script.async = true
    script.onload = () => {
      const cv = window.cv
      if (!cv) {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new Error('OpenCV.js の読み込みに失敗しました'))
        }
        return
      }
      // ビルドによって初期化の通知方法が異なるため両対応する
      if (cv.Mat) {
        finish(cv)
      } else if (typeof cv.then === 'function') {
        // Promise 形式のビルド
        cv.then((m: Cv) => finish(m))
      } else {
        cv.onRuntimeInitialized = () => finish(window.cv)
      }
    }
    script.onerror = () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error('OpenCV.js のダウンロードに失敗しました'))
      }
    }
    document.body.appendChild(script)
  })

  return cvPromise
}

/**
 * 画像（ImageData）から銘板とみられる四角形を検出し、その外接矩形を返す。
 * 処理: グレースケール→ぼかし→Cannyエッジ→膨張→輪郭抽出→四角形近似。
 * アスペクト比は厳密に要求せず、面積が一定以上の凸四角形を採用する。
 * 見つからなければ null。
 *
 * @param cv loadOpenCv() で得た cv オブジェクト
 * @param imageData 検出対象（通常はガイド枠内の切り出し）
 * @param minAreaRatio 画像面積に対する最小面積比
 */
export function detectPlateRect(
  cv: Cv,
  imageData: ImageData,
  minAreaRatio = 0.18,
): DetectedRect | null {
  const src = cv.matFromImageData(imageData)
  const gray = new cv.Mat()
  const blurred = new cv.Mat()
  const edges = new cv.Mat()
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U)
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()

  let best: DetectedRect | null = null
  let bestArea = 0
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0)
    cv.Canny(blurred, edges, 50, 150)
    cv.dilate(edges, edges, kernel)
    cv.findContours(
      edges,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE,
    )

    const totalArea = imageData.width * imageData.height
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i)
      const peri = cv.arcLength(cnt, true)
      const approx = new cv.Mat()
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true)
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const area = cv.contourArea(approx)
        if (area > minAreaRatio * totalArea && area > bestArea) {
          const r = cv.boundingRect(approx)
          best = { x: r.x, y: r.y, width: r.width, height: r.height }
          bestArea = area
        }
      }
      approx.delete()
      cnt.delete()
    }
  } finally {
    // OpenCV.js は手動でメモリ解放が必要
    src.delete()
    gray.delete()
    blurred.delete()
    edges.delete()
    kernel.delete()
    contours.delete()
    hierarchy.delete()
  }

  return best
}
