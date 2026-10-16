#!/usr/bin/env python3
"""infra/gcp/cloudbuild-deploy.yaml without Google: parsed, its substitutions resolved the way Cloud Build resolves them,
and its steps run in order against the stub docker, gcloud and curl in infra/gcp/test/stub (nothing is built, pushed or
deployed). The deploy step really runs scripts/deploy-gcp.sh, so the images the file pushes are compared with the images
the script deploys.
usage: infra/gcp/test/cloudbuild-deploy.test.py [repo root]
Needs PyYAML (in uv.lock: `uv run python infra/gcp/test/cloudbuild-deploy.test.py`); without it this fails, never skips."""

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[3]).resolve()
CFG = ROOT / "infra/gcp/cloudbuild-deploy.yaml"
STUB = ROOT / "infra/gcp/test/stub"
failed = False


def check(name: str, ok: bool, detail: str = "") -> bool:
    global failed
    print(f"PASS  {name}" if ok else f"FAIL  {name}" + (f": {detail}" if detail else ""))
    failed |= not ok
    return ok


try:
    import yaml
except ImportError:
    check("PyYAML is importable", False, "run it with `uv run python` or install pyyaml")
    sys.exit(1)

try:
    cfg = yaml.safe_load(CFG.read_text())
    parsed = isinstance(cfg, dict) and isinstance(cfg.get("steps"), list) and len(cfg["steps"]) > 0
except (OSError, yaml.YAMLError) as e:
    cfg, parsed = None, False
    print(f"      {type(e).__name__}: {str(e).splitlines()[0]}")
if not check("parses as YAML with a list of steps", parsed):
    sys.exit(1)

steps = cfg["steps"]
ids = [s.get("id") for s in steps]
by_id = {s["id"]: s for s in steps if s.get("id")}

# ---- static checks ------------------------------------------------------------------------------------------------
KEYS = {
    "steps",
    "images",
    "availableSecrets",
    "substitutions",
    "timeout",
    "options",
    "tags",
    "artifacts",
    "serviceAccount",
    "logsBucket",
    "queueTtl",
}
check("top-level keys are Cloud Build's", set(cfg) <= KEYS, f"unknown: {sorted(set(cfg) - KEYS)}")
opts = cfg.get("options") or {}
check("logging is CLOUD_LOGGING_ONLY", opts.get("logging") == "CLOUD_LOGGING_ONLY", str(opts.get("logging")))
m = re.fullmatch(r"(\d+)s", str(cfg.get("timeout", "")))
check("a timeout over the 10-minute default and at most an hour", bool(m) and 600 < int(m.group(1)) <= 3600, str(cfg.get("timeout")))
check("a machine type is set", bool(opts.get("machineType")))
check(
    "every step has a name and a unique id", all(s.get("name") for s in steps) and None not in ids and len(set(ids)) == len(ids), str(ids)
)

waits_ok = True
for i, s in enumerate(steps):
    for w in s.get("waitFor", []):
        waits_ok &= w == "-" or w in ids[:i]
check("every waitFor names an earlier step", waits_ok)


def deps(i: int) -> set[str]:
    """What step i waits for, as Cloud Build reads it: no waitFor means every earlier step; '-' means none."""
    w = steps[i].get("waitFor")
    return set(ids[:i]) if w is None else {x for x in w if x != "-"}


def ancestors(sid: str) -> set[str]:
    out, todo = set(), [sid]
    while todo:
        for d in deps(ids.index(todo.pop())):
            if d not in out:
                out.add(d)
                todo.append(d)
    return out


# Every $NAME Cloud Build would substitute: a declared user substitution (_X) or a built-in of a triggered build.
BUILTIN = {
    "PROJECT_ID",
    "PROJECT_NUMBER",
    "BUILD_ID",
    "LOCATION",
    "TRIGGER_NAME",
    "COMMIT_SHA",
    "REVISION_ID",
    "SHORT_SHA",
    "REPO_NAME",
    "REPO_FULL_NAME",
    "BRANCH_NAME",
    "TAG_NAME",
    "REF_NAME",
    "SERVICE_ACCOUNT_EMAIL",
    "SERVICE_ACCOUNT",
}
DOLLAR = re.compile(r"\$(\$|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*)|)")
declared = set((cfg.get("substitutions") or {}).keys())


