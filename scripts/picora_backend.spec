# -*- mode: python ; coding: utf-8 -*-
"""CPU専用onedirビルド。JITキャッシュのためes_simはPythonソースとして収録。"""
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules

root = Path(SPECPATH).parent
analysis = Analysis(
    [str(root / "scripts" / "backend_entry.py")],
    pathex=[str(root / "backend")],
    hiddenimports=["numba", "llvmlite", *collect_submodules("es_sim"), *collect_submodules("uvicorn")],
    excludes=["tkinter", "matplotlib", "PIL", "IPython", "pytest", "numba.tests", "llvmlite.tests", "numpy.tests", "scipy.tests"],
    module_collection_mode={"es_sim": "py"},
    noarchive=False,
)
pyz = PYZ(analysis.pure)
exe = EXE(
    pyz, analysis.scripts, [("X utf8", None, "OPTION")],
    exclude_binaries=True, name="picora-backend", debug=False,
    bootloader_ignore_signals=False, strip=False, upx=False, console=True,
)
collection = COLLECT(exe, analysis.binaries, analysis.datas, strip=False, upx=False, name="picora-backend")
