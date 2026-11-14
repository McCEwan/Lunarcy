import os

# Tests never hit the network: force the offline ephemeris before api.main is imported.
os.environ.setdefault("EPHEMERIS", "analytic")
