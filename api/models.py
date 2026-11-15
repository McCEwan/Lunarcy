"""Request and response shapes for /evaluate (see docs/ARCHITECTURE.md)."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

MAX_PERIOD_DAYS = 366
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
    # Analysis period (inclusive UTC dates). One day = start only (or start == end).
    period_start: date | None = None
    period_end: date | None = None

    @model_validator(mode="after")
    def check_period(self):
        if self.period_end and not self.period_start:
            raise ValueError("period_end needs period_start")
        if self.period_start:
            end = self.period_end or self.period_start
            if end < self.period_start:
                raise ValueError("period_end is before period_start")
            if (end - self.period_start).days + 1 > MAX_PERIOD_DAYS:
                raise ValueError(f"the analysis period can be at most {MAX_PERIOD_DAYS} days")
            for d in (self.period_start, end):
                if not (EPHEMERIS_START <= d <= EPHEMERIS_END):
                    raise ValueError(f"period dates must be between {EPHEMERIS_START} and {EPHEMERIS_END}")
        return self

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


class FindRequest(BaseModel):
    """Mission requirements for the landing-site finder (api/finder.py)."""
    period_start: date
    period_end: date
    min_sun_pct: float = Field(0, ge=0, le=100)
    min_earth_pct: float = Field(0, ge=0, le=100)
    min_avg_w_m2: float = Field(0, ge=0, le=1361)    # mean sunlight on a flat panel over the period
    max_slope_deg: float = Field(15, ge=0, le=90)
    region: Literal["all", "south", "north", "nearside", "farside"] = "all"
    # Mission goal (api/finder.GOALS). "ice_craters" adds the ice map and a distance limit.
    goal: Literal["ice_craters"] | None = None
    max_ice_km: float = Field(50, ge=1, le=1000)    # landing site to the nearest ice candidate

    @model_validator(mode="after")
    def check_dates(self):
        if self.period_end < self.period_start:
            raise ValueError("period_end is before period_start")
        if (self.period_end - self.period_start).days + 1 > MAX_PERIOD_DAYS:
            raise ValueError(f"the period can be at most {MAX_PERIOD_DAYS} days")
        for d in (self.period_start, self.period_end):
            if not (EPHEMERIS_START <= d <= EPHEMERIS_END):
                raise ValueError(f"dates must be between {EPHEMERIS_START} and {EPHEMERIS_END}")
        return self


class SiteStats(BaseModel):
    slope_deg: float | None
    slope_baseline_m: float | None      # distance the slope was measured over
    elevation_m: float | None
    temp_range_k: list[float] | None
    sunlight_pct: float                 # Sun above the terrain horizon
    earth_visible_pct: float            # Earth above the terrain horizon
    sunlight_pct_flat: float            # same, ignoring terrain (smooth-sphere horizon)
    earth_visible_pct_flat: float
    sun_hours: float                    # hours of the analysis period with the Sun visible
    earth_hours: float                  # hours with Earth visible (direct-to-Earth comms)
    sun_hours_flat: float
    earth_hours_flat: float


class Period(BaseModel):
    kind: Literal["day", "range", "mission", "lunar_day"]
    start: str                          # UTC, inclusive
    end: str                            # UTC, exclusive
    hours: float


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
    period: Period
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
