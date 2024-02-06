# CHANGELOG

## Version 2.1.0, 2023-XX-XX, `kezarjg`

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
