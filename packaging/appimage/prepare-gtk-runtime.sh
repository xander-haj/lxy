#!/usr/bin/env bash
set -euo pipefail

appdir="${1:?Usage: prepare-gtk-runtime.sh APPDIR}"
multiarch="$(gcc -print-multiarch 2>/dev/null || dpkg-architecture -qDEB_HOST_MULTIARCH)"
lib_root="${appdir}/usr/lib/${multiarch}"

mkdir -p "${lib_root}" "${appdir}/usr/etc" "${appdir}/usr/share" "${appdir}/lib"

if [ ! -e "${appdir}/lib/${multiarch}" ]; then
  ln -s "../usr/lib/${multiarch}" "${appdir}/lib/${multiarch}"
fi

copy_file() {
  local source="$1"
  local destination="$2"

  if [ -e "${source}" ]; then
    install -Dm755 "${source}" "${destination}"
  fi
}

copy_tree() {
  local source="$1"
  local destination="$2"

  if [ -d "${source}" ]; then
    mkdir -p "$(dirname "${destination}")"
    cp -a "${source}" "${destination}"
  fi
}

copy_shared_object() {
  local source="$1"

  case "$(basename "${source}")" in
    ld-linux-*|libBrokenLocale.so.*|libanl.so.*|libc.so.*|libdl.so.*|libm.so.*)
      return
      ;;
    libmvec.so.*|libnsl.so.*|libpthread.so.*|libresolv.so.*|librt.so.*|libthread_db.so.*|libutil.so.*)
      return
      ;;
  esac

  if [ -e "${source}" ]; then
    cp -L "${source}" "${lib_root}/$(basename "${source}")"
  fi
}

copy_dependencies() {
  local target="$1"

  if [ ! -e "${target}" ]; then
    return
  fi

  ldd "${target}" |
    awk '/=> \// { print $3 } /^\// { print $1 }' |
    sort -u |
    while read -r dependency; do
      copy_shared_object "${dependency}"
    done
}

copy_matching_shared_objects() {
  local pattern="$1"
  local found=0

  for source in ${pattern}; do
    if [ -e "${source}" ]; then
      found=1
      copy_shared_object "${source}"
      copy_dependencies "${source}"
    fi
  done

  return 0
}

copy_webkit_runtime() {
  local api="$1"
  local helper_dir="/usr/lib/${multiarch}/webkit2gtk-${api}"

  copy_tree "${helper_dir}" "${lib_root}/webkit2gtk-${api}"
  copy_tree "/usr/libexec/webkit2gtk-${api}" "${appdir}/usr/libexec/webkit2gtk-${api}"
  copy_tree "/usr/share/webkitgtk-${api}" "${appdir}/usr/share/webkitgtk-${api}"

  if [ -d "${lib_root}/webkit2gtk-${api}" ]; then
    find "${lib_root}/webkit2gtk-${api}" -type f -perm -111 -print |
      while read -r helper; do
        copy_dependencies "${helper}"
      done
  fi
}

copy_matching_shared_objects "/usr/lib/${multiarch}/libwebkit2gtk-4.1.so"* || true
copy_matching_shared_objects "/usr/lib/${multiarch}/libjavascriptcoregtk-4.1.so"* || true
copy_matching_shared_objects "/usr/lib/${multiarch}/libwebkit2gtk-4.0.so"* || true
copy_matching_shared_objects "/usr/lib/${multiarch}/libjavascriptcoregtk-4.0.so"* || true
copy_matching_shared_objects "/usr/lib/${multiarch}/libgtk-3.so"* || true

copy_webkit_runtime "4.1"
copy_webkit_runtime "4.0"
copy_tree "/usr/lib/${multiarch}/girepository-1.0" "${lib_root}/girepository-1.0"
copy_tree "/usr/lib/${multiarch}/gtk-3.0" "${lib_root}/gtk-3.0"
copy_tree "/usr/lib/${multiarch}/gdk-pixbuf-2.0" "${lib_root}/gdk-pixbuf-2.0"
copy_tree "/etc/fonts" "${appdir}/usr/etc/fonts"
copy_tree "/usr/share/glib-2.0" "${appdir}/usr/share/glib-2.0"
copy_tree "/usr/share/fontconfig" "${appdir}/usr/share/fontconfig"

if command -v glib-compile-schemas >/dev/null 2>&1 && [ -d "${appdir}/usr/share/glib-2.0/schemas" ]; then
  glib-compile-schemas "${appdir}/usr/share/glib-2.0/schemas"
fi

for loader in "${lib_root}/gdk-pixbuf-2.0"/*/loaders/*.so; do
  if [ -e "${loader}" ]; then
    copy_dependencies "${loader}"
  fi
done

copy_file "/usr/bin/gdk-pixbuf-query-loaders" "${appdir}/usr/bin/gdk-pixbuf-query-loaders"
copy_dependencies "/usr/bin/gdk-pixbuf-query-loaders"
