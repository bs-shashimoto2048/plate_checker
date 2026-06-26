// useCamera フック
// cameraService（純粋ロジック）を React のライフサイクルに結びつける。
// ストリームの保持・解放、video 要素への接続、エラー整形を担当する。
// OCR には依存しない（撮影した Blob を呼び出し側が ocrService へ渡す）。

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  captureFrame,
  isCameraSupported,
  startCameraStream,
  stopCameraStream,
  type CaptureResult,
} from '../services/cameraService'

export interface UseCamera {
  /** プレビュー用 <video> に割り当てる ref */
  videoRef: React.RefObject<HTMLVideoElement>
  /** カメラ起動中か */
  active: boolean
  /** カメラ起動エラーメッセージ（なければ null） */
  error: string | null
  /** このブラウザがカメラに対応しているか */
  supported: boolean
  /** カメラを起動する */
  start: () => Promise<void>
  /** カメラを停止しリソースを解放する */
  stop: () => void
  /** 現在のフレームをキャプチャする */
  capture: () => Promise<CaptureResult>
}

/** getUserMedia 例外を日本語メッセージへ整形する */
function toCameraErrorMessage(e: unknown): string {
  if (e instanceof DOMException) {
    switch (e.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'カメラの使用が許可されませんでした。ブラウザの権限設定をご確認ください。'
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return '利用可能なカメラが見つかりませんでした。'
      case 'NotReadableError':
        return 'カメラに接続できませんでした（他のアプリが使用中の可能性があります）。'
      default:
        return `カメラの起動に失敗しました: ${e.name}`
    }
  }
  return e instanceof Error ? e.message : String(e)
}

export function useCamera(): UseCamera {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const stop = useCallback(() => {
    stopCameraStream(streamRef.current)
    streamRef.current = null
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    setActive(false)
  }, [])

  const start = useCallback(async () => {
    setError(null)
    try {
      const stream = await startCameraStream({ facingMode: 'environment' })
      streamRef.current = stream
      const video = videoRef.current
      if (video) {
        video.srcObject = stream
        // iOS Safari 対策: muted + playsInline 前提で明示的に play()
        await video.play().catch(() => undefined)
      }
      setActive(true)
    } catch (e: unknown) {
      stopCameraStream(streamRef.current)
      streamRef.current = null
      setError(toCameraErrorMessage(e))
      setActive(false)
    }
  }, [])

  const capture = useCallback(async (): Promise<CaptureResult> => {
    if (!videoRef.current) {
      throw new Error('カメラが起動していません')
    }
    return captureFrame(videoRef.current)
  }, [])

  // アンマウント時に確実にストリームを解放する
  useEffect(() => {
    return () => {
      stopCameraStream(streamRef.current)
      streamRef.current = null
    }
  }, [])

  return {
    videoRef,
    active,
    error,
    supported: isCameraSupported(),
    start,
    stop,
    capture,
  }
}
