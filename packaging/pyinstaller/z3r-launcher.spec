# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller packaging recipe for the standalone Z3R Launcher desktop executable."""

import os
from pathlib import Path
import sys

import certifi
from PyInstaller.utils.hooks import collect_all, collect_submodules


root = Path.cwd()
linux = sys.platform.startswith("linux")
REEXEC_ENV = "Z3R_LAUNCHER_PYINSTALLER_REEXEC"
SPEC_PATH = root / "packaging" / "pyinstaller" / "z3r-launcher.spec"
LINUX_PACKAGING_PYTHON = root / ".packaging-venv" / "bin" / "python"

LINUX_GTK_HIDDEN_IMPORTS = [
    "gi",
    "gi._gi",
    "gi._option",
    "gi.repository",
    "gi.repository.Gdk",
    "gi.repository.Gio",
    "gi.repository.GLib",
    "gi.repository.GObject",
    "gi.repository.Gtk",
    "gi.repository.Soup",
    "gi.repository.WebKit2",
]
LINUX_QT_EXCLUDES = [
    "PyQt5",
    "PyQt6",
    "PySide2",
    "PySide6",
    "qtpy",
    "webview.platforms.qt",
]
LINUX_WEBVIEW_SUBMODULE_EXCLUDES = [
    "webview.platforms.android",
    "webview.platforms.qt",
]


def include_webview_submodule(name):
    """Return True when a pywebview submodule belongs in the frozen launcher."""
    if not linux:
        return True
    return not any(
        name == excluded or name.startswith(f"{excluded}.") for excluded in LINUX_WEBVIEW_SUBMODULE_EXCLUDES
    )


def reexec_with_linux_packaging_python():
    """Restart PyInstaller with the system-Python venv when an older workflow uses hosted Python."""
    if not linux or os.environ.get(REEXEC_ENV) or not LINUX_PACKAGING_PYTHON.is_file():
        return

    try:
        current_python = Path(sys.executable).resolve()
        packaging_python = LINUX_PACKAGING_PYTHON.resolve()
    except OSError:
        current_python = Path(sys.executable)
        packaging_python = LINUX_PACKAGING_PYTHON

    if current_python == packaging_python:
        return

    os.environ[REEXEC_ENV] = "1"
    os.execv(
        str(packaging_python),
        [str(packaging_python), "-m", "PyInstaller", "--clean", str(SPEC_PATH)],
    )


def require_linux_gtk_stack():
    """Fail the Linux release build unless GTK/WebKitGTK imports match pywebview's GTK backend."""
    try:
        import gi

        gi.require_version("Gtk", "3.0")
        gi.require_version("Gdk", "3.0")
        try:
            gi.require_version("WebKit2", "4.1")
            gi.require_version("Soup", "3.0")
        except ValueError:
            gi.require_version("WebKit2", "4.0")
            gi.require_version("Soup", "2.4")
    except (ImportError, ValueError) as error:
        message = (
            "Linux PyInstaller builds require PyGObject, GTK 3, and WebKitGTK 4.1 or 4.0. "
            "Run the Linux build with .packaging-venv/bin/python created from /usr/bin/python3."
        )
        raise SystemExit(message) from error


hiddenimports = ["tkinter", "tkinter.filedialog", "certifi"]
hiddenimports += collect_submodules("webview", filter=include_webview_submodule)
binaries = []
datas = [
    (str(root / "src"), "src"),
    (str(root / "resources"), "resources"),
    (certifi.where(), "certifi"),
]
excludes = []

if linux:
    reexec_with_linux_packaging_python()
    require_linux_gtk_stack()
    gi_datas, gi_binaries, gi_hiddenimports = collect_all("gi", on_error="raise")
    datas += gi_datas
    binaries += gi_binaries
    hiddenimports += gi_hiddenimports + LINUX_GTK_HIDDEN_IMPORTS
    excludes += LINUX_QT_EXCLUDES

hiddenimports = list(dict.fromkeys(hiddenimports))
excludes = list(dict.fromkeys(excludes))

if sys.platform == "darwin":
    icon = root / "resources" / "icons" / "icon.icns"
elif sys.platform == "win32":
    icon = root / "resources" / "icons" / "icon.ico"
else:
    icon = None

a = Analysis(
    [str(root / "packaging" / "pyinstaller" / "z3r_launcher_entry.py")],
    pathex=[str(root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="z3r-launcher",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(icon) if icon and icon.is_file() else None,
)

if sys.platform == "darwin":
    app = BUNDLE(
        exe,
        name="Z3R Launcher.app",
        icon=str(icon) if icon and icon.is_file() else None,
        bundle_identifier="io.github.xander_haj.Z3RLauncher",
    )
