"""
The OCR JSON contract (§31 / §7.3.2).

These models exist to guarantee shape, not to interpret. The one substantive rule enforced
here is that unknown stays unknown: every statistic is Optional, and nothing in this file
converts a None into a 0. That distinction (§21) is what keeps a missing player from being
scored as a zero-stat player downstream.
"""

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

GameMode = Literal["hardpoint", "search_and_destroy", "control"]
IdentityStatus = Literal[
    "IDENTIFIED", "STREAMER_MODE_ANONYMOUS", "OCR_UNREADABLE", "AMBIGUOUS"
]

REFERENCE_SCORES: dict[str, int] = {
    "hardpoint": 250,
    "search_and_destroy": 20,
    "control": 4,
}


class PlayerConfidence(BaseModel):
    name: Optional[float] = None
    score: Optional[float] = None
    kills: Optional[float] = None
    deaths: Optional[float] = None
    assists: Optional[float] = None
    objectiveTimeSeconds: Optional[float] = None


class OcrPlayer(BaseModel):
    side: Literal["left", "right"]
    slot: int
    rowPresent: bool
    name: Optional[str] = None
    identityStatus: IdentityStatus = "IDENTIFIED"
    score: Optional[int] = None
    kills: Optional[int] = None
    deaths: Optional[int] = None
    assists: Optional[int] = None
    objectiveTimeSeconds: Optional[int] = None
    contribution: Optional[int] = None
    additionalStats: dict[str, Any] = Field(default_factory=dict)
    confidence: PlayerConfidence = Field(default_factory=PlayerConfidence)


class OcrMatch(BaseModel):
    mode: Optional[GameMode] = None
    map: Optional[str] = None
    streamer_mode_enabled: bool = False
    leftScore: Optional[int] = None
    rightScore: Optional[int] = None
    leftResult: Optional[Literal["win", "loss"]] = None
    rightResult: Optional[Literal["win", "loss"]] = None
    scoreGap: Optional[int] = None
    gapPercentage: Optional[float] = None
    dateTime: Optional[str] = None


class OcrSide(BaseModel):
    teamName: Optional[str] = None
    players: list[OcrPlayer] = Field(default_factory=list)


class OcrTeams(BaseModel):
    left: OcrSide = Field(default_factory=OcrSide)
    right: OcrSide = Field(default_factory=OcrSide)


class TeamPointsPreview(BaseModel):
    left: Optional[int] = None
    right: Optional[int] = None
    # Always false. The TypeScript backend is the only authoritative scorer (§1).
    authoritative: bool = False


class Validation(BaseModel):
    valid: bool = True
    issues: list[str] = Field(default_factory=list)


class OcrResponse(BaseModel):
    match: Optional[OcrMatch] = None
    teams: OcrTeams = Field(default_factory=OcrTeams)
    teamPointsPreview: TeamPointsPreview = Field(default_factory=TeamPointsPreview)
    validation: Validation = Field(default_factory=Validation)


class ExtractRequest(BaseModel):
    image_url: str
    match_id: str
    expected_mode: Optional[GameMode] = None


def invalid_response(issues: list[str]) -> OcrResponse:
    """§32: the fixed shape for an unreadable image."""
    return OcrResponse(
        match=None,
        teams=OcrTeams(),
        teamPointsPreview=TeamPointsPreview(),
        validation=Validation(valid=False, issues=issues),
    )


def parse_objective_time(value: Optional[str]) -> Optional[int]:
    """MM:SS to seconds. Returns None for anything unparseable — never 0 (§21)."""
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    if ":" in text:
        parts = text.split(":")
        if len(parts) != 2:
            return None
        try:
            minutes, seconds = int(parts[0]), int(parts[1])
        except ValueError:
            return None
        if seconds > 59 or minutes < 0 or seconds < 0:
            return None
        return minutes * 60 + seconds
    try:
        parsed = int(text)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


def compute_gap(mode: Optional[str], left: Optional[int], right: Optional[int]) -> tuple[
    Optional[int], Optional[float]
]:
    """Informational only (§30) — the backend recomputes both authoritatively."""
    if mode is None or left is None or right is None:
        return None, None
    reference = REFERENCE_SCORES.get(mode)
    if not reference:
        return None, None
    gap = abs(left - right)
    return gap, gap / reference
