// https://docs.openvehicles.com/en/latest/userguide/scripting.html

// NOTE: const in duktape implementation is not much more than var offers
// https://wiki.duktape.org/postes5features
const DEBUG = false
const MIN_CALIBRATION_SPEED = 30 // kph
const OVMS_API_KEY = '32b2162f-9599-4647-8139-66e9f9528370'
const VERSION = '2.0'

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
    if (isNil(cloned[key])) {
      delete cloned[key]
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

function medianPowerMetrics(array) {
  if (!array.length) {
    return null
  }
  // Find the median based on the power metric
  const sorted = array.slice().sort(function (a, b) {
    return a.power - b.power
  })
  const midpoint = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    // Don't try and average the readings as they could have been some seconds
    // apart. Simply return the reading closest to the sorted middle with the
    // lower power reading.
    return sorted[midpoint - 1]
  } else {
    return sorted[midpoint]
  }
}

const console = logger()
var collectedMetrics = []
var lastSentTelemetry = {
  utc: 0,
}
var subscribedLowFrequency = false
var subscribedHighFrequency = false

function collectHighFrequencyMetrics() {
  const highFrequencyMetricNames = ['v.b.power', 'v.p.speed']
  const metrics = OvmsMetrics.GetValues(highFrequencyMetricNames)
  const power = metrics['v.b.power']
  const speed = metrics['v.p.speed']
  if (!isNil(power) && !isNil(speed)) {
    collectedMetrics.push({
      power,
      speed,
    })
  }
}

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
    // Nissan Leaf specific metrics
    'xnl.v.b.range.instrument',
    'xnl.v.b.soc.instrument',
    'xnl.v.b.soh.instrument',
  ]
  return OvmsMetrics.GetValues(metricNames)
}

function getUsrAbrpConfig() {
  return OvmsConfig.GetValues('usr', 'abrp.')
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
  // Significant change if the power changes by more than 1 kW while charging.
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
  // TODO: confirm if is_charging is supposed to be true if regenerative braking is
  // charging the battery.
  const is_charging = chargingStates.indexOf(metrics['v.c.state']) > -1
  // The instrument range reported by the Nissan Leaf OVMS metrics doesn't
  // appear to update when the car is parked and then charged. So, use the
  // generic vehicle ideal range when it's more than 10% of the reported
  // instrument range.
  const instrumentRange = round(metrics['xnl.v.b.range.instrument']) || 0
  const idealRange = round(metrics['v.b.range.ideal'])
  // https://documenter.getpostman.com/view/7396339/SWTK5a8w
  const telemetry = {
    utc: round(Date.now() / 1000),
    soc: round(metrics['xnl.v.b.soc.instrument']) || round(metrics['v.b.soc']),
    power: round(metrics['v.b.power'], 2), // ~ nearest 10W of precision
    speed: round(metrics['v.p.speed']),
    lat: round(metrics['v.p.latitude'], 5), // ~1.11 m of precision
    lon: round(metrics['v.p.longitude'], 5), // ~1.11 m of precision
    is_charging,
    is_dcfc: is_charging && dcfcMode === metrics['v.c.mode'],
    is_parked: metrics['v.e.parktime'] > 0,
    kwh_charged: is_charging ? round(metrics['v.c.kwh'], 1) : 0,
    soh: round(metrics['xnl.v.b.soh.instrument']) || round(metrics['v.b.soh']),
    heading: round(metrics['v.p.direction'], 1),
    elevation: round(metrics['v.p.altitude'], 1),
    ext_temp: round(metrics['v.e.temp']),
    batt_temp: round(metrics['v.b.temp']),
    voltage: round(metrics['v.b.voltage']),
    current: round(metrics['v.b.current'], 1),
    odometer: round(metrics['v.p.odometer']),
    est_battery_range:
      idealRange > 1.1 * instrumentRange ? idealRange : instrumentRange,
  }
  // console.debug('Mapped ABRP telemetry', telemetry)
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
  console.info('Sending telemetry to ABRP', telemetry)
  const url =
    'http://api.iternio.com/1/tlm/send?api_key=' +
    encodeURIComponent(OVMS_API_KEY) +
    '&token=' +
    encodeURIComponent(token) +
    '&tlm=' +
    encodeURIComponent(JSON.stringify(telemetry))
  HTTP.Request({
    done: function (response) {
      if (response.statusCode !== 200) {
        console.warn('Non 200 response from ABRP', response)
      }
    },
    fail: function (error) {
      console.error('ABRP error', error)
    },
    url,
  })
}

