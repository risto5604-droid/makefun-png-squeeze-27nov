# makefun-png-squeeze-27nov

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/risto5604-droid/makefun-png-squeeze-27nov/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/risto5604-droid/makefun-png-squeeze-27nov/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Re-encode 1280x720 RGBA screenshots as the smallest lossless PNG. Pure
Node.js standard library — no third-party code, no network, deterministic
output (two runs write identical bytes).

## How it works

For each screenshot the program:

1. Decodes the input PNG to raw RGBA pixels.
2. Analyses the pixels: distinct-colour count, all-grey?, alpha all opaque?
3. Builds the cheapest exact colour representation: palette (colour type 3)
   when there are at most 256 distinct colours, grey (type 0) or grey+alpha
   (type 4) when every pixel is grey, RGB (type 2) when fully opaque,
   otherwise RGBA (type 6). A palette is also tried in luminance order.
4. Tries every PNG filter strategy on each representation — all five fixed
   filters plus a per-row adaptive choice — ranking them with a fast
   level-6 deflate, then refining the best two at level 9 (also trying the
   Z_FILTERED strategy), and keeps the smallest real output.
5. Writes the smallest encoding as `/output/<id>/image.png`.

Fixed filters often beat adaptive ones: unfiltered rows let deflate's own
matches find repeated rows and flat runs that no per-row heuristic can see.

## Run it

```sh
node main.ts
```

Reads `/input/i001` … `/input/i008` and writes `/output/<id>/image.png`
for each. Practice-set score: 698,112 (house baseline fixed-paeth 1.0.0:
420,399), whole set in ~17 s — well inside the 60 s wall.

---

<sub>Entered on [make.fun](https://make.fun/?ref=38hw3qgw&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
