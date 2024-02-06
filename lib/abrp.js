// https://docs.openvehicles.com/en/latest/userguide/scripting.html

// NOTE: const in duktape implementation is not much more than var offers
// https://wiki.duktape.org/postes5features
const DEBUG = false
const MIN_CALIBRATION_SPEED = 70 // kph
const OVMS_API_KEY = '32b2162f-9599-4647-8139-66e9f9528370'
const VERSION = '2.1.0-alpha'

/**
Creates a shallow copy of the provided object.
@param {Object} obj - The object to be cloned.
@returns {Object} - A new object that is a shallow copy of the input object.
*/
function clone(obj) {
  return Object.assign({}, obj)
}

/**
Checks if the provided value is null or undefined.
@param {*} value - The value to be checked.
@returns {boolean} - Returns true if the value is null or undefined, otherwise returns false.
*/
function isNil(value) {
  return value == null
}

function timestamp() {
  return new Date().toLocaleString()
}

/**
 * Creates a logger object with various logging functions.
 * 
 * @returns {Object} - An object with logging functions (log, debug, error, info, warn).
 */
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

/**
Creates a new object by omitting properties with null or undefined values from the provided object.
@param {Object} obj - The object from which properties with null or undefined values will be omitted.
@returns {Object} - A new object that is a clone of the input object with null or undefined properties omitted.
*/
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

/**
Rounds the given number to the specified precision.
@param {number} number - The number to be rounded.
@param {number} [precision] - The desired precision (number of decimal places) for the rounded result. Defaults to 0 if not provided.
@returns {number} - The rounded number, or the original number if it is 0, null, or undefined.
*/
function round(number, precision) {
  if (!number) {
    return number // could be 0, null or undefined
  }
  return Number(number.toFixed(precision || 0))
}

/**
Calculates the median power metric from the given array of readings.
@param {Array} array - An array of readings containing power metrics.
@returns {Object|null} - The median power metric reading, or null if the input array is empty.
*/
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

/**
Collects high-frequency metrics for power and speed and stores them in the collectedMetrics array.
*/
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

/**
 * Retrieves the ABRP configuration values for the user.
 * 
 * @returns {object} The ABRP configuration object containing user-specific values.
 */
function getUsrAbrpConfig() {
  return OvmsConfig.GetValues('usr', 'abrp.')
}

/**
Determines if a telemetry change is significant based on a comparison between current and previous telemetry data.
@param {Object} currentTelemetry - The current telemetry data object.
@param {Object} previousTelemetry - The previous telemetry data object.
@returns {boolean} - Returns true if the telemetry change is considered significant, false otherwise.
*/
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

/**
Checks if all the required metrics are supported by the OvmsMetrics system.
@param {Array} requiredMetrics - An array of required metric names to be checked.
@returns {boolean} - Returns true if all the required metrics are supported, false otherwise.
*/
function isOvmsMetricSupported(requiredMetrics) {
  for (var i = 0; i < requiredMetrics.length; i++) {
    if (!OvmsMetrics.HasValue(requiredMetrics[i])) {
      return false; // Return false if any metric is not supported
    }
  }
  return true; // All metrics are supported
}

