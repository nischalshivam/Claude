# Known limitations — M5.0-B.2

## Production foundation that is complete

- In-UI fresh project input flow
- Single-instance/busy-port-safe launcher
- Pack/audio/SRT preflight and honest build status
- Automatic draft, missing-range plan and human media fill
- Voiceover-synced preview, play/pause/scrub and shot selection
- Persistent per-shot trim/crop/scale/fit edits
- EDL edits applied to final FFmpeg output
- Critical/HARD EVIDENCE human approval
- Fresh start with recoverable project archive

## Not yet a CapCut/Filmora replacement

- No freeform split, ripple trim, magnetic timeline or arbitrary shot reorder
- No multi-select/group editing or full undo/redo UI
- No keyframe animation editor
- Style templates, transitions, effects and music automation are not active yet
- Queue and Library screens are placeholders, not production multi-project tools

## Input and research limits

- Auto-SRT estimates timing from script and audio; it does not transcribe speech.
- Exact-clip accuracy cannot exceed the evidence in the research pack and the
  footage actually available online.
- Dead/private/blocked sources and unavailable episodes must be filled through
  Missing Media. This is intentional human-in-the-loop behavior, not hidden by
  generic cards.
- Cross-niche engine logic supports series, anime, film and documentary scopes,
  but every new niche still needs one real acceptance pilot before claiming the
  same sourcing accuracy.

## Scale limits

- One active project at a time in the UI.
- Large file uploads currently pass through the local Node process; very large
  source uploads would benefit from a streaming worker in a future release.
- YouTube downloads remain subject to YouTube availability, throttling and
  yt-dlp compatibility.

These limits are product milestones, not reasons to return to the removed
old-folder/update workflow.
