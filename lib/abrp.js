/**
 * Uses the embedded GSM of OVMS to periodically send vehicle telemetry (if
 * necessary) to ABRP, so there's an impact on GSM data consumption.
 * /!\ requires OVMS firmware version 3.2.008-147 minimum (for HTTP call)
 *
 * Installation:
 *  - install this script to /store/scripts/lib/abrp.js
 *  - config set usr abrp.user_token "your-token-goes-here"
 *  - add to /store/scripts/ovmsmain.js:
 *        abrp = require("lib/abrp");
 *        abrp.send(1)
 *  - script reload
 *
 * Usage:
 *  - script eval abrp.info()         => to display vehicle telemetry that would be sent to ABRP
 *  - script eval abrp.onetime()      => to send current telemetry to ABRP
 *  - script eval abrp.send(1)        => start periodically sending telemetry (if necessary) to ABRP
 *  - script eval abrp.send(0)        => stop sending telemetry
 *  - script eval abrp.resetConfig()  => reset configuration
 **/

// https://docs.openvehicles.com/en/latest/userguide/scripting.html

// NOTE: const in duktape implementation is not much more than var offers
// https://wiki.duktape.org/postes5features
const DEBUG = true
const OVMS_API_KEY = '32b2162f-9599-4647-8139-66e9f9528370'
const VERSION = '1.5.0'

function clone(obj) {
  return Object.assign({}, obj)
}

function isNil(value) {
  return value == null
}

function timestamp() {
  return new Date().toLocaleString()
}

// simple console shim
function logger() {
  // TODO: timestamp for the log entry
  function log(message, obj) {
    print(message + (obj ? ' ' + JSON.stringify(obj) : '') + '\n')
  }

  function debug(message, obj) {
    if (DEBUG) {
      log('(' + timestamp() + ') DEBUG: ' + message, obj)
    }
  }

  function error(message, obj) {
    log('(' + timestamp() + ') ERROR: ' + message, obj)
  }

  function info(message, obj) {
    log('(' + timestamp() + ') INFO: ' + message, obj)
  }

  function warn(message, obj) {
    log('(' + timestamp() + ') WARN: ' + message, obj)
  }

  return {
    debug,
    error,
    info,
    log,
    warn,
  }
}

function omitNil(obj) {
  const cloned = clone(obj)
  const keys = Object.keys(cloned)
  keys.forEach(function (key) {
    if (isNil(clone[key])) {
      delete clone[key]
    }
  })
  return cloned
}

function round(number, precision) {
  if (!number) {
    return number // could be 0, null or undefined
  }
  return Number(number.toFixed(precision || 0))
}

const console = logger()
var previousTelemetry = {
  utc: 0,
}
var subscribed = false

function getOvmsMetrics() {
  const metricNames = [
    'v.b.current',
    'v.b.power',
    'v.b.range.ideal',
    'v.b.soc',
    'v.b.soh',
    'v.b.temp',
    'v.b.voltage',
    'v.c.kwh',
    'v.c.mode',
    'v.c.state', // v.c.charging is also true when regenerating, which isn't what is wanted
    'v.e.parktime',
    'v.e.temp',
    'v.p.altitude',
    'v.p.direction',
    'v.p.latitude',
    'v.p.longitude',
    'v.p.odometer',
    'v.p.speed',
  ]
  const started = performance.now()
  const metrics = OvmsMetrics.GetValues(metricNames)
  const duration = performance.now() - started
  console.debug('Getting OvmsMetrics took ' + round(duration) + 'ms', metrics)
  return metrics
}

function getUsrAbrpConfig() {
  const config = OvmsConfig.GetValues('usr', 'abrp.')
  console.debug('usr abrp. config', config)
  return config
}