/**
Retrieves the value of the specified OVMS metric parameter.
@param {string} parameter - The parameter name of the OVMS metric.
@returns {[boolean, any]} - Returns a two-element array. The first element indicates whether the metric is supported, and the second element is the metric value. If the parameter is unrecognized, the array will contain [false, null].
*/
function getOVMSMetric(parameter) {

  const vehicleType = OvmsMetrics.GetValues('v.type');

  // Set return values to default
  var isSupported = false;
  var value = null;

  // Initialize working variables 
  var requiredMetrics, metrics;

  // Implement case structure to handle each parameter
  switch (parameter) {

    case "utc":
      // utc [s]: Current UTC timestamp (epoch) in seconds (note, not milliseconds!)
      isSupported = true;
      value = Date.now() / 1000;
      break;

    case "soc":
      // soc [SoC %]: State of Charge of the vehicle (what's displayed on the dashboard of the vehicle is preferred)
      // 'v.b.soc' - State of charge [%]

      switch (vehicleType) {
        case 'NL':
          requiredMetrics = ['xnl.v.b.soc.instrument'];
          isSupported = isOvmsMetricSupported(requiredMetrics);

          if (isSupported) {
            metrics = OvmsMetrics.GetValues(requiredMetrics);
            value = metrics['xnl.v.b.soc.instrument'];
          }
          break;

        default:
          requiredMetrics = ['v.b.soc'];
          isSupported = isOvmsMetricSupported(requiredMetrics);

          if (isSupported) {
            metrics = OvmsMetrics.GetValues(requiredMetrics);
            value = metrics['v.b.soc'];
          }
          break;
      }
      break;

    case "power":
      // power [kW]: Instantaneous power output/input to the vehicle. Power output is positive, power input is negative (charging)
      // 'v.b.power' - Main battery momentary power [kW] (output=positive)
      requiredMetrics = ['v.b.power'];
      isSupported = isOvmsMetricSupported(requiredMetrics);

      if (isSupported) {
        metrics = OvmsMetrics.GetValues(requiredMetrics);
        value = metrics['v.b.power'];
      }
      break;

    case "speed":
      // speed [km/h]: Vehicle speed
      // 'v.p.speed' - Vehicle speed [kph]
      requiredMetrics = ['v.p.speed'];
      isSupported = isOvmsMetricSupported(requiredMetrics);

      if (isSupported) {
        metrics = OvmsMetrics.GetValues(requiredMetrics);
        value = metrics['v.p.speed'];
      }
      break;

    case "lat":
      // lat [°]: Current vehicle latitude
      // 'v.p.latitude'
      requiredMetrics = ['v.p.latitude'];
      isSupported = isOvmsMetricSupported(requiredMetrics);

      if (isSupported) {
        metrics = OvmsMetrics.GetValues(requiredMetrics);
        value = metrics['v.p.latitude'];
      }
      break;

    case "lon":
      // lon [°]: Current vehicle longitude
      // 'v.p.longitude'
      requiredMetrics = ['v.p.longitude'];
      isSupported = isOvmsMetricSupported(requiredMetrics);

      if (isSupported) {
        metrics = OvmsMetrics.GetValues(requiredMetrics);
        value = metrics['v.p.longitude'];
      }
      break;

    case "is_charging":
      // is_charging [bool or 1/0]: Determines vehicle state. 0 is not charging, 1 is charging
      // 'v.c.charging' - True = currently charging
      switch (vehicleType) {
        case 'NL':
          // 'v.c.state' - charging, topoff, done, prepare, timerwait, heating, stopped
          requiredMetrics = ['v.c.state'];
          isSupported = isOvmsMetricSupported(requiredMetrics);
          if (isSupported) {
            var chargingStates = ['charging', 'topoff']
            metrics = OvmsMetrics.GetValues(requiredMetrics);
            // Array.prototype.includes() not supported in duktape
            // TODO: confirm if is_charging is supposed to be true if regenerative braking is
            // charging the battery.
            value = chargingStates.indexOf(metrics['v.c.state']) > -1;
          }
          break;
        default:
          requiredMetrics = ['v.c.charging'];
          isSupported = isOvmsMetricSupported(requiredMetrics);

          if (isSupported) {
            metrics = OvmsMetrics.GetValues(requiredMetrics);
            value = metrics['v.c.charging'];
          }
          break;
      }
      break;

    case "is_dcfc":
      // is_dcfc [bool or 1/0]: If is_charging, indicate if this is DC fast charging
      // 'v.c.mode' - standard, range, performance, storage
      requiredMetrics = ['v.c.mode'];
      isSupported = isOvmsMetricSupported(requiredMetrics);

      if (isSupported) {
        metrics = OvmsMetrics.GetValues(requiredMetrics);
        value = metrics['v.c.mode'] === 'performance';
      }
      break;

    case "is_parked":
      // is_parked [bool or 1/0]: If the vehicle gear is in P (or the driver has left the car)
      // 'v.e.parktime'
      requiredMetrics = ['v.e.parktime'];
      isSupported = isOvmsMetricSupported(requiredMetrics);

      if (isSupported) {
        metrics = OvmsMetrics.GetValues(requiredMetrics);
        value = metrics['v.e.parktime'] > 0;
      }
      break;

    case "capacity":
      // capacity [kWh]: Estimated usable battery capacity (can be given together with soh, but usually not)
      // 'v.b.cac' - Calculated capacity [Ah]
      // 'v.b.voltage.nominal' - TODO: This metric doesn't exist yet
      requiredMetrics = ['v.b.cac', 'v.b.voltage.nominal'];
      isSupported = isOvmsMetricSupported(requiredMetrics);

      if (isSupported) {
        metrics = OvmsMetrics.GetValues(requiredMetrics);
        value = metrics['v.b.cac'] * metrics['v.b.voltage.nominal'];
      }
      break;

    case "kwh_charged":
      // kwh_charged [kWh]: Measured energy input while charging. Typically a cumulative total, but also supports individual sessions.
      // 'v.c.charging' - True = currently charging
      // 'v.c.kwh' - Energy sum for running charge [kWh]
      requiredMetrics = ['v.c.charging', 'v.c.kwh'];
      isSupported = isOvmsMetricSupported(requiredMetrics);

      if (isSupported) {
        metrics = OvmsMetrics.GetValues(requiredMetrics);
        value = metrics['v.c.charging'] ? metrics['v.c.kwh'] : 0;
      }
      break;

    case "soh":
      // soh [%]: State of Health of the battery. 100 = no degradation
      // 'v.b.soh' - State of health [%]

      switch (vehicleType) {
        case 'NL':
          requiredMetrics = ['xnl.v.b.soh.instrument'];
          isSupported = isOvmsMetricSupported(requiredMetrics);
          if (isSupported) {
            metrics = OvmsMetrics.GetValues(requiredMetrics);
            value = metrics['xnl.v.b.soh.instrument'];
          }
          break;

        default:
          requiredMetrics = ['v.b.soh'];
          isSupported = isOvmsMetricSupported(requiredMetrics);

          if (isSupported) {
            metrics = OvmsMetrics.GetValues(requiredMetrics);
            value = metrics['v.b.soh'];
          }
          break;
      }
      break;

    case "heading":
      // heading [°]: Current heading of the vehicle. This will take priority over phone heading, so don't include if not accurate.
      // 'v.p.direction'
      requiredMetrics = ['v.p.direction'];
      isSupported = isOvmsMetricSupported(requiredMetrics);

      if (isSupported) {
        metrics = OvmsMetrics.GetValues(requiredMetrics);
        value = metrics['v.p.direction'];
      }
      break;

    case "elevation":
      // elevation [m]: Vehicle's current elevation. If not given, will be looked up from location (but may miss 3D structures)
      // 'v.p.altitude'
      requiredMetrics = ['v.p.altitude'];
      isSupported = isOvmsMetricSupported(requiredMetrics);

      if (isSupported) {
        metrics = OvmsMetrics.GetValues(requiredMetrics);
        value = metrics['v.p.altitude'];
      }
      break;

    case "ext_temp":
      // ext_temp [°C]: Outside temperature measured by the vehicle
      // 'v.e.temp' - Ambient temperature [°C]
      requiredMetrics = ['v.e.temp'];
      isSupported = isOvmsMetricSupported(requiredMetrics);

      if (isSupported) {
        metrics = OvmsMetrics.GetValues(requiredMetrics);
        value = metrics['v.e.temp'];
      }
      break;

    case "batt_temp":
      // batt_temp [°C]: Battery temperature
      // 'v.b.temp' - Battery temperature [°C]
      requiredMetrics = ['v.b.temp'];
      isSupported = isOvmsMetricSupported(requiredMetrics);

      if (isSupported) {
        metrics = OvmsMetrics.GetValues(requiredMetrics);
        value = metrics['v.b.temp'];
      }
      break;

    case "voltage":
      // voltage [V]: Battery pack voltage
      // 'v.b.voltage' - Main battery momentary voltage [V]
      requiredMetrics = ['v.b.voltage'];
      isSupported = isOvmsMetricSupported(requiredMetrics);

      if (isSupported) {
        metrics = OvmsMetrics.GetValues(requiredMetrics);
        value = metrics['v.b.voltage'];
      }
      break;

    case "current":
      // current [A]: Battery pack current (similar to power: output is positive, input (charging) is negative.)
      // 'v.b.current' - Main battery momentary current [A] (output=positive)
      requiredMetrics = ['v.b.current'];
      isSupported = isOvmsMetricSupported(requiredMetrics);

      if (isSupported) {
        metrics = OvmsMetrics.GetValues(requiredMetrics);
        value = metrics['v.b.current'];
      }
      break;

    case "odometer":
      // odometer [km]: Current odometer reading in km.
      // 'v.p.odometer'
      requiredMetrics = ['v.p.odometer'];
      isSupported = isOvmsMetricSupported(requiredMetrics);

      if (isSupported) {
        metrics = OvmsMetrics.GetValues(requiredMetrics);
        value = metrics['v.p.odometer'];
      }
      break;

    case "est_battery_range":
      // est_battery_range [km]: Estimated remaining range of the vehicle (according to the vehicle)
      // 'v.b.range.est' - Estimated range [km]
      switch (vehicleType) {
        case 'NL':
          requiredMetrics = ['xnl.v.b.range.instrument', 'v.b.range.ideal'];
          isSupported = isOvmsMetricSupported(requiredMetrics);

          if (isSupported) {
            var instrumentRange, idealRange
            metrics = OvmsMetrics.GetValues(requiredMetrics);
            instrumentRange = round(metrics['xnl.v.b.range.instrument']) || 0;
            idealRange = round(metrics['v.b.range.ideal']);
            value = idealRange > 1.1 * instrumentRange ? idealRange : instrumentRange;
          }
          break;

        default:
          requiredMetrics = ['v.b.range.est'];
          isSupported = isOvmsMetricSupported(requiredMetrics);

          if (isSupported) {
            metrics = OvmsMetrics.GetValues(requiredMetrics);
            value = metrics['v.b.range.est'];
          }
          break;
      }
      break;

    default:
      // If an unrecognized parameter is received, it will return isSupported = false
      break;
  }

  return [isSupported, value];

}

