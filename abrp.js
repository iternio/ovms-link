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
const URL = "http://api.iternio.com/1/tlm/send";

const DEFAULT_CFG = {
  url: URL,
};

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

function round(number, precision) {
  if (!number) {
    return number; // could be 0, null or undefined
  }
  return Number(number.toFixed(precision || 0));
}

// simple console shim
const console = logger();

var DEBUG = true;
var objTLM;
var objTimer, objEvent;
var sHasChanged = "";
var bMotorsOn = false;

// initialise from default
var abrp_cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));

// Read & process config:
function readConfig() {
  var read_cfg = OvmsConfig.GetValues("usr", "abrp.");
  console.debug("usr abrp. config", read_cfg);
  if (!read_cfg.user_token) {
    OvmsNotify.Raise(
      "error",
      "usr.abrp.status",
      "ABRP::config usr abrp.user_token not set"
    );
  } else {
    abrp_cfg.user_token = read_cfg.user_token;
  }
}

// Make json telemetry object
function InitTelemetryObj() {
  return {
    utc: 0,
    soc: 0,
    soh: 0,
    speed: 0,
    lat: 0,
    lon: 0,
    elevation: 0,
    ext_temp: 0,
    is_charging: 0,
    batt_temp: 0,
    voltage: 0,
    current: 0,
    power: 0,
  };
}

function SetIfChanged(new_val, old_val, name, tolerance) {
  if (old_val !== null && (new_val === null || new_val === undefined)) {
    return old_val; // Sometimes we get nulls,
  }
  new_val = Number(new_val);
  if (isNaN(new_val)) {
    return old_val; // Maybe sometimes we get NaNs?
  }
  if (Math.abs(new_val - old_val) > tolerance) {
    if (["power", "soc", "speed", "lat", "lon"].indexOf(name) >= 0) {
      sHasChanged += " " + name + ": " + new_val + ", ";
    }
    return new_val;
  } else if (new_val != old_val) {
    return new_val;
  } else {
    return old_val;
  }
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
  return telemetry;
}

// Fill json telemetry object
function UpdateTelemetryObj(myJSON) {
  const started = performance.now();
  if (!myJSON) {
    // if the data object is undefined or null then return early
    return false;
  }
  var read_num = 0;
  var read_str = "";

  sHasChanged = "";

  if (bMotorsOn) {
    sHasChanged = "_MOTORS-ON";
    bMotorsOn = false;
  }

  myJSON.soh = SetIfChanged(
    Number(OvmsMetrics.Value("v.b.soh")),
    myJSON.soh,
    "soh",
    0
  );
  myJSON.soc = SetIfChanged(
    Number(OvmsMetrics.Value("v.b.soc")),
    myJSON.soc,
    "soc",
    0
  );

  if (myJSON.soh + myJSON.soc == 0) {
    // Sometimes the canbus is not readable, and abrp doesn't like 0 values
    console.error("canbus not readable: reset module and then put motors on");
    return false;
  }

  //myJSON.lat = OvmsMetrics.AsFloat("v.p.latitude").toFixed(3);
  //above code line works, except when value is undefined, after reboot

  read_num = OvmsMetrics.AsFloat("v.p.latitude");
  myJSON.lat = SetIfChanged(read_num.toFixed(4), myJSON.lat, "lat", 0.05);
  read_num = Number(OvmsMetrics.AsFloat("v.p.longitude"));
  myJSON.lon = SetIfChanged(read_num.toFixed(4), myJSON.lon, "lon", 0.05);
  read_num = Number(OvmsMetrics.AsFloat("v.p.altitude"));
  myJSON.elevation = SetIfChanged(
    read_num.toFixed(1),
    myJSON.elevation,
    "elevation",
    2
  );

  read_num = Number(OvmsMetrics.Value("v.b.power"));
  myJSON.power = SetIfChanged(read_num.toFixed(3), myJSON.power, "power", 0);

  myJSON.speed = SetIfChanged(
    Number(OvmsMetrics.Value("v.p.speed")),
    myJSON.speed,
    "speed",
    0
  );
  myJSON.batt_temp = SetIfChanged(
    Number(OvmsMetrics.Value("v.b.temp")),
    myJSON.batt_temp,
    "batt_temp",
    0
  );
  myJSON.ext_temp = SetIfChanged(
    Number(OvmsMetrics.Value("v.e.temp")),
    myJSON.ext_temp,
    "ext_temp",
    0
  );
  myJSON.voltage = SetIfChanged(
    Number(OvmsMetrics.Value("v.b.voltage")),
    myJSON.voltage,
    "voltage",
    0
  );
  myJSON.current = SetIfChanged(
    Number(OvmsMetrics.Value("v.b.current")),
    myJSON.current,
    "current",
    0
  );

  myJSON.utc = Math.trunc(Date.now() / 1000);
  //myJSON.utc = OvmsMetrics.Value("m.time.utc");

  // read_bool = Boolean(OvmsMetrics.Value("v.c.charging"));
  // v.c.charging is also on when regen => not wanted here
  read_str = OvmsMetrics.Value("v.c.state");
  if (read_str == "charging" || read_str == "topoff") {
    read_num = 1;
    console.debug("Charging with mode = " + OvmsMetrics.Value("v.c.mode"));
  } else {
    read_num = 0;
  }
  myJSON.is_charging = SetIfChanged(
    read_num,
    myJSON.is_charging,
    "is_charging",
    0
  );

  if (sHasChanged !== "") {
    console.debug(sHasChanged);
  }
  const duration = performance.now() - started;
  console.debug("Getting OvmsMetrics took " + round(duration) + "ms");
  return sHasChanged !== "";
}

