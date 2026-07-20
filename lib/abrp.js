// https://docs.openvehicles.com/en/latest/userguide/scripting.html

// NOTE: const in duktape implementation is not much more than var offers
// https://wiki.duktape.org/postes5features

// Module constants
const OVMS_API_KEY = '32b2162f-9599-4647-8139-66e9f9528370'
const VERSION = '2.3.1'
const Logger = logger()

// Configuration constants
const DEBUG = false
const BANDWIDTH_SAVER = false // When true, manual/bookend sends also apply median smoothing; the live path always smooths
const MIN_CALIBRATION_SPEED = 70 // kph
const METRIC_POLL_RATE_DRIVING = 5 // Poll rate during driving (s)
const METRIC_POLL_RATE_CHARGING = 30 * 60 // Poll rate during charging (s)
const CHARGE_POWER_DELTA_KW = 1 // while charging, ignore power swings smaller than this (kW) so DC fast-charge jitter doesn't force a point every sample; 0 keeps the old round() resolution. (current/voltage are not significance triggers in 2.x, so only power needs damping)
const METRIC_POLL_STALE_CONNECTION = (3 * 60) - 20// 3 minutes for OVMS API Key
const MAX_TELEMETRY_QUEUE_SIZE = 100
const MAX_BULK_BATCH_SIZE = 10 // max telemetry points per bulk POST

// Module variables
var user_token = (typeof OvmsConfig !== 'undefined')
  ? OvmsConfig.GetValues('usr', 'abrp.').user_token
  : undefined
var isTimeValid = false;
var isActive = false;
var isSampling = false;
var telemetryToSend = []
var collectedMetrics = []
var lastQueuedTelemetry = {
  utc: 0,
}
var subscriptions = {};
var isSending = false

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
  { key: 'capacity', label: 'Capacity', unit: 'kWh' , requiredMetrics: ['v.b.capacity'] ,
      metric: function(metrics) { return metrics['v.b.capacity']; } },
  { key: 'soe', label: 'Present Energy', unit: 'kWh' , requiredMetrics: ['v.b.soc', 'v.b.capacity'] ,
      metric: function(metrics) { return (metrics['v.b.soc'] / 100) * metrics['v.b.capacity']; } },
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
  // No generic OVMS source for HVAC power; supply via overrideMetricMap() on
  // vehicles that expose it (e.g. an x… extended metric). Unmapped => auto-skipped.
  { key: 'hvac_power', label: 'HVAC Power', unit: 'kW' , requiredMetrics: []  },
  { key: 'hvac_setpoint', label: 'HVAC Setpoint', unit: '°C' , requiredMetrics: ['v.e.cabinsetpoint'] ,
      metric: function(metrics) { return metrics['v.e.cabinsetpoint']; } },
  { key: 'cabin_temp', label: 'Cabin Temp', unit: '°C' , requiredMetrics: ['v.e.cabintemp'] ,
      metric: function(metrics) { return metrics['v.e.cabintemp']; } },
  // OVMS exposes tyre data as a vector metric; wheel order is fixed: FL=0, FR=1, RL=2, RR=3.
  { key: 'tire_pressure_fl', label: 'FL Tire Pressure', unit: 'kPa' , requiredMetrics: ['v.t.pressure'] ,
      metric: function(metrics) { return metrics['v.t.pressure'][0]; } },
  { key: 'tire_pressure_fr', label: 'FR Tire Pressure', unit: 'kPa' , requiredMetrics: ['v.t.pressure'] ,
      metric: function(metrics) { return metrics['v.t.pressure'][1]; } },
  { key: 'tire_pressure_rl', label: 'RL Tire Pressure', unit: 'kPa' , requiredMetrics: ['v.t.pressure'] ,
      metric: function(metrics) { return metrics['v.t.pressure'][2]; } },
  { key: 'tire_pressure_rr', label: 'RR Tire Pressure', unit: 'kPa' , requiredMetrics: ['v.t.pressure'] ,
      metric: function(metrics) { return metrics['v.t.pressure'][3]; } },
];

// Utility Functions

/**
 * Creates a shallow copy of the provided object.
 */
function clone(obj) {
  return Object.assign({}, obj)
}