function sendTelemetryIfNecessary() {
  const maxCalibrationTimeout = 5 // seconds
  const maxChargingTimeout = 30 * 60 // 30 minutes
  const staleConnectionTimeout = 3 * 60 // 3 minutes for OVMS API Key
  const staleConnectionTimeoutBuffer = 20 // seconds

  const metrics = getOvmsMetrics()
  const currentTelemetry = mapMetricsToTelemetry(metrics)

  // If being collected, somewhat smooth the point in time power and speed
  // reported using the metrics for the median power entry from those collected
  // at a higher frequency
  if (collectedMetrics.length) {
    console.debug('Collected metrics', collectedMetrics)
    const medianMetrics = medianPowerMetrics(collectedMetrics)
    if (!isNil(medianMetrics)) {
      console.debug('Median power metrics', medianMetrics)
      currentTelemetry.power = round(medianMetrics.power, 2) // ~ nearest 10W of precision
      currentTelemetry.speed = round(medianMetrics.speed)
    }
    // And then clear the collected metrics for the next low frequency pass
    collectedMetrics = []
  }

  const elapsed = currentTelemetry.utc - lastSentTelemetry.utc
  var maxElapsedDuration
  if (isSignificantTelemetryChange(currentTelemetry, lastSentTelemetry)) {
    console.info('Significant telemetry change')
    maxElapsedDuration = 0 // always send
  } else if (currentTelemetry.speed > MIN_CALIBRATION_SPEED) {
    console.info('Speed greater than minimum calibration speed')
    maxElapsedDuration = maxCalibrationTimeout
  } else if (!currentTelemetry.is_parked || currentTelemetry.is_dcfc) {
    console.info('Not parked or DC fast charging')
    maxElapsedDuration = staleConnectionTimeout - staleConnectionTimeoutBuffer
  } else if (currentTelemetry.is_charging) {
    console.info('Standard charging')
    // Only needed if SOC significant change doesn't trigger
    maxElapsedDuration = maxChargingTimeout
  } else {
    // Don't keep the modem connection live just for the sake of sending data.
    // Only very periodically send an update if the car is simply parked
    // somewhere.
    maxElapsedDuration = 24 * 3600 // 24 hours
  }

  if (elapsed >= maxElapsedDuration) {
    sendTelemetry(currentTelemetry)
    lastSentTelemetry = clone(currentTelemetry)
  }
  // Subscribe to high frequency metric collection only if not parked
  if (currentTelemetry.is_parked) {
    unsubscribeHighFrequency()
  } else {
    subscribeHighFrequency()
  }
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

function subscribeHighFrequency() {
  if (!subscribedHighFrequency) {
    console.debug('Subscribing to collectHighFrequencyMetrics')
    PubSub.subscribe('ticker.1', collectHighFrequencyMetrics)
  }
  subscribedHighFrequency = true
}

function subscribeLowFrequency() {
  if (!subscribedLowFrequency) {
    console.debug('Subscribing to sendTelemetryIfNecessary')
    PubSub.subscribe('ticker.10', sendTelemetryIfNecessary)
    PubSub.subscribe('vehicle.on', sendTelemetryIfNecessary)
    PubSub.subscribe('vehicle.off', sendTelemetryIfNecessary)
  }
  subscribedLowFrequency = true
}

function unsubscribeLowFrequency() {
  if (subscribedLowFrequency) {
    // unsubscribe can be passed the subscription identifier or the function
    // reference to unsubscribe from all events using that handler
    console.debug('Unsubscribing from sendTelemetryIfNecessary')
    PubSub.unsubscribe(sendTelemetryIfNecessary)
  }
  subscribedLowFrequency = false
  // Also unsubscribe from high frequency
  unsubscribeHighFrequency()
}

function unsubscribeHighFrequency() {
  if (subscribedHighFrequency) {
    console.debug('Unsubscribing from collectHighFrequencyMetrics')
    PubSub.unsubscribe(collectHighFrequencyMetrics)
  }
  subscribedHighFrequency = false
}

// API method abrp.onetime():
function onetime() {
  if (!validateUsrAbrpConfig()) {
    return
  }
  const metrics = getOvmsMetrics()
  const telemetry = mapMetricsToTelemetry(metrics)
  sendTelemetry(telemetry)
}

// API method abrp.info():
function info() {
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
function resetConfig() {
  OvmsConfig.SetValues('usr', 'abrp.', {})
  OvmsNotify.Raise('info', 'usr.abrp.status', 'ABRP::usr abrp config reset')
}

// API method abrp.send():
function send(onoff) {
  if (onoff) {
    if (!validateUsrAbrpConfig()) {
      return
    }
    if (subscribedLowFrequency) {
      console.warn('Already running !')
      return
    }
    console.info('Start sending data...')
    subscribeLowFrequency()
    OvmsNotify.Raise('info', 'usr.abrp.status', 'ABRP::started')
  } else {
    if (!subscribedLowFrequency) {
      console.warn('Already stopped !')
      return
    }
    console.info('Stop sending data')
    unsubscribeLowFrequency()
    OvmsNotify.Raise('info', 'usr.abrp.status', 'ABRP::stopped')
  }
}

module.exports = {
  medianPowerMetrics, // jest
  omitNil, // jest
  info,
  onetime,
  send,
  resetConfig,
  round, // jest
}
