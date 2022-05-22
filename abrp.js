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
const MY_TOKEN = "@@@@@@@@-@@@@-@@@@-@@@@-@@@@@@@@@@@@";
const TIMER_INTERVAL = "ticker.10"; // every 10 seconds
const EVENT_MOTORS_ON = "vehicle.on";
const URL = "http://api.iternio.com/1/tlm/send";

const DEFAULT_CFG = {
  url: URL,
  user_token: MY_TOKEN,
};

const CR = "\n";

var objTLM;
var objTimer, objEvent;
var sHasChanged = "";
var bMotorsOn = false;

// initialise from default
var abrp_cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));

// check if json object is empty
function isJsonEmpty(obj) {
  for (var key in obj) {
    if (obj.hasOwnProperty(key)) return false;
  }
  return true;
}

// Read & process config:
function readConfig() {
  // check if config exist
  var read_cfg = OvmsConfig.GetValues("usr", "abrp.");
  print(JSON.stringify(read_cfg) + CR);
  if (isJsonEmpty(read_cfg) == true) {
    // no config yet, set the default values
    OvmsConfig.SetValues("usr", "abrp.", abrp_cfg);
  } else {
    // config existing
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

// Fill json telemetry object
function UpdateTelemetryObj(myJSON) {
  if (!myJSON) {
    // if the data object is undefined or null then return early
    return false;
  }
  var read_num = 0;
  var read_str = "";
  var read_bool = false;

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
    print("canbus not readable: reset module and then put motors on" + CR);
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
    print("Charging with mode = " + OvmsMetrics.Value("v.c.mode") + CR);
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
    print(sHasChanged + CR);
  }
  return sHasChanged !== "";
}

// Show available vehicle data
function DisplayLiveData() {
  var newcontent = "";
  newcontent += "altitude = " + objTLM.elevation + "m" + CR; //GPS altitude
  newcontent += "latitude = " + objTLM.lat + "°" + CR; //GPS latitude
  newcontent += "longitude= " + objTLM.lon + "°" + CR; //GPS longitude
  newcontent += "ext temp = " + objTLM.ext_temp + "°C" + CR; //Ambient temperature
  newcontent += "charge   = " + objTLM.soc + "%" + CR; //State of charge
  newcontent += "health   = " + objTLM.soh + "%" + CR; //State of health
  newcontent += "bat temp = " + objTLM.batt_temp + "°C" + CR; //Main battery momentary temperature
  newcontent += "voltage  = " + objTLM.voltage + "V" + CR; //Main battery momentary voltage
  newcontent += "current  = " + objTLM.current + "A" + CR; //Main battery momentary current
  newcontent += "power    = " + objTLM.power + "kW" + CR; //Main battery momentary power
  newcontent += "charging = " + objTLM.is_charging + CR; //yes = currently charging
  print(newcontent);
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
  print("response=" + resp.statusCode + ":" + resp.statusText + CR);
  //OvmsNotify.Raise("info", "usr.abrp.status", "ABRP::" + sHasChanged);
}

// http request callback if failed
function OnRequestFail(error) {
  print("error=" + JSON.stringify(error) + CR);
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
  print(JSON.stringify(objTLM) + CR);
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
    print("Sending: Telemetry changed." + CR);
  } else if (elapsed >= 1500) {
    // Send the data if last send was more than 25 minutes ago.
    should_send = true;
    print("Sending: 25 minutes passed." + CR);
  } else if (
    elapsed >= 25.0 &&
    (objTLM.is_charging || Math.abs(objTLM.speed) >= 5.0)
  ) {
    // Send every 25 seconds at least if active.  This keeps the live data marked 'live'
    // in ABRP
    should_send = true;
    print("Sending: Charging / driving and 25 seconds passed." + CR);
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

function Reactivate_MotorsOn() {
  bMotorsOn = true;
  SendLiveData();
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
  readConfig();
  InitTelemetry();
  UpdateTelemetry();
  DisplayLiveData();
  CloseTelemetry();
};

// API method abrp.resetConfig()
//   Resets stored config to default
exports.resetConfig = function () {
  OvmsConfig.SetValues("usr", "abrp.", DEFAULT_CFG);
  print(JSON.stringify(abrp_cfg));
  OvmsNotify.Raise("info", "usr.abrp.status", "ABRP::config changed");
};

// API method abrp.send():
//   Checks every minut if important data has changed, and send it
exports.send = function (onoff) {
  if (onoff) {
    readConfig();
    if (objTimer != null) {
      print("Already running !" + CR);
      return;
    }
    print("Start sending data..." + CR);
    InitTelemetry();
    SendLiveData();
    InitTimer();
    OvmsNotify.Raise("info", "usr.abrp.status", "ABRP::started");
  } else {
    if (objTimer == null) {
      print("Already stopped !" + CR);
      return;
    }
    print("Stop sending data" + CR);
    CloseTimer();
    CloseTelemetry();
    OvmsNotify.Raise("info", "usr.abrp.status", "ABRP::stopped");
  }
};