/**
 * Rounds the given number to the specified precision.
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
  var sorted = array.slice().sort(function (a, b) {
    return a.power - b.power
  })
  var midpoint = Math.floor(sorted.length / 2)
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
  // If user_token is not set or empty, attempt to populate it
  if (!user_token) {
    user_token = OvmsConfig.GetValues('usr', 'abrp.').user_token;
  }

  // If user_token is still not set, raise an error notification
  if (!user_token) {
    OvmsNotify.Raise(
      'error',
      'usr.abrp.status',
      'ABRP::config usr abrp.user_token not set'
    );
    return false;
  }
  return true;
}

/**
 * Logs the telemetry list (tlm_list) from a bulk telemetry post object.
 */
function logTlmList(bulkPost) {
  if (bulkPost && bulkPost.data && bulkPost.data.length > 0) {
    var tlmList = bulkPost.data[0].tlm_list; // Access the tlm_list
    
    tlmList.forEach(function(item) {
      Logger.debug('Sending: ' + JSON.stringify(item));
    });
  } 
}

/**
 * Function to subscribe to events and store the token
 */
function subscribe(topic, callback) {
  var token = PubSub.subscribe(topic, callback);
  subscriptions[topic] = subscriptions[topic] || []; // Initialize array if not exists
  subscriptions[topic].push(token);
}

/**
 * Function to unsubscribe from events
 */
function unsubscribe(topic) {
  if (subscriptions[topic]) {
      for (var i = 0; i < subscriptions[topic].length; i++) {
          PubSub.unsubscribe(subscriptions[topic][i]);
      }
      delete subscriptions[topic]; // Optionally remove the topic from tracking
  }
}

// Telemetry and Metric Functions

/**
 * Updates the `metricMap` based on the vehicle type retrieved from the OvmsMetrics service.
 * Additional cases for other vehicle types can be added as needed.
 */
