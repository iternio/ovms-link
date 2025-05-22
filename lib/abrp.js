// https://docs.openvehicles.com/en/latest/userguide/scripting.html

// NOTE: const in duktape implementation is not much more than var offers
// https://wiki.duktape.org/postes5features

// Module constants
const OVMS_API_KEY = '32b2162f-9599-4647-8139-66e9f9528370'
const VERSION = '2.2.0'
const console = logger()

// Configuration constants
const DEBUG = false
const MIN_CALIBRATION_SPEED = 70 // kph

// Module variables
var collectedMetrics = []
var lastSentTelemetry = {
  utc: 0,
}
var subscribedLowFrequency = false
var subscribedHighFrequency = false

/**
 * metricMap defines a list of ABRP (A Better Routeplanner) metrics and their 
 *   corresponding OVMS (Open Vehicle Monitoring System) metrics.
 * 
 * Each entry in metricMap contains the following properties:
 * - key: A unique identifier for the metric from the Iternio Telemetry API.
 * - label: A descriptive name for the metric to be displayed in UI or logs.
 * - unit: (Optional) The unit of measurement for the metric.
 * - requiredMetrics: An array of OVMS metrics that are required to calculate the value of the metric.
 *     If requiredMetrics is empty, the metric is not supported or cannot be calculated from the available data.
 * - metric: A function that processes the telemetry data and returns the value for the metric.
 * 
 * Vehicle-Specific Implementations: 
 * A function called `overrideMetricMap` can be used to modify the default `metricMap` on startup, 
 *   allowing vehicle-specific implementations or adjustments to certain metrics.
 */