def strings(x):
    if isinstance(x, str):
        yield x
    elif isinstance(x, dict):
        for k, v in x.items():
            if k != "substitutions":
                yield from strings(v)
    elif isinstance(x, list):
        for v in x:
            yield from strings(v)


used, bad = set(), []
for text in strings(cfg):
    for mm in DOLLAR.finditer(text):
        if mm.group(1) == "$":
            continue
        name = mm.group(2) or mm.group(3)
        if not name:
            bad.append(f"a lone $ in {text[max(0, mm.start() - 20) : mm.end() + 20]!r} (a shell $ is written $$)")
        elif name.startswith("_"):
            used.add(name)
            if name not in declared:
                bad.append(f"${name} is not declared under substitutions")
        elif name not in BUILTIN:
            bad.append(f"${name} is not a built-in substitution (a shell variable is written $${name})")
check("every $NAME is a declared _X or a built-in, shell variables are $$", not bad, "; ".join(bad[:3]))
check("every declared substitution is used", declared <= used, f"unused: {sorted(declared - used)}")

dockerfiles = set(re.findall(r"infra/gcp/docker/[\w.-]+\.Dockerfile\b", "\n".join(strings(cfg))))
missing = [d for d in sorted(dockerfiles) if not (ROOT / d).is_file() or not (ROOT / f"{d}.dockerignore").is_file()]
check("every Dockerfile it names exists, with its .dockerignore", bool(dockerfiles) and not missing, f"missing: {missing}")
every = {str(p.relative_to(ROOT)) for p in (ROOT / "infra/gcp/docker").glob("*.Dockerfile")}
check("it builds every Dockerfile in infra/gcp/docker", every == dockerfiles, f"not built: {sorted(every - dockerfiles)}")

# The script as an argument of its own, not inside another step's message.
deploy_steps = [s for s in steps if "scripts/deploy-gcp.sh" in map(str, s.get("args", []))]
args = [str(a) for a in deploy_steps[0].get("args", [])] if len(deploy_steps) == 1 else []
tag_ok = any(a == "--tag" and b == "$SHORT_SHA" for a, b in zip(args, args[1:], strict=False)) or "--tag=$SHORT_SHA" in args
check(
    "one deploy step: scripts/deploy-gcp.sh --skip-build --tag $SHORT_SHA",
    len(deploy_steps) == 1 and "--skip-build" in args and tag_ok,
    str(args),
)
check(
    "the deploy step runs bash in a Google Cloud SDK image",
    bool(deploy_steps) and deploy_steps[0].get("entrypoint") == "bash" and "cloudsdktool" in deploy_steps[0].get("name", ""),
    str(deploy_steps[0].get("name") if deploy_steps else None),
)
push_ids = [s["id"] for s in steps if (s.get("args") or [None])[0] == "push"]
before = ancestors(deploy_steps[0]["id"]) if deploy_steps else set()
check(
    "the deploy step waits for every push and every build",
    bool(push_ids) and set(push_ids) <= before and all(ancestors(p) <= before for p in push_ids),
    f"not waited for: {sorted(set(push_ids) - before)}",
)
check("every build waits for the check step", all("check" in ancestors(s["id"]) for s in steps if s["id"] != "check"))

# ---- the steps, run --------------------------------------------------------------------------------------------------
PROJECT, NUMBER, SHA = "demo-proj", "123456789012", "abc1234"  # NUMBER is what the stub gcloud answers for the project
TENANT = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b"
KEY = "sfkey-test-123"  # what the stub gcloud answers for a secret; the build's secretEnv gets the same
newest = max(int(p.name[:4]) for p in (ROOT / "db/migrations").glob("[0-9][0-9][0-9][0-9]_*.sql"))
HEALTH = '{"status":"ok","migration_version":%d,"idp":"identity-platform"}'
secret_env = {e["env"]: KEY for e in (cfg.get("availableSecrets") or {}).get("secretManager", [])}


