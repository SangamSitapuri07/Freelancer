#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="$(node -p 'require("./package.json").version')"
OUT_DIR="dist"
OUT_NAME="ghostgate-${VERSION}"
OUT_PATH="${OUT_DIR}/${OUT_NAME}"

rm -rf "${OUT_PATH}" "${OUT_DIR}/ghostgate-${VERSION}.zip"
mkdir -p "${OUT_PATH}"

cp -R src public scripts docs test \
  "${OUT_PATH}/"

cp package.json package-lock.json .env.example Dockerfile docker-compose.yml \
  render.yaml README.md THREAT_MODEL.md LICENSE start.sh start.bat \
  "${OUT_PATH}/"

chmod +x "${OUT_PATH}/start.sh"

cd "${OUT_DIR}"
zip -r "ghostgate-${VERSION}.zip" "${OUT_NAME}" >/dev/null

echo "Created dist/ghostgate-${VERSION}.zip"
