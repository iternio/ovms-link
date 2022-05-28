/**
 *       /store/scripts/abrp.js
 *
 * Module plugin:
 *  Send live data to a better route planner
 *  This version uses the embedded GSM of OVMS, so there's an impact on data consumption
 *  /!\ requires OVMS firmware version 3.2.008-147 minimum (for HTTP call)
 *
 * Version 1.3   2020   inf0mike (forum https://www.openvehicles.com)
 * Version 1.4   2021   Jason_ABRP
 * Enable:
 *  - install at above path
 *  - config set usr abrp.user_token "your-token-goes-here"
 *  - add to /store/scripts/ovmsmain.js:
 *                  abrp = require("abrp");
 *                  abrp.send(1)
 *  - script reload
 *
 * Usage:
 *  - script eval abrp.info()         => to display vehicle data to be sent to abrp
 *  - script eval abrp.onetime()      => to launch one time the request to abrp server
 *  - script eval abrp.send(1)        => toggle send data to abrp
 *  -                      (0)        => stop sending data
 *  - script eval abrp.resetConfig()  => reset configuration to defaults
 *
 *  Version 1.4 updates:
 *  - Update script so it can be running continuously
 *  - Remove unneeded dependencies on multiple config items (Now only have to set token)
 *  - Stability improvements
 *
 * Version 1.3 updates:
 *  - Fix for rounding of fractional SOC causing abrp to report SOC off by 1
 *  - Fix for altitude never being sent
 *  - New convenience method to reset config to defaults
 *
 * Version 1.2 updates:
 *  - based now on OVMS configuration to store user token, car model and url
 *  - review messages sent during charge
 *  - send a message when vehicle is on before moving to update abrp
 *
 * Version 1.1 fix and update:
 *  - fixed the utc refreshing issue
 *  - send notifications
 *  - send live data only if necessary
 **/

/*
 * Declarations:
 *   OVMS_API_KEY : API_KEY to access to ABRP API, given by the developer
 *   MY_TOKEN : Your token (corresponding to your abrp profile)
 *   TIMER_INTERVAL : to subscribe to a ticker event
 *   URL : url to send telemetry to abrp following: https://iternio.com/index.php/iternio-telemetry-api/
 *   CR : Carriage Return for console prints
 *
 *   objTLM : JSON object containing data read
 *   objTimer : timer object
 */

const OVMS_API_KEY = "32b2162f-9599-4647-8139-66e9f9528370";
const TIMER_INTERVAL = "ticker.10"; // every 10 seconds
const EVENT_MOTORS_ON = "vehicle.on";

function clone(obj) {
  return Object.assign({}, obj);
}

function isNil(value) {
  return value == null;
}

function logger() {
  function log(message, obj) {
    print(message + (obj ? " " + JSON.stringify(obj) : "") + "\n");
  }

  function debug(message, obj) {
    if (DEBUG) {
      log("DEBUG: " + message, obj);
    }
  }

  function error(message, obj) {
    log("ERROR: " + message, obj);
  }

  function info(message, obj) {
    log("INFO: " + message, obj);
  }

  function warn(message, obj) {
    log("WARN: " + message, obj);
  }

  return {
    debug,
    error,
    info,
    log,
    warn,
  };
}

function omitNil(obj) {
  const cloned = clone(obj);
  const keys = Object.keys(cloned);
  keys.forEach(function (key) {
    if (isNil(clone[key])) {
      delete clone[key];
    }
  });
  return cloned;
}

function round(number, precision) {
  if (!number) {
    return number; // could be 0, null or undefined
  }
  return Number(number.toFixed(precision || 0));
}

// simple console shim
const console = logger();

var DEBUG = true;
var objTLM = {
  utc: 0,
};
var objTimer, objEvent;