var metricMap = [
  { key: 'utc', label: 'UTC Timestamp', unit: 's' , requiredMetrics: ['m.time.utc'] ,
      metric: function(metrics) { return metrics['m.time.utc']; } },
  { key: 'soc', label: 'State of Charge', unit: '%' , requiredMetrics: ['v.b.soc'] ,
      metric: function(metrics) { return metrics['v.b.soc']; } },
  { key: 'power', label: 'Battery Power', unit: 'kW' , requiredMetrics: ['v.b.power'] ,
      metric: function(metrics) { return metrics['v.b.power']; } },
  { key: 'speed', label: 'Vehicle Speed', unit: 'kph' , requiredMetrics: ['v.p.speed'] ,
      metric: function(metrics) { return metrics['v.p.speed']; } },
  { key: 'lat', label: 'GPS Latitude', unit: '°' , requiredMetrics: ['v.p.latitude'] ,
      metric: function(metrics) { return metrics['v.p.latitude']; } },
  { key: 'lon', label: 'GPS Longitude', unit: '°' , requiredMetrics: ['v.p.longitude'] ,
      metric: function(metrics) { return metrics['v.p.longitude']; } },
  { key: 'is_charging', label: 'Charging' , requiredMetrics: ['v.c.charging'] ,
      metric: function(metrics) { return metrics['v.c.charging']; } },
  { key: 'is_dcfc', label: 'DC Fast Charging' , requiredMetrics: ['v.c.mode'] ,
      metric: function(metrics) { return metrics['v.c.mode'] === 'performance'; } },
  { key: 'is_parked', label: 'Parked' , requiredMetrics: ['v.e.parktime'] ,
      metric: function(metrics) { return metrics['v.e.parktime'] > 0; } },
  { key: 'capacity', label: 'Capacity', unit: 'kWh'  },
  { key: 'soe', label: 'Present Energy', unit: 'kWh'  },
  { key: 'soh', label: 'State of Health', unit: '%' , requiredMetrics: ['v.b.soh'] ,
      metric: function(metrics) { return metrics['v.b.soh']; } },
  { key: 'heading', label: 'GPS Heading', unit: '°' , requiredMetrics: ['v.p.direction'] ,
      metric: function(metrics) { return metrics['v.p.direction']; } },
  { key: 'elevation', label: 'GPS Elevation', unit: 'm' , requiredMetrics: ['v.p.altitude'] ,
      metric: function(metrics) { return metrics['v.p.altitude']; } },
  { key: 'ext_temp', label: 'External Temp', unit: '°C' , requiredMetrics: ['v.e.temp'] ,
      metric: function(metrics) { return metrics['v.e.temp']; } },
  { key: 'batt_temp', label: 'Battery Temp', unit: '°C' , requiredMetrics: ['v.b.temp'] ,
      metric: function(metrics) { return metrics['v.b.temp']; } },
  { key: 'voltage', label: 'Battery Voltage', unit: 'V' , requiredMetrics: ['v.b.voltage'] ,
      metric: function(metrics) { return metrics['v.b.voltage']; } },
  { key: 'current', label: 'Battery Current', unit: 'A' , requiredMetrics: ['v.b.current'] ,
      metric: function(metrics) { return metrics['v.b.current']; } },
  { key: 'odometer', label: 'Odometer', unit: 'km' , requiredMetrics: ['v.p.odometer'] ,
      metric: function(metrics) { return metrics['v.p.odometer']; } },
  { key: 'est_battery_range', label: 'Estimated Range', unit: 'km' , requiredMetrics: ['v.b.range.est'] ,
      metric: function(metrics) { return metrics['v.b.range.est']; } },
  { key: 'hvac_power', label: 'HVAC Power', unit: 'kW' , requiredMetrics: []  },
  { key: 'hvac_setpoint', label: 'HVAC Setpoint', unit: '°C' , requiredMetrics: ['v.e.cabinsetpoint'] ,
      metric: function(metrics) { return metrics['v.e.cabinsetpoint']; } },
  { key: 'cabin_temp', label: 'Cabin Temp', unit: '°C' , requiredMetrics: ['v.e.cabintemp'] ,
      metric: function(metrics) { return metrics['v.e.cabintemp']; } },
  { key: 'tire_pressure_fl', label: 'FL Tire Pressure', unit: 'kPa' , requiredMetrics: ['v.tp.fl.p'] ,
      metric: function(metrics) { return metrics['v.tp.fl.p']; } },
  { key: 'tire_pressure_fr', label: 'FR Tire Pressure', unit: 'kPa' , requiredMetrics: ['v.tp.fr.p'] ,
      metric: function(metrics) { return metrics['v.tp.fr.p']; } },
  { key: 'tire_pressure_rl', label: 'RL Tire Pressure', unit: 'kPa' , requiredMetrics: ['v.tp.rl.p'] ,
      metric: function(metrics) { return metrics['v.tp.rl.p']; } },
  { key: 'tire_pressure_rr', label: 'RR Tire Pressure', unit: 'kPa' , requiredMetrics: ['v.tp.rr.p'] ,
      metric: function(metrics) { return metrics['v.tp.rr.p']; } },
];

// Utility Functions

/**
 * Creates a shallow copy of the provided object.
 * @param {Object} obj - The object to be cloned.
 * @returns {Object} - A new object that is a shallow copy of the input object.
 */
function clone(obj) {
  return Object.assign({}, obj)
}

/**
 * Rounds the given number to the specified precision.
 * @param {number} number - The number to be rounded.
 * @param {number} [precision] - The desired precision (number of decimal places) for the rounded result. Defaults to 0 if not provided.
 * @returns {number} - The rounded number, or the original number if it is 0, null, or undefined.
 */
function round(number, precision) {
  if (!number) {
    return number // could be 0, null or undefined
  }
  return Number(number.toFixed(precision || 0))
}

/**
 * Returns the current date and time as a localized string.
 */ 
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
 * Calculates the median power metric from the given array of readings.
 * @param {Array} array - An array of readings containing power metrics.
 * @returns {Object|null} - The median power metric reading, or null if the input array is empty.
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
 * Checks if the provided value is null or undefined.
 * @param {*} value - The value to be checked.
 * @returns {boolean} - Returns true if the value is null or undefined, otherwise returns false.
 */
function isNil(value) {
  return value == null
}

