# Connect fonts

Inter and JetBrains Mono are self-hosted through `next/font/local`. Their original
SIL Open Font License files are included beside the font assets. Builds and page
loads do not fetch fonts from Google or another CDN.

Downloaded from the official Google Fonts repository on September 26, 2026:

- [Inter variable](https://github.com/google/fonts/blob/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf)
  SHA-256: `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031`
- [JetBrains Mono variable](https://github.com/google/fonts/blob/main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf)
  SHA-256: `48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda`

Pages load WOFF2 files generated from these sources by `scripts/subset-fonts.mjs` with
`subset-font@2.4.0` (HarfBuzz). They keep every OpenType feature and variation axis and cover
Latin, Latin Extended, Greek, Cyrillic, common punctuation/symbols, and every character in the
translation files; the script fails if a covered source character would be lost. Output is
deterministic:

- `inter-variable.woff2` SHA-256: `f5b55f7a576e532503f85f6ee926f4e4edea0705ad847e9da05701c1653aa388`
- `jetbrains-mono-variable.woff2` SHA-256: `ce554cb8e99e7278f7407f9698b580f98302c6b4c9dfd50a864d7d62a2b69987`

The existing Figtree asset is retained for compatibility with historical uses.