def subst(text: str, values: dict[str, str]) -> str:
    return DOLLAR.sub(lambda mm: "$" if mm.group(1) == "$" else values.get(mm.group(2) or mm.group(3) or "", ""), text)


def build_run(tenant: str = TENANT, sha: str = SHA, health: str = HEALTH % newest) -> dict:
    """Runs every step in file order (a valid order: each waits only for earlier steps) until one fails, as Cloud Build
    stops a build at its first failed step. Returns the stubs' logs and which step failed."""
    values = {"PROJECT_ID": PROJECT, "PROJECT_NUMBER": NUMBER, "SHORT_SHA": sha, "COMMIT_SHA": sha, "_DEMO_TENANT_ID": tenant}
    with tempfile.TemporaryDirectory() as tmp:
        logs = {n: Path(tmp, n) for n in ("gcloud", "docker", "curl")}
        for p in logs.values():
            p.touch()
        failed_step, out = None, ""
        for s in steps:
            env = {
                "PATH": f"{STUB}:{os.environ['PATH']}",
                "HOME": tmp,
                "STUB_LOG": str(logs["gcloud"]),
                "DOCKER_LOG": str(logs["docker"]),
                "CURL_LOG": str(logs["curl"]),
                "STUB_HEALTH": health,
            }
            for e in s.get("env", []):
                k, _, v = subst(e, values).partition("=")
                env[k] = v
            env.update({k: secret_env[k] for k in s.get("secretEnv", [])})
            entry = s.get("entrypoint") or ("docker" if s["name"] == "gcr.io/cloud-builders/docker" else None)
            if entry is None:
                failed_step, out = s["id"], f"no entrypoint known for {s['name']}"
                break
            r = subprocess.run(
                [entry] + [subst(str(a), values) for a in s.get("args", [])], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120
            )
            if r.returncode != 0:
                failed_step, out = s["id"], (r.stdout + r.stderr).strip()
                break
        docker = [ln.split("\x1f") for ln in logs["docker"].read_text().splitlines()]
        return {
            "failed": failed_step,
            "out": out,
            "gcloud": logs["gcloud"].read_text().splitlines(),
            "docker": docker,
            "curl": logs["curl"].read_text().splitlines(),
        }


def built(run: dict) -> list[list[str]]:
    return [d for d in run["docker"] if len(d) > 1 and d[1] == "build"]


def deployed(run: dict) -> dict[str, str]:
    return dict(re.findall(r"run deploy (\S+) --image (\S+)", "\n".join(run["gcloud"])))


good = build_run()
check("a good trigger build runs every step", good["failed"] is None, f"step {good['failed']}: {good['out'][:300]}")
builds = built(good)
pushed = sorted(d[2] for d in good["docker"] if len(d) > 2 and d[1] == "push")
tagged = sorted(d[d.index("-t") + 1] for d in builds if "-t" in d)
check("five images built and the same five pushed", len(builds) == 5 and tagged == pushed, f"built {tagged}, pushed {pushed}")
check(
    "every docker build has BuildKit on (the .dockerignore allowlists need it)", bool(builds) and all(d[0] == "BUILDKIT=1" for d in builds)
)
ran_files = {d[d.index("-f") + 1] for d in builds if "-f" in d}
check(
    "every Dockerfile a build ran exists, with its .dockerignore",
    bool(ran_files) and all((ROOT / f).is_file() and (ROOT / f"{f}.dockerignore").is_file() for f in ran_files),
    str(sorted(ran_files)),
)
images = sorted(subst(i, {"PROJECT_ID": PROJECT, "SHORT_SHA": SHA}) for i in cfg.get("images", []))
check("`images:` lists exactly the pushed images", images == pushed, str(images))
dep = deployed(good)
check(
    "deploy-gcp.sh deploys exactly the pushed images, all tagged with the commit",
    sorted(dep.values()) == pushed and len(dep) == 5 and all(v.endswith(f":{SHA}") for v in dep.values()),
    f"deployed {dep}",
)
check("the deploy step built nothing (--skip-build)", not any("builds submit" in ln for ln in good["gcloud"]))
web_line = next((ln for ln in good["gcloud"] if "run deploy munim-web" in ln), "")
check("web is deployed with the trigger's demo tenant", f"MUNIM_DEMO_TENANT_ID={TENANT}" in web_line)

