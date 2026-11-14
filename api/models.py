"""Request and response shapes for /evaluate (see docs/ARCHITECTURE.md)."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

EPHEMERIS_START = date(2025, 1, 1)
EPHEMERIS_END = date(2050, 12, 31)  # DE421 + moon_pa_de421 cover 1900-2050


class EvaluateRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    lander_id: str | None = None
    payload_kg: float | None = Field(default=None, ge=0)
    landing_date: date | None = None
    landing_time: datetime | None = None  # UTC; wins over landing_date when both are sent
    terrain_level: Literal["global", "detailed"] = "global"

    @field_validator("landing_date")
    @classmethod
    def in_ephemeris_range(cls, v: date | None) -> date | None:
        if v is not None and not (EPHEMERIS_START <= v <= EPHEMERIS_END):
            raise ValueError(f"must be between {EPHEMERIS_START} and {EPHEMERIS_END}")
        return v

    @field_validator("landing_time")
    @classmethod
    def utc_and_in_range(cls, v: datetime | None) -> datetime | None:
        if v is None:
            return None
        if v.tzinfo is not None:
            v = v.astimezone(timezone.utc).replace(tzinfo=None)  # store as naive UTC
        if not (EPHEMERIS_START <= v.date() <= EPHEMERIS_END):
            raise ValueError(f"must be between {EPHEMERIS_START} and {EPHEMERIS_END}")
        return v.replace(minute=0, second=0, microsecond=0)  # the model runs on whole hours


class SiteStats(BaseModel):
    slope_deg: float | None
    slope_baseline_m: float | None      # distance the slope was measured over
    elevation_m: float | None
    temp_range_k: list[float] | None
    sunlight_pct: float                 # Sun above the terrain horizon
    earth_visible_pct: float            # Earth above the terrain horizon
    sunlight_pct_flat: float            # same, ignoring terrain (smooth-sphere horizon)
    earth_visible_pct_flat: float


class SkyPoint(BaseModel):
    t: str
    sun_el: float
    sun_az: float      # degrees from north, through east
    earth_el: float
    earth_az: float
    sun_visible: bool  # above the terrain horizon
    earth_visible: bool


class TerrainInfo(BaseModel):
    level: Literal["global", "detailed"]
    heights_source: str
    resolution_m: float
    site_elevation_m: float             # also sent to Horizons as the site altitude
    skyline_max_deg: float              # highest point of the terrain horizon
    detailed_cached: bool               # detailed terrain already downloaded for this site


class Events(BaseModel):
    """First horizon crossing of each kind within the series (UTC), or null."""
    sunrise: str | None
    sunset: str | None
    earthrise: str | None
    earthset: str | None


class PowerPoint(BaseModel):
    t: str
    w: float           # electrical output of the lander's (or a 1 m², 30% reference) panel
    w_m2: float        # sunlight arriving on a flat panel per m² (0 in terrain shadow)


class CommsPoint(BaseModel):
    t: str
    visible: bool


class Window(BaseModel):
    start: date
    end: date
    start_time: str   # first landing hour that works: the suggested landing time (UTC)
    end_time: str     # last landing hour that works (UTC)


class Check(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    name: str
    pass_: bool = Field(alias="pass")
    detail: str


class EvaluateResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    site: SiteStats
    terrain: TerrainInfo
    sky: list[SkyPoint]
    events: Events
    power_w: list[PowerPoint]
    comms: list[CommsPoint]
    windows: list[Window] | None
    launch_estimate: date | None
    checks: list[Check]
    pass_: bool | None = Field(alias="pass")
    sources: list[str]
