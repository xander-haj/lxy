#!/usr/bin/env bash
set -euo pipefail

output_root="${OUTPUT_ROOT:-bundled-tools/linux}"
zig_version="${ZIG_VERSION:-0.13.0}"
zig_url="${ZIG_URL:-https://ziglang.org/download/${zig_version}/zig-linux-x86_64-${zig_version}.tar.xz}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
tool_root="${repo_root}/${output_root}"
download_root="${tool_root}/_downloads"
archive="${download_root}/zig-linux-x86_64-${zig_version}.tar.xz"

rm -rf "${tool_root}"
mkdir -p "${download_root}"

curl \
  --fail \
  --location \
  --show-error \
  --connect-timeout 30 \
  --max-time 900 \
  --retry 4 \
  --retry-delay 5 \
  --retry-max-time 900 \
  --output "${archive}" \
  "${zig_url}"

tar -xJf "${archive}" -C "${download_root}"
zig_dir="$(find "${download_root}" -maxdepth 1 -type d -name 'zig-linux-x86_64-*' | head -n 1)"

if [ -z "${zig_dir}" ] || [ ! -x "${zig_dir}/zig" ]; then
  echo "Downloaded Zig archive did not contain an executable zig binary." >&2
  exit 1
fi

mv "${zig_dir}" "${tool_root}/zig"

cat > "${tool_root}/cc" <<'EOF'
#!/usr/bin/env sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "${script_dir}/zig/zig" cc "$@"
EOF

chmod +x "${tool_root}/cc" "${tool_root}/zig/zig"
rm -rf "${download_root}"

for required in "${tool_root}/cc" "${tool_root}/zig/zig" "${tool_root}/zig/lib"; do
  if [ ! -e "${required}" ]; then
    echo "Linux toolchain is missing required path: ${required}" >&2
    exit 1
  fi
done

echo "Linux AppImage compiler prepared at ${tool_root}/cc"
