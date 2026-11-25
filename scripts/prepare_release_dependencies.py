# Copyright (c) 2026 Workflow Controller Contributors
#
# Licensed under the MIT License (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://opensource.org/licenses/MIT
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Embed the locked axcor release wheels in the distribution metadata."""

import json
import re
import subprocess
import tomllib
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

AXCOR_REPOSITORY = "guixu-labs/axcor"
AXCOR_GIT = f"https://github.com/{AXCOR_REPOSITORY}.git"


def release_assets(tag: str, commit: str) -> dict:
    """Read wheel assets after checking the release tag against the locked commit."""
    tag_ref = f"refs/tags/{tag}"
    refs = subprocess.check_output(
        ["git", "ls-remote", AXCOR_GIT, tag_ref, tag_ref + "^{}"], text=True, timeout=60
    )
    commits = {ref: sha for sha, ref in (line.split() for line in refs.splitlines())}
    resolved = commits.get(tag_ref + "^{}", commits.get(tag_ref))
    if resolved is None:
        raise SystemExit(f"axcor tag {tag} does not exist")
    if resolved != commit:
        raise SystemExit(f"axcor tag {tag} resolves to {resolved}, not locked commit {commit}")

    release = subprocess.check_output(
        ["gh", "release", "view", tag, "--repo", AXCOR_REPOSITORY, "--json", "assets,isDraft"],
        text=True,
        timeout=60,
    )
    metadata = json.loads(release)
    if metadata["isDraft"]:
        raise SystemExit(f"axcor release {tag} has not been published")
    return {asset["name"]: asset for asset in metadata["assets"] if asset["state"] == "uploaded"}


def main() -> None:
    """Rewrite the release checkout's requirements using verified axcor wheel URLs."""
    project_file = Path("pyproject.toml")
    project_text = project_file.read_text(encoding="utf-8")
    project = tomllib.loads(project_text)
    lock = tomllib.loads(Path("uv.lock").read_text(encoding="utf-8"))
    axcor_lock = Path("axcor.lock").read_text(encoding="utf-8")
    commit = next(
        line.split()[1] for line in axcor_lock.splitlines() if line.startswith("axcor_sha: ")
    )
    sources = {
        name: source
        for name, source in project["tool"]["uv"]["sources"].items()
        if source.get("git") == AXCOR_GIT
    }
    tags = {source.get("tag") for source in sources.values()}
    if len(tags) != 1 or None in tags:
        raise SystemExit("All axcor dependencies must use the same release tag")
    (tag,) = tags
    assets = release_assets(tag, commit)
    wheels = {}
    for package in lock["package"]:
        name = package["name"]
        if name not in sources:
            continue
        git_url = urlsplit(package["source"]["git"])
        if git_url.fragment != commit or parse_qs(git_url.query).get("tag") != [tag]:
            raise SystemExit(f"uv.lock does not pin {name} to axcor {tag} at {commit}")
        filename = f"{name.replace('-', '_')}-{package['version']}-py3-none-any.whl"
        asset = assets.get(filename)
        digest = (asset or {}).get("digest") or ""
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
            raise SystemExit(f"axcor {tag} is missing {filename} or its SHA-256 digest")
        wheels[name] = f"{name} @ {asset['url']}#{digest.replace(':', '=')}"
    if wheels.keys() != sources.keys():
        raise SystemExit("uv.lock is missing one or more axcor dependencies")

    requirements = []
    for requirement in project["project"]["dependencies"]:
        name = re.split(r"[\s<>=!~;\[]", requirement, maxsplit=1)[0]
        dependency = wheels.pop(name, requirement)
        project_text = project_text.replace(json.dumps(requirement), json.dumps(dependency), 1)
        requirements.append(dependency)
    if wheels or tomllib.loads(project_text)["project"]["dependencies"] != requirements:
        raise SystemExit("Could not encode all axcor wheels in project.dependencies")
    project_file.write_text(project_text, encoding="utf-8")


if __name__ == "__main__":
    main()
