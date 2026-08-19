from __future__ import annotations

import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
SOURCE_ROOT = ROOT / "accounting-agent" / "skills"
DEPLOY_ROOT = ROOT / "deploy"
BASE_DEPLOY_ROOT = WORKSPACE / "formal-accounting-release-2026-07-28" / "deploy"
FIXED_TIME = (2026, 8, 10, 0, 0, 0)


def zip_text(zf: zipfile.ZipFile, member: str) -> str:
    return zf.read(member).decode("utf-8")


def agent_metadata(skill_dir: Path) -> str:
    source = skill_dir / "agents" / "openai.yaml"
    if source.exists():
        return source.read_text(encoding="utf-8")

    base_zip = BASE_DEPLOY_ROOT / f"{skill_dir.name}.zip"
    if not base_zip.exists():
        raise RuntimeError(f"Missing agents/openai.yaml for {skill_dir.name}")
    with zipfile.ZipFile(base_zip) as zf:
        return zip_text(zf, "agents/openai.yaml")


def write_member(zf: zipfile.ZipFile, member: str, data: bytes) -> None:
    info = zipfile.ZipInfo(member, FIXED_TIME)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    zf.writestr(info, data)


def package_skill(skill_dir: Path) -> Path:
    skill_file = skill_dir / "SKILL.md"
    if not skill_file.exists():
        raise RuntimeError(f"Missing SKILL.md in {skill_dir}")

    DEPLOY_ROOT.mkdir(parents=True, exist_ok=True)
    destination = DEPLOY_ROOT / f"{skill_dir.name}.zip"
    temporary = DEPLOY_ROOT / f".{skill_dir.name}.zip.tmp"

    with zipfile.ZipFile(temporary, "w") as zf:
        write_member(zf, "SKILL.md", skill_file.read_bytes())
        write_member(zf, "agents/openai.yaml", agent_metadata(skill_dir).encode("utf-8"))
        reference_root = skill_dir / "references"
        if reference_root.exists():
            for path in sorted(reference_root.rglob("*")):
                if path.is_file():
                    member = path.relative_to(skill_dir).as_posix()
                    write_member(zf, member, path.read_bytes())

    temporary.replace(destination)
    return destination


def main() -> None:
    skill_dirs = sorted(path for path in SOURCE_ROOT.iterdir() if path.is_dir())
    packaged = [package_skill(skill_dir) for skill_dir in skill_dirs]
    print(f"Packaged {len(packaged)} Accounting Agent Skills:")
    for path in packaged:
        print(f"- {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
