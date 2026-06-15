#!/usr/bin/env bash
set -euo pipefail

toolkit_root="${TOOLKIT_ROOT:-bundled-tools/linux}"
minimum_bytes="${MINIMUM_BYTES:-50000000}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
tool_root="${repo_root}/${toolkit_root}"

required_paths=(
  "cc"
  "zig/zig"
  "zig/lib"
)

for relative in "${required_paths[@]}"; do
  path="${tool_root}/${relative}"
  if [ ! -e "${path}" ]; then
    echo "Linux AppImage toolchain is missing required path: ${relative}" >&2
    exit 1
  fi
done

if [ ! -x "${tool_root}/cc" ] || [ ! -x "${tool_root}/zig/zig" ]; then
  echo "Linux AppImage toolchain compiler files are not executable." >&2
  exit 1
fi

total_bytes="$(find "${tool_root}" -type f -printf '%s\n' | awk '{sum += $1} END {print sum + 0}')"

if [ "${total_bytes}" -lt "${minimum_bytes}" ]; then
  echo "Linux AppImage toolchain is too small (${total_bytes} bytes). It was probably not downloaded." >&2
  exit 1
fi

echo "Linux AppImage toolchain total bytes: ${total_bytes}"
echo "Linux AppImage compiler: ${tool_root}/cc"
