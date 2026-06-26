// 映像リアルタイム検査フック
//
// 負荷分離が最重要:
//   - 表示・輪郭検出ループ: requestAnimationFrame（約30FPS）。プレビュー上に
//     ガイド枠（赤）・検出輪郭・行帯を描画する（銘板の記載内容は重ねない）。
//   - OCR検査ループ: setInterval(500ms)（約2FPS）。最新フレームを1枚取得し、
//     切り出し→二値化→行分割→行ごとOCR→照合→行ごとOK確定 を行う。
//     前回が終わっていなければスキップ（多重実行防止）。
//
// 検査モデル: 製番(Product) は複数の銘板(No) を持ち、各 No は枚数(quantity) を持つ。
//   行ごとに一度PASSで確定（順不同で消し込み）→ 全行確定で「1枚OK」→ 残数カウント →
//   必要枚数に達したら次の No へ → 全 No 完了で製番の全数完了。
//
// OCR処理(ocrService) / カメラ(cameraService) / 輪郭検出(opencvService) /
// 前処理・行分割(vision) はそれぞれ独立。OpenCV が読めない場合もガイド枠
// フォールバックで検査を継続する。

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  InspectionTarget,
  LineMode,
  PreprocessSettings,
  LineState,
  ProductProgress,
} from '../types'
import {
  createOcrService,
  type OcrOptions,
  type OcrService,
} from '../services/ocrService'
import { startCameraStream, stopCameraStream } from '../services/cameraService'
import {
  detectPlateRect,
  loadOpenCv,
  type DetectedRect,
} from '../services/opencvService'
import {
  grayscale,
  detectLinesAuto,
  detectLinesFixed,
  type Band,
} from '../logic/vision'
import {
  preprocessRegion,
  finishBandCanvas,
} from '../logic/preprocessPipeline'
import { matchExpectedLine, type MatchThresholds } from '../logic/match'
import { normalizeText } from '../logic/normalize'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** 映像枠に映す内容（通常映像 / 前処理後映像。表示のみの切替でOCRには影響しない） */
export type PreviewMode = 'normal' | 'preprocessed'

export interface UseVideoInspection {
  videoRef: React.RefObject<HTMLVideoElement>
  overlayRef: React.RefObject<HTMLCanvasElement>
  /** 前処理後映像（表示用）を描画する不透明canvas。映像枠を覆う */
  binaryRef: React.RefObject<HTMLCanvasElement>
  running: boolean
  cvReady: boolean
  cvError: string | null
  error: string | null
  /** OCR言語データ（jpn+eng）のロード失敗メッセージ。正常時は null */
  ocrError: string | null
  /** 検出枠の幅・高さ（表示px。映像枠上で見えている実寸基準） */
  guideWpx: number
  guideHpx: number
  setGuideWpx: (v: number) => void
  setGuideHpx: (v: number) => void
  /** 検出枠pxの最小値（幅=100 / 高さ=50）と最大値（=映像枠の表示実寸px・動的） */
  guideMinWpx: number
  guideMinHpx: number
  guideMaxWpx: number
  guideMaxHpx: number
  /** 検出枠pxの調整ステップ（=5） */
  guideStepPx: number
  mode: LineMode
  toggleMode: () => void
  fixedRows: number
  setFixedRows: (n: number) => void
  detectedLineCount: number
  /** 映像枠の表示モード（通常 / 前処理後）。設定メニューのSwitchで切替 */
  previewMode: PreviewMode
  setPreviewMode: (m: PreviewMode) => void
  /** 直近にOCRが読み取った生テキスト（映像右上表示用・2FPS更新） */
  lastOcrText: string
  /** 直近に照合した行のラベルと類似度（映像右上表示用・2FPS更新） */
  lastMatch: { label: string; score: number } | null
  /** 現在の製番の検査進捗（テーブル表示に使用） */
  progress: ProductProgress | null
  /** 全数完了したか */
  allDone: boolean
  start: () => Promise<void>
  stop: () => void
  reset: () => void
}

