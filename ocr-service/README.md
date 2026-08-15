# OCR Microservice

PaddleOCR-VL scoreboard extraction, hosted separately from the bot (§2, §3).

It is intentionally not part of the bot's process or its hosting budget. The bot calls it
over HTTP, and if it is down, result submission falls back to manual entry rather than
failing.

## Run

```bash
pip install -r requirements.txt
pip install paddleocr paddlepaddle    # or the model's own distribution
uvicorn main:app --host 0.0.0.0 --port 8000
```

## Environment

| Variable | Purpose |
|---|---|
| `OCR_SERVICE_KEY` | Bearer token. Set it — the bot sends it, and without it the endpoint is open. |
| `OCR_MODEL_ID` | Defaults to `PaddlePaddle/PaddleOCR-VL` |
| `MAX_IMAGE_BYTES` | Upload ceiling, default 12 MB |

Point the bot at it with `OCR_SERVICE_URL` and `OCR_SERVICE_KEY`, then enable the pipeline
with `/config toggle screenshot_ocr_pipeline true`.

## Endpoints

`GET /health` — reports 503 while the model is unloaded, so a deploy that fails to load
weights is visible rather than silently returning garbage.

`POST /extract` — `{ image_url, match_id, expected_mode? }` → the §31 JSON contract.

## What this service does not do

It does not score. `teamPointsPreview.authoritative` is always `false`, and the bot
recalculates every number in TypeScript (§1, rule 4). It does not map anonymous identifiers
to registered players, and it does not decide the winner from side colour — only from the
final score.

`prompt.txt` is the §30 extraction prompt, held as a file so it can be tuned without a code
change.
