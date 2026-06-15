# Bundled Tools

This directory is packaged with the Python launcher. The Windows release workflow
fills `windows/` with portable Git, Python, TCC, and SDL2 before building the
installer.

The Linux AppImage release workflow fills `linux/` with a Zig-based `cc` wrapper
before PyInstaller runs. Flatpak does not package that generated Linux compiler;
it uses the Flatpak SDK/runtime toolchain instead.

The generated binaries are intentionally not committed to source control.
