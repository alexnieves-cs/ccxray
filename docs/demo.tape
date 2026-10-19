# Demo GIF for the README. Synthetic data only: scripts/demo-corpus.ts writes a made-up corpus
# into a fresh temp dir, and HOME points there, so no real transcript is read.
#
#   pnpm build && ~/go/bin/vhs docs/demo.tape      # run from the repo root
#
# Needs vhs, ttyd and ffmpeg. Output: docs/demo.gif

Output docs/demo.gif

Set Shell bash
Set FontSize 14
Set Width 1000
Set Height 940
Set Padding 16
Set TypingSpeed 40ms
Set Theme "Dracula"

Hide
Type "export REPO=$PWD DEMO=$(mktemp -d) && npx tsx scripts/demo-corpus.ts $DEMO >/dev/null"
Enter
Sleep 4s
Type "export HOME=$DEMO PS1='$ ' && unset CLAUDE_CONFIG_DIR && cd $DEMO && tknxray() { node $REPO/dist/cli.js $@; } && clear"
Enter
Sleep 1s
Show

Type "# synthetic demo corpus; tknxray reads ~/.claude/projects, locally"
Enter
Sleep 500ms
Type "tknxray --since 2026-10-12"
Sleep 300ms
Enter
Sleep 7s

Type "clear"
Enter
Type "tknxray session 72f3"
Sleep 300ms
Enter
Sleep 6s
