// OCRホワイトリストの読み込み・組み立て。
// 編集元はプロジェクトルートの `whitelist.jsonc`（コメント付きJSONC）。
// ビルド時に `?raw` で文字列として取り込み（実行時fetchではない）、コメントを除去して
// パースし、文字種グループを連結＋重複除去して1つのホワイトリスト文字列にする。

import whitelistRaw from '../../whitelist.jsonc?raw'

interface WhitelistFile {
  /** 文字種グループ（base/hiragana/katakana/kanji/symbols 等）。順に連結する */
  groups?: Record<string, string>
  /** 旧形式（配列）。後方互換のため対応 */
  parts?: string[]
}

/**
 * JSONC（// 行コメント・/* *​/ ブロックコメント）からコメントを除去する。
 * 文字列リテラル内の // などは除去しないよう、文字列状態を追跡する。
 */
function stripJsonComments(src: string): string {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      out += c
      continue
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (c === '/' && n === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i++ // 末尾の '*' を飛ばす（'/' は for ループの i++ で飛ぶ）
      continue
    }
    out += c
  }
  return out
}

/** whitelist.jsonc を組み立て：グループ連結 → 重複文字を除去（最初の出現順を保持）。 */
function buildWhitelist(): string {
  let parsed: WhitelistFile = {}
  try {
    parsed = JSON.parse(stripJsonComments(whitelistRaw)) as WhitelistFile
  } catch {
    // パース失敗時は安全側で無制限（空文字）にフォールバック
    return ''
  }
  const pieces: string[] = parsed.groups
    ? Object.values(parsed.groups)
    : Array.isArray(parsed.parts)
      ? parsed.parts
      : []
  const combined = pieces.join('')
  // 重複文字を1つにまとめる（同じ文字が二重に入らないように。出現順は保持）
  const seen = new Set<string>()
  let out = ''
  for (const ch of combined) {
    if (!seen.has(ch)) {
      seen.add(ch)
      out += ch
    }
  }
  return out
}

/** OCRに渡すホワイトリスト文字列（重複除去済み）。空文字は無制限を意味する。 */
export const OCR_WHITELIST: string = buildWhitelist()