/**
 * Creates a telemetry object with the specified parameters.
 * 
 * @returns {Object} The telemetry object containing the supported parameters and their values.
 */
function createTelemetry() {
  const IternioParameters = [
    "utc",
    "soc",
    "power",
    "speed",
    "lat",
    "lon",
    "is_charging",
    "is_dcfc",
    "is_parked",
    "capacity",
    "kwh_charged",
    "soh",
    "heading",
    "elevation",
    "ext_temp",
    "batt_temp",
    "voltage",
    "current",
    "odometer",
    "est_battery_range"
  ] 

  const telemetry = {};  // Creating an empty object to hold the telemetry data

  // Iterating over the parameters array and adding properties to the telemetry object
  var i, n;
  for (i = 0, n = IternioParameters.length; i < n; i++) {
    var result;
    var isSupported;
    var value;

    result = getOVMSMetric(IternioParameters[i]);

    isSupported = result[0];
    value = result[1];

    if (isSupported) {
      telemetry[IternioParameters[i]] = value;  // Add the value to the telemetry object
    }
  }

  return telemetry;  // Returning the telemetry object
}

/**
Sends telemetry data to the ABRP (A Better Routeplanner) API.
@param {Object} telemetry - The telemetry data to be sent to ABRP.
*/
function sendTelemetry(telemetry) {
  const config = getUsrAbrpConfig()
  const token = config.user_token
  if (!token) {
    console.error('config usr abrp.user_token not set')
    return
  }
  console.info('Sending telemetry to ABRP', telemetry)
  const url =
    'https://api.iternio.com/1/tlm/send?api_key=' +
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

/**
Sends telemetry data to ABRP (A Better Routeplanner) if necessary, based on specified conditions and timing considerations.
*/
function sendTelemetryIfNecessary() {
  const maxCalibrationTimeout = 5 // seconds
  const maxChargingTimeout = 30 * 60 // 30 minutes
  const staleConnectionTimeout = 3 * 60 // 3 minutes for OVMS API Key
  const staleConnectionTimeoutBuffer = 20 // seconds

  const currentTelemetry = createTelemetry();

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

/**
 * Validates the ABRP configuration for the user.
 * 
 * @returns {boolean} True if the configuration is valid, false otherwise.
 */
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

/**
Subscribes to high-frequency metric collection by subscribing to the 'ticker.1' PubSub channel.
If not already subscribed, the 'collectHighFrequencyMetrics' function is registered as the event handler for the subscription.
*/
function subscribeHighFrequency() {
  if (!subscribedHighFrequency) {
    console.debug('Subscribing to collectHighFrequencyMetrics')
    PubSub.subscribe('ticker.1', collectHighFrequencyMetrics)
  }
  subscribedHighFrequency = true
}

/**
 * Subscribes to low-frequency events for sending telemetry if necessary.
 * If not already subscribed, it subscribes to specific events ('ticker.10', 'vehicle.on', 'vehicle.off')
 * and calls the 'sendTelemetryIfNecessary' function.
 */
function subscribeLowFrequency() {
  if (!subscribedLowFrequency) {
    console.debug('Subscribing to sendTelemetryIfNecessary')
    PubSub.subscribe('ticker.10', sendTelemetryIfNecessary)
    PubSub.subscribe('vehicle.on', sendTelemetryIfNecessary)
    PubSub.subscribe('vehicle.off', sendTelemetryIfNecessary)
  }
  subscribedLowFrequency = true
}

/**
Unsubscribes from low-frequency metric collection by unsubscribing from the 'sendTelemetryIfNecessary' PubSub channel.
If already subscribed, the 'sendTelemetryIfNecessary' function is unregistered as the event handler for the subscription.
Additionally, it unsubscribes from high-frequency metric collection by calling the 'unsubscribeHighFrequency' function.
*/
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

/**
Unsubscribes from high-frequency metric collection by unsubscribing from the 'collectHighFrequencyMetrics' PubSub channel.
If already subscribed, the 'collectHighFrequencyMetrics' function is unregistered as the event handler for the subscription.
*/
function unsubscribeHighFrequency() {
  if (subscribedHighFrequency) {
    console.debug('Unsubscribing from collectHighFrequencyMetrics')
    PubSub.unsubscribe(collectHighFrequencyMetrics)
  }
  subscribedHighFrequency = false
}

/**
 * Executes a one-time telemetry sending process.
 * Validates the user's ABRP configuration, creates telemetry data, and sends it.
 */
function onetime() {
  if (!validateUsrAbrpConfig()) {
    return
  }
  const telemetry = createTelemetry();
  sendTelemetry(telemetry)
}

/**
 * Logs information about telemetry data to the console.
 * Retrieves telemetry data using the `createTelemetry` function and logs specific properties if they exist.
 */
function info() {
  const telemetry = createTelemetry();
  // space before units as per NIST guidelines https://physics.nist.gov/cuu/Units/checklist.html
  console.log('Plugin Version:   ' + VERSION);
  if (telemetry.hasOwnProperty("soc")) {
    console.log('State of Charge:  ' + telemetry.soc + ' %');
  }
  if (telemetry.hasOwnProperty("power")) {
    console.log('Battery Power:    ' + telemetry.power + ' kW');
  }
  if (telemetry.hasOwnProperty("speed")) {
    console.log('Vehicle Speed:    ' + telemetry.speed + ' kph');
  }
  if (telemetry.hasOwnProperty("lat")) {
    console.log('GPS Latitude:     ' + telemetry.lat + ' °');
  }
  if (telemetry.hasOwnProperty("lon")) {
    console.log('GPS Longitude:    ' + telemetry.lon + ' °');
  }
  if (telemetry.hasOwnProperty("is_charging")) {
    console.log('Charging:         ' + telemetry.is_charging);
  }
  if (telemetry.hasOwnProperty("is_dcfc")) {
    console.log('DC Fast Charging: ' + telemetry.is_dcfc);
  }
  if (telemetry.hasOwnProperty("is_parked")) {
    console.log('Parked:           ' + telemetry.is_parked);
  }
  if (telemetry.hasOwnProperty("capacity")) {
    console.log('Capacity          ' + telemetry.capacity + ' Ah');
  }
  if (telemetry.hasOwnProperty("kwh_charged")) {
    console.log('Charged kWh:      ' + telemetry.kwh_charged) + ' kWh';
  }
  if (telemetry.hasOwnProperty("soh")) {
    console.log('State of Health:  ' + telemetry.soh + ' %');
  }
  if (telemetry.hasOwnProperty("heading")) {
    console.log('GPS Heading:      ' + telemetry.heading + ' °');
  }
  if (telemetry.hasOwnProperty("elevation")) {
    console.log('GPS Elevation:    ' + telemetry.elevation + ' m');
  }
  if (telemetry.hasOwnProperty("ext_temp")) {
    console.log('External Temp:    ' + telemetry.ext_temp + ' °C');
  }
  if (telemetry.hasOwnProperty("batt_temp")) {
    console.log('Battery Temp:     ' + telemetry.batt_temp + ' °C');
  }
  if (telemetry.hasOwnProperty("voltage")) {
    console.log('Battery Voltage:  ' + telemetry.voltage + ' V');
  }
  if (telemetry.hasOwnProperty("current")) {
    console.log('Battery Current:  ' + telemetry.current + ' A');
  }
  if (telemetry.hasOwnProperty("odometer")) {
    console.log('Odometer:         ' + telemetry.odometer + ' km');
  }
  if (telemetry.hasOwnProperty("est_battery_range")) {
    console.log('Estimated Range:  ' + telemetry.est_battery_range + ' km');
  }
}

/**
 * Resets the ABRP configuration to default values.
 */
function resetConfig() {
  OvmsConfig.SetValues('usr', 'abrp.', {})
  OvmsNotify.Raise('info', 'usr.abrp.status', 'ABRP::usr abrp config reset')
}

/**
 * Controls the sending of data based on the provided `onoff` flag.
 * @param {boolean} onoff - Indicates whether to start or stop sending data.
 */
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
