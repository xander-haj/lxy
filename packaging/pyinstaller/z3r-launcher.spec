# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path


root = Path.cwd()
datas = [
    (str(root / "src"), "src"),
    (str(root / "resources"), "resources"),
    (str(root / "bundled-tools"), "bundled-tools"),
]
icon = root / "resources" / "icons" / "icon.ico"

a = Analysis(
    [str(root / "packaging" / "pyinstaller" / "z3r_launcher_entry.py")],
    pathex=[str(root)],
    binaries=[],
    datas=datas,
    hiddenimports=["tkinter", "tkinter.filedialog"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
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
    icon=str(icon) if icon.is_file() else None,
)
