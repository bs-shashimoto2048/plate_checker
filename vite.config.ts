import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// Vite の基本設定。PoC のためシンプルに保つ。
// iOS Safari の getUserMedia(カメラ) は HTTPS / localhost でしか動作しないため、
// 開発サーバーを自己署名証明書つき HTTPS で起動できるよう basicSsl を有効化している。
// iPhone 実機から LAN 経由で使う場合は `npm run dev -- --host` で公開し、
// https://<PCのIP>:5173 にアクセスする（自己署名証明書の警告は手動で許可）。
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    port: 5173,
    open: true,
    // host: true 相当にしたい場合は CLI の `--host` を使う
  },
})
