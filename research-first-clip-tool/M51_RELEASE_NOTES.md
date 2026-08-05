# M5.1 FINAL — Critical Review, Shot Replacement and Full Voiceover

## User-facing changes

1. Valid critical media no longer leaves the user trapped. The Missing Media
   page and Export flow offer one explicit confirmation for every ready
   critical request. Only inspected media with a current fingerprint is
   approved; changed files require review again.
2. Right-click any shot and choose **Change Clip / Image...**. The selected
   file is copied into the project, survives EDL rebuilds and is reconciled
   into the final render. **Restore Original** safely undoes it.
3. The shot list shows exact start, end and duration.
4. **Export / Save As** asks for the destination in Chrome/Edge and streams the
   finished MP4 to disk. The internal final MP4 remains safe if the copy fails.
5. Voiceover duration is the final timeline authority. When SRT ends up to five
   seconds early, the last visual extends to audio end. Audio is never trimmed.
   Larger mismatches remain a blocking input error.

## Verification

- Mini/content: 13 PASS / 0 FAIL
- Regression: 133 PASS / 0 FAIL
- Server/API: 17 PASS / 0 FAIL
- M5B contracts: 20 PASS / 0 FAIL
- Real FFmpeg EDL parity: 9 PASS / 0 FAIL
- Total: **192 PASS / 0 FAIL**
- Browser smoke: rapid-navigation race fixed; Editor, exact timing labels,
  right-click menu and Export verified with zero console errors.
- Horrid Henry state copy: 12 valid critical requests approved, 0 remaining,
  export became available.
- Voiceover parity fixture: 9-second SRT plus 12-second audio produced a full
  12-second render with the last visual extended to 12 seconds.

## Deliberately not included

Transitions, animations, effects and text-template variations are deferred to
the next milestone so this release stays focused on reliable assembly, manual
shot correction and export.
