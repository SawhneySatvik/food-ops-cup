#!/bin/bash
# T-121: scripts/deploy-gcp.sh against a stub gcloud (no Google calls). usage: infra/gcp/test/deploy-gcp.test.sh [script]
S="${1:-$(cd "$(dirname "$0")/../../.." && pwd)/scripts/deploy-gcp.sh}"
STUBDIR="$(cd "$(dirname "$0")" && pwd)/stub"; export STUB_LOG="$(mktemp)"
fail=0
t() { # t <name> <expected exit> <env-prefix...> -- args...
  local name="$1" want="$2"; shift 2
  : > "$STUB_LOG"
  out="$(env PATH="$STUBDIR:$PATH" "$@" 2>&1)"; got=$?
  if [ "$got" = "$want" ]; then echo "PASS  $name (exit $got)"; else echo "FAIL  $name: want exit $want, got $got"; echo "$out" | head -5; fail=1; fi
}
V=/dev/null
# usage errors -> 2
t "unknown flag"                    2 /bin/bash "$S" --bogus
t "unknown flag with project"       2 /bin/bash "$S" --project demo-proj --dry-run --bogus
t "--project without value"         2 /bin/bash "$S" --project
t "--project followed by a flag"    2 /bin/bash "$S" --project --dry-run
t "--project= (empty)"              2 /bin/bash "$S" --project=
t "--tag without value"             2 /bin/bash "$S" --project demo-proj --tag
t "no project at all"               2 env -u PROJECT_ID /bin/bash "$S" --dry-run
t "project id too short (x)"        2 /bin/bash "$S" --project=x --dry-run
t "project id uppercase"            2 /bin/bash "$S" --project=Demo-Proj --dry-run
t "--only unknown service"          2 /bin/bash "$S" --project demo-proj --only bogus --dry-run
t "--only empty"                    2 /bin/bash "$S" --project demo-proj --only= --dry-run
t "--skip-build without --tag"      2 /bin/bash "$S" --project demo-proj --skip-build --dry-run
t "--tag with a slash"              2 /bin/bash "$S" --project demo-proj --tag=a/b --dry-run
# accepted forms -> 0
t "--project value form"            0 /bin/bash "$S" --project demo-proj --dry-run
t "--project=value form"            0 /bin/bash "$S" --project=demo-proj --dry-run
t "PROJECT_ID from env"             0 env PROJECT_ID=demo-proj /bin/bash "$S" --dry-run
t "--only=a,b --tag=t --skip-build" 0 /bin/bash "$S" --project=demo-proj --only=core-api,web --tag=t1 --skip-build --dry-run
t "--help"                          0 /bin/bash "$S" --help
# a dry run executes nothing: the stub's log stays empty
: > "$STUB_LOG"; env PATH="$STUBDIR:$PATH" /bin/bash "$S" --project demo-proj --dry-run >/dev/null 2>&1
if [ ! -s "$STUB_LOG" ]; then echo "PASS  dry run made 0 gcloud calls"; else echo "FAIL  dry run called gcloud:"; cat "$STUB_LOG" | head -3; fail=1; fi
# what the script prints is plain: --help, a usage error and a dry run name this script and the README, never a make target, a ticket or a gotcha
PLAIN='T-[0-9]|gotcha|make |\(R[0-9]'
help="$(/bin/bash "$S" --help 2>&1)"
if echo "$help" | grep -q "scripts/deploy-gcp.sh --project <id>"; then echo "PASS  --help names the script and its flags"; else echo "FAIL  --help does not show the usage line:"; echo "$help" | head -5; fail=1; fi
for what in "--help:$help" "usage error:$(/bin/bash "$S" --bogus 2>&1)" "dry run:$(env PATH="$STUBDIR:$PATH" /bin/bash "$S" --project demo-proj --dry-run 2>&1)"; do
  if echo "${what#*:}" | grep -qE "$PLAIN"; then echo "FAIL  ${what%%:*} prints an internal id or a make target:"; echo "${what#*:}" | grep -E "$PLAIN" | head -3; fail=1; else echo "PASS  ${what%%:*} prints no internal id or make target"; fi
done
# the real branch (stub gcloud): web refuses without a tenant id, runs with one, and says so honestly
t "real run, web, no tenant id"     2 /bin/bash "$S" --project demo-proj --only web
t "real run, web, bad tenant id"    2 env MUNIM_DEMO_TENANT_ID=nope /bin/bash "$S" --project demo-proj --only web
t "real run, core-api"              0 /bin/bash "$S" --project demo-proj --only core-api
echo "stub calls in the last real run: $(wc -l < "$STUB_LOG")"
exit $fail