/**
 * Creates a new object by omitting properties with null or undefined values from the provided object.
 * @param {Object} obj - The object from which properties with null or undefined values will be omitted.
 * @returns {Object} - A new object that is a clone of the input object with null or undefined properties omitted.
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
 * Retrieves the ABRP configuration values for the user.
 * 
 * @returns {object} The ABRP configuration object containing user-specific values.
 */
function getUsrAbrpConfig() {
  return OvmsConfig.GetValues('usr', 'abrp.')
}

// Telemetry and Metric Functions

/**
 * Updates the `metricMap` based on the vehicle type retrieved from the OvmsMetrics service.
 * Additional cases for other vehicle types can be added as needed.
 */
function overrideMetricMap() {
  console.debug("Running overrideMetricMap...");

  var vehicleType = OvmsMetrics.Value('v.type');
  console.debug("Vehicle type: " + vehicleType);

  metricMap.forEach(function(entry) {
    switch (vehicleType) {
      case 'KS':
        // Kia Soul has an OVMS bug for calculating SOH. This removes it from being reported.
        if (entry.key === 'soh') {
          delete entry.requiredMetrics;
          delete entry.metric;
        }
        break;
      case 'NL':
        if (entry.key === 'soc') {
          entry.requiredMetrics = ['xnl.v.b.soc.instrument'];
          entry.metric = function(metrics) { 
            return metrics['xnl.v.b.soc.instrument']; 
          };
        }
        if (entry.key === 'soh') {
            entry.requiredMetrics = ['xnl.v.b.soh.instrument'];
            entry.metric = function(metrics) { 
              return metrics['xnl.v.b.soh.instrument']; 
            };
          }
        if (entry.key === 'est_battery_range') {
          entry.requiredMetrics = ['xnl.v.b.range.instrument', 'v.b.range.ideal'];
          entry.metric = function(metrics) {
            instrumentRange = metrics['xnl.v.b.range.instrument'] || 0;
            idealRange = metrics['v.b.range.ideal'];
            return idealRange > 1.1 * instrumentRange ? idealRange : instrumentRange; 
          };
        }
        break;
      case 'SUBSOL':
      case 'TOYBZ4X':
        if (entry.key === 'is_parked') {
          entry.requiredMetrics = ['v.e.gear'];
          entry.metric = function(metrics) { 
            return metrics['v.e.gear'] === 0; 
          };
        }
        break;
      // Add cases for other vehicle types as needed
    }
  });
}

/**
 * Checks if all the required metrics are supported by the OvmsMetrics system.
 * @param {Array} requiredMetrics - An array of required metric names to be checked.
 * @returns {boolean} - Returns true if all the required metrics are supported, false otherwise.
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
 * Retrieves the value of the specified OVMS metric parameter.
 * @param {string} parameter - The parameter name of the OVMS metric.
 * @returns {[boolean, any]} - Returns a two-element array. The first element indicates whether the metric is supported, and the second element is the metric value. If the parameter is unrecognized, the array will contain [false, null].
 */
function getOVMSMetric(parameter) {
  // Search through metricMap to find the matching entry
  var telemetryEntry = null;
  for (var i = 0; i < metricMap.length; i++) {
    if (metricMap[i].key === parameter) {
      telemetryEntry = metricMap[i];
      break;
    }
  }

  if (telemetryEntry) {
    // If requiredMetrics is an empty array, return unsupported
    if (!telemetryEntry.requiredMetrics || telemetryEntry.requiredMetrics.length === 0) {
      return [false, null];
    }

    // Check if all required metrics are supported
    var isSupported = isOvmsMetricSupported(telemetryEntry.requiredMetrics);

    if (isSupported) {
      // Retrieve the metrics values
      var metrics = OvmsMetrics.GetValues(telemetryEntry.requiredMetrics);
      var value = telemetryEntry.metric(metrics); // Pass metrics
      return [true, value];
    } else {
      return [false, null];
    }
  } else {
    // If the parameter is not found in metricMap, return [false, null]
    return [false, null];
  }
}

