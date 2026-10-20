#!/usr/bin/env bash
# Read-only real-log check for tknxray. Run it yourself in a terminal on your own machine:
#
#   curl -fsSL https://raw.githubusercontent.com/alexnieves-cs/ccxray/main/scripts/real-check.sh | bash
#   # or, from a checkout:  bash scripts/real-check.sh
#
# It clones `main` (or the branch in CCXRAY_REF) into a temp dir, builds it, reads ~/.claude/projects and prints AGGREGATE
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
REF=${CCXRAY_REF:-main}
git clone -q --branch "$REF" https://github.com/alexnieves-cs/ccxray "$D" || exit 1
cd "$D" || exit 1
echo "commit $(git rev-parse --short HEAD) ($REF)"
echo "node $(node -v 2>/dev/null || echo missing) · $(sw_vers -productVersion 2>/dev/null || uname -sr) · $(sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m)"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 20 ]; then echo "tknxray needs Node 20 or newer; this is $(node -v 2>/dev/null || echo 'no node')"; exit 1; fi
command -v pnpm >/dev/null || corepack enable >/dev/null 2>&1
command -v pnpm >/dev/null || { echo "pnpm not found (and corepack could not enable it): npm i -g pnpm"; exit 1; }
echo "pnpm $(pnpm -v 2>/dev/null)"
# On failure, show the tail of the real output (home and temp paths stripped) instead of hiding it.
fail() { echo "$1 failed; last lines:"; tail -n 40 "$OUT/$2" | sed -e "s#$HOME#~#g" -e "s#$TMP#<tmp>#g"; exit 1; }
pnpm install --frozen-lockfile >"$OUT/install.log" 2>&1 || fail "pnpm install" install.log
pnpm build >"$OUT/build.log" 2>&1 || fail "build" build.log
# Scripts run through the local tsx, not `pnpm <script>`: some pnpm builds reject `-s`.
TSX="$D/node_modules/.bin/tsx"
[ -x "$TSX" ] || { echo "tsx missing after install"; exit 1; }

step "doctor"
run node dist/cli.js doctor

step "format probe (counts only)"
run "$TSX" scripts/probe-format.ts

if [ "${SKIP_CCUSAGE:-0}" != 1 ]; then
  step "ccusage cross-check (target ±0.5%)"
  # `ccusage claude session`: Claude Code only. Plain `session` also counts other coding CLIs.
  { npx -y ccusage@latest claude session --json > "$OUT/ccusage.json" 2>/dev/null \
    || npx -y ccusage@latest session --json > "$OUT/ccusage.json" 2>/dev/null; } \
    && run "$TSX" scripts/validate-real.ts --ccusage "$OUT/ccusage.json" \
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
  by[k].findings++;
  // subagent-cost adds a window-wide summary (data.parents) over its per-parent findings; skip
  // its tokens so the sum is not doubled.
  if (!(k === "subagent-cost" && f.data?.parents !== undefined))
    by[k].tokens += f.tokens?.value ?? f.tokens?.count ?? 0;
}
// No per-project or per-session keys: those are paths and ids. Counts and model names only.
const t = r.totals ?? {};
const totals = { all: t.all, byModel: t.byModel, byRole: t.byRole,
  days: Object.keys(t.byDay ?? {}).length, projects: Object.keys(t.byProject ?? {}).length };
console.log(JSON.stringify({ totals, calibration: r.calibration, byAnalyzer: by }, null, 2));
' "$OUT/report.json"

step "false-positive spot check, last 30 days (mechanical evidence check)"
run "$TSX" scripts/fp-check.ts --since "$SINCE"

step "my-sessions (aggregate)"
run "$TSX" bench/my-sessions.ts --out "$OUT/MY_SESSIONS.md"

step "timing + peak RSS"
WEEK=$(date -u -v-7d +%Y-%m-%d 2>/dev/null || date -u -d '7 days ago' +%Y-%m-%d)
for W in "$WEEK" 2000-01-01; do
  for i in 1 2 3; do
    T0=$(node -e 'console.log(Date.now())')
    CCXRAY_BENCH_RSS_OUT="$OUT/rss.json" node --import ./bench/rss-hook.mjs dist/cli.js --since "$W" --json >/dev/null 2>&1
    T1=$(node -e 'console.log(Date.now())')
    RSS=$(node -e 'console.log((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).maxRssKiB*1024/1e6).toFixed(1))' "$OUT/rss.json" 2>/dev/null)
    echo "--since $W run $i: wall $(( (T1 - T0) ))ms, peak RSS ${RSS:-?} MB"
  done
done

step "done (temp clone deleted on exit)"
