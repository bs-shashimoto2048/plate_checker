import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import type {
  AnswerData,
  InspectionTarget,
  MatchResult,
  PreprocessSettings,
  Product,
} from './types'
import { loadProducts } from './services/answerDataService'
import { freshPreprocessSettings } from './logic/preprocessSettings'
import { PreprocessSettingsForm } from './components/PreprocessSettingsForm'
import {
  createOcrService,
  DEFAULT_OCR_OPTIONS,
  type OcrOptions,
} from './services/ocrService'
import { useCamera } from './hooks/useCamera'
import { useVideoInspection } from './hooks/useVideoInspection'
import { DEFAULT_THRESHOLDS, matchLabels, overallResult } from './logic/match'
import {
  buildInspectionResult,
  buildProductResult,
  downloadJson,
  downloadProductJson,
} from './logic/resultOutput'

const OVERALL_LABEL: Record<string, string> = {
  PASS: 'PASS（合格）',
  NG: 'NG（不合格）',
  REVIEW: '要確認',
}

const STATUS_LABEL: Record<string, string> = {
  PASS: 'PASS',
  NG: 'NG',
  REVIEW: '要確認',
}

// 手動（アップロード/撮影画像）用の OCR サービス（映像検査側とは別ワーカー）
const ocrService = createOcrService()

