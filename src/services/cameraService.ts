// カメラ処理モジュール（純粋ロジック層）
// OCR処理（ocrService）とは疎結合。ここではストリームの起動／停止と
// 1フレームのキャプチャだけを担い、React 連携は useCamera フックが行う。

/** カメラ起動オプション */
export interface CameraStartOptions {
  /** 'environment'=背面カメラ / 'user'=前面カメラ */
  facingMode?: 'environment' | 'user'
}

/** キャプチャ結果 */
export interface CaptureResult {
  blob: Blob
  dataUrl: string
}

/** このブラウザがカメラ(getUserMedia)に対応しているか */
export function isCameraSupported(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia)
}

/**
 * 背面カメラ等のメディアストリームを起動する。
 * HTTPS（または localhost）でないと iOS/モダンブラウザでは失敗する点に注意。
 */
export async function startCameraStream(
  options: CameraStartOptions = {},
): Promise<MediaStream> {
  if (!isCameraSupported()) {
    throw new Error('このブラウザはカメラ(getUserMedia)に対応していません')
  }
  const facingMode = options.facingMode ?? 'environment'
  // OCRは解像度が精度に直結するため、可能なら高解像度を要求する。
  // ideal 指定なので非対応端末では自動的に取得可能な解像度へフォールバックする。
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  })
}

/** ストリームの全トラックを停止してリソースを解放する */
export function stopCameraStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop())
}

/**
 * <video> の現在のフレームを <canvas> に描画し、Blob / dataURL に変換する。
 * @param video 再生中の video 要素
 */
export async function captureFrame(
  video: HTMLVideoElement,
  type = 'image/jpeg',
  quality = 0.92,
): Promise<CaptureResult> {
  const width = video.videoWidth
  const height = video.videoHeight
  if (!width || !height) {
    throw new Error('カメラ映像をまだ取得できていません')
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('canvas コンテキストの取得に失敗しました')
  }
  ctx.drawImage(video, 0, 0, width, height)

  const dataUrl = canvas.toDataURL(type, quality)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, type, quality),
  )
  if (!blob) {
    throw new Error('画像の生成に失敗しました')
  }
  return { blob, dataUrl }
}
