"""/api/files/list must keep the project's own files when extra_dirs are big.

Regression: extra-dir files are absolute (`/data/...`) and used to be sorted
together with the project's relative paths before the 20k cap. `/` sorts
before every letter, so a large extra dir filled the whole budget and the
project's files (e.g. every tracked .php) vanished from the quick switcher.
"""
import asyncio

from painapple_code.routes import api_files


def test_project_files_survive_large_extra_dir(tmp_path, monkeypatch):
    proj = tmp_path / "proj"
    extra = tmp_path / "data"
    proj.mkdir()
    extra.mkdir()

    async def fake_enum(directory, include_ignored=False):
        if directory == proj.resolve():
            return ["src/index.php", "app/Kernel.php"], False
        return [f"f{i:05d}.html" for i in range(25_000)], False

    monkeypatch.setattr(api_files, "_enumerate_files", fake_enum)
    monkeypatch.setattr(api_files.paths, "load_global_config", lambda: {"extra_dirs": [str(extra)]})
    monkeypatch.setattr(api_files.paths, "get_project_config_path", lambda _p: tmp_path / "missing.json")

    res = asyncio.run(api_files.list_project_files(cwd=str(proj)))

    assert res["files"][:2] == ["app/Kernel.php", "src/index.php"]
    assert len(res["files"]) == 20_000
    assert res["files"][2].startswith(str(extra.resolve()) + "/")
    assert res["total"] == 25_002
    assert res["truncated"] is True