function App() {
  const [products, setProducts] = useState<Product[]>([])
  const [answerError, setAnswerError] = useState<string | null>(null)

  // OCR設定（手動・映像検査で共有）
  const [ocrOptions] = useState<OcrOptions>(DEFAULT_OCR_OPTIONS)

  // 設定メニュー（オーバーレイ）の開閉
  const [settingsOpen, setSettingsOpen] = useState(false)

  // 前処理設定（フォームの値で実際にOCR入力へ前処理を適用）。
  // 設定メニューを閉じても state は保持される（セッション中は値が失われない）。
  const [preprocessSettings, setPreprocessSettings] = useState<PreprocessSettings>(
    () => freshPreprocessSettings(),
  )

  // 製番→種類の2段階選択
  const [serialIndex, setSerialIndex] = useState(0)
  const [typeIndex, setTypeIndex] = useState(0)
  const [activeTarget, setActiveTarget] = useState<InspectionTarget | null>(null)

  // 映像リアルタイム検査（前処理設定はフォームの最新値を渡す＝リアルタイム反映）
  const video = useVideoInspection(
    activeTarget,
    ocrOptions,
    DEFAULT_THRESHOLDS,
    preprocessSettings,
  )

  useEffect(() => {
    setAnswerError(null)
    loadProducts()
      .then((data) => {
        setProducts(data)
        setSerialIndex(0)
        setTypeIndex(0)
      })
      .catch((e: unknown) =>
        setAnswerError(e instanceof Error ? e.message : String(e)),
      )
  }, [])

  const currentSerial = products[serialIndex] ?? null
  const typeOptions = currentSerial?.types ?? []

  /** 製番が変わったら種類選択をリセット */
  const handleSerialChange = (idx: number) => {
    setSerialIndex(idx)
    setTypeIndex(0)
  }

  /** 選択中の製番＋種類をセット（毎回クローンして検査進捗をリセット） */
  const handleSet = () => {
    const t = currentSerial?.types[typeIndex]
    if (!currentSerial || !t) return
    const target: InspectionTarget = {
      serialNumber: currentSerial.serialNumber,
      type: t.type,
      nameplates: JSON.parse(JSON.stringify(t.nameplates)),
    }
    setActiveTarget(target)
  }

  // 最小化ステータス（1行）
  const statusText = video.error
    ? video.error
    : video.ocrError
      ? `OCR言語データ読込失敗: ${video.ocrError}`
      : video.allDone && activeTarget
        ? '全数検査完了'
        : !activeTarget
          ? '製番・種類をセットしてください'
          : `${video.running ? (video.cvReady ? 'CV✓' : 'CV…') : '停止中'}・行${video.detectedLineCount}・${video.mode === 'auto' ? '自動' : '固定'}`

  return (
    <div className="app">
      {/* ヘッダー（タイトル＋設定歯車。元の検査開始ボタンの位置に歯車を配置） */}
      <header className="head">
        <span className="brand">PlateChecker</span>
        <div className="head-actions">
          <button
            className="btn-icon"
            onClick={() => setSettingsOpen(true)}
            aria-label="設定"
            title="設定"
          >
            ⚙
          </button>
        </div>
      </header>

      {/* 映像枠（横長）＋検出枠 */}
      <div className="iv-stage">
        <video
          ref={video.videoRef}
          className="iv-video"
          playsInline
          muted
          autoPlay
        />
        <canvas ref={video.binaryRef} className="iv-binary" />
        <canvas ref={video.overlayRef} className="iv-overlay" />
        {!video.running && (
          <div className="iv-placeholder">「検査開始」でカメラを起動</div>
        )}
        {video.running && (
          <div className="iv-readout">
            <div className="ro-ocr">
              <span className="ro-label">OCR: </span>
              {video.lastOcrText || '待機中…'}
            </div>
            <div className="ro-sim">
              <span className="ro-label">照合: </span>
              {video.lastMatch
                ? `${video.lastMatch.label} ${Math.round(video.lastMatch.score * 100)}%`
                : '—'}
            </div>
          </div>
        )}
      </div>

      {/* 最小ステータス（1行） */}
      <div
        className={`status1 ${video.error || video.ocrError ? 'is-error' : ''} ${video.allDone && activeTarget ? 'is-done' : ''}`}
      >
        {statusText}
      </div>

      {/* モード切替＋行数セレクト＋検査開始/停止の横並び1行（折り返さない・揺れない） */}
      <div className="mode-row">
        <button className="btn-toggle" onClick={video.toggleMode}>
          {video.mode === 'auto' ? '自動(切替)' : '固定(切替)'}
        </button>
        <div
          className="rows-ui"
          style={{ visibility: video.mode === 'fixed' ? 'visible' : 'hidden' }}
        >
          <select
            className="rows-select"
            value={video.fixedRows}
            onChange={(e) => video.setFixedRows(Number(e.target.value))}
            aria-label="固定モードの行数"
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n}行
              </option>
            ))}
          </select>
        </div>
        <div className="run-actions">
          {!video.running ? (
            <button className="btn-primary sm" onClick={video.start}>
              検査開始
            </button>
          ) : (
            <>
              <button className="btn-secondary sm" onClick={video.reset}>
                リセット
              </button>
              <button className="btn-secondary sm" onClick={video.stop}>
                停止
              </button>
            </>
          )}
        </div>
      </div>

      {/* 検査ガイド（折りたたみ。映像枠の直下なので開いても映像が見える）
          検出枠サイズはpx指定：5px刻み・最小100px・最大は映像枠の表示実寸に追従 */}
      <details className="guide-details">
        <summary>検査ガイド（検出枠サイズ）</summary>
        <label className="slider-row">
          <span className="slider-label">幅</span>
          <input
            type="range"
            min={video.guideMinWpx}
            max={video.guideMaxWpx}
            step={video.guideStepPx}
            value={video.guideWpx}
            onChange={(e) => video.setGuideWpx(Number(e.target.value))}
          />
          <span className="slider-val">{video.guideWpx}px</span>
        </label>
        <label className="slider-row">
          <span className="slider-label">高さ</span>
          <input
            type="range"
            min={video.guideMinHpx}
            max={video.guideMaxHpx}
            step={video.guideStepPx}
            value={video.guideHpx}
            onChange={(e) => video.setGuideHpx(Number(e.target.value))}
          />
          <span className="slider-val">{video.guideHpx}px</span>
        </label>
      </details>

      {/* 検査データ：製番→種類の2段階選択 */}
      <div className="set-area">
        {answerError && <p className="error">読込エラー: {answerError}</p>}
        <div className="set-row">
          <select
            className="set-select"
            value={serialIndex}
            onChange={(e) => handleSerialChange(Number(e.target.value))}
            aria-label="製番"
          >
            {products.map((p, i) => (
              <option key={i} value={i}>
                {p.serialNumber}
              </option>
            ))}
          </select>
          <select
            className="set-select"
            value={typeIndex}
            onChange={(e) => setTypeIndex(Number(e.target.value))}
            aria-label="種類"
          >
            {typeOptions.map((t, i) => (
              <option key={i} value={i}>
                {t.type}
              </option>
            ))}
          </select>
          <button
            className="btn-primary sm"
            onClick={handleSet}
            disabled={!currentSerial}
          >
            セット
          </button>
        </div>
      </div>

      {/* 検査内容テーブル（固定高さ＋スクロール） */}
      <div className="table-fixed">
        <table className="inspect-table">
          <thead>
            <tr>
              <th className="col-no">No</th>
              <th className="col-row">行数</th>
              <th className="col-text">記載内容</th>
              <th className="col-ocr">OCR</th>
              <th className="col-count">検査数</th>
            </tr>
          </thead>
          <tbody>
            {!video.progress && (
              <tr>
                <td colSpan={5} className="empty-cell muted">
                  製番・種類をセットすると検査内容が表示されます
                </td>
              </tr>
            )}
            {video.progress?.nameplates.map((np) =>
              np.lines.map((l, li) => (
                <tr
                  key={`${np.no}-${li}`}
                  className={
                    video.progress!.currentNoIndex === np.no - 1
                      ? 'row-current'
                      : ''
                  }
                >
                  {li === 0 && (
                    <td className="col-no" rowSpan={np.lines.length}>
                      {np.no}
                    </td>
                  )}
                  <td className="col-row">{li + 1}</td>
                  <td className="col-text">{l.expected}</td>
                  <td className="col-ocr">
                    {l.confirmed ? <span className="ok-mark">○</span> : ''}
                  </td>
                  {li === 0 && (
                    <td className="col-count" rowSpan={np.lines.length}>
                      {np.doneCount}/{np.quantity}
                    </td>
                  )}
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>

      {/* その他（結果出力・手動検査）は退避して常時非表示 */}
      <details className="more-details">
        <summary>結果出力・手動検査</summary>
        <div className="more-actions">
          <button
            className="btn-secondary"
            onClick={() => {
              if (video.progress)
                downloadProductJson(buildProductResult(video.progress))
            }}
            disabled={!video.progress}
          >
            検査結果JSONをダウンロード
          </button>
        </div>
        <ManualInspection target={activeTarget} ocrOptions={ocrOptions} />
      </details>

      {/* 設定メニュー（オーバーレイ。画面レイアウトを押し広げない） */}
      {settingsOpen && (
        <div
          className="settings-overlay"
          onClick={() => setSettingsOpen(false)}
          role="presentation"
        >
          <div
            className="settings-panel"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="設定"
          >
            <div className="settings-head">
              <span>設定</span>
              <button
                className="btn-icon"
                onClick={() => setSettingsOpen(false)}
                aria-label="閉じる"
                title="閉じる"
              >
                ×
              </button>
            </div>

            <label className="switch-row">
              <span className="switch-label">前処理後の映像を表示</span>
              <span className="switch">
                <input
                  type="checkbox"
                  checked={video.previewMode === 'preprocessed'}
                  onChange={(e) =>
                    video.setPreviewMode(
                      e.target.checked ? 'preprocessed' : 'normal',
                    )
                  }
                />
                <span className="switch-track">
                  <span className="switch-thumb" />
                </span>
              </span>
            </label>
            <p className="muted switch-help">
              表示の切替のみです。OCRに渡る画像（前処理）やOCR処理自体は変わりません。
            </p>

            <hr className="settings-sep" />

            <PreprocessSettingsForm
              value={preprocessSettings}
              onChange={setPreprocessSettings}
              onReset={() => setPreprocessSettings(freshPreprocessSettings())}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ---- 手動検査（副次） ----

interface ManualProps {
  target: InspectionTarget | null
  ocrOptions: OcrOptions
}

function ManualInspection({ target, ocrOptions }: ManualProps) {
  const [noIndex, setNoIndex] = useState(0)
  const [imageBlob, setImageBlob] = useState<Blob | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imageName, setImageName] = useState('')
  const [ocrText, setOcrText] = useState('')
  const [ocrRunning, setOcrRunning] = useState(false)
  const [ocrProgress, setOcrProgress] = useState('')
  const [matches, setMatches] = useState<MatchResult[] | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const camera = useCamera()

  const nameplate = target?.nameplates[noIndex] ?? null
  const manualAnswer: AnswerData | null =
    target && nameplate
      ? {
          serialNumber: target.serialNumber,
          type: target.type,
          labelTexts: nameplate.labelTexts,
        }
      : null

  useEffect(() => {
    if (!imageBlob) {
      setImageUrl(null)
      return
    }
    const url = URL.createObjectURL(imageBlob)
    setImageUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [imageBlob])

  const setImage = (blob: Blob | null, name: string) => {
    setImageBlob(blob)
    setImageName(name)
    setOcrText('')
    setMatches(null)
  }

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    setImage(file, file?.name ?? '')
  }

  const handleCapture = async (): Promise<Blob | null> => {
    try {
      const { blob } = await camera.capture()
      camera.stop()
      setImage(blob, 'capture.jpg')
      return blob
    } catch {
      return null
    }
  }

  const runOcr = async (blob?: Blob) => {
    const t = blob ?? imageBlob
    if (!t || !manualAnswer) return
    setOcrRunning(true)
    setOcrProgress('準備中...')
    setMatches(null)
    try {
      const result = await ocrService.recognize(t, ocrOptions, (p, s) =>
        setOcrProgress(`${s} ${Math.round(p * 100)}%`),
      )
      setOcrText(result.text)
      setMatches(
        matchLabels(manualAnswer.labelTexts, result.text, DEFAULT_THRESHOLDS),
      )
    } catch (e: unknown) {
      setOcrProgress('')
      setOcrText(
        `OCRに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      )
    } finally {
      setOcrRunning(false)
    }
  }

  const manualOverall = useMemo(
    () => (matches ? overallResult(matches) : null),
    [matches],
  )

  const handleDownload = () => {
    if (!manualAnswer || !matches) return
    downloadJson(buildInspectionResult(manualAnswer, ocrText, matches))
  }

  return (
    <div className="manual-inner">
      {target ? (
        <label className="manual-select">
          照合対象の銘板（No）
          <select
            value={noIndex}
            onChange={(e) => {
              setNoIndex(Number(e.target.value))
              setMatches(null)
              setOcrText('')
            }}
          >
            {target.nameplates.map((np, i) => (
              <option key={i} value={i}>
                No.{i + 1}（{np.labelTexts.length}行）
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="muted">先に製番・種類をセットしてください。</p>
      )}

      <div className="upload-row">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleImageSelect}
          style={{ display: 'none' }}
        />
        <button
          className="btn-secondary"
          onClick={() => fileInputRef.current?.click()}
        >
          画像ファイルを選択
        </button>
        {imageName && <span className="muted">{imageName}</span>}
      </div>

      <div className="camera-block">
        {camera.supported && !camera.active && (
          <button className="btn-secondary" onClick={() => camera.start()}>
            カメラを起動
          </button>
        )}
        {camera.error && <p className="error">{camera.error}</p>}
        <div
          className="camera-view"
          style={{ display: camera.active ? 'block' : 'none' }}
        >
          <div className="camera-stage">
            <video
              ref={camera.videoRef}
              className="camera-video"
              playsInline
              muted
              autoPlay
            />
            <div className="camera-guide">
              <span className="camera-guide-hint">枠内に収めて撮影</span>
            </div>
          </div>
          <div className="camera-controls">
            <button
              className="btn-primary"
              onClick={async () => {
                const b = await handleCapture()
                if (b) await runOcr(b)
              }}
              disabled={!manualAnswer || ocrRunning}
            >
              撮影して検査
            </button>
            <button className="btn-secondary" onClick={camera.stop}>
              カメラ停止
            </button>
          </div>
        </div>
      </div>

      {imageUrl && (
        <div className="preview">
          <img src={imageUrl} alt="プレビュー" />
        </div>
      )}

      <div style={{ marginTop: '0.5rem' }}>
        <button
          className="btn-primary"
          onClick={() => runOcr()}
          disabled={!imageBlob || !manualAnswer || ocrRunning}
        >
          {ocrRunning ? 'OCR実行中...' : 'OCRを実行して照合'}
        </button>
        {ocrRunning && ocrProgress && (
          <div className="progress">{ocrProgress}</div>
        )}
      </div>

      <h3 className="subhead">OCR生テキスト</h3>
      <pre className="ocr-text">{ocrText || '（未実行）'}</pre>

      {matches && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>期待値</th>
                <th>OCR候補</th>
                <th>判定</th>
                <th className="score">類似度</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((m, i) => (
                <tr key={i}>
                  <td>{m.expected}</td>
                  <td>{m.ocrCandidate || '（未検出）'}</td>
                  <td>
                    <span className={`badge ${m.status}`}>
                      {STATUS_LABEL[m.status]}
                    </span>
                  </td>
                  <td className="score">{Math.round(m.score * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {manualOverall && (
        <div className={`overall ${manualOverall}`}>
          {OVERALL_LABEL[manualOverall]}
        </div>
      )}

      <div style={{ marginTop: '0.5rem' }}>
        <button
          className="btn-secondary"
          onClick={handleDownload}
          disabled={!matches}
        >
          この結果JSONをダウンロード
        </button>
      </div>
    </div>
  )
}

export default App
