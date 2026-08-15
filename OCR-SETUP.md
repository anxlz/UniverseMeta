# Getting `OCR_SERVICE_URL` and `OCR_SERVICE_KEY`

These two values are not issued by anyone. There is no signup, no dashboard, no API console.

- **`OCR_SERVICE_KEY`** is a password **you invent**. You put the same string in two places:
  the OCR service's environment and the bot's environment. That is the whole mechanism.
- **`OCR_SERVICE_URL`** is wherever **you deploy** `ocr-service/`. It only exists once you
  have run the service somewhere the bot can reach.

So the real task is "deploy the OCR service and point the bot at it." That is what the rest
of this document covers.

Nothing here is required to run the bot. With both values blank, `/matchresult` accepts the
screenshot and tells staff to record the result with `/matchscore`. Everything else — teams,
scheduling, tickets, applications, scoring, approval, leaderboards, compliance — works
without OCR.

---

## Step 1 — Generate the key

Run this on any machine. It is just a random string:

```bash
openssl rand -hex 32
```

Example output (**do not use this one**):

```
7f3c1a9e42b8d05c6e1f8a37d94b2c05e83a1f6d47b9c2e08a5d3f1b7c604e29
```

Windows PowerShell, if you don't have `openssl`:

```powershell
-join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
```

Save it somewhere safe. You will paste it twice and never need it again.

**This is a real credential.** Without it the `/extract` endpoint is open to anyone who
finds the URL, and they can bill your GPU time by sending it images. Never commit it — the
repo's `.gitignore` covers `.env*`, and CI fails the build if an `.env` is ever tracked.

---

## Step 2 — Pick where the service runs

PaddleOCR-VL is a vision-language model. It wants a GPU. It will run on CPU, but a scoreboard
that takes ~3 seconds on a GPU can take 60+ seconds on CPU, and Discord interactions expire.

The bot's own free-tier VM is **not** a candidate — §2 and §11 both exclude the model from
the bot's process and its hosting budget, deliberately.

| Option | Roughly | Good for | Watch out for |
|---|---|---|---|
| **RunPod / Vast.ai** serverless GPU | pay per second, ~$0.20–0.60/hr while active | Real leagues. Scales to zero between matches. | Cold starts of 20–60s on the first request after idle |
| **Hugging Face Spaces** (GPU tier) | ~$0.60/hr, free CPU tier exists | Trying it out with almost no setup | Free CPU tier is too slow for live use |
| **A second VPS with a GPU** (Hetzner GEX, OVH) | ~€180+/mo | High volume, predictable cost | Overkill for a scrim league |
| **Your own machine + Cloudflare Tunnel** | free | Testing, or a league whose admin leaves a PC on | Dies when the machine sleeps |
| **Railway / Render / Fly.io** (CPU) | ~$5–20/mo | Low volume, patient staff | Expect 60s+ per screenshot |

Start on whatever is cheapest to try. Moving later is a one-line `.env` change.

---

## Step 3 — Deploy the service

Everything below assumes you are in the `ocr-service/` directory of this repo.

### Option A — Local machine, exposed with Cloudflare Tunnel (fastest to test)

```bash
cd ocr-service
pip install -r requirements.txt
pip install paddleocr paddlepaddle        # or the GPU build for your CUDA version

export OCR_SERVICE_KEY=<the key from step 1>
uvicorn main:app --host 0.0.0.0 --port 8000
```

Confirm it is alive locally:

```bash
curl http://localhost:8000/health
# {"status":"ok","model":"PaddlePaddle/PaddleOCR-VL","modelLoaded":true}
```

`"status":"degraded"` with `"modelLoaded":false` means the model failed to load. The service
starts anyway on purpose, so you get a readable health response instead of a crash loop —
check the logs for the load error.

Then expose it:

```bash
cloudflared tunnel --url http://localhost:8000
```

That prints a public HTTPS URL. **That is your `OCR_SERVICE_URL`.**

### Option B — Docker (most hosts take this)

Create `ocr-service/Dockerfile`:

