# ClipMate

<p align="center">
  <strong>macOS Paste にインスパイアされた、軽量な Windows クリップボードマネージャー</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri-2-24C8D8" alt="Tauri" />
  <img src="https://img.shields.io/badge/Rust-1.95+-DEA584" alt="Rust" />
  <img src="https://img.shields.io/badge/Vite-6-646cff" alt="Vite" />
  <img src="https://img.shields.io/badge/Windows-11-0078d4" alt="Windows" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License" />
</p>

<p align="center">
  <a href="../README.md">简体中文</a> | <a href="README.en.md">English</a> | <a href="README.ja.md">日本語</a> | <a href="README.ko.md">한국어</a>
</p>

## プレビュー

<p align="center">
  <img src="../assets/preview.png" alt="ボトムレイアウト" height="300" />
  <img src="../assets/preview-right.png" alt="右側レイアウト" height="300" />
</p>

## 機能一覧

- **グローバルホットキー** — `Ctrl + Shift + V` でいつでもパネルを呼び出し
- **デュアルレイアウト** — ボトムバー（macOS Paste スタイル）/ 右サイドバー、自由に切替可能
- **マルチタイプ対応** — テキスト、画像、リンクを自動分類
- **スマート検索** — クリップボード履歴をリアルタイムでフィルタリング
- **ピン留め** — 重要な項目をトップに固定、上書きされません
- **画像ファイル保存** — base64 の代わりに PNG ファイルで保存、メモリ使用量を約99%削減
- **画像重複排除** — MD5 フィンガープリントで重複保存を防止
- **自動クリーンアップ** — 7日間の有効期限 + 200MB 容量上限 + 孤児ファイル回収
- **履歴の永続化** — JSON ファイル + 画像のディスク分離、再起動後も維持（最大200件）
- **グラスモーフィズム UI** — 半透明のぼかし背景、モダンなデザイン
- **システムトレイ** — トレイに最小化してバックグラウンドで動作
- **自動起動** — スタートアップ時に自動起動（トレイメニューで制御）
- **シングルインスタンス** — 複数ウィンドウの起動を防止
- **キーボードナビゲーション** — 方向キーで移動、Enterで貼り付け、Escで閉じる
- **カスタムホットキー** — グローバルショートカットのカスタム録音に対応
- **NSIS/MSI インストーラー** — 標準的な Windows インストーラー

## キーボードショートカット

| ショートカット | 操作 |
|---------------|------|
| `Ctrl + Shift + V` | パネルの表示 / 非表示（カスタマイズ可能） |
| `Ctrl + ,` | 設定パネルを開く |
| `ダブルクリック` | 選択項目を貼り付け |
| `Enter` | 現在の選択項目を貼り付け |
| `Esc` | パネルを閉じる |
| `←` `→` / `↑` `↓` | 項目の移動（方向はレイアウトに自動適応） |

## プロジェクト構成

```
clipboard-manager/
├── src/                    # フロントエンドソース (vanilla JS)
│   ├── main.js             # メインロジック（検索、デュアルレイアウト、設定、キーボード操作）
│   └── styles.css          # グローバルスタイル（グラスモーフィズム + デュアルモード + ライト/ダークテーマ）
├── src-tauri/              # Rust バックエンド
│   ├── src/
│   │   ├── main.rs         # ウィンドウ管理、トレイ、クリップボード監視、ホットキー、クリーンアップ
│   │   ├── commands.rs     # Tauri コマンド（CRUD、貼り付け、設定、自動起動）
│   │   └── models.rs       # データモデル、永続化、画像保存、MD5 重複排除、クリーンアップ
│   ├── icons/              # アプリアイコンリソース
│   ├── capabilities/       # Tauri 権限設定
│   ├── Cargo.toml          # Rust 依存関係
│   └── tauri.conf.json     # Tauri 設定
├── index.html              # HTML エントリ
├── package.json            # フロントエンド依存関係
├── vite.config.js          # Vite 設定
└── build.bat               # Windows ワンクリックビルドスクリプト
```

## 技術スタック

| 技術 | 用途 | バージョン |
|------|------|-----------|
| [Tauri](https://tauri.app/) | デスクトップアプリフレームワーク | 2.x |
| [Rust](https://www.rust-lang.org/) | バックエンドコア | 1.95+ |
| [Vite](https://vitejs.dev/) | フロントエンドビルドツール | 6.x |
| [Vanilla JS](https://developer.mozilla.org/en-US/docs/Web/JavaScript) | UI レンダリング | ES6+ |

### Rust コア依存関係

| 依存関係 | 用途 |
|----------|------|
| `arboard` | クリップボード読み書き |
| `tauri-plugin-global-shortcut` | グローバルホットキー |
| `tauri-plugin-autostart` | 自動起動 |
| `tauri-plugin-single-instance` | シングルインスタンスロック |
| `tauri-plugin-opener` | 外部リンクを開く |
| `reqwest` | HTTP リクエスト（バージョンチェック） |
| `windows` | Win32 API（SendInput で貼り付けをシミュレート） |

## 開発ガイド

### 前提条件

- Node.js >= 18
- Rust >= 1.70 （`rustup` でインストール）
- Windows 10/11

### 依存関係のインストール

```bash
cd clipboard-manager
npm install
```

### 開発モード

```bash
# Tauri 開発サーバーを起動（フロントエンドホットリロード + Rust 自動再コンパイル）
npx tauri dev
```

### ビルド

```bash
# ワンクリックビルド（フロントエンド + Rust コンパイル + インストーラーパッケージング）
build.bat

# または手動ビルド
npx tauri build
```

ビルド成果物は `src-tauri/target/release/bundle/` にあります：
- `nsis/ClipMate_1.2.2_x64-setup.exe` — NSIS インストーラー
- `msi/ClipMate_1.2.2_x64_en-US.msi` — MSI インストーラー
- `../clipmate.exe` — スタンドアロン実行ファイル

## データ保存

すべてのデータは `%APPDATA%/clipmate/` に保存されます：

| ファイル / ディレクトリ | 説明 |
|------------------------|------|
| `clipboard-history.json` | クリップボード履歴 + ピン留め項目 |
| `settings.json` | ユーザー設定（レイアウトモード、最大件数、ホットキーなど） |
| `images/{id}.png` | 画像ファイル保存（PNG 形式） |
| `debug.log` | 実行ログ（自動ローテーション、上限512KB） |

## ライセンス

[MIT](../LICENSE)
