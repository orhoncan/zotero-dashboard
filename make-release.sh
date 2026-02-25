#!/usr/bin/env bash
set -euo pipefail

APP_NAME="orhons-zotero-dashboard"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<USAGE
Usage:
  ./make-release.sh <version>

Examples:
  ./make-release.sh 0.0.2
  ./make-release.sh v0.0.3

What it does:
  1) Creates/updates tag v<version> at current HEAD
  2) Builds clean zip via git archive
  3) Creates a short release notes template file
USAGE
}

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git not found" >&2
  exit 1
fi

if ! git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: not a git repository: $SCRIPT_DIR" >&2
  echo "Run this script from the release repo clone." >&2
  exit 1
fi

raw_version="${1}"
version="${raw_version#v}"
tag="v${version}"
zip_file="${APP_NAME}-${version}.zip"
notes_file="RELEASE_NOTES_${version}.md"

cd "$SCRIPT_DIR"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Warning: working tree is not clean. Continuing with current HEAD."
fi

current_commit="$(git rev-parse --short HEAD)"
git tag -f "$tag"

git archive \
  --format=zip \
  --output="$zip_file" \
  --prefix="${APP_NAME}/" \
  "$tag"

cat > "$notes_file" <<NOTES
## Orhon's Zotero Dashboard ${tag}

- AI analysis flow: stability and speed improvements.
- UI/UX: refinements for chat, context, and notes workflow.
- Integration: Zotero/CLI/Obsidian reliability updates.

Build:
- Tag: ${tag}
- Commit: ${current_commit}
- Artifact: ${zip_file}
NOTES

echo "Done."
echo "Tag:       ${tag}"
echo "Commit:    ${current_commit}"
echo "Artifact:  ${SCRIPT_DIR}/${zip_file}"
echo "Notes:     ${SCRIPT_DIR}/${notes_file}"
echo
echo "Next steps:"
echo "  1) git push origin main"
echo "  2) git push origin ${tag} --force"
echo "  3) Upload ${zip_file} to GitHub Release"
