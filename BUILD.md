# Build Guide

## One-Click Build (Recommended)

After cloning or downloading this project, simply double-click `build.bat` in the root directory. The script handles everything automatically:

1. Checks Node.js environment
2. Checks npm
3. Installs project dependencies (`npm install`)
4. Builds frontend and packages Electron installer (`npm run pack`)

The installer will be generated at `dist-electron\ClipMate Setup 1.0.0.exe`.

## Prerequisites

- **Node.js** v18 or later: https://nodejs.org/
- **npm** (included with Node.js)
- Windows 10/11

## Troubleshooting

### "Node.js not found"

Install Node.js from https://nodejs.org/ and make sure to check **"Add to PATH"** during installation. Then restart your file explorer and try again.

### npm install fails or is too slow

Set a China mirror:

```bash
npm config set registry https://registry.npmmirror.com
```

Then double-click `build.bat` again.

### Electron binary download fails

Set an Electron mirror:

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

Then double-click `build.bat` again.

### Antivirus false positive

Electron-packaged apps may occasionally be flagged by Windows Defender. This is a known issue. Try adding the `dist-electron\` folder to the exclusion list.

## Manual Build

```bash
# 1. Install dependencies
npm install

# 2. Build frontend + package installer
npm run pack
```

## Output

| File | Path | Description |
|------|------|-------------|
| Installer | `dist-electron/ClipMate Setup 1.0.0.exe` | Windows NSIS installer |
| Portable | `dist-electron/win-unpacked/ClipMate.exe` | Can run without installation |
