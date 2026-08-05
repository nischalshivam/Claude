# M5 Local API — contract (v1)

Backend: `server/app.js` — Node ka apna `http`, sirf `127.0.0.1`, koi npm dependency nahi.
Har request (health aur UI shell ke alawa) ko session token chahiye:

- header `x-rfc-token: <token>`, ya
- query `?token=<token>`  (EventSource / `<img>`/`<video>` src ke liye)

Token har server start par naya banta hai aur `http://127.0.0.1:7900/?token=<token>` URL mein hota hai.
Env `RFC_UI_TOKEN` se fix bhi kar sakte ho (test/automation).

Errors hamesha structured:
```json
{ "ok": false, "code": "APPROVAL_EXPIRED", "message": "...", "artifacts": [] }
```
`artifacts` mein sirf wahi file jo sach mein disk par hai.

## Endpoints

| Method | Path | Kaam |
|---|---|---|
| GET | `/api/v1/health` | zinda hai? (token nahi chahiye) |
| GET | `/api/v1/state` | **canonical** project state (neeche) — UI kabhi khud calculate na kare |
| GET | `/api/v1/inputs` | in-UI inputs ka summary (pack valid?, audio duration, srt cues, script?) |
| POST | `/api/v1/import?kind=pack\|audio\|script\|srt&name=<f>` | file body upload → `input/` mein (audio mp3/m4a/wav auto-detect; pack validate) |
| POST | `/api/v1/make-srt` | clean script (ya pack) + audio se ESTIMATED `voiceover.srt` banao |
| POST | `/api/v1/new-project` | fresh start — `input/DATA/jobs/project` sab `archive/<ts>` mein (delete kabhi nahi) |
| GET | `/api/v1/genspark-prompt` | research-pack banane ka Genspark prompt (UI panel ke liye) |
| GET | `/api/v1/research-health` | pack validation + pack-check report |
| GET | `/api/v1/missing` | har unresolved gap (stable key, criticality, approval, files, reasons) |
| POST | `/api/v1/draft` | pack-check (agar stale) + `run.js --draft --redo` — ek job |
| POST | `/api/v1/export` | pack-check (agar stale) + `run.js` (final) |
| POST | `/api/v1/jobs/cancel` | chal raha job SIGTERM |
| GET | `/api/v1/jobs/events` | **SSE** live log; events: `log`, `done`, `idle` |
| POST | `/api/v1/requests/:key/media?name=<f>` | file body upload → us request ke `media/` mein |
| POST | `/api/v1/requests/:key/override` | `{allow_reuse}` |
| POST | `/api/v1/requests/:key/approve` | critical beat approve (fingerprint record banta hai) |
| DELETE | `/api/v1/requests/:key/approval` | approve hatao |
| GET | `/api/v1/edl` | `project-edl-v1` (tokens only, koi raw path nahi) |
| PATCH | `/api/v1/edl` | `{expected_revision, ops:[{shot_id, transform?, trim?}]}` — 409 on stale |
| POST | `/api/v1/edl/rebuild` | draft ke naye artifacts se EDL dobara (edits bachte hain) |
| GET | `/api/v1/media/:token` | asset file (video range-request supported) |
| GET | `/api/v1/thumb/:token?t=<sec>` | 320px thumbnail (ffmpeg, cached) |

`:key` = stable `request_key` (`REQ_xxxxxxxx`). Legacy `request_id` bhi chalta hai.

## `/api/v1/state` shape

```json
{
  "schema": "project-state-v1",
  "state": "NEEDS_MEDIA",
  "human": "...",
  "can_export": false,
  "inputs": { "pack": true, "srt": true, "audio": true, "inputs_valid": true, "pack_checked": true },
  "timebase": { "audio": 894.7, "srt_end": 896.1, "project_duration": 894.7, "correction": "CLAMPED_SRT_TAIL", "ok": true, "reason": "..." },
  "media_state": "NEEDS_MEDIA",
  "total_requests": 16, "blocking": 7,
  "job": { "kind": "draft", "running": false, "exit": 0 },
  "artifacts": { "draft": true, "final": false, "gap_plan": true, "timeline": true, "manifest": true, "shot_review": true },
  "job_id": "candace",
  "project_states": { "NO_INPUTS": "NO_INPUTS", ... }
}
```

`state` in se ek hota hai (backend `readiness.PROJECT_STATE`):
```
NO_INPUTS · INPUTS_INVALID · READY_TO_RESEARCH · READY_TO_DRAFT · DRAFT_RUNNING ·
NO_DRAFT · NEEDS_MEDIA · NEEDS_MORE_MEDIA · NEEDS_CRITICAL_APPROVAL ·
READY_FOR_CONTENT_REVIEW · CONTENT_LOCKED · STYLE_READY · EXPORT_RUNNING ·
EXPORT_FAILED · FINAL_READY
```

## Security

- bind sirf `127.0.0.1` — machine ke bahar se kabhi reachable nahi
- token har protected route par
- media token allow-list: sirf `DATA/` aur maujooda job dir ke andar ki files resolve hoti hain
- upload sirf us request ke `media/` folder ke andar (path containment, `..` reject)
- spawn hamesha argument-array se — kabhi user-built shell string nahi
- browser ko raw filesystem path kabhi nahi milta (sirf opaque token)
