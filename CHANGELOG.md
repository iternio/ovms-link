# CHANGELOG

## Version 2.3.1, 2026-07-20, `kezarjg`

- Fix: correct the inverted battery-power sign on smart 453/forfour (`SQ`) and smart
  ED/fortwo (`SE`). Both OVMS smart modules report `v.b.power` with the wrong sign —
  negative while driving (consuming), positive while charging — the opposite of the
  OVMS core / Iternio convention. ABRP uses `power` for consumption calibration, so it
  read consumption as regen and the calibrated reference consumption drifted toward zero
  (issue #40). `overrideMetricMap` now corrects `power` for these vehicles by keeping the
  module's power magnitude and taking its sign from `v.b.current`, which the same modules
  report correctly. This is self-healing: `v.b.current` is correct in both the current
  (buggy) and a future upstream-fixed firmware, so once the module's `v.b.power` sign is
  fixed the correction becomes a no-op — no plugin change needed to retire it. Only
  `power` is affected; `current`, `is_charging`, and `is_dcfc` are unchanged. Upstream
  firmware bugs filed separately against `vehicle_smarteq` and `vehicle_smarted`.

## Version 2.3.0, 2026-06-25, `kezarjg`

- Switched telemetry to batched bulk uploads (`/1/tlm/bulk`) behind a queue, with
  GPS-time gating so points are only sent once a valid UTC time is known.
- Reliability: the queue is cleared only when the API confirms success (HTTP 200
  *and* body `status: "ok"`), the in-flight batch is removed by identity, and queue
  overflow can no longer discard never-sent points — closing several data-loss paths.
- Session handling: a single level-based handler drives the four session events, so a
  `charge.stop` no longer kills the sampler mid-drive, a reboot while parked-and-charging
  resumes immediately, overlapping on+charging no longer double-subscribes, and
  `send(0)`/`send(1)` teardown is symmetric with setup.
- Charge-power deadband: charging-power changes under 1 kW no longer force a queued
  point, cutting the DC fast-charge point flood without losing SoC progression or the
  charge curve.
- Fixed AC-charge send cadence on Toyota e-TNGA (`SUBSOL`/`TOYBZ4X`): a momentarily-absent
  `is_parked` no longer throttles AC charging onto the stale-connection cadence.
- Restored median power/speed smoothing while driving; charging sends instantaneous power.
- Metrics: wired `capacity` and derived `soe`; `hvac_power` is now supplied only via
  vehicle overrides (incl. Toyota e-TNGA); fixed tyre pressure to read the `v.t.pressure` vector.
- Fixed a Nissan Leaf range-override bug.
- Added a unit-test suite (`lib/abrp.test.js`) covering the telemetry pipeline, cadence
  selector, metric derivations, and vehicle overrides.

## Version 2.2.0, 2025-05-21, `kezarjg`

- Introduced a centralized metricMap to define and compute telemetry parameters in a modular, declarative format.
- Added support for vehicle-specific metric overrides via new overrideMetricMap() function.
- New metrics added to the telemetry map:
  - `hvac_power`, `hvac_setpoint`, `cabin_temp`
  - Tire pressure metrics for all four wheels
  - `soe` (State of Energy)

## Version 2.1.0, 2024-09-24, `kezarjg`

- Programattically determine what vehicle metrics are supported and only add supported metrics to the telemetry object.
- Additional telemetry field sent to ABRP
  - `capacity`

## Version 2.0.1, 2023-01-02, `dteirney` and `Edwintenhaaf`

- Change to HTTPS for the ABRP API endpoint
- Associated instructions to setup the trusted root CA certificate for the ABRP
  API

## Version 2.0, 2022, `dteirney`

- Additional telemetry fields sent to ABRP
  - `is_dcfc`
  - `is_parked`
  - `kwh_charged`
  - `heading`
  - `odometer`
  - `est_battery_range`
- Nissan Leaf specific metrics used for SOC, SOH and estimated range
- Reduce bandwidth by only sending frequent data for calibration (every 10
  seconds) when the driving speed is greater than 70 kph
- Reduce bandwidth by changing the determination of a significant telemetry
  change to take into account whether the vehicle is charging, and only send if
  the power changes by more than 1 kW.
- Capture speed and power metrics every second and then send median based on the
  power reading for more accurate ABRP calibration of estimated km/kWh @ 110 kph
- Additional DEBUG logging included (off by default)
- Numerous code modifications to reduce use of module state within module
  functions

## Version 1.4, 2021, `Jason_ABRP`

- Update script so it can be running continuously
- Remove unneeded dependencies on multiple config items (Now only have to set
  token)
- Stability improvements

## Version 1.3, 2020, `inf0mike`

- Background on the OVMS forum at
  [Send live data to abrp](https://www.openvehicles.com/node/2375)
- Fix for rounding of fractional SOC causing abrp to report SOC off by 1
- Fix for altitude never being sent
- New convenience method to reset config to defaults

## Version 1.2

- based now on OVMS configuration to store user token, car model and url
- review messages sent during charge
- send a message when vehicle is on before moving to update abrp

## Version 1.1

- fixed the utc refreshing issue
- send notifications
- send live data only if necessary
- script eval abrp.resetConfig() => reset configuration to defaults
