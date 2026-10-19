#!/usr/bin/env bash
# Read-only real-log check for tknxray. Run it yourself in a terminal on your own machine:
#
#   curl -fsSL https://raw.githubusercontent.com/alexnieves-cs/ccxray/docs-readme/scripts/real-check.sh | bash
#   # or, from a checkout:  bash scripts/real-check.sh
#
# It clones the repo into a temp dir, builds it, reads ~/.claude/projects and prints AGGREGATE
# counts only (no paths, project names, ids, prompts or file contents), then deletes the clone.
# Nothing is uploaded anywhere. The only network use: git clone, pnpm install, and `npx ccusage`
# for the cross-check (skip that with SKIP_CCUSAGE=1).
set -uo pipefail

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
D="$TMP/ccxray"
OUT="$TMP/out"
mkdir -p "$OUT"

step() { printf '\n===== %s =====\n' "$1"; }
run() { "$@" 2>&1 | sed -e "s#$HOME#~#g" -e "s#$TMP#<tmp>#g"; }

step "setup"
git clone -q https://github.com/alexnieves-cs/ccxray "$D" || exit 1
cd "$D" || exit 1
git checkout -q docs-readme
git -c user.name=x -c user.email=x@x merge -q --no-edit origin/m1-perf-timestamps >/dev/null 2>&1 \
  || { git merge --abort >/dev/null 2>&1; echo "note: perf-timestamps merge skipped (conflict)"; }
command -v pnpm >/dev/null || corepack enable >/dev/null 2>&1
pnpm install --frozen-lockfile --silent >/dev/null 2>&1 || { echo "pnpm install failed"; exit 1; }
pnpm -s build >/dev/null 2>&1 || { echo "build failed"; exit 1; }
echo "node $(node -v) · $(sw_vers -productVersion 2>/dev/null || uname -sr) · $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m)"

step "doctor"
run node dist/cli.js doctor

step "format probe (counts only)"
run pnpm -s probe

if [ "${SKIP_CCUSAGE:-0}" != 1 ]; then
  step "ccusage cross-check (target ±0.5%)"
  npx -y ccusage@latest session --json > "$OUT/ccusage.json" 2>/dev/null \
    && run pnpm -s validate:real --ccusage "$OUT/ccusage.json" \
    || echo "ccusage run failed; skipped"
fi

step "findings per analyzer, last 30 days"
SINCE=$(date -u -v-30d +%Y-%m-%d 2>/dev/null || date -u -d '30 days ago' +%Y-%m-%d)
node dist/cli.js --since "$SINCE" --json > "$OUT/report.json" 2>/dev/null
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const by = {};
for (const f of r.findings ?? []) {
  const k = f.analyzer ?? f.id ?? "?";
  by[k] ??= { findings: 0, tokens: 0, kind: f.tokens?.kind ?? "?" };
  by[k].findings++; by[k].tokens += f.tokens?.value ?? f.tokens?.count ?? 0;
}
console.log(JSON.stringify({ totals: r.totals, calibration: r.calibration, byAnalyzer: by }, null, 2));
' "$OUT/report.json"

step "my-sessions (aggregate)"
run pnpm -s my-sessions --out "$OUT/MY_SESSIONS.md"
cat "$OUT/MY_SESSIONS.md"

step "timing + peak RSS"
for W in "--since $(date -u -v-7d +%Y-%m-%d 2>/dev/null || date -u -d '7 days ago' +%Y-%m-%d)" "--since 2000-01-01"; do
  for i in 1 2 3; do
    if /usr/bin/time -l true >/dev/null 2>&1; then
      /usr/bin/time -l node dist/cli.js $W --json >/dev/null 2>"$OUT/t"
      echo "$W run $i: $(grep -E 'real|maximum resident' "$OUT/t" | tr -s ' ' | tr '\n' ' ')"
    else
      /usr/bin/time -v node dist/cli.js $W --json >/dev/null 2>"$OUT/t"
      echo "$W run $i: $(grep -E 'Elapsed|Maximum resident' "$OUT/t" | tr -s ' ' | tr '\n' ' ')"
    fi
  done
done

step "done (temp clone deleted on exit)"
