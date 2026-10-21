// Records docs/report.gif: hovering the per-day chart, then replaying a session at 4x until it
// stops at a cache rebuild. Synthetic data only (scripts/demo-corpus.ts). Needs Playwright with
// Chromium and ffmpeg; neither is a project dependency. From the repo root:
//
//   pnpm build && D=$(mktemp -d) && npx tsx scripts/demo-corpus.ts $D/home >/dev/null
//   HOME=$D/home node dist/cli.js --since 2026-10-12 --html $D/r.html >/dev/null
//   mkdir $D/f && node scripts/record-report-gif.cjs $D/r.html $D/f dark
//   ffmpeg -y -framerate 10 -i $D/f/f%04d.png -vf "scale=900:-1:flags=lanczos,split[a][b];\
//     [a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" docs/report.gif
/* eslint-disable */
const { chromium } = require(
  require('child_process').execSync('npm root -g').toString().trim() + '/playwright',
);
(async () => {
  const [file, dir, scheme = 'dark'] = process.argv.slice(2);
  const b = await chromium.launch(
    process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
  );
  const p = await b.newPage({
    viewport: { width: 1200, height: 760 },
    colorScheme: scheme,
    deviceScaleFactor: 1,
  });
  await p.goto('file://' + file);
  await p.waitForTimeout(300);
  let n = 0;
  const snap = async (k = 1) => {
    const buf = await p.screenshot();
    for (let i = 0; i < k; i++)
      require('fs').writeFileSync(`${dir}/f${String(n++).padStart(4, '0')}.png`, buf);
  };
  await snap(12);
  const hits = await p.$$('#ov-plot .hit');
  for (const h of hits) {
    await h.hover();
    await p.waitForTimeout(60);
    await snap(5);
  }
  await p.mouse.move(5, 5);
  await snap(4);
  // scroll down smoothly to the replay
  const target = await p.evaluate(
    () => document.querySelector('#replay').getBoundingClientRect().top + scrollY - 56,
  );
  for (let i = 1; i <= 12; i++) {
    await p.evaluate((y) => scrollTo(0, y), (target * i) / 12);
    await snap(1);
  }
  await snap(6);
  await p.selectOption('#rp-session', process.env.SESS || '1');
  await p.selectOption('#rp-speed', '4');
  await p.waitForTimeout(100);
  await snap(4);
  await p.click('#rp-play');
  let paused = 0;
  for (let i = 0; i < 110; i++) {
    await p.waitForTimeout(110);
    await snap(1);
    const t = await p.textContent('#rp-play');
    if (/play/i.test(t || '')) {
      if (++paused === 10) {
        await p.click('#rp-play');
        paused = 0;
      }
    }
  }
  await snap(10);
  console.log('frames', n);
  await b.close();
})();
