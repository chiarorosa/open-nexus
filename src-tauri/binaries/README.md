# binaries/

This directory contains Nexus sidecar binaries that are bundled with the app.

## Whisper (STT)

Place the compiled `whisper` binary here.
- Windows: `whisper-x86_64-pc-windows-msvc.exe`
- macOS: `whisper-aarch64-apple-darwin` / `whisper-x86_64-apple-darwin`

Tauri expects the binary to follow the naming convention:
`{name}-{target_triple}[.exe]`

See: TECHNICAL_SCOPE §10 — Sidecar Strategy
See: src-tauri/tauri.conf.json → bundle.externalBin

## Building Whisper

```bash
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
make -j
# Copy the resulting binary to this directory
```
