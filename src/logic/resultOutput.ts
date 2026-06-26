// 結果出力処理モジュール
// 検査結果をJSON化してダウンロードする。
// PDF出力など別形式は、ここに exporter を追加するだけで拡張できるよう
// データ生成（build*）と出力（downloadJsonData）を分けている。

import type {
  AnswerData,
  InspectionResult,
  MatchResult,
  NameplateResult,
  ProductInspectionResult,
  ProductProgress,
} from '../types'
import { overallResult } from './match'

/** "YYYY-MM-DD HH:mm" 形式のローカル時刻文字列を返す */
export function formatCheckedAt(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
    `${p(date.getHours())}:${p(date.getMinutes())}`
  )
}

/** 検査結果オブジェクト（1銘板分）を組み立てる（手動検査で使用） */
export function buildInspectionResult(
  answer: AnswerData,
  ocrText: string,
  matches: MatchResult[],
  checkedAt: string = formatCheckedAt(),
): InspectionResult {
  return {
    serialNumber: answer.serialNumber,
    type: answer.type,
    result: overallResult(matches),
    checkedAt,
    ocrText,
    matches,
  }
}

/** 映像検査の進捗（製番単位）から検査結果を組み立てる */
export function buildProductResult(
  progress: ProductProgress,
  checkedAt: string = formatCheckedAt(),
): ProductInspectionResult {
  const nameplates: NameplateResult[] = progress.nameplates.map((np) => ({
    no: np.no,
    quantity: np.quantity,
    passedCount: np.doneCount,
    result: np.done ? 'PASS' : 'NG',
    matches: np.lines.map((l) => ({
      expected: l.expected,
      ocrCandidate: l.candidate,
      status: l.confirmed ? ('PASS' as const) : ('NG' as const),
      score: l.score,
    })),
  }))
  return {
    serialNumber: progress.serialNumber,
    type: progress.type,
    checkedAt,
    result: progress.done ? 'PASS' : 'NG',
    nameplates,
  }
}

/** 任意のデータをJSONファイルとしてダウンロードさせる */
export function downloadJsonData(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** 検査結果JSON（1銘板分・手動検査）をダウンロードする */
export function downloadJson(result: InspectionResult): void {
  const safeSerial = result.serialNumber || 'result'
  downloadJsonData(
    result,
    `inspection_${safeSerial}_${result.checkedAt.replace(/[ :]/g, '-')}.json`,
  )
}

/** 検査結果JSON（製番単位・複数銘板）をダウンロードする */
export function downloadProductJson(result: ProductInspectionResult): void {
  const safeSerial = result.serialNumber || 'result'
  downloadJsonData(
    result,
    `inspection_${safeSerial}_${result.checkedAt.replace(/[ :]/g, '-')}.json`,
  )
}
