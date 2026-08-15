"""
PaddleOCR-VL extraction service.

Deliberately separate from the Discord bot (§2, §3): its own process, its own host, its own
budget. The bot calls it over HTTP and treats every field it returns as advisory — the
TypeScript backend performs all authoritative scoring (§1, rule 4).

Stateless by design. No database, no persistence, image in and JSON out.
"""

from __future__ import annotations

import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

from schemas import (
    ExtractRequest,
    OcrPlayer,
    OcrResponse,
    compute_gap,
    invalid_response,
    parse_objective_time,
)

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format='{"ts":"%(asctime)s","level":"%(levelname)s","message":"%(message)s"}',
)
logger = logging.getLogger("ocr-service")

PROMPT_PATH = Path(__file__).parent / "prompt.txt"
MODEL_ID = os.environ.get("OCR_MODEL_ID", "PaddlePaddle/PaddleOCR-VL")
API_KEY = os.environ.get("OCR_SERVICE_KEY")
MAX_IMAGE_BYTES = int(os.environ.get("MAX_IMAGE_BYTES", 12 * 1024 * 1024))

_model: Any = None


def load_prompt() -> str:
    return PROMPT_PATH.read_text(encoding="utf-8")


@asynccontextmanager
async def lifespan(_: FastAPI):
    """
    The model is loaded once at startup rather than per request — a multi-GB load on every
    submission would dominate the response time and exhaust memory under any concurrency.
    """
    global _model
    try:
        from paddleocr import PaddleOCRVL  # type: ignore

        logger.info("loading model %s", MODEL_ID)
        _model = PaddleOCRVL()
        logger.info("model ready")
    except Exception as exc:  # noqa: BLE001
        # Start anyway so /health can report degraded instead of the container crash-looping.
        logger.error("model failed to load: %s", exc)
        _model = None
    yield
    _model = None


app = FastAPI(title="UM League OCR Service", version="1.0.0", lifespan=lifespan)


def require_api_key(authorization: Optional[str] = Header(default=None)) -> None:
    if not API_KEY:
        return
    if authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="Invalid or missing API key.")


@app.get("/health")
async def health() -> JSONResponse:
    ready = _model is not None
    return JSONResponse(
        {"status": "ok" if ready else "degraded", "model": MODEL_ID, "modelLoaded": ready},
        status_code=200 if ready else 503,
    )


async def download_image(url: str) -> bytes:
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        response = await client.get(url)
        response.raise_for_status()
        content = response.content
        if len(content) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=413, detail="Screenshot is too large.")
        return content


def coerce_player(raw: dict[str, Any], side: str, slot: int) -> OcrPlayer:
    """
    Normalize one model row into the contract.

    Two rules matter here and both are load-bearing. Unreadable values stay None rather than
    becoming 0 (§21), and objective time is only accepted for Hardpoint — contribution and
    impact columns are never reinterpreted as objective time (§15).
    """
    obj = raw.get("objectiveTimeSeconds")
    if isinstance(obj, str):
        obj = parse_objective_time(obj)

    identity = raw.get("identityStatus") or "IDENTIFIED"
    name = raw.get("name")
    if name is not None and not str(name).strip():
        name = None
    if name is None and identity == "IDENTIFIED":
        identity = "OCR_UNREADABLE"

    def as_int(value: Any) -> Optional[int]:
        if value is None or value == "":
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    return OcrPlayer(
        side=side,  # type: ignore[arg-type]
        slot=int(raw.get("slot", slot)),
        rowPresent=bool(raw.get("rowPresent", True)),
        name=name,
        identityStatus=identity,  # type: ignore[arg-type]
        score=as_int(raw.get("score")),
        kills=as_int(raw.get("kills")),
        deaths=as_int(raw.get("deaths")),
        assists=as_int(raw.get("assists")),
        objectiveTimeSeconds=as_int(obj),
        contribution=as_int(raw.get("contribution")),
        additionalStats=raw.get("additionalStats") or {},
    )


def build_response(payload: dict[str, Any], expected_mode: Optional[str]) -> OcrResponse:
    match_raw = payload.get("match")
    if not match_raw:
        return invalid_response(payload.get("validation", {}).get("issues") or ["Not a CODM scoreboard"])

    mode = match_raw.get("mode") or expected_mode
    left_score = match_raw.get("leftScore")
    right_score = match_raw.get("rightScore")

    teams_raw = payload.get("teams") or {}
    sides: dict[str, list[OcrPlayer]] = {"left": [], "right": []}
    for side in ("left", "right"):
        rows = (teams_raw.get(side) or {}).get("players") or []
        for index, row in enumerate(rows, start=1):
            sides[side].append(coerce_player(row, side, index))

    gap, gap_pct = compute_gap(mode, left_score, right_score)

    left_result = right_result = None
    if left_score is not None and right_score is not None and left_score != right_score:
        # §4/§37: the winner comes from the score, never from which side is blue or red.
        left_result = "win" if left_score > right_score else "loss"
        right_result = "loss" if left_score > right_score else "win"

    response = OcrResponse.model_validate(
        {
            "match": {
                "mode": mode,
                "map": match_raw.get("map"),
                "streamer_mode_enabled": bool(match_raw.get("streamer_mode_enabled", False)),
                "leftScore": left_score,
                "rightScore": right_score,
                "leftResult": left_result,
                "rightResult": right_result,
                "scoreGap": gap,
                "gapPercentage": gap_pct,
                "dateTime": match_raw.get("dateTime"),
            },
            "teams": {
                "left": {
                    "teamName": (teams_raw.get("left") or {}).get("teamName"),
                    "players": [p.model_dump() for p in sides["left"]],
                },
                "right": {
                    "teamName": (teams_raw.get("right") or {}).get("teamName"),
                    "players": [p.model_dump() for p in sides["right"]],
                },
            },
            "teamPointsPreview": {"left": None, "right": None, "authoritative": False},
            "validation": {"valid": True, "issues": []},
        }
    )
    return response


@app.post("/extract", response_model=OcrResponse, dependencies=[Depends(require_api_key)])
async def extract(request: ExtractRequest) -> OcrResponse:
    if _model is None:
        raise HTTPException(status_code=503, detail="Model is not loaded.")

    started = time.perf_counter()
    try:
        image_bytes = await download_image(request.image_url)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("image download failed for %s: %s", request.match_id, exc)
        return invalid_response(["Not a CODM scoreboard"])

    try:
        raw_output = _model.predict(image_bytes, prompt=load_prompt())
        payload = raw_output if isinstance(raw_output, dict) else json.loads(str(raw_output))
    except json.JSONDecodeError:
        logger.warning("model returned non-JSON for %s", request.match_id)
        return invalid_response(["Conflicting OCR values"])
    except Exception as exc:  # noqa: BLE001
        logger.error("extraction failed for %s: %s", request.match_id, exc)
        raise HTTPException(status_code=500, detail="Extraction failed.") from exc

    response = build_response(payload, request.expected_mode)
    logger.info(
        "extracted match=%s valid=%s streamer=%s ms=%d",
        request.match_id,
        response.validation.valid,
        response.match.streamer_mode_enabled if response.match else False,
        int((time.perf_counter() - started) * 1000),
    )
    return response