function isSignificantTelemetryChange(currentTelemetry, previousTelemetry) {
  // Significant if the SOC changes so that it updates in ABRP as soon as
  // possible after it's changed within the vehicle.
  if (currentTelemetry.soc !== previousTelemetry.soc) {
    return true
  }
  // Significant change if either the is_parked or is_charging states changes
  if (currentTelemetry.is_charging !== previousTelemetry.is_charging) {
    return true
  }
  if (currentTelemetry.is_parked !== previousTelemetry.is_parked) {
    return true
  }
  // Significant change if the power changes by more than 1kW while charging.
  // Another piece of information that is clearly shown within ABRP so good
  // to be responsive to those changes in charging power.
  if (
    currentTelemetry.is_charging &&
    round(currentTelemetry.power) !== round(previousTelemetry.power)
  ) {
    return true
  }
  // Otherwise, updates purely based on timing considerations based on the
  // current state of the metrics and when the last telemetry was sent
  return false
}

function mapMetricsToTelemetry(metrics) {
  const chargingStates = ['charging', 'topoff']
  const dcfcMode = 'performance'
  // Array.prototype.includes() not supported in duktape
  // TODO: confirm if is_charging is supposed to be true if regen braking is
  // charging the battery.
  const is_charging = chargingStates.indexOf(metrics['v.c.state']) > -1
  // https://documenter.getpostman.com/view/7396339/SWTK5a8w
  const telemetry = {
    utc: round(Date.now() / 1000),
    soc: round(metrics['v.b.soc']),
    power: round(metrics['v.b.power'], 1), // ~ nearest 100W of precision
    speed: round(metrics['v.p.speed']),
    lat: round(metrics['v.p.latitude'], 5), // ~1.11 m of precision
    lon: round(metrics['v.p.longitude'], 5), // ~1.11 m of precision
    is_charging,
    is_dcfc: is_charging && dcfcMode === metrics['v.c.mode'],
    is_parked: metrics['v.e.parktime'] > 0,
    kwh_charged: is_charging ? round(metrics['v.c.kwh'], 1) : 0,
    soh: round(metrics['v.b.soh']),
    heading: round(metrics['v.p.direction'], 1),
    elevation: round(metrics['v.p.altitude'], 1),
    ext_temp: round(metrics['v.e.temp']),
    batt_temp: round(metrics['v.b.temp']),
    voltage: round(metrics['v.b.voltage']),
    current: round(metrics['v.b.current'], 1),
    odometer: round(metrics['v.p.odometer']),
    est_battery_range: round(metrics['v.b.range.ideal']),
  }
  console.debug('Mapped ABRP telemetry', telemetry)
  // Omit nil properties as ABRP doesn't appreciate getting them.
  return omitNil(telemetry)
}

function sendTelemetry(telemetry) {
  const config = getUsrAbrpConfig()
  const token = config.user_token
  if (!token) {
    console.error('config usr abrp.user_token not set')
    return
  }
  const url =
    'http://api.iternio.com/1/tlm/send?api_key=' +
    encodeURIComponent(OVMS_API_KEY) +
    '&token=' +
    encodeURIComponent(token) +
    '&tlm=' +
    encodeURIComponent(JSON.stringify(telemetry))
  console.debug('ABRP URL', url)
  HTTP.Request({
    done: function (response) {
      console.debug('ABRP response', response)
    },
    fail: function (error) {
      console.error('ABRP error', error)
    },
    url,
  })
}

function sendTelemetryIfNecessary() {
  const minCalibrationSpeed = 70 // kph
  const minDrivingSpeed = 5 // kph
  const maxCalibrationTimeout = 5 // seconds
  const maxLiveConnectionTimeout = 3 * 60 // 3 minutes
  const liveConnectionTimeoutBuffer = 20 // seconds

  const metrics = getOvmsMetrics()
  const currentTelemetry = mapMetricsToTelemetry(metrics)
  const isDriving = currentTelemetry.speed > minDrivingSpeed

  const elapsed = currentTelemetry.utc - previousTelemetry.utc
  var maxElapsedDuration
  if (isSignificantTelemetryChange(currentTelemetry, previousTelemetry)) {
    console.info('Significant telemetry change')
    maxElapsedDuration = 0 // always send
  } else if (isDriving && currentTelemetry.speed > minCalibrationSpeed) {
    console.info('Driving and speed greater than minimum calibration speed')
    maxElapsedDuration = maxCalibrationTimeout
  } else if (isDriving || currentTelemetry.is_dcfc) {
    console.info('Driving or DC fast charging')
    maxElapsedDuration = maxLiveConnectionTimeout - liveConnectionTimeoutBuffer
  } else {
    maxElapsedDuration = 30 * 60 // At least every 30 minutes
  }

  if (elapsed >= maxElapsedDuration) {
    sendTelemetry(currentTelemetry)
  }
  previousTelemetry = clone(currentTelemetry)
}

