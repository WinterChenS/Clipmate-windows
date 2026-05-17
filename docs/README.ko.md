# ClipMate

<p align="center">
  <strong>macOS Paste에서 영감을 받은 가벼운 Windows 클립보드 매니저</strong>
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

## 미리보기

<p align="center">
  <img src="../assets/preview.png" alt="하단 레이아웃" height="300" />
  <img src="../assets/preview-right.png" alt="우측 레이아웃" height="300" />
</p>

## 기능

- **글로벌 단축키** — `Ctrl + Shift + V` 로 언제든 패널 호출
- **듀얼 레이아웃** — 하단 바(macOS Paste 스타일) / 우측 사이드바, 자유롭게 전환
- **멀티 타입 지원** — 텍스트, 이미지, 링크 자동 분류
- **스마트 검색** — 클립보드 기록 실시간 필터링
- **고정 핀** — 중요한 항목을 상단에 고정하여 덮어쓰기 방지
- **이미지 파일 저장** — base64 대신 PNG 파일로 저장, 메모리 사용량 약 99% 감소
- **이미지 중복 제거** — MD5 핑거프린트 비교로 중복 저장 방지
- **자동 정리** — 7일 만료 + 200MB 용량 제한 + 고아 파일 회수
- **기록 영속화** — JSON 파일 + 이미지 디스크 분리, 재시작 후에도 유지(최대 200개)
- **글래스모피즘 UI** — 반투명 블러 배경, 모던한 디자인
- **시스템 트레이** — 트레이로 최소화하여 백그라운드에서 실행
- **자동 시작** — 부팅 시 자동 실행(트레이 메뉴에서 제어)
- **단일 인스턴스** — 다중 창 실행 방지
- **키보드 탐색** — 방향키로 이동, Enter로 붙여넣기, Esc로 닫기
- **커스텀 단축키** — 글로벌 단축키 커스텀 녹음 지원
- **NSIS/MSI 설치 프로그램** — 표준 Windows 설치 프로그램

## 키보드 단축키

| 단축키 | 동작 |
|--------|------|
| `Ctrl + Shift + V` | 패널 표시 / 숨기기(커스터마이즈 가능) |
| `Ctrl + ,` | 설정 패널 열기 |
| `더블클릭` | 선택 항목 붙여넣기 |
| `Enter` | 현재 선택 항목 붙여넣기 |
| `Esc` | 패널 닫기 |
| `←` `→` / `↑` `↓` | 항목 탐색(방향은 레이아웃에 자동 적응) |

## 프로젝트 구조

```
clipboard-manager/
├── src/                    # 프론트엔드 소스 (vanilla JS)
│   ├── main.js             # 메인 로직(검색, 듀얼 레이아웃, 설정, 키보드 탐색)
│   └── styles.css          # 글로벌 스타일(글래스모피즘 + 듀얼 모드 + 라이트/다크 테마)
├── src-tauri/              # Rust 백엔드
│   ├── src/
│   │   ├── main.rs         # 창 관리, 트레이, 클립보드 감시, 단축키, 정리
│   │   ├── commands.rs     # Tauri 명령(CRUD, 붙여넣기, 설정, 자동 시작)
│   │   └── models.rs       # 데이터 모델, 영속화, 이미지 저장, MD5 중복 제거, 정리
│   ├── icons/              # 앱 아이콘 리소스
│   ├── capabilities/       # Tauri 권한 설정
│   ├── Cargo.toml          # Rust 의존성
│   └── tauri.conf.json     # Tauri 설정
├── index.html              # HTML 엔트리
├── package.json            # 프론트엔드 의존성
├── vite.config.js          # Vite 설정
└── build.bat               # Windows 원클릭 빌드 스크립트
```

## 기술 스택

| 기술 | 용도 | 버전 |
|------|------|------|
| [Tauri](https://tauri.app/) | 데스크톱 앱 프레임워크 | 2.x |
| [Rust](https://www.rust-lang.org/) | 백엔드 코어 | 1.95+ |
| [Vite](https://vitejs.dev/) | 프론트엔드 빌드 도구 | 6.x |
| [Vanilla JS](https://developer.mozilla.org/en-US/docs/Web/JavaScript) | UI 렌더링 | ES6+ |

### Rust 핵심 의존성

| 의존성 | 용도 |
|--------|------|
| `arboard` | 클립보드 읽기/쓰기 |
| `tauri-plugin-global-shortcut` | 글로벌 단축키 |
| `tauri-plugin-autostart` | 자동 시작 |
| `tauri-plugin-single-instance` | 단일 인스턴스 잠금 |
| `tauri-plugin-opener` | 외부 링크 열기 |
| `reqwest` | HTTP 요청(버전 확인) |
| `windows` | Win32 API(SendInput으로 붙여넣기 시뮬레이션) |

## 개발 가이드

### 사전 요구 사항

- Node.js >= 18
- Rust >= 1.70 (`rustup`으로 설치)
- Windows 10/11

### 의존성 설치

```bash
cd clipboard-manager
npm install
```

### 개발 모드

```bash
# Tauri 개발 서버 시작(프론트엔드 핫 리로드 + Rust 자동 재컴파일)
npx tauri dev
```

### 빌드

```bash
# 원클릭 빌드(프론트엔드 + Rust 컴파일 + 설치 프로그램 패키징)
build.bat

# 또는 수동 빌드
npx tauri build
```

빌드 산출물은 `src-tauri/target/release/bundle/` 에 있습니다:
- `nsis/ClipMate_1.2.2_x64-setup.exe` — NSIS 설치 프로그램
- `msi/ClipMate_1.2.2_x64_en-US.msi` — MSI 설치 프로그램
- `../clipmate.exe` — 독립 실행 파일

## 데이터 저장

모든 데이터는 `%APPDATA%/clipmate/` 에 저장됩니다:

| 파일 / 디렉토리 | 설명 |
|----------------|------|
| `clipboard-history.json` | 클립보드 기록 + 고정 항목 |
| `settings.json` | 사용자 설정(레이아웃 모드, 최대 항목 수, 단축키 등) |
| `images/{id}.png` | 이미지 파일 저장(PNG 형식) |
| `debug.log` | 실행 로그(자동 순환, 최대 512KB) |

## 라이선스

[MIT](../LICENSE)
