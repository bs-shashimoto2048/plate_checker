// 回答データ読込モジュール
// 現状は public 配下の固定JSONファイルを読み込む。
//
// 形式（新・正）: 製番 → 複数の種類 → 各種類が複数の銘板(No) を持つ
//   {
//     "products": [
//       { "serialNumber": "...", "types": [
//           { "type": "...", "nameplates": [ { "labelTexts": [...], "quantity": 1 } ] }
//       ] }
//     ]
//   }
//
// 後方互換（可能な範囲で正規化）:
//   - { plates: [ { serialNumber, type, nameplates|labelTexts } ] }
//   - 単一/配列、quantity 省略時は 1
//   - 同一 serialNumber は1つの製番にまとめ、type ごとに types[] へ集約する。

import type { Nameplate, Product, ProductType } from '../types'

interface RawNameplate {
  labelTexts?: unknown
  quantity?: unknown
}

/** フラットな (製番, 種類, 銘板群) 中間表現 */
interface FlatTarget {
  serialNumber: string
  type: string
  nameplates: Nameplate[]
}

function toStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  if (!value.every((t) => typeof t === 'string')) return null
  return value as string[]
}

function toQuantity(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.floor(n)
}

function toNameplate(value: unknown): Nameplate | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as RawNameplate
  const labelTexts = toStringArray(v.labelTexts)
  if (!labelTexts) return null
  return { labelTexts, quantity: toQuantity(v.quantity) }
}

function toNameplates(value: unknown): Nameplate[] {
  if (!Array.isArray(value)) return []
  return value.map(toNameplate).filter((n): n is Nameplate => n !== null)
}

/** 1エントリ（製番）から (製番, 種類, 銘板群) を取り出す */
function flattenEntry(value: unknown): FlatTarget[] {
  if (typeof value !== 'object' || value === null) return []
  const v = value as Record<string, unknown>
  const serialNumber = typeof v.serialNumber === 'string' ? v.serialNumber : ''

  // 新構造: types[]
  if (Array.isArray(v.types)) {
    const out: FlatTarget[] = []
    for (const t of v.types) {
      if (typeof t !== 'object' || t === null) continue
      const tt = t as Record<string, unknown>
      const type = typeof tt.type === 'string' ? tt.type : ''
      const nameplates = toNameplates(tt.nameplates)
      if (nameplates.length > 0) out.push({ serialNumber, type, nameplates })
    }
    return out
  }

  const type = typeof v.type === 'string' ? v.type : ''

  // 旧: nameplates[] を直接持つ
  if (Array.isArray(v.nameplates)) {
    const nameplates = toNameplates(v.nameplates)
    if (nameplates.length > 0) return [{ serialNumber, type, nameplates }]
    return []
  }

  // 旧: labelTexts（単一銘板）
  const labelTexts = toStringArray(v.labelTexts)
  if (labelTexts) {
    return [
      {
        serialNumber,
        type,
        nameplates: [{ labelTexts, quantity: toQuantity(v.quantity) }],
      },
    ]
  }
  return []
}

/** 任意のJSONを Product[]（製番→種類→銘板）へ正規化する */
function toProducts(json: unknown): Product[] {
  let list: unknown[]
  if (Array.isArray(json)) {
    list = json
  } else if (typeof json === 'object' && json !== null) {
    const obj = json as Record<string, unknown>
    if (Array.isArray(obj.products)) list = obj.products
    else if (Array.isArray(obj.plates)) list = obj.plates
    else list = [json]
  } else {
    list = [json]
  }

  const flat = list.flatMap(flattenEntry)

  // serialNumber ごとに製番へ集約（出現順を保つ）
  const order: string[] = []
  const map = new Map<string, Product>()
  for (const f of flat) {
    let product = map.get(f.serialNumber)
    if (!product) {
      product = { serialNumber: f.serialNumber, types: [] }
      map.set(f.serialNumber, product)
      order.push(f.serialNumber)
    }
    product.types.push({ type: f.type, nameplates: f.nameplates } as ProductType)
  }

  const products = order.map((s) => map.get(s)!).filter((p) => p.types.length > 0)
  if (products.length === 0) {
    throw new Error('回答データの形式が正しくありません')
  }
  return products
}

/**
 * 回答データ（製番→種類→銘板）を読み込む。
 * @param url 取得先。既定では public/sample-answers.json
 */
export async function loadProducts(
  url = `${import.meta.env.BASE_URL}sample-answers.json`,
): Promise<Product[]> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) {
    throw new Error(`回答データの取得に失敗しました (HTTP ${res.status})`)
  }
  const json: unknown = await res.json()
  return toProducts(json)
}