// 検出枠は「表示px」で指定する（映像枠上で見えている実寸基準）。
// ステップ5px、最大は映像枠の表示実寸（動的）に追従する。
// 最小は 幅100px × 高さ50px（高さは幅の半分）。
const GUIDE_MIN_W_PX = 100
const GUIDE_MIN_H_PX = 50
const GUIDE_STEP_PX = 5
// 表示実寸が未測定のときの暫定上限（測定後に実寸へ置き換わる）
const GUIDE_FALLBACK_MAX_PX = 4000
/** px値を 5px 刻みに丸めて [min, max] にクランプ */
const snapGuidePx = (v: number, min: number, max: number) => {
  const snapped = Math.round(v / GUIDE_STEP_PX) * GUIDE_STEP_PX
  return Math.max(min, Math.min(Math.max(min, max), snapped))
}

function clampRect(r: Rect, w: number, h: number): Rect {
  const x = Math.max(0, Math.min(w - 1, r.x))
  const y = Math.max(0, Math.min(h - 1, r.y))
  return {
    x,
    y,
    width: Math.max(1, Math.min(w - x, r.width)),
    height: Math.max(1, Math.min(h - y, r.height)),
  }
}

function freshLines(labelTexts: string[]): LineState[] {
  return labelTexts.map((t) => ({
    expected: t,
    confirmed: false,
    candidate: '',
    score: 0,
  }))
}

