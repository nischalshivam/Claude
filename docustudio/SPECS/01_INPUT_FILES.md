# SPEC 01 — Input files overview

Per video, DocuStudio takes:

| # | File | Format | Spec |
|---|------|--------|------|
| 1 | Clean script | `.txt`, word-for-word same as the voiceover | — |
| 2 | Editing Help Script | annotated script: scenes + tags | `02_EDITING_HELP_SCRIPT.md` |
| 3 | Visual Help File | per-scene assets/links/timestamps | `03_VISUAL_HELP_FILE.md` |
| 4 | Voiceover | ONE audio file for the whole video (30 min – 2 hr) | — |
| 5 | Data file (optional) | `.txt`/`.csv` of stats & facts | below |
| 6 | Assets folder | local images/clips used via `LOCAL:` | — |

## How they relate

- The **clean script** is the alignment anchor: whisper maps it to the
  VO so every line gets a timestamp. It must match the narration
  exactly — that is why the Editing Help Script never rewrites lines.
- The **Editing Help Script** defines scene boundaries and meaning.
- The **Visual Help File** uses the SAME scene numbers and supplies the
  pictures. Generate it FROM the Editing Help Script (see the prompt in
  spec 03) so numbering always matches.
- The tool validates all three at load: scene count mismatch, missing
  scene, or narration text drift between clean script and help script
  → clear error listing the exact scenes, before any downloading.

## Data file (optional)

Plain lines of `label = value | source` used to auto-fill `[STAT]`
cards and comparison panels:

```
UK violent crime per 100k = 2034 | ONS 2019
US violent crime per 100k = 466 | FBI UCR 2019
Handguns banned in UK = 1997 | Firearms (Amendment) Act
```

If a `[STAT]` tag matches a label here, the card shows the exact value
+ a source footer; otherwise the tag's own text is used as-is.