function validateUsrAbrpConfig() {
  const config = getUsrAbrpConfig()
  if (!config.user_token) {
    OvmsNotify.Raise(
      'error',
      'usr.abrp.status',
      'ABRP::config usr abrp.user_token not set'
    )
    return false
  }
  return true
}

function subscribe() {
  if (subscribed) {
    return
  }
  PubSub.subscribe('ticker.10', sendTelemetryIfNecessary)
  PubSub.subscribe('vehicle.on', sendTelemetryIfNecessary)
  PubSub.subscribe('vehicle.off', sendTelemetryIfNecessary)
  subscribed = true
}

function unsubscribe() {
  // unsubscribe can be passed the subscription identifier or the function
  // reference to unsubscribe from all events using that handler
  PubSub.unsubscribe(sendTelemetryIfNecessary)
  subscribed = false
}

// API method abrp.onetime():
//   Read and send data, but only once, no timer launched
exports.onetime = function () {
  if (!validateUsrAbrpConfig()) {
    return
  }
  const metrics = getOvmsMetrics()
  const telemetry = mapMetricsToTelemetry(metrics)
  sendTelemetry(telemetry)
}

// API method abrp.info():
//   Do not send any data, just read vehicle data and writes in the console
exports.info = function () {
  const metrics = getOvmsMetrics()
  const telemetry = mapMetricsToTelemetry(metrics)
  // space before units as per NIST guidelines https://physics.nist.gov/cuu/Units/checklist.html
  console.log('Plugin Version:   ' + VERSION)
  console.log('State of Charge:  ' + telemetry.soc + ' %')
  console.log('Battery Power:    ' + telemetry.power + ' kW')
  console.log('Vehicle Speed:    ' + telemetry.speed + ' kph')
  console.log('GPS Latitude:     ' + telemetry.lat + ' °')
  console.log('GPS Longitude:    ' + telemetry.lon + ' °')
  console.log('Charging:         ' + telemetry.is_charging)
  console.log('DC Fast Charging: ' + telemetry.is_dcfc)
  console.log('Parked:           ' + telemetry.is_parked)
  console.log('Charged kWh:      ' + telemetry.kwh_charged)
  console.log('State of Health:  ' + telemetry.soh + ' %')
  console.log('GPS Heading:      ' + telemetry.heading + ' °')
  console.log('GPS Elevation:    ' + telemetry.elevation + ' m')
  console.log('External Temp:    ' + telemetry.ext_temp + ' °C')
  console.log('Battery Temp:     ' + telemetry.batt_temp + ' °C')
  console.log('Battery Voltage:  ' + telemetry.voltage + ' V')
  console.log('Battery Current:  ' + telemetry.current + ' A')
  console.log('Odometer:         ' + telemetry.odometer + ' km')
  console.log('Estimated Range:  ' + telemetry.est_battery_range + ' km')
}

// API method abrp.resetConfig()
//   Resets stored config to default
exports.resetConfig = function () {
  OvmsConfig.SetValues('usr', 'abrp.', {})
  OvmsNotify.Raise('info', 'usr.abrp.status', 'ABRP::usr abrp. config reset')
}

// API method abrp.send():
//   Checks every minute if important data has changed, and send it
exports.send = function (onoff) {
  if (onoff) {
    if (!validateUsrAbrpConfig()) {
      return
    }
    if (subscribed) {
      console.warn('Already running !')
      return
    }
    console.info('Start sending data...')
    sendTelemetryIfNecessary()
    subscribe()
    OvmsNotify.Raise('info', 'usr.abrp.status', 'ABRP::started')
  } else {
    if (!subscribed) {
      console.warn('Already stopped !')
      return
    }
    console.info('Stop sending data')
    unsubscribe()
    OvmsNotify.Raise('info', 'usr.abrp.status', 'ABRP::stopped')
  }
}