```dockerfile
FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt paddleocr paddlepaddle
COPY . .
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Build, run, and set the key as an environment variable:

```bash
docker build -t uml-ocr .
docker run -d -p 8000:8000 -e OCR_SERVICE_KEY=<your key> --name uml-ocr uml-ocr
```

On RunPod, Railway, Render or Fly: push this image (or point them at the repo), set
`OCR_SERVICE_KEY` in their environment/secrets panel, and expose port 8000. Each of them
gives you a public URL when the deploy succeeds — **that URL is `OCR_SERVICE_URL`.**

### Option C — Hugging Face Spaces

1. Create a Space, SDK **Docker**.
2. Upload the contents of `ocr-service/` plus the Dockerfile above.
3. Settings → **Variables and secrets** → new secret `OCR_SERVICE_KEY` = your key.
4. The Space URL is `https://<user>-<space>.hf.space` — **that is `OCR_SERVICE_URL`.**

---

## Step 4 — Verify from outside

Do this before touching the bot. It isolates "is the service working" from "is the bot
configured correctly," which saves a lot of guessing later.

```bash
curl https://your-ocr-host/health
```

Expect `{"status":"ok", ... "modelLoaded":true}`.

Now prove the key works. Without it:

```bash
curl -X POST https://your-ocr-host/extract \
  -H "Content-Type: application/json" \
  -d '{"image_url":"https://example.com/x.png","match_id":"TEST"}'
# Expect: 401 Invalid or missing API key
```

With it:

```bash
curl -X POST https://your-ocr-host/extract \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your key>" \
  -d '{"image_url":"<a real scoreboard image URL>","match_id":"TEST"}'
```

You should get the §31 JSON contract back. If the 401 does **not** happen without the key,
`OCR_SERVICE_KEY` did not reach the container — fix that before going further, because the
endpoint is currently open.

---

## Step 5 — Point the bot at it

In the bot's `.env`:

```dotenv
OCR_SERVICE_URL=https://your-ocr-host
OCR_SERVICE_KEY=7f3c1a9e42b8d05c6e1f8a37d94b2c05e83a1f6d47b9c2e08a5d3f1b7c604e29
OCR_TIMEOUT_MS=60000
```

- No trailing slash on the URL — the client strips one, but keep it clean.
- The key must be **character-for-character identical** to the one on the service. A trailing
  newline from a copy-paste is the usual culprit behind a mystery 401.
- Raise `OCR_TIMEOUT_MS` if you are on CPU or a cold-starting serverless GPU. 60s is the
  default; 120000 is reasonable for CPU.

Restart the bot:

```bash
sudo systemctl restart uml-bot
journalctl -u uml-bot -f
```

---

## Step 6 — Turn the pipeline on

The environment variables alone do not enable OCR. The toggle is separate and per-guild, so
you can run the service and still leave it off while testing:

```
/config toggle key:screenshot_ocr_pipeline value:true
```

Check it took:

```
/config show
```

---

## Step 7 — Test end to end

1. Register two teams with rosters whose IGNs match a real scoreboard.
2. `/matchregister`, then `/matchconfirm` as the opposing captain.
3. `/matchresult match_id:<id> screenshot:<the scoreboard>`.

A working pipeline produces the result embed with team points and a calibration note. Then
`/matchapprove` to award points.

---

## When it doesn't work

**"OCR is not enabled on this server"** — `screenshot_ocr_pipeline` is off, or
`OCR_SERVICE_URL` is blank. Both must be set.

**"The OCR service could not be reached"** — the bot got a connection error or a timeout.
Check `/health` from another machine, confirm the host is not asleep, and confirm the URL in
`.env` is the public one rather than `localhost`.

**"OCR service returned HTTP 401"** — the keys differ. Re-copy, and check for a trailing
newline (`echo -n "$OCR_SERVICE_KEY" | wc -c` should be 64 for a 32-byte hex key).

**"OCR service returned HTTP 503"** — the model has not loaded. The service is up but not
ready; check its logs for the load failure.

**Everything returns "Not a CODM scoreboard"** — the model is loading but reading nothing
useful. Usually a cropped or heavily compressed screenshot. Try a full-resolution one.

**It works but is very slow** — you are on CPU. Either raise `OCR_TIMEOUT_MS` and accept it,
or move to a GPU host.

---

## Security notes

- Rotate the key by changing it on the service, then in the bot's `.env`, then restarting
  both. There is no revocation list; the key *is* the access.
- The service is stateless. It stores nothing, so a compromise leaks compute, not data.
- Restrict inbound traffic to the bot's IP where the host allows it. The bearer key is the
  only other thing standing between your GPU budget and the open internet.
- The bot never sends the key anywhere except `OCR_SERVICE_URL`, and never logs it.
