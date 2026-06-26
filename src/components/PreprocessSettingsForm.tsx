// OCR前処理パラメータの編集フォーム（設定オーバーレイ内）。
// 現段階は「値の保持・表示・編集」のみで、画像処理には適用しない（次段階で適用）。
// 値の構造は types.ts の PreprocessSettings（依頼JSON）に1:1対応する。

import type {
  DenoiseMethod,
  MorphMethod,
  PreprocessSettings,
  ThresholdType,
} from '../types'

type Ops = PreprocessSettings['operations']

interface Props {
  value: PreprocessSettings
  onChange: (next: PreprocessSettings) => void
  onReset: () => void
}

/** セレクト選択肢（内部値は英語キーのまま、表示のみ日本語） */
interface Option<T extends string> {
  value: T
  label: string
}

const THRESHOLD_TYPES: Option<ThresholdType>[] = [
  { value: 'binary', label: '二値' },
  { value: 'binary_inv', label: '二値（反転）' },
  { value: 'otsu', label: '大津' },
  { value: 'adaptive', label: '適応' },
  { value: 'none', label: 'なし' },
]
const MORPH_METHODS: Option<MorphMethod>[] = [
  { value: 'close', label: 'クローズ' },
  { value: 'open', label: 'オープン' },
  { value: 'dilate', label: '膨張' },
  { value: 'erode', label: '収縮' },
]
const DENOISE_METHODS: Option<DenoiseMethod>[] = [
  { value: 'gaussian', label: 'ガウシアン' },
  { value: 'median', label: 'メディアン' },
  { value: 'bilateral', label: 'バイラテラル' },
  { value: 'none', label: 'なし' },
]

// ---- 小さな再利用コントロール ----

function NumberField(props: {
  label: string
  value: number
  step?: number
  min?: number
  max?: number
  onChange: (v: number) => void
}) {
  return (
    <label className="pp-field">
      <span className="pp-label">{props.label}</span>
      <input
        type="number"
        className="pp-num"
        value={props.value}
        step={props.step ?? 1}
        min={props.min}
        max={props.max}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  )
}

function SelectField<T extends string>(props: {
  label: string
  value: T
  options: readonly Option<T>[]
  onChange: (v: T) => void
}) {
  return (
    <label className="pp-field">
      <span className="pp-label">{props.label}</span>
      <select
        className="pp-select"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value as T)}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function ToggleField(props: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="pp-field pp-toggle">
      <span className="pp-label">{props.label}</span>
      <span className="switch">
        <input
          type="checkbox"
          checked={props.checked}
          onChange={(e) => props.onChange(e.target.checked)}
        />
        <span className="switch-track">
          <span className="switch-thumb" />
        </span>
      </span>
    </label>
  )
}

