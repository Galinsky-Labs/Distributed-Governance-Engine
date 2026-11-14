# Bundled export fonts

The export library (`src/export/`) embeds caller-supplied TrueType fonts. These
files are the default font family for PDF exports.

| File | Family / style | Version (name table) | PostScript name |
| --- | --- | --- | --- |
| `liberation/LiberationSerif-Regular.ttf` | Liberation Serif Regular | Version 2.1.5 | LiberationSerif |
| `liberation/LiberationSerif-Bold.ttf` | Liberation Serif Bold | Version 2.1.5 | LiberationSerif-Bold |
| `liberation/LiberationSerif-Italic.ttf` | Liberation Serif Italic | Version 2.1.5 | LiberationSerif-Italic |
| `liberation/LiberationSerif-BoldItalic.ttf` | Liberation Serif Bold Italic | Version 2.1.5 | LiberationSerif-BoldItalic |

- Source: the Debian `fonts-liberation` package 1:2.1.5-3 (upstream
  <https://github.com/liberationfonts>), copied unmodified.
- License: SIL Open Font License 1.1; full text and copyright notice in
  `liberation/LICENSE`. Embedding in exported documents is permitted (OS/2
  `fsType` is 0, installable embedding).
- Coverage: Latin, Greek, Cyrillic and Hebrew. Arabic, CJK and emoji are not
  covered; such characters are reported in the export manifest warnings and
  drawn as the `.notdef` glyph.
