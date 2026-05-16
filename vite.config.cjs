const { defineConfig } = require('vite')
const react = require('@vitejs/plugin-react')
const path = require('path')
const { execSync } = require('child_process')

// 从 git tag 读取版本号，格式: v1.2.3 → 1.2.3
function getGitVersion() {
  try {
    const tag = execSync('git describe --tags --abbrev=0 2>/dev/null', { encoding: 'utf-8' }).trim()
    return tag.replace(/^v/, '')
  } catch (_) {
    // 没有 tag 时回退到 package.json 或 dev 标记
    try {
      return require('./package.json').version
    } catch (_) {
      return '0.0.0-dev'
    }
  }
}

const appVersion = getGitVersion()

module.exports = defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer')
    }
  },
  define: {
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  server: {
    port: 5173
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
