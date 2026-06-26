// 正規化処理モジュール
// OCR結果や期待値を比較しやすい形に整える。
//  - 全角英数字→半角
//  - 空白・改行の除去
//  - 文字置換辞書による補正（誤認識・異体字対応）

/**
 * 文字置換辞書。
 * 「OCRで出やすい誤読」や「異体字」を正しい文字へ寄せるために使う。
 * 後から項目を追加するだけで補正ルールを増やせる構造にしている。
 * 例: '髙' → '高'
 */
export const REPLACEMENT_DICTIONARY: Record<string, string> = {
  髙: '高', // はしご高 → 高
  﨑: '崎',
  // OCRで紛らわしい例（必要に応じて追加）
  // 'O': '0',
  // 'l': '1',
}

/** 全角英数字・全角記号を半角へ変換する */
export function toHalfWidth(input: string): string {
  return input
    // 全角英数字・記号（！〜～）を半角へ
    .replace(/[！-～]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    )
    // 全角スペース → 半角スペース
    .replace(/　/g, ' ')
}

/** 辞書に基づき文字を置換する */
export function applyDictionary(
  input: string,
  dictionary: Record<string, string> = REPLACEMENT_DICTIONARY,
): string {
  let out = input
  for (const [from, to] of Object.entries(dictionary)) {
    out = out.split(from).join(to)
  }
  return out
}

/**
 * 比較用に1つの文字列を正規化する。
 *  1. 全角→半角
 *  2. 辞書置換
 *  3. すべての空白除去
 *  4. 比較に不要な記号の除去（必要な . - _ / ( ) は残す）
 */
export function normalizeText(
  input: string,
  dictionary: Record<string, string> = REPLACEMENT_DICTIONARY,
): string {
  let s = input
  s = toHalfWidth(s)
  s = applyDictionary(s, dictionary)
  // 半角・全角スペース、タブ、改行などの空白をすべて除去する。
  // 例: '3棟 200V動力' → '3棟200V動力'
  s = s.replace(/\s+/g, '')
  // 英数字・日本語（漢字/ひらがな/カタカナ）・一部記号のみ残す
  s = s.replace(/[^0-9A-Za-z぀-ヿ一-鿿.\-_/()]/g, '')
  return s
}

/**
 * OCRの生テキストを行単位の候補リストに分割する。
 *  - 改行で分割
 *  - 各行を正規化
 *  - 空行を除去
 */
export function splitIntoLines(
  rawText: string,
  dictionary: Record<string, string> = REPLACEMENT_DICTIONARY,
): string[] {
  return rawText
    .split(/\r?\n/)
    .map((line) => normalizeText(line, dictionary))
    .filter((line) => line.length > 0)
}
