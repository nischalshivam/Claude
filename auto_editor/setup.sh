#!/usr/bin/env bash
# One-time setup for Auto Editor (macOS/Linux).
set -e
cd "$(dirname "$0")"
python3 -m pip install --upgrade pip
python3 -m pip install Pillow
python3 -m pip install faster-whisper || echo "NOTE: faster-whisper failed; tool falls back to weighted timing."
if ! command -v ffprobe >/dev/null; then
  echo "Install ffmpeg with your package manager (e.g. brew install ffmpeg / apt install ffmpeg)"
fi
echo "Setup complete. Run: ./run.sh"
