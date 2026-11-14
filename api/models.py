"""Request and response shapes for /evaluate (see docs/ARCHITECTURE.md)."""

from __future__ import annotations

from datetime import date, datetime, timezone

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
    elevation_m: float | None
    temp_range_k: list[float] | None
    sunlight_pct: float
    earth_visible_pct: float


class SkyPoint(BaseModel):
    t: str
    sun_el: float
    sun_az: float      # degrees from north, through east
    earth_el: float
    earth_az: float


class Events(BaseModel):
    """First horizon crossing of each kind within the series (UTC), or null."""
    sunrise: str | None
    sunset: str | None
    earthrise: str | None
    earthset: str | None


class PowerPoint(BaseModel):
    t: str
    w: float


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
    sky: list[SkyPoint]
    events: Events
    power_w: list[PowerPoint]
    comms: list[CommsPoint]
    windows: list[Window] | None
    launch_estimate: date | None
    checks: list[Check]
    pass_: bool | None = Field(alias="pass")
    sources: list[str]
