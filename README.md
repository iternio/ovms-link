# README

[A Better Routeplanner (ABRP)](https://abetterrouteplanner.com) is an electric
vehicle (EV) focussed route planner that incorporates planning of EV charging
stops.

This OVMS plugin sends live telemetry data from the vehicle to ABRP to be used
for the route planning process and appropriate updates to the plan along the way
based on live information.

## Installation

### Obtain Live Data Token

1. Register with [A Better Routeplanner (ABRP)](https://abetterrouteplanner.com)
2. Setup your vehicle starting with **Select car model**
3. Ins the settings for the new vehicle, click on the **Live data** button to
   generate a generic token

### Install the abrp.js Plugin in OVMS

1. Create the `abrp.js` file
   1. Login to the
      [OVMS web console](https://docs.openvehicles.com/en/latest/userguide/installation.html#initial-connection-wifi-and-browser)
   2. Navigate to the **Tools** -> **Editor** menu item
   3. Create a new `lib` directory in `/store/scripts` if it does not exist
   4. Create a new `abrp.js` file in the `/store/scripts/lib` directory
   5. Copy the content of the `lib/abrp.js` file in this repository to that new
      file and save
2. Create the `ovmsmain.js` file

   1. Create a new `ovmsmain.js` file in `/store/scripts` if it does not exist
   2. Copy the content of the `ovmsmain.js` file in this repository to that new
      file and **Save**

3. **Reload JS Engine**

### Configure Plugin

1. Navigate to **Tools** -> **Shell** in the OVMS web console
2. In the OVMS shell issue the following command substituting `<token>` with the
   live data generic token that was set up for the vehicle in ABRP

   ```text
   config set usr abrp.user_token <token>
   ```

### Reload the JS Engine

1. Navigate to **Tools** -> **Editor** in the OVMS web console and press the
   **Reload JS Engine** button. This should result in an `ABRP::started`
   notification if the plugin is installed and configured correctly.

## Usage

With the configuration described above the ABRP plugin will automatically send
live telemetry from the vehicle to ABRP on a periodic basis. When data is sent
depends on what is happening for the vehicle. For example, when driving,
information will be sent more frequently than when charging, and even less often
when the car is off.