function isSignificantTelemetryChange(currentTelemetry, previousTelemetry) {
  // Significant if the SOC changes so that it updates in ABRP as soon as
  // possible after it's changed within the vehicle.
  if (currentTelemetry.soc !== previousTelemetry.soc) {
    return true;
  }
  // Significant change if the power changes by more than 1kW while charging.
  // Another piece of information that is clearly shown within ABRP so good
  // to be responsive to those changes in charging power.
  if (
    currentTelemetry.is_charging &&
    round(currentTelemetry.power) !== round(previousTelemetry.power)
  ) {
    return true;
  }
  // Otherwise, updates purely based on timing considerations based on the
  // current state of the metrics and when the last telemetry was sent
  return false;
}

function getOvmsMetrics() {
  const metricNames = [
    "v.b.current",
    "v.b.power",
    "v.b.range.ideal",
    "v.b.soc",
    "v.b.soh",
    "v.b.temp",
    "v.b.voltage",
    "v.c.kwh",
    "v.c.mode",
    "v.c.state", // v.c.charging is also true when regenerating, which isn't what is wanted
    "v.e.parktime",
    "v.e.temp",
    "v.p.altitude",
    "v.p.direction",
    "v.p.latitude",
    "v.p.longitude",
    "v.p.odometer",
    "v.p.speed",
  ];
  const started = performance.now();
  const metrics = OvmsMetrics.GetValues(metricNames);
  const duration = performance.now() - started;
  console.debug("Getting OvmsMetrics took " + round(duration) + "ms", metrics);
  return metrics;
}

function getUsrAbrpConfig() {
  const config = OvmsConfig.GetValues("usr", "abrp.");
  console.debug("usr abrp. config", config);
  return config;
}

function mapMetricsToTelemetry(metrics) {
  const chargingStates = ["charging", "topoff"];
  const dcfcMode = "performance";
  // Array.prototype.includes() not supported in duktape
  const is_charging = chargingStates.indexOf(metrics["v.c.state"]) > -1;
  // https://documenter.getpostman.com/view/7396339/SWTK5a8w
  const telemetry = {
    utc: round(Date.now() / 1000),
    soc: round(metrics["v.b.soc"]),
    power: round(metrics["v.b.power"], 1), // ~ nearest 100W of precision
    speed: round(metrics["v.p.speed"]),
    lat: round(metrics["v.p.latitude"], 5), // ~1.11 m of precision
    lon: round(metrics["v.p.longitude"], 5), // ~1.11 m of precision
    is_charging,
    is_dcfc: is_charging && dcfcMode === metrics["v.c.mode"],
    is_parked: metrics["v.e.parktime"] > 0,
    kwh_charged: is_charging ? round(metrics["v.c.kwh"], 1) : 0,
    soh: round(metrics["v.b.soh"]),
    heading: round(metrics["v.p.direction"], 1),
    elevation: round(metrics["v.p.altitude"], 1),
    ext_temp: round(metrics["v.e.temp"]),
    batt_temp: round(metrics["v.b.temp"]),
    voltage: round(metrics["v.b.voltage"]),
    current: round(metrics["v.b.current"], 1),
    odometer: round(metrics["v.p.odometer"]),
    est_battery_range: round(metrics["v.b.range.ideal"]),
  };
  console.debug("Mapped ABRP telemetry", telemetry);
  return omitNil(telemetry);
}

function sendTelemetry(telemetry) {
  const config = getUsrAbrpConfig();
  const token = config.user_token;
  if (!token) {
    console.error("config usr abrp.user_token not set");
    return;
  }
  const url =
    "http://api.iternio.com/1/tlm/send?api_key=" +
    encodeURIComponent(OVMS_API_KEY) +
    "&token=" +
    encodeURIComponent(token) +
    "&tlm=" +
    encodeURIComponent(JSON.stringify(telemetry));
  console.debug("ABRP URL", url);
  HTTP.Request({
    done: function (response) {
      console.debug("ABRP response", response);
    },
    fail: function (error) {
      console.error("ABRP error", error);
    },
    url,
  });
}

function validateUsrAbrpConfig() {
  const config = getUsrAbrpConfig();
  if (!config.user_token) {
    OvmsNotify.Raise(
      "error",
      "usr.abrp.status",
      "ABRP::config usr abrp.user_token not set"
    );
    return false
  }
  return true;
}

