// 照合処理モジュール
// 期待値（labelTexts）とOCR結果を照合する。
// 判定段階:
//   完全一致      → PASS (score = 1.0)
//   部分一致      → PASS（OCR候補が期待値を含む / 期待値が候補を含む）
//   類似度一致    → 閾値以上なら REVIEW（要確認）、未満なら NG
// 類似度は簡易にレーベンシュタイン距離から算出する。

import type { MatchResult, OverallResult } from '../types'
import { normalizeText, splitIntoLines } from './normalize'

/** レーベンシュタイン距離（編集距離）を計算する */
export function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m

  // 1行分のDPテーブルを使い回す
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let curr = new Array<number>(n + 1)

  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1, // 削除
        curr[j - 1] + 1, // 挿入
        prev[j - 1] + cost, // 置換
      )
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

/** 2文字列の類似度（0.0〜1.0）。1.0で完全一致 */
export function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1
  const dist = levenshtein(a, b)
  const maxLen = Math.max(a.length, b.length)
  return maxLen === 0 ? 1 : 1 - dist / maxLen
}

/** 照合の閾値設定 */
export interface MatchThresholds {
  /** これ以上の類似度なら「要確認(REVIEW)」とみなす下限 */
  reviewThreshold: number
}

export const DEFAULT_THRESHOLDS: MatchThresholds = {
  reviewThreshold: 0.8,
}

/**
 * 1つの期待値に対し、OCR候補群（正規化済みの文字列配列）の中から
 * 最も近いものを選んで判定する。映像検査の行ごと照合でも使用する。
 */
export function matchExpectedLine(
  expected: string,
  candidates: string[],
  thresholds: MatchThresholds = DEFAULT_THRESHOLDS,
): MatchResult {
  const normExpected = normalizeText(expected)

  let best = { candidate: '', score: 0 }
  for (const cand of candidates) {
    // 完全一致を最優先
    if (cand === normExpected) {
      best = { candidate: cand, score: 1 }
      break
    }
    // 部分一致（どちらかが他方を含む）はスコア上限近くで扱う
    let score: number
    if (
      normExpected.length > 0 &&
      (cand.includes(normExpected) || normExpected.includes(cand))
    ) {
      // 包含関係。長さ比で軽く割り引く
      const ratio =
        Math.min(cand.length, normExpected.length) /
        Math.max(cand.length, normExpected.length)
      score = Math.max(similarity(cand, normExpected), 0.9 * ratio + 0.1)
    } else {
      score = similarity(cand, normExpected)
    }
    if (score > best.score) best = { candidate: cand, score }
  }

  const score = Number(best.score.toFixed(4))
  let status: MatchResult['status']
  if (score >= 1) {
    status = 'PASS'
  } else if (score >= thresholds.reviewThreshold) {
    status = 'REVIEW'
  } else {
    status = 'NG'
  }

  return {
    expected,
    ocrCandidate: best.candidate,
    status,
    score,
  }
}

/**
 * 期待値リスト全体とOCR生テキストを照合する。
 */
export function matchLabels(
  labelTexts: string[],
  ocrRawText: string,
  thresholds: MatchThresholds = DEFAULT_THRESHOLDS,
): MatchResult[] {
  const candidates = splitIntoLines(ocrRawText)
  return labelTexts.map((expected) =>
    matchExpectedLine(expected, candidates, thresholds),
  )
}

/**
 * 個々の照合結果から総合判定を導く。
 *   全件PASS                       → PASS
 *   1件でもNGあり                  → NG
 *   NGはないがREVIEWあり           → REVIEW（要確認）
 */
export function overallResult(matches: MatchResult[]): OverallResult {
  if (matches.length === 0) return 'NG'
  if (matches.some((m) => m.status === 'NG')) return 'NG'
  if (matches.some((m) => m.status === 'REVIEW')) return 'REVIEW'
  return 'PASS'
}
