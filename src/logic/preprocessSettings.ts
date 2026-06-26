// OCR前処理パラメータのデフォルト値（＝依頼JSONの構造・既定値そのまま）。
// 現段階では値の保持・表示・編集のみに使用し、画像処理には適用しない（次段階で適用）。

import type { PreprocessSettings } from '../types'

/** 前処理設定の初期値（唯一の参照元）。リセット時もこれへ戻す */
export const DEFAULT_PREPROCESS_SETTINGS: PreprocessSettings = {
  ratio_threshold: 1.6,
  operations: {
    threshold: { type: 'binary', value: 70 },
    clahe: { clip_limit: 1, tile_grid_size: 2 },
    sharpen: { enabled: true, amount: 0.2, sigma: 0.5 },
    gamma: { enabled: false, value: 1 },
    morph: { enabled: false, method: 'close', ksize: 3, iterations: 1 },
    unsharp: { enabled: false, amount: 0.8, radius: 1, threshold: 0 },
    bilateral: { enabled: false, diameter: 5, sigma_color: 50, sigma_space: 50 },
    local_contrast: { enabled: false, clip_limit: 2, tile_grid_size: 8 },
    crop_margin: { enabled: false, threshold: 245, margin: 2 },
    hist_equalize: { enabled: false },
    stroke_boost: { enabled: false, method: 'close', ksize: 1, iterations: 1 },
    denoise: { method: 'gaussian', ksize: 1 },
    deskew: { enabled: false },
    resize: { single: 48, wide_height: 48, keep_ratio: true },
  },
}

/** ディープコピーした初期値を返す（state 初期化・リセット用に共有参照を避ける） */
export function freshPreprocessSettings(): PreprocessSettings {
  return JSON.parse(JSON.stringify(DEFAULT_PREPROCESS_SETTINGS)) as PreprocessSettings
}