/**
 * Creates a telemetry object with the specified parameters.
 * 
 * @returns {Object} The telemetry object containing the supported parameters and their values.
 */
function createTelemetry() {
  var startTime = performance.now();  // Start timer
  var telemetry = {};  // Creating an empty object to hold the telemetry data

  // Use metricMap to fetch and store telemetry data
  metricMap.forEach(function(entry) {
    var key = entry.key;
    
    var result = getOVMSMetric(key);  // Fetch the metric for the current key
    var isSupported = result[0];
    var value = result[1];

    if (isSupported) {
      telemetry[key] = value;  // Add the value to the telemetry object
    }
  });

  var duration = performance.now() - startTime;  // Calculate duration
  if (duration > 500) {
    console.warn("Metrics collected. Finished in " + duration.toFixed(2) + " ms");
  }

  return telemetry;  // Returning the telemetry object
}

/**
 * Determines if a telemetry change is significant based on a comparison between current and previous telemetry data.
 * @param {Object} currentTelemetry - The current telemetry data object.
 * @param {Object} previousTelemetry - The previous telemetry data object.
 * @returns {boolean} - Returns true if the telemetry change is considered significant, false otherwise.
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
 * Collects high-frequency metrics for power and speed and stores them in the collectedMetrics array.
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
 * Sends telemetry data to ABRP (A Better Routeplanner) if necessary, based on specified conditions and timing considerations.
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

// Queue Processing and Data Transmission

/**
 * Sends telemetry data to the ABRP (A Better Routeplanner) API.
 * @param {Object} telemetry - The telemetry data to be sent to ABRP.
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

// Event Handlers

/**
 * Subscribes to high-frequency metric collection by subscribing to the 'ticker.1' PubSub channel.
 * If not already subscribed, the 'collectHighFrequencyMetrics' function is registered as the event handler for the subscription.
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
 * Unsubscribes from low-frequency metric collection by unsubscribing from the 'sendTelemetryIfNecessary' PubSub channel.
 * If already subscribed, the 'sendTelemetryIfNecessary' function is unregistered as the event handler for the subscription.
 * Additionally, it unsubscribes from high-frequency metric collection by calling the 'unsubscribeHighFrequency' function.
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
 * Unsubscribes from high-frequency metric collection by unsubscribing from the 'collectHighFrequencyMetrics' PubSub channel.
 * If already subscribed, the 'collectHighFrequencyMetrics' function is unregistered as the event handler for the subscription.
 */
function unsubscribeHighFrequency() {
  if (subscribedHighFrequency) {
    console.debug('Unsubscribing from collectHighFrequencyMetrics')
    PubSub.unsubscribe(collectHighFrequencyMetrics)
  }
  subscribedHighFrequency = false
}

// Core Control Functions

/**
 * Logs telemetry data to the console.
 */
function info() {
  var telemetry = createTelemetry();

  // Helper function for formatting output
  function logTelemetry(key, label, unit) {
    unit = unit || '';  // Default to empty string if unit is not provided
    if (telemetry.hasOwnProperty(key)) {
      console.log(label + ': ' + telemetry[key] + ' ' + unit);
    }
  }

  // Display plugin version
  console.log('Plugin Version: ' + VERSION);

  // Iterate over metricMap and display values if available
  metricMap.forEach(function(item) {
    logTelemetry(item.key, item.label, item.unit);
  });
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

/**
 * Resets the ABRP configuration to default values.
 */
function resetConfig() {
  OvmsConfig.SetValues('usr', 'abrp.', {})
  OvmsNotify.Raise('info', 'usr.abrp.status', 'ABRP::usr abrp config reset')
}

// Main Initialization Logic
PubSub.subscribe('vehicle.type.set', overrideMetricMap);
overrideMetricMap();

// Module exports
module.exports = {
  medianPowerMetrics, // jest
  omitNil, // jest
  info,
  onetime,
  send,
  resetConfig,
  round, // jest
}
