// OCR処理モジュール
// 将来エンジンを差し替えられるよう、インターフェースで抽象化する。
// 現状の実装は Tesseract.js を使用。別エンジン（クラウドOCR等）に
// 置き換える場合は OcrService を実装した新クラスを作り、
// createOcrService() の戻り値を差し替えるだけでよい。
//
// 映像リアルタイム検査では行ごとに高頻度でOCRするため、ワーカーを毎回
// 生成・破棄せず「永続ワーカーを使い回す」実装にしている（lang 変更時のみ再生成）。

import Tesseract from 'tesseract.js'
// ホワイトリストの唯一の編集元（ルートの whitelist.jsonc）をビルド時importで読み込む
import { OCR_WHITELIST } from '../logic/whitelist'

/** OCRに渡せる画像の型 */
export type OcrImage = File | Blob | string | HTMLCanvasElement | ImageData

/** OCR実行時のオプション */
export interface OcrOptions {
  /** 言語。Tesseract の言語データ名（例: 'jpn+eng'） */
  lang: string
  /** Page Segmentation Mode（6=均一なブロック / 7=単一行 など） */
  psm: number
  /** 認識を許可する文字のホワイトリスト。空文字なら無制限 */
  whitelist: string
}

/** OCRの実行結果 */
export interface OcrResult {
  /** 認識された生テキスト */
  text: string
  /** 全体の信頼度（0〜100）。エンジンが返さない場合は undefined */
  confidence?: number
}

/** 進捗通知コールバック（0.0〜1.0 と状態文字列） */
export type OcrProgress = (progress: number, status: string) => void

/** OCRエンジンの抽象インターフェース */
export interface OcrService {
  /**
   * ワーカーを事前生成し、言語データ（jpn+eng の traineddata）のロードを
   * 完了させておく。初回 recognize の待ち時間短縮と、言語データのロード失敗を
   * 早期に検知（＝呼び出し側で例外を受けてステータス表示）するために使う。
   * ロードに失敗した場合は例外を投げる。
   */
  init(options: OcrOptions, onProgress?: OcrProgress): Promise<void>
  /**
   * 画像からテキストを認識する。
   * @param image File / Blob / data URL / canvas / ImageData などを受け付ける
   */
  recognize(
    image: OcrImage,
    options: OcrOptions,
    onProgress?: OcrProgress,
  ): Promise<OcrResult>
  /** リソース解放 */
  terminate(): Promise<void>
}

/**
 * OCRオプションの初期値。ホワイトリストは `whitelist.jsonc`（ルート）由来で、
 * `src/logic/whitelist.ts` がグループ連結＋重複除去した文字列（OCR_WHITELIST）を供給する。
 * lang / psm はここで定義する。
 */
export const DEFAULT_OCR_OPTIONS: OcrOptions = {
  lang: 'jpn+eng',
  psm: 6,
  whitelist: OCR_WHITELIST,
}

/**
 * 言語学習データ（*.traineddata）の取得元。
 * 未指定（undefined）の場合、tesseract.js は jsDelivr CDN
 * （https://cdn.jsdelivr.net/npm/@tesseract.js-data/<lang>/4.0.0）から
 * 言語ごとに取得する。社内ネットワーク等でCDNに出られない場合は、ここに
 * jpn.traineddata.gz / eng.traineddata.gz を配置したベースURL（例: '/tessdata'）
 * を指定すれば取得元を差し替えられる。
 */
export const OCR_LANG_PATH: string | undefined = undefined

/** Tesseract.js を使った OcrService 実装（永続ワーカー方式） */
class TesseractOcrService implements OcrService {
  private worker: Tesseract.Worker | null = null
  private workerLang = ''
  private creating: Promise<Tesseract.Worker> | null = null
  /** logger から参照する進捗コールバック（recognize ごとに差し替える） */
  private onProgress: OcrProgress | null = null
  /** createWorker / 言語データロード中に起きた致命的エラー（errorHandler 経由） */
  private lastWorkerError: string | null = null

  /**
   * psm・whitelist 等のパラメータをワーカーへ適用する。
   * tessedit_char_whitelist は「初期化寄り」のパラメータで、永続ワーカーを
   * 使い回す場合は設定タイミングがずれると効かないことがある。そのため
   * ワーカー生成直後と、各認識の直前の両方で確実に適用する。
   */
  private async applyParameters(
    worker: Tesseract.Worker,
    options: OcrOptions,
  ): Promise<void> {
    await worker.setParameters({
      // psm は数値だが Tesseract の型定義上 enum 扱いのため変換する
      tessedit_pageseg_mode: String(options.psm) as unknown as Tesseract.PSM,
      tessedit_char_whitelist: options.whitelist ?? '',
    })
  }

  /** 指定 options でワーカーを取得（必要なら生成・再生成）する */
  private async getWorker(options: OcrOptions): Promise<Tesseract.Worker> {
    const lang = options.lang
    if (this.worker && this.workerLang === lang) return this.worker
    if (this.creating) {
      const w = await this.creating
      if (this.workerLang === lang) return w
    }
    // lang が変わった、または未生成
    if (this.worker) {
      await this.worker.terminate()
      this.worker = null
    }
    this.lastWorkerError = null
    // createWorker の第1引数 lang に options.lang（= 'jpn+eng'）を渡すことで、
    // 生成時点で日本語＋英語の traineddata がロードされる。両経路とも同じ
    // DEFAULT_OCR_OPTIONS を使うため、ここに渡る lang は常に 'jpn+eng'。
    this.creating = Tesseract.createWorker(lang, undefined, {
      // 言語データの取得元（未指定なら jsDelivr CDN）
      langPath: OCR_LANG_PATH,
      logger: (m: { progress: number; status: string }) => {
        if (this.onProgress) this.onProgress(m.progress ?? 0, m.status ?? '')
      },
      // 言語データ取得失敗等の致命的エラーを捕捉（握り潰さず後段へ伝える）
      errorHandler: (e: unknown) => {
        this.lastWorkerError = e instanceof Error ? e.message : String(e)
      },
    })
    let worker: Tesseract.Worker
    try {
      worker = await this.creating
    } catch (e: unknown) {
      this.creating = null
      const detail =
        this.lastWorkerError ?? (e instanceof Error ? e.message : String(e))
      // jpn を含む言語データのロード失敗はここに来る（CDN取得失敗等）
      throw new Error(`OCR言語データ(${lang})のロードに失敗しました: ${detail}`)
    }
    this.worker = worker
    this.workerLang = lang
    this.creating = null
    // 生成直後にホワイトリスト等を適用しておく（初期化時に効かせる）
    await this.applyParameters(worker, options)
    return worker
  }

  async init(options: OcrOptions, onProgress?: OcrProgress): Promise<void> {
    this.onProgress = onProgress ?? null
    try {
      await this.getWorker(options)
    } finally {
      this.onProgress = null
    }
  }

  async recognize(
    image: OcrImage,
    options: OcrOptions,
    onProgress?: OcrProgress,
  ): Promise<OcrResult> {
    this.onProgress = onProgress ?? null
    const worker = await this.getWorker(options)

    // 認識直前にも必ずホワイトリスト等を再適用する（永続ワーカー対策）
    await this.applyParameters(worker, options)

    const { data } = await worker.recognize(image as Tesseract.ImageLike)
    this.onProgress = null
    return { text: data.text ?? '', confidence: data.confidence }
  }

  async terminate(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate()
      this.worker = null
      this.workerLang = ''
    }
  }
}

/** OcrService のファクトリ。エンジン差し替え時はここを変更する。 */
export function createOcrService(): OcrService {
  return new TesseractOcrService()
}