function overrideMetricMap() {
  Logger.debug("Running overrideMetricMap...");

  var vehicleType = OvmsMetrics.Value('v.type');
  Logger.debug("Vehicle type: " + vehicleType);

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
            var instrumentRange = metrics['xnl.v.b.range.instrument'] || 0;
            var idealRange = metrics['v.b.range.ideal'];
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
        if (entry.key === 'hvac_power') {
          entry.requiredMetrics = ['xte.v.e.hvac.power'];
          entry.metric = function(metrics) {
            return metrics['xte.v.e.hvac.power'];
          };
        }
        break;
      case 'SQ':
      case 'SE':
        // smart 453/forfour (SQ) and smart ED/fortwo (SE) report v.b.power with an
        // inverted sign (negative while driving/consuming) until the upstream firmware
        // fix lands (see iternio/ovms-link#40). v.b.current is correctly signed
        // (discharge-positive) in BOTH the buggy and the fixed firmware, so keep power's
        // magnitude and take its sign from current: corrects the bug now, and becomes a
        // no-op once v.b.power's sign is fixed upstream (no plugin change needed).
        if (entry.key === 'power') {
          entry.requiredMetrics = ['v.b.power', 'v.b.current'];
          entry.metric = function(metrics) {
            var power = metrics['v.b.power'];
            var current = metrics['v.b.current'];
            if (current < 0) { return -Math.abs(power); }
            if (current > 0) { return Math.abs(power); }
            return power; // current == 0: power is ~0, sign irrelevant
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
      return false; // Return false if any metric is not defined or stale
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
    Logger.warn("Metrics collected. Finished in " + duration.toFixed(2) + " ms");
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
  // Significant change if the charging power moves by at least CHARGE_POWER_DELTA_KW.
  // Power is clearly shown within ABRP so it is good to be responsive to real
  // changes, but a magnitude deadband (vs the old round() compare) stops noisy DC
  // fast-charge power from forcing a point every sample on sub-kW jitter that merely
  // crosses an integer boundary. The deadband is measured against the last queued
  // point, so a slow ramp still accumulates to a significant change.
  if (
    CHARGE_POWER_DELTA_KW > 0 &&
    currentTelemetry.is_charging &&
    typeof currentTelemetry.power === 'number' &&
    typeof previousTelemetry.power === 'number' &&
    Math.abs(currentTelemetry.power - previousTelemetry.power) >= CHARGE_POWER_DELTA_KW
  ) {
    return true
  }
  // Otherwise, updates purely based on timing considerations based on the
  // current state of the metrics and when the last telemetry was sent
  return false
}

/**
 * Calculates the maximum elapsed duration for telemetry transmission 
 * based on the current telemetry data and predefined conditions.
 *
 * @param {Object} telemetry - The current telemetry data.
 * @param {number} telemetry.speed - The current speed of the vehicle.
 * @param {boolean} telemetry.is_parked - Indicates if the vehicle is parked.
 * @param {boolean} telemetry.is_dcfc - Indicates if the vehicle is using DC fast charging.
 * @param {boolean} telemetry.is_charging - Indicates if the vehicle is currently charging.
 * 
 * @returns {number} - The maximum elapsed duration in seconds for telemetry transmission.
 *                     Returns 0 if a significant telemetry change is detected, 
 *                     otherwise returns predefined poll rates based on the vehicle's state,
 *                     or defaults to 86400 seconds (24 hours) if parked.
 */
function calculateMaxElapsedDuration(telemetry) {
  if (isSignificantTelemetryChange(telemetry, lastQueuedTelemetry)) {
    Logger.debug('Significant telemetry change');
    return 0; // Always send
  }

  if (telemetry.speed > MIN_CALIBRATION_SPEED) {
    Logger.debug('Speed greater than minimum calibration speed');
    return METRIC_POLL_RATE_DRIVING;
  }

  // DC fast charging keeps the connection fresh (checked before is_charging,
  // since is_dcfc implies is_charging).
  if (telemetry.is_dcfc) {
    Logger.debug('DC fast charging');
    return METRIC_POLL_STALE_CONNECTION;
  }

  // Standard (AC) charging — decided before the not-parked path so that a missing
  // is_parked (e.g. SUBSOL/TOYBZ4X drop v.e.gear while plugged in) cannot throttle
  // a charge session onto the 160 s stale-connection cadence.
  if (telemetry.is_charging) {
    Logger.debug('Standard charging');
    return METRIC_POLL_RATE_CHARGING;
  }

  if (!telemetry.is_parked) {
    Logger.debug('Moving / not parked');
    return METRIC_POLL_STALE_CONNECTION;
  }

  // Default to 24 hours if parked
  return 24 * 3600;
}

/**
 * Queues telemetry, optionally processing collected data for smoothing.
 */
function queueTelemetry(telemetry, processCollectedData) {
  // If processing collected data, smooth power and speed metrics
  if (processCollectedData && collectedMetrics.length) {
    Logger.debug('Processing collected metrics');
    var medianMetrics = medianPowerMetrics(collectedMetrics);
    if (medianMetrics) {
      telemetry.power = round(medianMetrics.power, 2);  // Round power to nearest 10W
      telemetry.speed = round(medianMetrics.speed);     // Round speed
    }
  }

  telemetryToSend.push(telemetry);
  lastQueuedTelemetry = clone(telemetry);
  collectedMetrics = [];  // Reset collected metrics after sending

  // Check the size of telemetryToSend and handle overflow
  if (telemetryToSend.length > MAX_TELEMETRY_QUEUE_SIZE) {
    // Drop the oldest queued point. Safe even while a bulk batch is in flight:
    // removeTelemetryBatch removes sent points by identity, so a shifted queue
    // front never causes the wrong rows to be dropped when the flush completes.
    telemetryToSend.shift();  // Remove the oldest element (first in queue)
    Logger.warn('Telemetry queue exceeded ' + MAX_TELEMETRY_QUEUE_SIZE + ' items. Oldest entry dropped.');
  }

  Logger.debug('Telemetry added, data in queue:', telemetryToSend.length);
}

/**
 * Per-second handler while the vehicle is on. Always collects high-frequency
 * samples (for median power/speed smoothing) while not parked, then queues a
 * smoothed telemetry point once enough time has elapsed for the current state.
 */
function queueTelemetryIfNecessary() {
  var currentTelemetry = createTelemetry()
  var timeSinceLastSent = currentTelemetry.utc - lastQueuedTelemetry.utc

  // Collect 1 Hz samples only while moving. is_parked is true during charging,
  // so charge points intentionally carry instantaneous power (sent on a
  // significant >1 kW change); a median over a 30-min charge window would be
  // meaningless. The median smooths driving power/speed for ABRP km/kWh calibration.
  if (!currentTelemetry.is_parked) {
    collectedMetrics.push(currentTelemetry)
    Logger.debug('Collected metrics in queue: ' + collectedMetrics.length)
  }

  var maxElapsedDuration = calculateMaxElapsedDuration(currentTelemetry)

  if (timeSinceLastSent >= maxElapsedDuration) {
    queueTelemetry(currentTelemetry, true) // apply median smoothing
  }
}

/**
 * Queues the current telemetry snapshot immediately, regardless of timing.
 * Used by the vehicle on/off handlers to bookend a driving/charging session.
 */
function queueTelemetryManual() {
  var currentTelemetry = createTelemetry();
  // Manual/one-off sends pass BANDWIDTH_SAVER as processCollectedData; with the
  // default BANDWIDTH_SAVER=false this ships the snapshot without median smoothing.
  queueTelemetry(currentTelemetry, BANDWIDTH_SAVER);
}

// Queue Processing and Data Transmission

/**
 * Removes the given batch's telemetry objects from the queue by identity. A
 * successful flush thus drops only the points that were actually sent, even if
 * the queue's front shifted (an overflow drop) while the request was in flight —
 * unlike a positional splice, which could discard never-sent points. Objects
 * already removed (e.g. shifted out as overflow) are simply not found.
 */
function removeTelemetryBatch(batch) {
  for (var i = 0; i < batch.length; i++) {
    var idx = telemetryToSend.indexOf(batch[i]);
    if (idx !== -1) {
      telemetryToSend.splice(idx, 1);
    }
  }
}

/**
 * The Iternio API returns HTTP 200 even for application-level errors, signalling
 * the real outcome via a JSON body {"status":"ok"|"error"}. Returns true only
 * when the body parses and status === 'ok'. Defensive: a missing/malformed body
 * is treated as NOT ok.
 */
function isApiOk(body) {
  if (!body) {
    return false
  }
  try {
    return JSON.parse(body).status === 'ok'
  } catch (e) {
    Logger.warn('Could not parse ABRP response body', body)
    return false
  }
}

/**
 * Sends single telemetry data to the ABRP (A Better Routeplanner) API.
 * Only used in oneTime()
 * @param {Object} telemetry - The telemetry data to be sent to ABRP.
 */
function sendTelemetry(telemetry) {
  Logger.info('Sending telemetry to ABRP', telemetry)
  var url =
    'https://api.iternio.com/1/tlm/send?api_key=' +
    encodeURIComponent(OVMS_API_KEY) +
    '&token=' +
    encodeURIComponent(user_token) +
    '&tlm=' +
    encodeURIComponent(JSON.stringify(telemetry))

  // Perform the HTTP request
  HTTP.Request({
    url: url,
    timeout: 5000,
    done: function (response) {
      if (response.statusCode === 200 && isApiOk(response.body)) {
        Logger.debug('Telemetry data sent successfully.')
      } else {
        Logger.warn('ABRP did not accept telemetry', response)
      }
    },
    fail: function (error) {
      Logger.error('ABRP error', error);
    },
  });
}

/**
 * Builds a bulk telemetry post object for the given batch (a snapshot of up to
 * MAX_BULK_BATCH_SIZE queued points).
 */
function createBulkPost(batch) {
  return {
    data: [
      {
        token: user_token,
        tlm_list: batch,
      },
    ],
  }
}

/**
 * Flushes queued telemetry to the ABRP bulk endpoint. Sends at most one batch
 * per call, never overlaps in-flight requests, and only removes points from the
 * queue once the API confirms success (HTTP 200 AND body status === 'ok').
 */
function sendBulkTelemetry() {
  if (isSending) {
    Logger.debug('Bulk send already in progress; skipping this tick.')
    return
  }
  if (telemetryToSend.length === 0) {
    return
  }

  // Snapshot the batch now so the removal count cannot drift if more telemetry
  // is queued while the request is in flight.
  var batch = telemetryToSend.slice(0, MAX_BULK_BATCH_SIZE)
  var bulkPost = createBulkPost(batch)
  var url =
    'https://api.iternio.com/1/tlm/bulk?api_key=' +
    encodeURIComponent(OVMS_API_KEY)

  Logger.debug('Sending bulk telemetry to ABRP')
  isSending = true
  try {
    HTTP.Request({
      url: url,
      headers: [{ 'Content-Type': 'application/json' }],
      post: JSON.stringify(bulkPost),
      timeout: 8000, // must complete within ticker.10
      done: function (response) {
        isSending = false
        if (response.statusCode === 200 && isApiOk(response.body)) {
          Logger.debug('Bulk telemetry accepted. Removing batch from queue.')
          logTlmList(bulkPost)
          // Remove exactly the sent objects by identity, so an overflow drop that
          // shifted the queue front mid-flight can't discard never-sent points.
          removeTelemetryBatch(batch)
        } else {
          Logger.warn('ABRP rejected bulk telemetry; keeping batch for retry', response)
        }
      },
      fail: function (error) {
        isSending = false
        Logger.error('ABRP error', error)
      },
    })
  } catch (e) {
    isSending = false
    Logger.error('HTTP.Request threw synchronously', e)
  }
}

// Event Handlers

/**
 * Handles the event when the vehicle is switched on.
 * Logs an informational message and sends an initial telemetry update to the queue.
 * Subscribes to the 'ticker.1' event to queue telemetry if necessary.
 *
 * @returns {void} - This function does not return a value; it performs actions related to the vehicle's power state.
 */
function callbackVehicleOn() {
  Logger.info('Vehicle switched on...');
  isSampling = true;
  // Send an initial telemetry to the queue
  queueTelemetryManual();
  subscribe('ticker.1', queueTelemetryIfNecessary);
}

/**
 * Handles the event when the vehicle is switched off.
 * Logs an informational message and unsubscribes from the 'ticker.1' event.
 * Sends a final telemetry update to the queue, attempts to process the telemetry queue,
 * and clears the collected metrics for the session.
 *
 * @returns {void} - This function does not return a value; it performs actions related to the vehicle's power state.
 */
function callbackVehicleOff() {
  Logger.info('Vehicle switched off...');
  isSampling = false;
  unsubscribe('ticker.1');
  // Send a final telemetry to the queue
  queueTelemetryManual();
  collectedMetrics = []; // Session is complete. Clear collectedMetrics.
}

/**
 * Whether a telemetry session should be live, as a LEVEL: the vehicle is on
 * (driving) or charging. The four session events (vehicle.on/off,
 * charge.start/stop) are edges of these two independent states, so no single
 * edge can decide on its own — e.g. charge.stop while the driver has already
 * powered up must NOT end the session.
 */
function isVehicleActive() {
  return Boolean(OvmsMetrics.Value('v.e.on')) || Boolean(OvmsMetrics.Value('v.c.charging'));
}

/**
 * Single handler for all four session events (and the cold-boot check):
 * re-reads the level and starts/stops the sampler only on an actual session
 * transition. isSampling makes overlapping edges idempotent — on + charging
 * subscribes the per-second sampler exactly once.
 */
function updateSamplingState() {
  var shouldSample = isVehicleActive();
  if (shouldSample && !isSampling) {
    callbackVehicleOn();
  } else if (!shouldSample && isSampling) {
    callbackVehicleOff();
  }
}

/**
 * Manages subscribing or unsubscribing to vehicle state events based on the provided parameter.
 *
 * If subscribing, it registers the level-based session handler for the vehicle
 * state events and applies the current level (covers a (re)boot mid-session,
 * when the on/charge.start edges have already fired). If unsubscribing, it
 * removes all the event subscriptions it created and ends any live session.
 *
 * @param {boolean} shouldSubscribe - If true, subscribes to vehicle state events; if false, unsubscribes.
 *
 * @returns {void} - This function does not return a value; it modifies the subscription state for vehicle events.
 */
function manageVehicleStateEvents(shouldSubscribe) {
  if (shouldSubscribe) {
    Logger.debug('Subscribing to Vehicle State Events');
  } else {
    Logger.debug('Unsubscribing to Vehicle State Events');
  }

  if (shouldSubscribe) {
    subscribe('vehicle.type.set', overrideMetricMap);
    subscribe('ticker.10', sendBulkTelemetry)
    subscribe('vehicle.on', updateSamplingState);
    subscribe('vehicle.charge.start', updateSamplingState);
    subscribe('vehicle.off', updateSamplingState);
    subscribe('vehicle.charge.stop', updateSamplingState);

    updateSamplingState();

  } else {
    unsubscribe('vehicle.on');
    unsubscribe('vehicle.charge.start');
    unsubscribe('vehicle.off');
    unsubscribe('vehicle.charge.stop');
    // Symmetric teardown: without these, every send(0)/send(1) cycle stacked
    // an extra sendBulkTelemetry / overrideMetricMap subscription.
    unsubscribe('vehicle.type.set');
    unsubscribe('ticker.10');
    if (isSampling) {
      callbackVehicleOff();
    }
  }

  isActive = shouldSubscribe;
}

/**
 * Monitors time and checks if it becomes valid, based on a minimum timestamp (Jan 1, 2000).
 * If valid, unsubscribes from the 'ticker.1' event and triggers startup logic.
 */
function checkTime() {
  const minValidTime = 946684800; // Unix timestamp for Jan 1, 2000
  if (OvmsMetrics.Value('m.time.utc') > minValidTime) {
    isTimeValid = true;  // Mark the time as valid
    Logger.debug('GPS time is valid, unsubscribing from ticker.1');
    
    // Unsubscribe from the ticker.1 event once the time is valid
    unsubscribe('ticker.1');
    
    // Proceed with startup
    send(true);
  } else {
    Logger.debug('Invalid GPS time, skipping telemetry processing.');
  }
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
    if (Object.prototype.hasOwnProperty.call(telemetry, key)) {
      Logger.log(label + ': ' + telemetry[key] + ' ' + unit);
    }
  }

  // Display plugin version
  Logger.log('Plugin Version: ' + VERSION);

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
  var telemetry = createTelemetry();
  sendTelemetry(telemetry)
}

/**
 * Controls the sending of data based on the provided `shouldSend` flag.
 * @param {boolean} shouldSend - Indicates whether to start or stop sending data.
 */
function send(shouldSend) {
  // Check if config is valid
  if (!validateUsrAbrpConfig()) return;

  // Check if time is valid
  if (!isTimeValid) {
    Logger.error('Cannot send data: GPS time is invalid.');
    return;
  }

  if (shouldSend && !isActive) {
    Logger.info('Start sending data...');
    manageVehicleStateEvents(true);
  } else if (!shouldSend && isActive) {
    Logger.info('Stop sending data');
    manageVehicleStateEvents(false);
  } else {
    Logger.warn(isActive ? 'Already running!' : 'Already stopped!');
  }
}

/**
 * Resets the ABRP configuration to default values.
 */
function resetConfig() {
  send(0);
  OvmsConfig.Delete('usr', 'abrp.user_token')
  OvmsNotify.Raise('info', 'usr.abrp.status', 'ABRP::usr abrp config reset')
}

// Main Initialization Logic — only auto-start inside OVMS, so the module can be
// require()'d under Jest with no side effects.
if (typeof OvmsConfig !== 'undefined' &&
    typeof OvmsMetrics !== 'undefined' &&
    typeof PubSub !== 'undefined') {
  overrideMetricMap()
  subscribe('ticker.1', checkTime)
}

// Module exports
module.exports = {
  // Public, in-vehicle entry points (invoked via `script eval abrp.<fn>()`)
  info,
  onetime,
  send,
  resetConfig,
  // Pure helpers exercised by the test suite
  round,
  medianPowerMetrics,
  isSignificantTelemetryChange,
  calculateMaxElapsedDuration,
  getOVMSMetric,
  createBulkPost,
  // Test-only seam (OVMS ignores extra exports; keeps the public surface clean)
  __test: {
    createTelemetry: createTelemetry,
    overrideMetricMap: overrideMetricMap,
    queueTelemetry: queueTelemetry,
    queueTelemetryIfNecessary: queueTelemetryIfNecessary,
    sendBulkTelemetry: sendBulkTelemetry,
    checkTime: checkTime,
    callbackVehicleOn: callbackVehicleOn,
    callbackVehicleOff: callbackVehicleOff,
    manageVehicleStateEvents: manageVehicleStateEvents,
    isActive: function () { return isActive },
    isTimeValid: function () { return isTimeValid },
    getQueue: function () { return telemetryToSend },
    getCollected: function () { return collectedMetrics },
    setCollected: function (metrics) { collectedMetrics = metrics },
    setLastQueued: function (o) { lastQueuedTelemetry = o },
  },
}
