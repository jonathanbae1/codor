#!/usr/bin/env bash
set -Eeuo pipefail

# harn:assume verified-commit-installers-are-sha-addressed-and-ephemeral ref=shared-release-artifact-builder
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$ROOT/release-artifacts}"
if [[ "$OUT_DIR" != /* ]]; then
  OUT_DIR="$ROOT/$OUT_DIR"
fi
case "$OUT_DIR" in
  "$ROOT"|"$ROOT/"|"/"|"/tmp"|"/var/tmp")
    printf 'refusing unsafe release artifact directory: %s\n' "$OUT_DIR" >&2
    exit 2
    ;;
esac

VERSION="$(cd "$ROOT" && node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version")"
TGZ_NAME="richhardry-codor-$VERSION.tgz"
VSIX_NAME="codor-copilot-bridge-$VERSION.vsix"
EXTENSION_DIR="$ROOT/packages/adapters/copilot/vscode-extension"
INSPECT_DIR=''

cleanup() {
  if [[ -n "$INSPECT_DIR" ]]; then
    rm -rf -- "$INSPECT_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

rm -rf -- "$OUT_DIR"
mkdir -p "$OUT_DIR"

cd "$ROOT"
pnpm build:artifact

PACKED_NAME="$(cd artifact/codor && npm pack --pack-destination "$OUT_DIR" | tail -n 1 | tr -d '\r')"
if [[ "$PACKED_NAME" != "$TGZ_NAME" || ! -s "$OUT_DIR/$TGZ_NAME" ]]; then
  printf 'unexpected public package output: %s (expected %s)\n' "$PACKED_NAME" "$TGZ_NAME" >&2
  exit 1
fi

pnpm --dir "$EXTENSION_DIR" build
(cd "$EXTENSION_DIR" && pnpm dlx @vscode/vsce@3.6.0 package \
  --no-dependencies \
  --allow-missing-repository \
  --skip-license \
  --out "$OUT_DIR/$VSIX_NAME")
test -s "$OUT_DIR/$VSIX_NAME"

INSPECT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codor-release-artifacts.XXXXXX")"
tar -xzf "$OUT_DIR/$TGZ_NAME" -C "$INSPECT_DIR"
node --input-type=module - "$INSPECT_DIR/package/package.json" "$VERSION" <<'NODE'
import { readFileSync } from 'node:fs';

const [manifestPath, expectedVersion] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.name !== '@richhardry/codor') throw new Error('staged TGZ has the wrong public name');
if (manifest.version !== expectedVersion) throw new Error('staged TGZ has the wrong version');
if (manifest.repository?.url !== 'https://github.com/rjx18/codor') {
  throw new Error('staged TGZ has the wrong repository URL');
}
if (manifest.private !== undefined) throw new Error('staged TGZ must not remain private');
NODE

unzip -p "$OUT_DIR/$VSIX_NAME" extension/package.json > "$INSPECT_DIR/extension-package.json"
node --input-type=module - "$INSPECT_DIR/extension-package.json" "$VERSION" <<'NODE'
import { readFileSync } from 'node:fs';

const [manifestPath, expectedVersion] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.name !== 'codor-copilot-bridge') throw new Error('VSIX has the wrong extension name');
if (manifest.version !== expectedVersion) throw new Error('VSIX has the wrong version');
NODE

(cd "$OUT_DIR" && sha256sum "$TGZ_NAME" "$VSIX_NAME" > SHA256SUMS && sha256sum -c SHA256SUMS)

printf 'release artifacts: %s/%s, %s/%s, SHA256SUMS\n' \
  "$OUT_DIR" "$TGZ_NAME" "$OUT_DIR" "$VSIX_NAME"
# harn:end verified-commit-installers-are-sha-addressed-and-ephemeral