function InitTelemetry() {
  objTLM = InitTelemetryObj();
  sHasChanged = "";
}

function UpdateTelemetry() {
  if (!objTLM) {
    InitTelemetry(); // If the telemetry object doesn't exist, create it.
  }
  var bChanged = UpdateTelemetryObj(objTLM);
  return bChanged;
}

function CloseTelemetry() {
  objTLM = null;
  sHasChanged = "";
}

// http request callback if successful
function OnRequestDone(resp) {
  console.debug("response=" + resp.statusCode + ":" + resp.statusText);
  //OvmsNotify.Raise("info", "usr.abrp.status", "ABRP::" + sHasChanged);
}

// http request callback if failed
function OnRequestFail(error) {
  console.error("Error communicating with ABRP", error);
  // OvmsNotify.Raise("info", "usr.abrp.status", "ABRP::" + JSON.stringify(error));
}

// Return full url with JSON telemetry object
function GetUrlABRP() {
  var urljson = abrp_cfg.url;
  urljson += "?";
  urljson += "api_key=" + OVMS_API_KEY;
  urljson += "&";
  urljson += "token=" + abrp_cfg.user_token;
  urljson += "&";
  urljson += "tlm=" + encodeURIComponent(JSON.stringify(objTLM));
  console.debug("ABRP URL", objTLM);
  return urljson;
}

// Return config object for HTTP request
function GetURLcfg() {
  var cfg = {
    url: GetUrlABRP(),
    done: function (resp) {
      OnRequestDone(resp);
    },
    fail: function (err) {
      OnRequestFail(err);
    },
  };
  return cfg;
}

var last_send = 0.0;
var last_data = {};
function SendLiveData() {
  // Check if telemetry updated.
  var bChanged = UpdateTelemetry();
  var elapsed = Math.trunc(Date.now() / 1000) - last_send;
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
    (objTLM.is_charging || Math.abs(objTLM.speed) >= 5.0)
  ) {
    // Send every 25 seconds at least if active.  This keeps the live data marked 'live'
    // in ABRP
    should_send = true;
    console.info("Sending: Charging / driving and 25 seconds passed.");
  }
  if (should_send) {
    zeroStaleData();
    HTTP.Request(GetURLcfg());
    last_send = Math.trunc(Date.now() / 1000);
    last_data = {
      power: objTLM.power,
      current: objTLM.current,
      is_charging: objTLM.is_charging,
      speed: objTLM.speed,
    };
  }
}

function zeroStaleData() {
  const elapsed = Math.trunc(Date.now() / 1000) - last_send;
  if (elapsed >= 300) {
    // If any of these values are the same as they were 5 or more minutes ago, consider them stale and set them zero.
    if (last_data.power == objTLM.power) {
      objTLM.power = 0;
    }
    if (last_data.current == objTLM.current) {
      objTLM.current = 0;
    }
    if (last_data.is_charging == objTLM.is_charging) {
      objTLM.is_charging = 0;
    }
    if (last_data.speed == objTLM.speed || objTLM.speed < 0.5) {
      objTLM.speed = 0;
    }
  }
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
  readConfig();
  InitTelemetry();
  SendLiveData();
  CloseTelemetry();
};

// API method abrp.info():
//   Do not send any data, just read vehicle data and writes in the console
exports.info = function () {
  // DEBUG = false;
  const metrics = getOvmsMetrics();
  const telemetry = mapMetricsToTelemetry(metrics);
  // DEBUG = true;
  console.log("State of Charge:  " + telemetry.soc + "%");
  console.log("Battery Power:    " + telemetry.power + "kW");
  console.log("Vehicle Speed:    " + telemetry.speed + "kph");
  console.log("GPS Latitude:     " + telemetry.lat + "°");
  console.log("GPS Longitude:    " + telemetry.lon + "°");
  console.log("Charging:         " + telemetry.is_charging);
  console.log("DC Fast Charging: " + telemetry.is_dcfc);
  console.log("Parked:           " + telemetry.is_parked);
  console.log("Charged kWh:      " + telemetry.kwh_charged);
  console.log("State of Health:  " + telemetry.soh + "%");
  console.log("GPS Heading:      " + telemetry.heading + "°");
  console.log("GPS Elevation:    " + telemetry.elevation + "m");
  console.log("External Temp:    " + telemetry.ext_temp + "°C");
  console.log("Battery Temp:     " + telemetry.batt_temp + "°C");
  console.log("Battery Voltage:  " + telemetry.voltage + "V");
  console.log("Battery Current:  " + telemetry.current + "A");
  console.log("Odometer:         " + telemetry.odometer + "km");
  console.log("Estimated Range:  " + telemetry.est_battery_range + "km");
};

// API method abrp.resetConfig()
//   Resets stored config to default
exports.resetConfig = function () {
  OvmsConfig.SetValues("usr", "abrp.", DEFAULT_CFG);
  console.debug("usr abrp. config", abrp_cfg);
  OvmsNotify.Raise("info", "usr.abrp.status", "ABRP::usr abrp. config reset");
};

// API method abrp.send():
//   Checks every minut if important data has changed, and send it
exports.send = function (onoff) {
  if (onoff) {
    readConfig();
    if (objTimer != null) {
      console.warn("Already running !");
      return;
    }
    console.info("Start sending data...");
    InitTelemetry();
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
    CloseTelemetry();
    OvmsNotify.Raise("info", "usr.abrp.status", "ABRP::stopped");
  }
};