# web's build arguments: the names cloudbuild-web.yaml passes, and the values deploy-gcp.sh would pass when it builds web.
web_cfg = yaml.safe_load((ROOT / "infra/gcp/cloudbuild-web.yaml").read_text())
want_names = sorted(
    re.match(r"--build-arg=([A-Z_]+)=", a).group(1) for a in web_cfg["steps"][0]["args"] if str(a).startswith("--build-arg=")
)
web_build = next((d for d in builds if "infra/gcp/docker/web.Dockerfile" in d), [])
got_args = dict(a[len("--build-arg=") :].split("=", 1) for a in web_build if a.startswith("--build-arg="))
check("web gets cloudbuild-web.yaml's build arguments", sorted(got_args) == want_names, f"{sorted(got_args)} vs {want_names}")
with tempfile.TemporaryDirectory() as tmp:
    log = Path(tmp, "gcloud")
    log.touch()
    r = subprocess.run(
        ["bash", str(ROOT / "scripts/deploy-gcp.sh"), "--project", PROJECT, "--tag", SHA, "--only", "web"],
        env={"PATH": f"{STUB}:{os.environ['PATH']}", "HOME": tmp, "STUB_LOG": str(log), "MUNIM_DEMO_TENANT_ID": TENANT},
        capture_output=True,
        text=True,
        timeout=60,
    )
    sub = re.search(r"--substitutions (\S+)", log.read_text()) if r.returncode == 0 else None
    script_args = dict(kv.split("=", 1) for kv in sub.group(1).split(",")) if sub else {}
check(
    "web's core-api origin and storefront key equal what deploy-gcp.sh bakes in",
    bool(script_args)
    and got_args.get("MUNIM_API_ORIGIN") == script_args.get("_MUNIM_API_ORIGIN")
    and got_args.get("NEXT_PUBLIC_MUNIM_STOREFRONT_KEY") == script_args.get("_STOREFRONT_KEY") == KEY,
    f"file {got_args}, script {script_args}",
)
core_health = f"{script_args.get('_MUNIM_API_ORIGIN')}/health"
check(
    "the schema step reads core-api's /health at the script's core-api URL",
    good["curl"] == [core_health],
    f"{good['curl']} vs {core_health}",
)


def refused(name: str, run: dict, *, builds_none: bool) -> None:
    """A refusal: some step failed, nothing was deployed and, when the refusal is up front, nothing was built."""
    ok = run["failed"] is not None and not deployed(run) and (not builds_none or not built(run))
    check(name, ok, f"failed step {run['failed']}, built {len(built(run))}, deployed {sorted(deployed(run))}")


refused("an empty _DEMO_TENANT_ID refuses before any build", build_run(tenant=""), builds_none=True)
refused("a malformed _DEMO_TENANT_ID refuses before any build", build_run(tenant="nope"), builds_none=True)
refused("an empty SHORT_SHA refuses before any build", build_run(sha=""), builds_none=True)
refused("a database behind this commit's migrations refuses the deploy", build_run(health=HEALTH % (newest - 1)), builds_none=False)
refused("core-api /health without a version refuses the deploy", build_run(health='{"error":"unavailable"}'), builds_none=False)
refused("core-api /health unreachable refuses the deploy", build_run(health=""), builds_none=False)

sys.exit(1 if failed else 0)
