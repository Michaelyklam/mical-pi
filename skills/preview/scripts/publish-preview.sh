#!/bin/sh
set -eu

PREVIEW_ROOT=${PREVIEW_ROOT:-/home/michael/personal-website-data/preview}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-https://michaelyklam.me/preview}
PREVIEW_MAX_SIZE_KIB=${PREVIEW_MAX_SIZE_KIB:-262144}

usage() {
  echo "Usage: $0 <artifact-directory>" >&2
  exit 2
}

[ "$#" -eq 1 ] || usage
source_dir=$1

if [ ! -d "$source_dir" ] || [ -L "$source_dir" ]; then
  echo "Artifact path must be a directory, not a symlink: $source_dir" >&2
  exit 1
fi
if [ ! -f "$source_dir/index.html" ] || [ -L "$source_dir/index.html" ]; then
  echo "Artifact must contain a regular index.html" >&2
  exit 1
fi

unsafe_entry=$(find "$source_dir" -mindepth 1 ! -type f ! -type d -print -quit)
if [ -n "$unsafe_entry" ]; then
  echo "Artifact contains a symlink or non-file entry: $unsafe_entry" >&2
  exit 1
fi

case "$PREVIEW_MAX_SIZE_KIB" in
  ''|*[!0-9]*)
    echo "PREVIEW_MAX_SIZE_KIB must be a positive whole number" >&2
    exit 1
    ;;
esac
if [ "$PREVIEW_MAX_SIZE_KIB" -eq 0 ]; then
  echo "PREVIEW_MAX_SIZE_KIB must be greater than zero" >&2
  exit 1
fi

mkdir -p "$PREVIEW_ROOT/.staging"
staging=
owns_staging=false
cleanup() {
  if [ "$owns_staging" = true ] && [ -n "$staging" ]; then
    rm -rf -- "$staging"
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

while true; do
  preview_id=$(openssl rand -base64 16 | tr '+/' '-_' | tr -d '=\n')
  staging="$PREVIEW_ROOT/.staging/$preview_id"
  if [ ! -e "$PREVIEW_ROOT/$preview_id" ] && mkdir "$staging" 2>/dev/null; then
    owns_staging=true
    break
  fi
done

cp -a -- "$source_dir/." "$staging/"

unsafe_entry=$(find "$staging" -mindepth 1 ! -type f ! -type d -print -quit)
if [ -n "$unsafe_entry" ]; then
  echo "Staged artifact contains a symlink or non-file entry: $unsafe_entry" >&2
  exit 1
fi

size_kib=$(du -sk "$staging" | awk '{print $1}')
if [ "$size_kib" -gt "$PREVIEW_MAX_SIZE_KIB" ]; then
  echo "Artifact is ${size_kib} KiB; limit is ${PREVIEW_MAX_SIZE_KIB} KiB" >&2
  exit 1
fi

# Cleanup uses this directory timestamp as the publication time.
touch "$staging"
mv -T -- "$staging" "$PREVIEW_ROOT/$preview_id"
owns_staging=false
trap - EXIT HUP INT TERM

printf '%s/%s/\n' "${PUBLIC_BASE_URL%/}" "$preview_id"
