// アプリ全体で共有する型定義

// ---- 回答データ（製番 → 種類 → 銘板(No)） ----

/** 1つの銘板(No)。行リストと枚数(quantity)を持つ */
export interface Nameplate {
  /** 銘板に記載されているべき文字列リスト（＝行ごとの期待値） */
  labelTexts: string[]
  /** 同一銘板の枚数（同じものが何枚あるか）。既定1 */
  quantity: number
}

/** 種類（製番にぶら下がる）。複数の銘板Noを含む */
export interface ProductType {
  /** 種類 */
  type: string
  /** 銘板リスト（No.1, No.2, ...） */
  nameplates: Nameplate[]
}

/** 製番（1つの製番に複数の種類がぶら下がる） */
export interface Product {
  /** 製番 */
  serialNumber: string
  /** 種類リスト */
  types: ProductType[]
}

/** 製番＋種類をセットした検査対象（映像検査フックへ渡す） */
export interface InspectionTarget {
  serialNumber: string
  type: string
  nameplates: Nameplate[]
}

/** 1銘板分の単純な回答データ（手動検査・後方互換で使用） */
export interface AnswerData {
  serialNumber: string
  type: string
  labelTexts: string[]
}

// ---- 照合結果 ----

/** 1件あたりの照合判定 */
export type MatchStatus = 'PASS' | 'NG' | 'REVIEW'

/** 1件あたりの照合結果 */
export interface MatchResult {
  expected: string
  ocrCandidate: string
  status: MatchStatus
  score: number
}

/** 総合判定 */
export type OverallResult = 'PASS' | 'NG' | 'REVIEW'

/** 検査結果（1銘板分。手動検査のダウンロードに使用） */
export interface InspectionResult {
  serialNumber: string
  type: string
  result: OverallResult
  checkedAt: string
  ocrText: string
  matches: MatchResult[]
}

/** 映像検査: 1銘板(No)分の結果 */
export interface NameplateResult {
  no: number
  quantity: number
  /** OKになった枚数 */
  passedCount: number
  result: 'PASS' | 'NG'
  matches: MatchResult[]
}

/** 映像検査: 製番単位の結果（複数銘板対応） */
export interface ProductInspectionResult {
  serialNumber: string
  type: string
  checkedAt: string
  result: 'PASS' | 'NG'
  nameplates: NameplateResult[]
}

// ---- 前処理設定（設定メニューのフォームで保持。処理適用は次段階） ----

/** 二値化の種別（セレクト候補） */
export type ThresholdType = 'binary' | 'binary_inv' | 'otsu' | 'adaptive' | 'none'
/** モルフォロジー演算の種別（morph / stroke_boost のセレクト候補） */
export type MorphMethod = 'close' | 'open' | 'dilate' | 'erode'
/** ノイズ除去の種別（セレクト候補） */
export type DenoiseMethod = 'gaussian' | 'median' | 'bilateral' | 'none'

/**
 * OCR前処理パラメータ。
 * 依頼JSONの `preprocess` 構造に1:1で対応する。**現段階では値の保持・表示・編集のみ**で、
 * 実際の画像処理には適用しない（次段階で `operations` 配下を処理パイプラインへ渡す想定）。
 */
export interface PreprocessSettings {
  /** 単一行/横長判定などに使う縦横比のしきい値 */
  ratio_threshold: number
  operations: {
    /** 二値化（種別＋しきい値） */
    threshold: { type: ThresholdType; value: number }
    /** CLAHE（コントラスト制限付き適応ヒストグラム平坦化） */
    clahe: { clip_limit: number; tile_grid_size: number }
    /** シャープ化 */
    sharpen: { enabled: boolean; amount: number; sigma: number }
    /** ガンマ補正 */
    gamma: { enabled: boolean; value: number }
    /** モルフォロジー演算 */
    morph: {
      enabled: boolean
      method: MorphMethod
      ksize: number
      iterations: number
    }
    /** アンシャープマスク */
    unsharp: {
      enabled: boolean
      amount: number
      radius: number
      threshold: number
    }
    /** バイラテラルフィルタ */
    bilateral: {
      enabled: boolean
      diameter: number
      sigma_color: number
      sigma_space: number
    }
    /** 局所コントラスト */
    local_contrast: {
      enabled: boolean
      clip_limit: number
      tile_grid_size: number
    }
    /** 余白クロップ */
    crop_margin: { enabled: boolean; threshold: number; margin: number }
    /** ヒストグラム平坦化 */
    hist_equalize: { enabled: boolean }
    /** 線の強調（モルフォロジーベース） */
    stroke_boost: {
      enabled: boolean
      method: MorphMethod
      ksize: number
      iterations: number
    }
    /** ノイズ除去 */
    denoise: { method: DenoiseMethod; ksize: number }
    /** 傾き補正 */
    deskew: { enabled: boolean }
    /** リサイズ（単一行高さ・横長時の高さ・アスペクト比保持） */
    resize: { single: number; wide_height: number; keep_ratio: boolean }
  }
}

// ---- 映像リアルタイム検査の進捗 ----

/** 行検出モード */
export type LineMode = 'auto' | 'fixed'

/**
 * 1行分の確定状態。
 * 「一度でもPASSが出たら confirmed=true で確定」し、以降再評価しない。
 */
export interface LineState {
  expected: string
  confirmed: boolean
  candidate: string
  score: number
}

/** 1銘板(No)の検査進捗 */
export interface NameplateProgress {
  /** 通し番号（1-based） */
  no: number
  /** 必要枚数 */
  quantity: number
  /** OKになった枚数 */
  doneCount: number
  /** 現在検査中の1枚の行状態 */
  lines: LineState[]
  /** この銘板の必要枚数を満たしたか */
  done: boolean
}

/** 製番単位の検査進捗 */
export interface ProductProgress {
  serialNumber: string
  type: string
  nameplates: NameplateProgress[]
  /** 現在検査中の銘板(No)のインデックス */
  currentNoIndex: number
  /** 全銘板が必要枚数を満たしたか */
  done: boolean
}