export function PreprocessSettingsForm({ value, onChange, onReset }: Props) {
  const ops = value.operations

  /** operations 配下の1項目を型安全に更新（イミュータブル） */
  const setOp = <K extends keyof Ops, F extends keyof Ops[K]>(
    op: K,
    field: F,
    v: Ops[K][F],
  ) => {
    const nextOps = { ...value.operations }
    nextOps[op] = { ...nextOps[op], [field]: v } as Ops[K]
    onChange({ ...value, operations: nextOps })
  }

  return (
    <div className="pp-form">
      <div className="pp-form-head">
        <span className="pp-title">前処理設定</span>
      </div>
      <p className="muted pp-note">
        ※ ここで変更した値は、OCRに渡る画像の前処理と「前処理後映像」表示の両方へ即時反映されます
        （OCRの切り出し範囲・アスペクト比は変わりません）。
      </p>

      {/* ルート */}
      <NumberField
        label="縦横比しきい値"
        value={value.ratio_threshold}
        step={0.1}
        onChange={(v) => onChange({ ...value, ratio_threshold: v })}
      />

      {/* threshold */}
      <fieldset className="pp-op">
        <legend>二値化</legend>
        <SelectField
          label="種別"
          value={ops.threshold.type}
          options={THRESHOLD_TYPES}
          onChange={(v) => setOp('threshold', 'type', v)}
        />
        <NumberField
          label="しきい値"
          value={ops.threshold.value}
          onChange={(v) => setOp('threshold', 'value', v)}
        />
      </fieldset>

      {/* clahe */}
      <fieldset className="pp-op">
        <legend>CLAHE（適応平坦化）</legend>
        <NumberField
          label="クリップ制限"
          value={ops.clahe.clip_limit}
          step={0.1}
          onChange={(v) => setOp('clahe', 'clip_limit', v)}
        />
        <NumberField
          label="タイル分割数"
          value={ops.clahe.tile_grid_size}
          onChange={(v) => setOp('clahe', 'tile_grid_size', v)}
        />
      </fieldset>

      {/* sharpen */}
      <fieldset className="pp-op">
        <legend>シャープ</legend>
        <ToggleField
          label="有効"
          checked={ops.sharpen.enabled}
          onChange={(v) => setOp('sharpen', 'enabled', v)}
        />
        <NumberField
          label="強度"
          value={ops.sharpen.amount}
          step={0.1}
          onChange={(v) => setOp('sharpen', 'amount', v)}
        />
        <NumberField
          label="シグマ"
          value={ops.sharpen.sigma}
          step={0.1}
          onChange={(v) => setOp('sharpen', 'sigma', v)}
        />
      </fieldset>

      {/* gamma */}
      <fieldset className="pp-op">
        <legend>ガンマ</legend>
        <ToggleField
          label="有効"
          checked={ops.gamma.enabled}
          onChange={(v) => setOp('gamma', 'enabled', v)}
        />
        <NumberField
          label="値"
          value={ops.gamma.value}
          step={0.1}
          onChange={(v) => setOp('gamma', 'value', v)}
        />
      </fieldset>

      {/* morph */}
      <fieldset className="pp-op">
        <legend>モルフォロジー</legend>
        <ToggleField
          label="有効"
          checked={ops.morph.enabled}
          onChange={(v) => setOp('morph', 'enabled', v)}
        />
        <SelectField
          label="方法"
          value={ops.morph.method}
          options={MORPH_METHODS}
          onChange={(v) => setOp('morph', 'method', v)}
        />
        <NumberField
          label="カーネル径"
          value={ops.morph.ksize}
          onChange={(v) => setOp('morph', 'ksize', v)}
        />
        <NumberField
          label="反復回数"
          value={ops.morph.iterations}
          onChange={(v) => setOp('morph', 'iterations', v)}
        />
      </fieldset>

      {/* unsharp */}
      <fieldset className="pp-op">
        <legend>アンシャープ</legend>
        <ToggleField
          label="有効"
          checked={ops.unsharp.enabled}
          onChange={(v) => setOp('unsharp', 'enabled', v)}
        />
        <NumberField
          label="強度"
          value={ops.unsharp.amount}
          step={0.1}
          onChange={(v) => setOp('unsharp', 'amount', v)}
        />
        <NumberField
          label="半径"
          value={ops.unsharp.radius}
          step={0.1}
          onChange={(v) => setOp('unsharp', 'radius', v)}
        />
        <NumberField
          label="しきい値"
          value={ops.unsharp.threshold}
          onChange={(v) => setOp('unsharp', 'threshold', v)}
        />
      </fieldset>

      {/* bilateral */}
      <fieldset className="pp-op">
        <legend>バイラテラル</legend>
        <ToggleField
          label="有効"
          checked={ops.bilateral.enabled}
          onChange={(v) => setOp('bilateral', 'enabled', v)}
        />
        <NumberField
          label="直径"
          value={ops.bilateral.diameter}
          onChange={(v) => setOp('bilateral', 'diameter', v)}
        />
        <NumberField
          label="色シグマ"
          value={ops.bilateral.sigma_color}
          onChange={(v) => setOp('bilateral', 'sigma_color', v)}
        />
        <NumberField
          label="空間シグマ"
          value={ops.bilateral.sigma_space}
          onChange={(v) => setOp('bilateral', 'sigma_space', v)}
        />
      </fieldset>

      {/* local_contrast */}
      <fieldset className="pp-op">
        <legend>局所コントラスト</legend>
        <ToggleField
          label="有効"
          checked={ops.local_contrast.enabled}
          onChange={(v) => setOp('local_contrast', 'enabled', v)}
        />
        <NumberField
          label="クリップ制限"
          value={ops.local_contrast.clip_limit}
          step={0.1}
          onChange={(v) => setOp('local_contrast', 'clip_limit', v)}
        />
        <NumberField
          label="タイル分割数"
          value={ops.local_contrast.tile_grid_size}
          onChange={(v) => setOp('local_contrast', 'tile_grid_size', v)}
        />
      </fieldset>

      {/* crop_margin */}
      <fieldset className="pp-op">
        <legend>余白クロップ</legend>
        <ToggleField
          label="有効"
          checked={ops.crop_margin.enabled}
          onChange={(v) => setOp('crop_margin', 'enabled', v)}
        />
        <NumberField
          label="しきい値"
          value={ops.crop_margin.threshold}
          onChange={(v) => setOp('crop_margin', 'threshold', v)}
        />
        <NumberField
          label="余白"
          value={ops.crop_margin.margin}
          onChange={(v) => setOp('crop_margin', 'margin', v)}
        />
      </fieldset>

      {/* hist_equalize */}
      <fieldset className="pp-op">
        <legend>ヒストグラム平坦化</legend>
        <ToggleField
          label="有効"
          checked={ops.hist_equalize.enabled}
          onChange={(v) => setOp('hist_equalize', 'enabled', v)}
        />
      </fieldset>

      {/* stroke_boost */}
      <fieldset className="pp-op">
        <legend>線強調</legend>
        <ToggleField
          label="有効"
          checked={ops.stroke_boost.enabled}
          onChange={(v) => setOp('stroke_boost', 'enabled', v)}
        />
        <SelectField
          label="方法"
          value={ops.stroke_boost.method}
          options={MORPH_METHODS}
          onChange={(v) => setOp('stroke_boost', 'method', v)}
        />
        <NumberField
          label="カーネル径"
          value={ops.stroke_boost.ksize}
          onChange={(v) => setOp('stroke_boost', 'ksize', v)}
        />
        <NumberField
          label="反復回数"
          value={ops.stroke_boost.iterations}
          onChange={(v) => setOp('stroke_boost', 'iterations', v)}
        />
      </fieldset>

      {/* denoise */}
      <fieldset className="pp-op">
        <legend>ノイズ除去</legend>
        <SelectField
          label="方法"
          value={ops.denoise.method}
          options={DENOISE_METHODS}
          onChange={(v) => setOp('denoise', 'method', v)}
        />
        <NumberField
          label="カーネル径"
          value={ops.denoise.ksize}
          onChange={(v) => setOp('denoise', 'ksize', v)}
        />
      </fieldset>

      {/* deskew */}
      <fieldset className="pp-op">
        <legend>傾き補正</legend>
        <ToggleField
          label="有効"
          checked={ops.deskew.enabled}
          onChange={(v) => setOp('deskew', 'enabled', v)}
        />
      </fieldset>

      {/* resize */}
      <fieldset className="pp-op">
        <legend>リサイズ</legend>
        <NumberField
          label="単一行高さ"
          value={ops.resize.single}
          onChange={(v) => setOp('resize', 'single', v)}
        />
        <NumberField
          label="横長時高さ"
          value={ops.resize.wide_height}
          onChange={(v) => setOp('resize', 'wide_height', v)}
        />
        <ToggleField
          label="縦横比保持"
          checked={ops.resize.keep_ratio}
          onChange={(v) => setOp('resize', 'keep_ratio', v)}
        />
      </fieldset>

      {/* 最下段：デフォルト値に戻す */}
      <button
        type="button"
        className="btn-secondary pp-reset"
        onClick={onReset}
      >
        デフォルト値に戻す
      </button>
    </div>
  )
}