function SendLiveData() {
  var metrics = getOvmsMetrics();
  var currentTelemetry = mapMetricsToTelemetry(metrics);
  var bChanged = isSignificantTelemetryChange(currentTelemetry, objTLM);
  var elapsed = currentTelemetry.utc - objTLM.utc;
  var should_send = false;
  if (bChanged) {
    should_send = true;
    console.info("Sending: Telemetry changed.");
  } else if (elapsed >= 1500) {
    // Send the data if last send was more than 25 minutes ago.
    should_send = true;
    console.info("Sending: 25 minutes passed.");
  } else if (
    elapsed >= 25.0 &&
    (currentTelemetry.is_charging || Math.abs(currentTelemetry.speed) >= 5.0)
  ) {
    // Send every 25 seconds at least if active.  This keeps the live data marked 'live'
    // in ABRP
    should_send = true;
    console.info("Sending: Charging / driving and 25 seconds passed.");
  }
  if (should_send) {
    sendTelemetry(currentTelemetry);
  }
  objTLM = clone(currentTelemetry);
}

function InitTimer() {
  objTimer = PubSub.subscribe(TIMER_INTERVAL, SendLiveData);
  objEvent = PubSub.subscribe(EVENT_MOTORS_ON, SendLiveData);
}

function CloseTimer() {
  PubSub.unsubscribe(objEvent);
  PubSub.unsubscribe(objTimer);
  objEvent = null;
  objTimer = null;
}

// API method abrp.onetime():
//   Read and send data, but only once, no timer launched
exports.onetime = function () {
  if (!validateUsrAbrpConfig()) {
    return
  }
  SendLiveData();
};

// API method abrp.info():
//   Do not send any data, just read vehicle data and writes in the console
exports.info = function () {
  // DEBUG = false;
  const metrics = getOvmsMetrics();
  const telemetry = mapMetricsToTelemetry(metrics);
  // DEBUG = true;
  // space before units as per NIST guidelines https://physics.nist.gov/cuu/Units/checklist.html
  console.log("State of Charge:  " + telemetry.soc + " %");
  console.log("Battery Power:    " + telemetry.power + " kW");
  console.log("Vehicle Speed:    " + telemetry.speed + " kph");
  console.log("GPS Latitude:     " + telemetry.lat + " °");
  console.log("GPS Longitude:    " + telemetry.lon + " °");
  console.log("Charging:         " + telemetry.is_charging);
  console.log("DC Fast Charging: " + telemetry.is_dcfc);
  console.log("Parked:           " + telemetry.is_parked);
  console.log("Charged kWh:      " + telemetry.kwh_charged);
  console.log("State of Health:  " + telemetry.soh + " %");
  console.log("GPS Heading:      " + telemetry.heading + " °");
  console.log("GPS Elevation:    " + telemetry.elevation + " m");
  console.log("External Temp:    " + telemetry.ext_temp + " °C");
  console.log("Battery Temp:     " + telemetry.batt_temp + " °C");
  console.log("Battery Voltage:  " + telemetry.voltage + " V");
  console.log("Battery Current:  " + telemetry.current + " A");
  console.log("Odometer:         " + telemetry.odometer + " km");
  console.log("Estimated Range:  " + telemetry.est_battery_range + " km");
};

// API method abrp.resetConfig()
//   Resets stored config to default
exports.resetConfig = function () {
  OvmsConfig.SetValues("usr", "abrp.", {});
  OvmsNotify.Raise("info", "usr.abrp.status", "ABRP::usr abrp. config reset");
};

// API method abrp.send():
//   Checks every minut if important data has changed, and send it
exports.send = function (onoff) {
  if (onoff) {
    if (!validateUsrAbrpConfig()) {
      return
    }
    if (objTimer != null) {
      console.warn("Already running !");
      return;
    }
    console.info("Start sending data...");
    SendLiveData();
    InitTimer();
    OvmsNotify.Raise("info", "usr.abrp.status", "ABRP::started");
  } else {
    if (objTimer == null) {
      console.warn("Already stopped !");
      return;
    }
    console.info("Stop sending data");
    CloseTimer();
    OvmsNotify.Raise("info", "usr.abrp.status", "ABRP::stopped");
  }
};