export function useVideoInspection(
  target: InspectionTarget | null,
  ocrOptions: OcrOptions,
  thresholds: MatchThresholds,
  preprocessSettings: PreprocessSettings,
): UseVideoInspection {
  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const binaryRef = useRef<HTMLCanvasElement>(null)

  // 内部用 canvas / リソース
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const detectCanvasRef = useRef<HTMLCanvasElement | null>(null)
  // 前処理プレビュー用（表示レート側で軽く処理するためのオフスクリーン）
  const previewSrcCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const previewBinCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const lastPreviewTsRef = useRef(0)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  const timerRef = useRef<number | null>(null)
  const ocrServiceRef = useRef<OcrService | null>(null)
  if (!ocrServiceRef.current) ocrServiceRef.current = createOcrService()

  // ループ内で参照する最新値（stale closure 回避のため ref に同期）
  const runningRef = useRef(false)
  const busyRef = useRef(false)
  const cvRef = useRef<unknown>(null)
  // 検出枠サイズ（表示px）。0 は未初期化（映像枠実寸の測定後に既定値を設定）
  const guideRef = useRef({ wpx: 0, hpx: 0 })
  const modeRef = useRef<LineMode>('auto')
  const fixedRowsRef = useRef(2)
  const previewModeRef = useRef<PreviewMode>('normal')
  const ocrOptionsRef = useRef(ocrOptions)
  const thresholdsRef = useRef(thresholds)
  // 前処理設定（フォームの最新値）。ループ内から参照し、変更がリアルタイムに反映される
  const preprocessRef = useRef(preprocessSettings)
  const lastDetectTsRef = useRef(0)
  const lastRectRef = useRef<Rect | null>(null)
  const lastRegionRef = useRef<Rect | null>(null)
  const lastBandsRef = useRef<Band[] | null>(null)

  // 進捗（ループ内では progressRef を直接更新し、commit で表示用stateへ反映）
  const progressRef = useRef<ProductProgress | null>(null)

  // 表示用 state
  const [running, setRunning] = useState(false)
  const [cvReady, setCvReady] = useState(false)
  const [cvError, setCvError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ocrError, setOcrError] = useState<string | null>(null)
  const [guideWpx, setGuideWpxState] = useState(0)
  const [guideHpx, setGuideHpxState] = useState(0)
  // 映像枠の表示実寸（px）。検出枠pxの最大値に使う（リサイズ/回転で追従）
  const [stageW, setStageW] = useState(0)
  const [stageH, setStageH] = useState(0)
  const [mode, setModeState] = useState<LineMode>('auto')
  const [fixedRows, setFixedRowsState] = useState(2)
  const [detectedLineCount, setDetectedLineCount] = useState(0)
  const [previewMode, setPreviewModeState] = useState<PreviewMode>('normal')
  const [lastOcrText, setLastOcrText] = useState('')
  const [lastMatch, setLastMatch] = useState<{
    label: string
    score: number
  } | null>(null)
  const [progressState, setProgressState] = useState<ProductProgress | null>(
    null,
  )
  const [allDone, setAllDone] = useState(false)

  // --- ref 同期 ---
  useEffect(() => {
    ocrOptionsRef.current = ocrOptions
  }, [ocrOptions])
  useEffect(() => {
    thresholdsRef.current = thresholds
  }, [thresholds])
  useEffect(() => {
    preprocessRef.current = preprocessSettings
  }, [preprocessSettings])

  const setGuideWpx = (v: number) => {
    const c = snapGuidePx(v, GUIDE_MIN_W_PX, stageW || GUIDE_FALLBACK_MAX_PX)
    guideRef.current = { ...guideRef.current, wpx: c }
    setGuideWpxState(c)
  }
  const setGuideHpx = (v: number) => {
    const c = snapGuidePx(v, GUIDE_MIN_H_PX, stageH || GUIDE_FALLBACK_MAX_PX)
    guideRef.current = { ...guideRef.current, hpx: c }
    setGuideHpxState(c)
  }

  // 映像枠（video要素）の表示実寸を監視し、検出枠pxの最大値に反映。
  // 初回測定時は既定サイズ（横長寄り：幅80%・高さ45%）で初期化し、
  // リサイズ/回転で枠が縮んだら現在値を新しい最大値へクランプする。
  useEffect(() => {
    const el = videoRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const apply = (cw: number, ch: number) => {
      if (cw <= 0 || ch <= 0) return
      setStageW(cw)
      setStageH(ch)
      const cur = guideRef.current
      let wpx = cur.wpx
      let hpx = cur.hpx
      if (wpx === 0 || hpx === 0) {
        // 未初期化：見やすい既定（幅80%・高さ45%）
        wpx = cw * 0.8
        hpx = ch * 0.45
      }
      wpx = snapGuidePx(wpx, GUIDE_MIN_W_PX, cw)
      hpx = snapGuidePx(hpx, GUIDE_MIN_H_PX, ch)
      if (wpx !== cur.wpx || hpx !== cur.hpx) {
        guideRef.current = { wpx, hpx }
      }
      setGuideWpxState(wpx)
      setGuideHpxState(hpx)
    }
    apply(el.clientWidth, el.clientHeight)
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) apply(Math.round(r.width), Math.round(r.height))
    })
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleMode = () => {
    const next: LineMode = modeRef.current === 'auto' ? 'fixed' : 'auto'
    modeRef.current = next
    setModeState(next)
  }
  const setFixedRows = (n: number) => {
    const c = Math.max(1, Math.min(4, Math.floor(n)))
    fixedRowsRef.current = c
    setFixedRowsState(c)
  }
  const setPreviewMode = (m: PreviewMode) => {
    previewModeRef.current = m
    setPreviewModeState(m)
    // 通常映像へ戻したら前処理canvasを即座に隠す（次フレームを待たない）
    if (m === 'normal' && binaryRef.current) {
      binaryRef.current.style.display = 'none'
    }
  }

  /** progressRef の内容を表示用 state へ反映（イミュータブルにクローン） */
  const commit = useCallback(() => {
    const p = progressRef.current
    setProgressState(
      p
        ? {
            ...p,
            nameplates: p.nameplates.map((np) => ({
              ...np,
              lines: np.lines.map((l) => ({ ...l })),
            })),
          }
        : null,
    )
  }, [])

  /** 検査対象から進捗を初期化する */
  const initProgress = useCallback(
    (tgt: InspectionTarget | null) => {
      const prog: ProductProgress | null = tgt
        ? {
            serialNumber: tgt.serialNumber,
            type: tgt.type,
            nameplates: tgt.nameplates.map((np, i) => ({
              no: i + 1,
              quantity: np.quantity,
              doneCount: 0,
              lines: freshLines(np.labelTexts),
              done: false,
            })),
            currentNoIndex: 0,
            done: tgt.nameplates.length === 0,
          }
        : null
      progressRef.current = prog
      lastRectRef.current = null
      lastRegionRef.current = null
      lastBandsRef.current = null
      setAllDone(prog?.done ?? false)
      setDetectedLineCount(0)
      setLastOcrText('')
      setLastMatch(null)
      commit()
    },
    [commit],
  )

  useEffect(() => {
    initProgress(target)
  }, [target, initProgress])

  /**
   * 検出枠（映像フレーム内ピクセル）を計算する。
   * ユーザー指定は「表示px」（映像枠上で見えている実寸）なので、object-fit:cover の
   * 拡大率（coverScale = max(cw/vw, ch/vh)）で割って映像フレームpxへ換算する。
   * これにより「指定px＝映像枠上で見えている範囲」となり、OCR切り出し用の実映像
   * 解像度との換算を内部で吸収する。中心固定で配置する。
   */
  const computeGuideRect = useCallback((vw: number, vh: number): Rect => {
    const el = videoRef.current
    const cw = el?.clientWidth || vw
    const ch = el?.clientHeight || vh
    const coverScale = Math.max(cw / vw, ch / vh) || 1 // 表示px / 映像px
    const { wpx, hpx } = guideRef.current
    // 表示px → 映像フレームpx（未初期化時は枠の80%/45%相当でフォールバック）
    const wReq = (wpx > 0 ? wpx : cw * 0.8) / coverScale
    const hReq = (hpx > 0 ? hpx : ch * 0.45) / coverScale
    const width = Math.min(vw, Math.max(1, wReq))
    const height = Math.min(vh, Math.max(1, hReq))
    return { x: (vw - width) / 2, y: (vh - height) / 2, width, height }
  }, [])

  /** 表示ループ用: ガイド枠内の輪郭検出（ダウンスケールして実行） */
  const detectContour = useCallback(
    (video: HTMLVideoElement, guide: Rect) => {
      const cv = cvRef.current
      if (!cv) return
      if (!detectCanvasRef.current) {
        detectCanvasRef.current = document.createElement('canvas')
      }
      const maxDim = 320
      const scale = Math.min(1, maxDim / guide.width)
      const dw = Math.max(1, Math.round(guide.width * scale))
      const dh = Math.max(1, Math.round(guide.height * scale))
      const dc = detectCanvasRef.current
      dc.width = dw
      dc.height = dh
      const dctx = dc.getContext('2d', { willReadFrequently: true })
      if (!dctx) return
      dctx.drawImage(video, guide.x, guide.y, guide.width, guide.height, 0, 0, dw, dh)
      const img = dctx.getImageData(0, 0, dw, dh)
      let rect: DetectedRect | null = null
      try {
        rect = detectPlateRect(cv, img)
      } catch {
        rect = null
      }
      if (rect) {
        const inv = 1 / scale
        lastRectRef.current = {
          x: guide.x + rect.x * inv,
          y: guide.y + rect.y * inv,
          width: rect.width * inv,
          height: rect.height * inv,
        }
      } else {
        lastRectRef.current = null
      }
    },
    [],
  )

  /**
   * 前処理後映像（表示用）を映像枠に描画する。
   * - OCRには一切影響しない「確認・デバッグ用」の表示切替。
   * - **OCRが実際に処理している切り出し領域（region）と同じ範囲**を、
   *   **OCRと同じ前処理パイプライン preprocessRegion** で処理して表示する（表示＝OCR入力）。
   * - 領域外は描かず通常映像を透過させるため、OCRが食べている範囲が一目で分かる。
   * - 30FPSの表示ループから呼ぶが、内部で約10FPSに間引き（throttle）し、表示用は
   *   領域を縮小して処理する（表示の軽量化はここに限定。OCR入力には波及しない）。
   */
  const drawPreprocessed = useCallback(
    (ts: number) => {
      const bin = binaryRef.current
      if (!bin) return
      const video = videoRef.current
      if (
        previewModeRef.current !== 'preprocessed' ||
        !video ||
        video.videoWidth === 0
      ) {
        if (bin.style.display !== 'none') bin.style.display = 'none'
        return
      }
      // 表示レート側の負荷を抑えるため約100ms（≒10FPS）に間引く
      if (ts - lastPreviewTsRef.current < 100) return
      lastPreviewTsRef.current = ts

      const cw = video.clientWidth
      const ch = video.clientHeight
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (cw === 0 || ch === 0) return

      // OCRが処理しているのと同じ領域を使う（直近OCRの region、無ければガイド枠）
      const guide = computeGuideRect(vw, vh)
      const region =
        lastRegionRef.current ?? clampRect(lastRectRef.current ?? guide, vw, vh)

      // 表示用に領域を縮小して前処理（処理内容・範囲はOCRと一致、解像度のみ表示都合）
      const maxW = 360
      const dscale = Math.min(1, maxW / region.width)
      const sw = Math.max(1, Math.round(region.width * dscale))
      const sh = Math.max(1, Math.round(region.height * dscale))
      if (!previewSrcCanvasRef.current) {
        previewSrcCanvasRef.current = document.createElement('canvas')
      }
      const src = previewSrcCanvasRef.current
      src.width = sw
      src.height = sh
      const sctx = src.getContext('2d', { willReadFrequently: true })
      if (!sctx) return
      sctx.drawImage(
        video,
        region.x,
        region.y,
        region.width,
        region.height,
        0,
        0,
        sw,
        sh,
      )
      const img = sctx.getImageData(0, 0, sw, sh)

      // OCRと同じ領域前処理パイプラインを適用（表示＝実際のOCR入力）。
      // 表示は領域を縮小しているが、処理内容（preprocessRegion）はOCRと同一。
      const g = preprocessRegion(img, preprocessRef.current, cvRef.current)
      if (!previewBinCanvasRef.current) {
        previewBinCanvasRef.current = document.createElement('canvas')
      }
      const small = previewBinCanvasRef.current
      small.width = sw
      small.height = sh
      const smctx = small.getContext('2d')
      if (!smctx) return
      const out = smctx.createImageData(sw, sh)
      for (let p = 0; p < g.data.length; p++) {
        const v = g.data[p]
        const o = p * 4
        out.data[o] = v
        out.data[o + 1] = v
        out.data[o + 2] = v
        out.data[o + 3] = 255
      }
      smctx.putImageData(out, 0, 0)

      // プレビューcanvasのバッキングストアは映像の実ピクセル(vw×vh)。
      // 領域の前処理結果を「映像ピクセル座標そのまま」で描く（縦横独立スケールはしない）。
      // 表示時は CSS の object-fit:cover が映像と同一に拡縮するため、通常映像と
      // 範囲・アスペクト比が完全に一致する（領域外は透明＝通常映像が透ける）。
      if (bin.width !== vw) bin.width = vw
      if (bin.height !== vh) bin.height = vh
      const bctx = bin.getContext('2d')
      if (!bctx) return
      bctx.clearRect(0, 0, vw, vh)
      bctx.imageSmoothingEnabled = false
      bctx.drawImage(small, region.x, region.y, region.width, region.height)
      if (bin.style.display !== 'block') bin.style.display = 'block'
    },
    [computeGuideRect],
  )

  /** 表示ループ本体（約30FPS） */
  const drawLoop = useCallback(
    (ts: number) => {
      if (!runningRef.current) return
      const video = videoRef.current
      const overlay = overlayRef.current
      // 前処理後映像（表示のみ・OCR非依存）。間引きは内部で実施
      drawPreprocessed(ts)
      if (video && overlay && video.videoWidth > 0) {
        const vw = video.videoWidth
        const vh = video.videoHeight
        // オーバーレイのバッキングストアは映像の実ピクセル(vw×vh)。映像ピクセル座標で
        // 描き、CSS object-fit:cover で映像と同一にスケール＝枠が映像とズレない。
        if (overlay.width !== vw) overlay.width = vw
        if (overlay.height !== vh) overlay.height = vh
        const ctx = overlay.getContext('2d')
        if (ctx) {
          ctx.clearRect(0, 0, vw, vh)
          const guide = computeGuideRect(vw, vh)
          // 線幅は映像解像度に比例（cover縮小後も視認できる太さ）
          const lw = Math.max(2, Math.round(vw / 320))

          // 輪郭検出は約100msごとに間引く（表示は毎フレーム）
          if (cvRef.current && ts - lastDetectTsRef.current > 100) {
            lastDetectTsRef.current = ts
            detectContour(video, guide)
          }

          // ガイド枠（赤・視認性向上）
          ctx.lineWidth = lw
          ctx.strokeStyle = 'rgba(239,68,68,0.95)'
          ctx.strokeRect(guide.x, guide.y, guide.width, guide.height)

          // 検出輪郭（外接矩形）
          const rect = lastRectRef.current
          if (rect) {
            ctx.lineWidth = lw
            ctx.strokeStyle = '#22c55e'
            ctx.strokeRect(rect.x, rect.y, rect.width, rect.height)
          }

          // 行帯
          const region = lastRegionRef.current
          const bands = lastBandsRef.current
          if (region && bands) {
            ctx.lineWidth = Math.max(1, Math.round(lw / 2))
            ctx.strokeStyle = 'rgba(34,211,238,0.95)'
            for (const b of bands) {
              ctx.strokeRect(
                region.x,
                region.y + b.y,
                region.width,
                b.height,
              )
            }
          }
          // 銘板の記載内容・判定情報は映像上に重ねない（テーブル側で確認）
        }
      }
      rafRef.current = requestAnimationFrame(drawLoop)
    },
    [computeGuideRect, detectContour, drawPreprocessed],
  )

  /** OCR検査ループ本体（約2FPS、多重実行防止） */
  const runOcrCycle = useCallback(async () => {
    if (!runningRef.current || busyRef.current) return
    const video = videoRef.current
    if (!video || video.videoWidth === 0) return
    const prog = progressRef.current
    if (!prog || prog.done) return // 未セット or 全数完了

    busyRef.current = true
    try {
      const vw = video.videoWidth
      const vh = video.videoHeight
      const guide = computeGuideRect(vw, vh)
      const region = clampRect(lastRectRef.current ?? guide, vw, vh)
      lastRegionRef.current = region

      if (!frameCanvasRef.current) {
        frameCanvasRef.current = document.createElement('canvas')
      }
      const fc = frameCanvasRef.current
      fc.width = Math.round(region.width)
      fc.height = Math.round(region.height)
      const fctx = fc.getContext('2d', { willReadFrequently: true })
      if (!fctx) return
      fctx.drawImage(
        video,
        region.x,
        region.y,
        region.width,
        region.height,
        0,
        0,
        fc.width,
        fc.height,
      )
      // 切り出し領域は region（映像フレームの実ピクセル）そのままで取得しており、
      // 範囲・座標・アスペクト比には一切手を入れない。OCR入力は元解像度を維持する。
      const img = fctx.getImageData(0, 0, fc.width, fc.height)

      // 行検出は「安定した中間画像（素のグレースケール）」で行い、前処理設定の
      // ON/OFFに左右されないようにする（行検出を壊さない）。
      const grayStable = grayscale(img)
      const bands =
        modeRef.current === 'auto'
          ? detectLinesAuto(grayStable)
          : detectLinesFixed(grayStable.height, fixedRowsRef.current)
      lastBandsRef.current = bands
      setDetectedLineCount(bands.length)

      // 設定フォームの値で領域前処理を実適用（幾何は変えない。同寸の処理結果）
      const settings = preprocessRef.current
      const cv = cvRef.current
      const processed = preprocessRegion(img, settings, cv)

      // 行ごとにOCR（永続ワーカー）。各バンドへ deskew/crop_margin/resize を適用
      const opts = ocrOptionsRef.current
      const candidates: string[] = []
      const rawTexts: string[] = []
      for (const band of bands) {
        if (!runningRef.current) return
        const canvas = finishBandCanvas(processed, band, settings, cv)
        const res = await ocrServiceRef.current!.recognize(canvas, opts)
        const raw = res.text.replace(/\s+/g, ' ').trim()
        if (raw) rawTexts.push(raw)
        const norm = normalizeText(res.text)
        if (norm) candidates.push(norm)
      }
      if (!runningRef.current) return

      // 映像右上の生テキスト表示を最新へ更新（2FPSに同期）
      setLastOcrText(rawTexts.join(' / '))

      // 現在の銘板(No)の各行を照合（順不同：一致した行から消し込む）
      const p = progressRef.current
      if (!p || p.done) return
      const np = p.nameplates[p.currentNoIndex]
      if (!np) return

      let changed = false
      // 直近に照合した行のうち最も類似度が高いものを右上表示用に保持
      let best: { label: string; score: number } | null = null
      for (const line of np.lines) {
        let s: number
        if (line.confirmed) {
          s = 1 // 既に消し込み済み
        } else {
          const m = matchExpectedLine(
            line.expected,
            candidates,
            thresholdsRef.current,
          )
          if (m.score > line.score) {
            line.candidate = m.ocrCandidate
            line.score = m.score
            changed = true
          }
          if (m.status === 'PASS') {
            line.confirmed = true
            line.candidate = m.ocrCandidate
            line.score = m.score
            changed = true
          }
          s = m.score
        }
        if (!best || s > best.score) best = { label: line.expected, score: s }
      }
      setLastMatch(best)

      // 全行が消し込まれた → 1枚OK
      if (np.lines.every((l) => l.confirmed)) {
        np.doneCount += 1
        changed = true
        if (np.doneCount >= np.quantity) {
          np.done = true
          // 次の未完了 No へ進む
          let next = p.currentNoIndex + 1
          while (next < p.nameplates.length && p.nameplates[next].done) next++
          p.currentNoIndex = next
          if (next >= p.nameplates.length) {
            p.done = true
            setAllDone(true)
          }
        } else {
          // 次の1枚に向けて行状態をリセット（確定済み枚数は維持）
          np.lines = np.lines.map((l) => ({
            ...l,
            confirmed: false,
            candidate: '',
            score: 0,
          }))
        }
      }

      if (changed) commit()
    } catch {
      // 1サイクルの失敗は無視して次サイクルへ
    } finally {
      busyRef.current = false
    }
  }, [computeGuideRect, commit])

  const stop = useCallback(() => {
    runningRef.current = false
    setRunning(false)
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    if (timerRef.current !== null) clearInterval(timerRef.current)
    rafRef.current = null
    timerRef.current = null
    stopCameraStream(streamRef.current)
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    // 前処理プレビューを消す（停止後に最終フレームが残らないように）
    if (binaryRef.current) binaryRef.current.style.display = 'none'
  }, [])

  const start = useCallback(async () => {
    setError(null)
    try {
      const stream = await startCameraStream({ facingMode: 'environment' })
      streamRef.current = stream
      const v = videoRef.current
      if (v) {
        v.srcObject = stream
        await v.play().catch(() => undefined)
      }
      runningRef.current = true
      setRunning(true)
      lastDetectTsRef.current = 0
      rafRef.current = requestAnimationFrame(drawLoop)

      // OCRワーカーを事前ロード（jpn+eng の traineddata 取得を先に走らせる）。
      // 失敗（CDN取得失敗等）した場合はステータスへ表示し、原因を可視化する。
      // 成功すれば初回OCRの待ち時間も短縮される。映像表示自体は継続する。
      setOcrError(null)
      ocrServiceRef.current!.init(ocrOptionsRef.current).catch((e: unknown) => {
        setOcrError(e instanceof Error ? e.message : String(e))
      })

      timerRef.current = window.setInterval(runOcrCycle, 500)
    } catch (e: unknown) {
      const msg =
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'カメラの使用が許可されませんでした。'
          : e instanceof Error
            ? e.message
            : String(e)
      setError(`${msg}（ファイルアップロード/撮影画像OCRをご利用ください）`)
      stop()
      return
    }

    // OpenCV はバックグラウンドで読み込む（失敗してもガイド枠で継続）
    if (!cvRef.current) {
      loadOpenCv()
        .then((cv) => {
          cvRef.current = cv
          setCvReady(true)
        })
        .catch((e: unknown) =>
          setCvError(e instanceof Error ? e.message : String(e)),
        )
    }
  }, [drawLoop, runOcrCycle, stop])

  const reset = useCallback(() => {
    initProgress(target)
  }, [initProgress, target])

  // アンマウント時にリソース解放
  useEffect(() => {
    const ocr = ocrServiceRef.current
    return () => {
      runningRef.current = false
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      if (timerRef.current !== null) clearInterval(timerRef.current)
      stopCameraStream(streamRef.current)
      streamRef.current = null
      void ocr?.terminate()
    }
  }, [])

  return {
    videoRef,
    overlayRef,
    binaryRef,
    running,
    cvReady,
    cvError,
    error,
    ocrError,
    guideWpx,
    guideHpx,
    setGuideWpx,
    setGuideHpx,
    guideMinWpx: GUIDE_MIN_W_PX,
    guideMinHpx: GUIDE_MIN_H_PX,
    guideMaxWpx: stageW || GUIDE_FALLBACK_MAX_PX,
    guideMaxHpx: stageH || GUIDE_FALLBACK_MAX_PX,
    guideStepPx: GUIDE_STEP_PX,
    mode,
    toggleMode,
    fixedRows,
    setFixedRows,
    detectedLineCount,
    previewMode,
    setPreviewMode,
    lastOcrText,
    lastMatch,
    progress: progressState,
    allDone,
    start,
    stop,
    reset,
  }
}
