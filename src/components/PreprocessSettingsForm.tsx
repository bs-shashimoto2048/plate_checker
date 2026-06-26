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

const THRESHOLD_TYPES: ThresholdType[] = [
  'binary',
  'binary_inv',
  'otsu',
  'adaptive',
  'none',
]
const MORPH_METHODS: MorphMethod[] = ['close', 'open', 'dilate', 'erode']
const DENOISE_METHODS: DenoiseMethod[] = ['gaussian', 'median', 'bilateral', 'none']

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
  options: readonly T[]
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
          <option key={o} value={o}>
            {o}
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
        <button type="button" className="btn-secondary sm" onClick={onReset}>
          既定に戻す
        </button>
      </div>
      <p className="muted pp-note">
        ※ 現段階は値の保持・表示・編集のみ。実際の前処理への適用は次段階です。
      </p>

      {/* ルート */}
      <NumberField
        label="ratio_threshold"
        value={value.ratio_threshold}
        step={0.1}
        onChange={(v) => onChange({ ...value, ratio_threshold: v })}
      />

      {/* threshold */}
      <fieldset className="pp-op">
        <legend>threshold</legend>
        <SelectField
          label="type"
          value={ops.threshold.type}
          options={THRESHOLD_TYPES}
          onChange={(v) => setOp('threshold', 'type', v)}
        />
        <NumberField
          label="value"
          value={ops.threshold.value}
          onChange={(v) => setOp('threshold', 'value', v)}
        />
      </fieldset>

      {/* clahe */}
      <fieldset className="pp-op">
        <legend>clahe</legend>
        <NumberField
          label="clip_limit"
          value={ops.clahe.clip_limit}
          step={0.1}
          onChange={(v) => setOp('clahe', 'clip_limit', v)}
        />
        <NumberField
          label="tile_grid_size"
          value={ops.clahe.tile_grid_size}
          onChange={(v) => setOp('clahe', 'tile_grid_size', v)}
        />
      </fieldset>

      {/* sharpen */}
      <fieldset className="pp-op">
        <legend>sharpen</legend>
        <ToggleField
          label="enabled"
          checked={ops.sharpen.enabled}
          onChange={(v) => setOp('sharpen', 'enabled', v)}
        />
        <NumberField
          label="amount"
          value={ops.sharpen.amount}
          step={0.1}
          onChange={(v) => setOp('sharpen', 'amount', v)}
        />
        <NumberField
          label="sigma"
          value={ops.sharpen.sigma}
          step={0.1}
          onChange={(v) => setOp('sharpen', 'sigma', v)}
        />
      </fieldset>

      {/* gamma */}
      <fieldset className="pp-op">
        <legend>gamma</legend>
        <ToggleField
          label="enabled"
          checked={ops.gamma.enabled}
          onChange={(v) => setOp('gamma', 'enabled', v)}
        />
        <NumberField
          label="value"
          value={ops.gamma.value}
          step={0.1}
          onChange={(v) => setOp('gamma', 'value', v)}
        />
      </fieldset>

      {/* morph */}
      <fieldset className="pp-op">
        <legend>morph</legend>
        <ToggleField
          label="enabled"
          checked={ops.morph.enabled}
          onChange={(v) => setOp('morph', 'enabled', v)}
        />
        <SelectField
          label="method"
          value={ops.morph.method}
          options={MORPH_METHODS}
          onChange={(v) => setOp('morph', 'method', v)}
        />
        <NumberField
          label="ksize"
          value={ops.morph.ksize}
          onChange={(v) => setOp('morph', 'ksize', v)}
        />
        <NumberField
          label="iterations"
          value={ops.morph.iterations}
          onChange={(v) => setOp('morph', 'iterations', v)}
        />
      </fieldset>

      {/* unsharp */}
      <fieldset className="pp-op">
        <legend>unsharp</legend>
        <ToggleField
          label="enabled"
          checked={ops.unsharp.enabled}
          onChange={(v) => setOp('unsharp', 'enabled', v)}
        />
        <NumberField
          label="amount"
          value={ops.unsharp.amount}
          step={0.1}
          onChange={(v) => setOp('unsharp', 'amount', v)}
        />
        <NumberField
          label="radius"
          value={ops.unsharp.radius}
          step={0.1}
          onChange={(v) => setOp('unsharp', 'radius', v)}
        />
        <NumberField
          label="threshold"
          value={ops.unsharp.threshold}
          onChange={(v) => setOp('unsharp', 'threshold', v)}
        />
      </fieldset>

      {/* bilateral */}
      <fieldset className="pp-op">
        <legend>bilateral</legend>
        <ToggleField
          label="enabled"
          checked={ops.bilateral.enabled}
          onChange={(v) => setOp('bilateral', 'enabled', v)}
        />
        <NumberField
          label="diameter"
          value={ops.bilateral.diameter}
          onChange={(v) => setOp('bilateral', 'diameter', v)}
        />
        <NumberField
          label="sigma_color"
          value={ops.bilateral.sigma_color}
          onChange={(v) => setOp('bilateral', 'sigma_color', v)}
        />
        <NumberField
          label="sigma_space"
          value={ops.bilateral.sigma_space}
          onChange={(v) => setOp('bilateral', 'sigma_space', v)}
        />
      </fieldset>

      {/* local_contrast */}
      <fieldset className="pp-op">
        <legend>local_contrast</legend>
        <ToggleField
          label="enabled"
          checked={ops.local_contrast.enabled}
          onChange={(v) => setOp('local_contrast', 'enabled', v)}
        />
        <NumberField
          label="clip_limit"
          value={ops.local_contrast.clip_limit}
          step={0.1}
          onChange={(v) => setOp('local_contrast', 'clip_limit', v)}
        />
        <NumberField
          label="tile_grid_size"
          value={ops.local_contrast.tile_grid_size}
          onChange={(v) => setOp('local_contrast', 'tile_grid_size', v)}
        />
      </fieldset>

      {/* crop_margin */}
      <fieldset className="pp-op">
        <legend>crop_margin</legend>
        <ToggleField
          label="enabled"
          checked={ops.crop_margin.enabled}
          onChange={(v) => setOp('crop_margin', 'enabled', v)}
        />
        <NumberField
          label="threshold"
          value={ops.crop_margin.threshold}
          onChange={(v) => setOp('crop_margin', 'threshold', v)}
        />
        <NumberField
          label="margin"
          value={ops.crop_margin.margin}
          onChange={(v) => setOp('crop_margin', 'margin', v)}
        />
      </fieldset>

      {/* hist_equalize */}
      <fieldset className="pp-op">
        <legend>hist_equalize</legend>
        <ToggleField
          label="enabled"
          checked={ops.hist_equalize.enabled}
          onChange={(v) => setOp('hist_equalize', 'enabled', v)}
        />
      </fieldset>

      {/* stroke_boost */}
      <fieldset className="pp-op">
        <legend>stroke_boost</legend>
        <ToggleField
          label="enabled"
          checked={ops.stroke_boost.enabled}
          onChange={(v) => setOp('stroke_boost', 'enabled', v)}
        />
        <SelectField
          label="method"
          value={ops.stroke_boost.method}
          options={MORPH_METHODS}
          onChange={(v) => setOp('stroke_boost', 'method', v)}
        />
        <NumberField
          label="ksize"
          value={ops.stroke_boost.ksize}
          onChange={(v) => setOp('stroke_boost', 'ksize', v)}
        />
        <NumberField
          label="iterations"
          value={ops.stroke_boost.iterations}
          onChange={(v) => setOp('stroke_boost', 'iterations', v)}
        />
      </fieldset>

      {/* denoise */}
      <fieldset className="pp-op">
        <legend>denoise</legend>
        <SelectField
          label="method"
          value={ops.denoise.method}
          options={DENOISE_METHODS}
          onChange={(v) => setOp('denoise', 'method', v)}
        />
        <NumberField
          label="ksize"
          value={ops.denoise.ksize}
          onChange={(v) => setOp('denoise', 'ksize', v)}
        />
      </fieldset>

      {/* deskew */}
      <fieldset className="pp-op">
        <legend>deskew</legend>
        <ToggleField
          label="enabled"
          checked={ops.deskew.enabled}
          onChange={(v) => setOp('deskew', 'enabled', v)}
        />
      </fieldset>

      {/* resize */}
      <fieldset className="pp-op">
        <legend>resize</legend>
        <NumberField
          label="single"
          value={ops.resize.single}
          onChange={(v) => setOp('resize', 'single', v)}
        />
        <NumberField
          label="wide_height"
          value={ops.resize.wide_height}
          onChange={(v) => setOp('resize', 'wide_height', v)}
        />
        <ToggleField
          label="keep_ratio"
          checked={ops.resize.keep_ratio}
          onChange={(v) => setOp('resize', 'keep_ratio', v)}
        />
      </fieldset>
    </div>
  )
}
