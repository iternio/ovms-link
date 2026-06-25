// Loads a fresh copy of the module with a clean global environment.
// Pass per-test host-global stubs (OvmsMetrics, HTTP, …) via `globals`.
// For stateful tests (shared module state), call loadAbrp() inside a setup()
// helper or beforeEach — NOT at describe-body level — so each test gets a fresh
// module instance. Describe-level calls share one instance across the block.
function loadAbrp(globals) {
  jest.resetModules()
  ;['OvmsConfig', 'OvmsMetrics', 'PubSub', 'HTTP', 'OvmsNotify'].forEach(
    (k) => {
      delete global[k]
    }
  )
  if (globals) Object.assign(global, globals)
  return require('./abrp')
}

describe('round', () => {
  const { round } = loadAbrp()
  test('should default to no decimal', () => {
    expect(round(12)).toBe(12)
    expect(round(12.34567)).toBe(12)
  })
  test('should use provided precision', () => {
    expect(round(12.34567, 2)).toBe(12.35)
    expect(round(12.34, 6)).toBe(12.34)
  })
})

describe('medianPowerMetrics', () => {
  const { medianPowerMetrics } = loadAbrp()
  test('should return null with no array elements', () => {
    expect(medianPowerMetrics([])).toBeNull()
  })
  test('odd number of elements returns the middle by power', () => {
    expect(
      medianPowerMetrics([
        { power: 1, speed: 10 },
        { power: 2, speed: 4 },
        { power: 3, speed: 3 },
        { power: 4, speed: 2 },
        { power: 10, speed: 1 },
      ])
    ).toEqual({ power: 3, speed: 3 })
    expect(
      medianPowerMetrics([
        { power: 10, speed: 1 },
        { power: 1, speed: 10 },
        { power: 4, speed: 2 },
        { power: 2, speed: 4 },
        { power: 3, speed: 3 },
      ])
    ).toEqual({ power: 3, speed: 3 })
  })
  test('even number of elements returns the lower-power middle', () => {
    expect(
      medianPowerMetrics([
        { power: 1, speed: 10 },
        { power: 3, speed: 3 },
        { power: 4, speed: 2 },
        { power: 10, speed: 1 },
      ])
    ).toEqual({ power: 3, speed: 3 })
    expect(
      medianPowerMetrics([
        { power: 10, speed: 1 },
        { power: 1, speed: 10 },
        { power: 4, speed: 2 },
        { power: 3, speed: 3 },
      ])
    ).toEqual({ power: 3, speed: 3 })
  })
})

describe('isSignificantTelemetryChange', () => {
  const { isSignificantTelemetryChange } = loadAbrp()
  const base = { soc: 50, is_charging: false, is_parked: true, power: 0 }

  test('SoC change is significant', () => {
    expect(isSignificantTelemetryChange({ ...base, soc: 51 }, base)).toBe(true)
  })
  test('charging-state change is significant', () => {
    expect(
      isSignificantTelemetryChange({ ...base, is_charging: true }, base)
    ).toBe(true)
  })
  test('parked-state change is significant', () => {
    expect(
      isSignificantTelemetryChange({ ...base, is_parked: false }, base)
    ).toBe(true)
  })
  test('power change >1kW while charging is significant', () => {
    const prev = { ...base, is_charging: true, power: 5 }
    const cur = { ...base, is_charging: true, power: 7 }
    expect(isSignificantTelemetryChange(cur, prev)).toBe(true)
  })
  test('power change while NOT charging is not significant', () => {
    expect(isSignificantTelemetryChange({ ...base, power: 7 }, base)).toBe(
      false
    )
  })
  test('sub-1kW power change while charging is not significant', () => {
    const prev = { ...base, is_charging: true, power: 5 }
    const cur = { ...base, is_charging: true, power: 5.4 }
    expect(isSignificantTelemetryChange(cur, prev)).toBe(false)
  })
  test('sub-deadband power change that crosses a rounding boundary is not significant', () => {
    // 0.9 kW swing (< CHARGE_POWER_DELTA_KW) but it crosses 5.6->4.7 i.e. round 6 vs 5.
    // The deadband measures magnitude, so jitter across an integer boundary no longer fires.
    const prev = { ...base, is_charging: true, power: 5.6 }
    const cur = { ...base, is_charging: true, power: 4.7 }
    expect(isSignificantTelemetryChange(cur, prev)).toBe(false)
  })
  test('identical telemetry is not significant', () => {
    expect(isSignificantTelemetryChange({ ...base }, base)).toBe(false)
  })
})

describe('sendBulkTelemetry data integrity', () => {
  function setup() {
    const requests = []
    const abrp = loadAbrp({ HTTP: { Request: (o) => requests.push(o) } })
    const q = abrp.__test.getQueue()
    q.length = 0
    return { abrp, requests, q }
  }

  test('removes only the batch that was sent, despite concurrent appends', () => {
    const { abrp, requests, q } = setup()
    q.push({ utc: 1 }, { utc: 2 }, { utc: 3 })
    abrp.__test.sendBulkTelemetry()
    expect(requests).toHaveLength(1)
    // telemetry queued while the request is in flight
    q.push({ utc: 4 })
    requests[0].done({ statusCode: 200, body: '{"status":"ok"}' })
    expect(q.map((t) => t.utc)).toEqual([4])
  })

  test('does not start a second send while one is in flight', () => {
    const { abrp, requests, q } = setup()
    q.push({ utc: 1 })
    abrp.__test.sendBulkTelemetry() // starts; done not yet called
    abrp.__test.sendBulkTelemetry() // must be skipped
    expect(requests).toHaveLength(1)
  })

  test('leaves the queue intact on a 200 with status:error', () => {
    const { abrp, requests, q } = setup()
    q.push({ utc: 1 }, { utc: 2 })
    abrp.__test.sendBulkTelemetry()
    requests[0].done({ statusCode: 200, body: '{"status":"error"}' })
    expect(q.map((t) => t.utc)).toEqual([1, 2])
    abrp.__test.sendBulkTelemetry() // guard must be cleared after a rejected-but-200 response
    expect(requests).toHaveLength(2)
  })

  test('sends and removes at most MAX_BULK_BATCH_SIZE (10) per flush', () => {
    const { abrp, requests, q } = setup()
    for (let i = 1; i <= 15; i++) q.push({ utc: i })
    abrp.__test.sendBulkTelemetry()
    expect(requests).toHaveLength(1)
    expect(requests[0].post).toBeDefined()
    const sent = JSON.parse(requests[0].post).data[0].tlm_list
    expect(sent).toHaveLength(10)
    requests[0].done({ statusCode: 200, body: '{"status":"ok"}' })
    expect(q.map((t) => t.utc)).toEqual([11, 12, 13, 14, 15])
  })

  test('clears the in-flight guard on failure so the next tick can retry', () => {
    const { abrp, requests, q } = setup()
    q.push({ utc: 1 })
    abrp.__test.sendBulkTelemetry()
    requests[0].fail('timeout')
    abrp.__test.sendBulkTelemetry() // guard cleared => a new request goes out
    expect(requests).toHaveLength(2)
  })
})

describe('getOVMSMetric: capacity and soe', () => {
  function withMetrics(present) {
    return loadAbrp({
      OvmsMetrics: {
        HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
        GetValues: (keys) => {
          const o = {}
          keys.forEach((k) => {
            o[k] = present[k]
          })
          return o
        },
      },
    })
  }

  test('capacity maps directly from v.b.capacity (kWh)', () => {
    const abrp = withMetrics({ 'v.b.capacity': 60 })
    expect(abrp.getOVMSMetric('capacity')).toEqual([true, 60])
  })

  test('soe is derived as (soc/100) * capacity', () => {
    const abrp = withMetrics({ 'v.b.soc': 50, 'v.b.capacity': 60 })
    expect(abrp.getOVMSMetric('soe')).toEqual([true, 30])
  })

  test('capacity is unsupported when v.b.capacity is absent', () => {
    const abrp = withMetrics({ 'v.b.soc': 50 })
    expect(abrp.getOVMSMetric('capacity')).toEqual([false, null])
  })

  test('soe is unsupported when capacity is absent', () => {
    const abrp = withMetrics({ 'v.b.soc': 50 })
    expect(abrp.getOVMSMetric('soe')).toEqual([false, null])
  })

  test('soe is unsupported when soc is absent', () => {
    const abrp = withMetrics({ 'v.b.capacity': 60 })
    expect(abrp.getOVMSMetric('soe')).toEqual([false, null])
  })
})

describe('getOVMSMetric: tyre pressures from the v.t.pressure vector', () => {
  function withMetrics(present) {
    return loadAbrp({
      OvmsMetrics: {
        HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
        GetValues: (keys) => {
          const o = {}
          keys.forEach((k) => {
            o[k] = present[k]
          })
          return o
        },
      },
    })
  }

  // OVMS pushes a vector metric to Duktape as a JS array; wheel order FL=0, FR=1, RL=2, RR=3.
  test('each corner reads its fixed index of v.t.pressure (kPa)', () => {
    const abrp = withMetrics({ 'v.t.pressure': [230, 231, 232, 233] })
    expect(abrp.getOVMSMetric('tire_pressure_fl')).toEqual([true, 230])
    expect(abrp.getOVMSMetric('tire_pressure_fr')).toEqual([true, 231])
    expect(abrp.getOVMSMetric('tire_pressure_rl')).toEqual([true, 232])
    expect(abrp.getOVMSMetric('tire_pressure_rr')).toEqual([true, 233])
  })

  test('tyre pressures are unsupported when v.t.pressure is absent', () => {
    const abrp = withMetrics({ 'v.b.soc': 50 })
    expect(abrp.getOVMSMetric('tire_pressure_fl')).toEqual([false, null])
    expect(abrp.getOVMSMetric('tire_pressure_rr')).toEqual([false, null])
  })
})

describe('median smoothing on the live path', () => {
  test('queueTelemetry applies the median power/speed when samples were collected', () => {
    const abrp = loadAbrp()
    abrp.__test.setLastQueued({ utc: 0 })
    abrp.__test.getQueue().length = 0
    abrp.__test.setCollected([
      { power: 1, speed: 10 },
      { power: 3, speed: 3 },
      { power: 10, speed: 1 },
    ])
    const telemetry = { utc: 100, soc: 50, power: 99, speed: 99 }
    abrp.__test.queueTelemetry(telemetry, true)
    const queued = abrp.__test.getQueue()
    expect(queued).toHaveLength(1)
    expect(queued[0].power).toBe(3) // median by power
    expect(queued[0].speed).toBe(3)
  })

  test('queueTelemetryIfNecessary collects a sample while driving', () => {
    const present = {
      'm.time.utc': 1000,
      'v.b.soc': 50,
      'v.p.speed': 30,
      'v.b.power': 5,
      'v.e.parktime': 0, // parktime 0 => is_parked false
    }
    const abrp = loadAbrp({
      OvmsMetrics: {
        HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
        GetValues: (keys) => {
          const o = {}
          keys.forEach((k) => {
            o[k] = present[k]
          })
          return o
        },
      },
    })
    // No significant change and no elapsed time => collect but do not queue.
    // Omit is_charging so it matches the undefined value createTelemetry yields
    // here (no v.c.charging stub) — otherwise the change looks "significant".
    abrp.__test.setLastQueued({
      utc: 1000,
      soc: 50,
      is_parked: false,
      power: 5,
    })
    abrp.__test.getQueue().length = 0
    abrp.__test.setCollected([])
    abrp.__test.queueTelemetryIfNecessary()
    expect(abrp.__test.getCollected()).toHaveLength(1)
    expect(abrp.__test.getQueue()).toHaveLength(0)
  })

  test('an elapsed tick collects the current sample, queues the median, and resets collected', () => {
    const present = {
      'm.time.utc': 1000,
      'v.b.soc': 50,
      'v.p.speed': 100,
      'v.b.power': 7,
      'v.e.parktime': 0, // not parked
    }
    const abrp = loadAbrp({
      OvmsMetrics: {
        HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
        GetValues: (keys) => {
          const o = {}
          keys.forEach((k) => {
            o[k] = present[k]
          })
          return o
        },
      },
    })
    abrp.__test.setCollected([
      { power: 1, speed: 10 },
      { power: 3, speed: 3 },
      { power: 10, speed: 1 },
    ])
    abrp.__test.setLastQueued({ utc: 0 })
    abrp.__test.getQueue().length = 0
    abrp.__test.queueTelemetryIfNecessary()
    const q = abrp.__test.getQueue()
    expect(q).toHaveLength(1)
    expect(q[0].power).toBe(3)
    expect(q[0].speed).toBe(3)
    expect(abrp.__test.getCollected()).toHaveLength(0)
  })
})

describe('sendBulkTelemetry queue-overflow during an in-flight batch', () => {
  test('a successful flush drops only the points that were actually sent', () => {
    const requests = []
    const abrp = loadAbrp({ HTTP: { Request: (o) => requests.push(o) } })
    const q = abrp.__test.getQueue()
    q.length = 0
    // Fill the queue to capacity (MAX_TELEMETRY_QUEUE_SIZE = 100) with
    // identifiable points.
    for (let i = 1; i <= 100; i++) q.push({ utc: i })

    abrp.__test.sendBulkTelemetry() // snapshots batch = utc 1..10
    expect(requests).toHaveLength(1)

    // While the request is in flight, 5 new points arrive. The queue is at
    // capacity, so queueTelemetry's overflow drop shifts the oldest (utc 1..5,
    // which are part of the in-flight batch) out of the front.
    for (let i = 101; i <= 105; i++) abrp.__test.queueTelemetry({ utc: i }, false)

    requests[0].done({ statusCode: 200, body: '{"status":"ok"}' })

    const remaining = q.map((t) => t.utc)
    // The sent batch (utc 1..10) must be gone...
    expect(remaining).not.toContain(10)
    // ...but the unsent points just behind it must NOT be dropped. The buggy
    // front-splice removes utc 6..15, silently discarding the never-sent 11..15.
    expect(remaining).toContain(11)
    expect(remaining).toContain(15)
    // ...and the newly queued points are retained.
    expect(remaining).toContain(105)
  })
})

describe('calculateMaxElapsedDuration cadence selector', () => {
  // calculateMaxElapsedDuration returns the MAX seconds allowed between sent
  // points for the current vehicle state (0 = send now, larger = quieter). It is
  // a first-match-wins cascade; branches 2-5 are only reached when the telemetry
  // is NOT a significant change vs lastQueuedTelemetry. `notSignificant(t)` builds
  // a matching baseline (same soc / is_charging / is_parked / power) so we fall
  // through branch 1 and exercise the timing branches.
  function notSignificant(t) {
    return {
      soc: t.soc,
      is_charging: t.is_charging,
      is_parked: t.is_parked,
      power: t.power,
    }
  }

  test('branch 1: a significant change (SoC moved) forces an immediate send (0)', () => {
    const abrp = loadAbrp()
    abrp.__test.setLastQueued({ soc: 50, is_charging: false, is_parked: false })
    expect(
      abrp.calculateMaxElapsedDuration({ soc: 51, is_charging: false, is_parked: false })
    ).toBe(0)
  })

  test('branch 2: driving above the 70 kph calibration speed polls every 5 s', () => {
    const abrp = loadAbrp()
    const t = { soc: 50, speed: 80, is_parked: false, is_charging: false, is_dcfc: false }
    abrp.__test.setLastQueued(notSignificant(t))
    expect(abrp.calculateMaxElapsedDuration(t)).toBe(5)
  })

  test('branch 2 boundary: exactly 70 kph is NOT "driving" — falls to the 160 s path', () => {
    const abrp = loadAbrp()
    const t = { soc: 50, speed: 70, is_parked: false, is_charging: false, is_dcfc: false }
    abrp.__test.setLastQueued(notSignificant(t))
    expect(abrp.calculateMaxElapsedDuration(t)).toBe(160)
  })

  test('branch 3: moving slowly / not parked uses the 160 s stale-connection heartbeat', () => {
    const abrp = loadAbrp()
    const t = { soc: 50, speed: 20, is_parked: false, is_charging: false, is_dcfc: false }
    abrp.__test.setLastQueued(notSignificant(t))
    expect(abrp.calculateMaxElapsedDuration(t)).toBe(160)
  })

  test('branch 3: DC fast charging uses the fast 160 s path even when parked', () => {
    const abrp = loadAbrp()
    const t = { soc: 50, speed: 0, is_parked: true, is_charging: true, is_dcfc: true, power: -60 }
    abrp.__test.setLastQueued(notSignificant(t))
    expect(abrp.calculateMaxElapsedDuration(t)).toBe(160)
  })

  test('branch 4: standard (AC) charging while parked uses the 30-min cadence', () => {
    const abrp = loadAbrp()
    const t = { soc: 50, speed: 0, is_parked: true, is_charging: true, is_dcfc: false, power: -6 }
    abrp.__test.setLastQueued(notSignificant(t))
    expect(abrp.calculateMaxElapsedDuration(t)).toBe(30 * 60)
  })

  test('branch 5: parked and idle defaults to 24 h (effectively silent)', () => {
    const abrp = loadAbrp()
    const t = { soc: 50, speed: 0, is_parked: true, is_charging: false, is_dcfc: false }
    abrp.__test.setLastQueued(notSignificant(t))
    expect(abrp.calculateMaxElapsedDuration(t)).toBe(24 * 3600)
  })

  // FIX: charging is decided before the not-parked stale path, so a missing
  // is_parked (SUBSOL/TOYBZ4X drop v.e.gear while plugged in) no longer throttles
  // AC charge to 160 s — it gets the intended 30-min charging cadence.
  test('AC charging with is_parked ABSENT uses the 30-min charging cadence', () => {
    const abrp = loadAbrp()
    const t = { soc: 50, speed: 0, is_charging: true, is_dcfc: false, power: -6 } // no is_parked
    abrp.__test.setLastQueued(notSignificant(t))
    expect(abrp.calculateMaxElapsedDuration(t)).toBe(30 * 60)
  })

  // DCFC is checked before charging, so even with is_parked absent it stays on the
  // fast 160 s path (guards the reorder from regressing DCFC).
  test('DCFC with is_parked ABSENT still uses the fast 160 s path', () => {
    const abrp = loadAbrp()
    const t = { soc: 50, speed: 0, is_charging: true, is_dcfc: true, power: -60 } // no is_parked
    abrp.__test.setLastQueued(notSignificant(t))
    expect(abrp.calculateMaxElapsedDuration(t)).toBe(160)
  })
})

// Shared stub builder: OVMS metric store where only `present` keys HasValue.
function metricsStub(present) {
  return {
    HasValue: (k) => Object.prototype.hasOwnProperty.call(present, k),
    GetValues: (keys) => {
      const o = {}
      keys.forEach((k) => {
        o[k] = present[k]
      })
      return o
    },
    Value: (k) => present[k],
  }
}

// PubSub stub that records subscriptions so a test can ask which topics are
// currently subscribed (active = subscribed and not yet unsubscribed).
function makePubSub() {
  const subs = []
  let n = 0
  return {
    pubsub: {
      subscribe: (topic, cb) => {
        const token = ++n
        subs.push({ topic, cb, token, active: true })
        return token
      },
      unsubscribe: (token) => {
        const s = subs.find((x) => x.token === token)
        if (s) s.active = false
      },
    },
    activeTopics: () => subs.filter((s) => s.active).map((s) => s.topic),
    fire: (topic) => {
      subs
        .filter((s) => s.active && s.topic === topic)
        .forEach((s) => { if (s.active) s.cb(topic) })
    },
    count: (topic) => subs.filter((s) => s.active && s.topic === topic).length,
  }
}

describe('getOVMSMetric: is_dcfc derivation (v.c.mode === "performance")', () => {
  const withMetrics = (present) => loadAbrp({ OvmsMetrics: metricsStub(present) })

  test('v.c.mode "performance" => DC fast charging true', () => {
    expect(withMetrics({ 'v.c.mode': 'performance' }).getOVMSMetric('is_dcfc')).toEqual([true, true])
  })
  test('any other v.c.mode => false (present but not DCFC)', () => {
    expect(withMetrics({ 'v.c.mode': 'standard' }).getOVMSMetric('is_dcfc')).toEqual([true, false])
  })
  test('v.c.mode absent => unsupported (field omitted from payload)', () => {
    expect(withMetrics({ 'v.b.soc': 50 }).getOVMSMetric('is_dcfc')).toEqual([false, null])
  })
})

describe('getOVMSMetric: is_parked derivation (default v.e.parktime > 0)', () => {
  const withMetrics = (present) => loadAbrp({ OvmsMetrics: metricsStub(present) })

  test('parktime > 0 => parked true', () => {
    expect(withMetrics({ 'v.e.parktime': 120 }).getOVMSMetric('is_parked')).toEqual([true, true])
  })
  test('parktime 0 => parked false', () => {
    expect(withMetrics({ 'v.e.parktime': 0 }).getOVMSMetric('is_parked')).toEqual([true, false])
  })
  test('parktime absent => unsupported (field omitted)', () => {
    expect(withMetrics({ 'v.b.soc': 50 }).getOVMSMetric('is_parked')).toEqual([false, null])
  })
})

describe('overrideMetricMap vehicle quirks (SUBSOL / TOYBZ4X)', () => {
  function withType(type, present) {
    const stub = metricsStub(present)
    stub.Value = (k) => (k === 'v.type' ? type : present[k])
    return loadAbrp({ OvmsMetrics: stub })
  }

  test('SUBSOL: is_parked derives from v.e.gear === 0 (not v.e.parktime)', () => {
    const abrp = withType('SUBSOL', { 'v.e.gear': 0 })
    abrp.__test.overrideMetricMap()
    expect(abrp.getOVMSMetric('is_parked')).toEqual([true, true])
  })
  test('SUBSOL: v.e.gear non-zero => not parked', () => {
    const abrp = withType('SUBSOL', { 'v.e.gear': 2 })
    abrp.__test.overrideMetricMap()
    expect(abrp.getOVMSMetric('is_parked')).toEqual([true, false])
  })
  test('SUBSOL: v.e.gear absent => is_parked unsupported (the AC-charge omission case)', () => {
    const abrp = withType('SUBSOL', { 'v.b.soc': 50 })
    abrp.__test.overrideMetricMap()
    expect(abrp.getOVMSMetric('is_parked')).toEqual([false, null])
  })
  test('SUBSOL: hvac_power derives from xte.v.e.hvac.power', () => {
    const abrp = withType('SUBSOL', { 'xte.v.e.hvac.power': 1.5 })
    abrp.__test.overrideMetricMap()
    expect(abrp.getOVMSMetric('hvac_power')).toEqual([true, 1.5])
  })
  test('TOYBZ4X shares the SUBSOL override (is_parked via v.e.gear)', () => {
    const abrp = withType('TOYBZ4X', { 'v.e.gear': 0 })
    abrp.__test.overrideMetricMap()
    expect(abrp.getOVMSMetric('is_parked')).toEqual([true, true])
  })
})

describe('createTelemetry charging payload shape (absent metrics are omitted, not zero-filled)', () => {
  test('a charge state with speed/gear/temp metrics absent omits exactly those fields', () => {
    // Mirrors the observed SUBSOL AC-charge payload: charging metrics present,
    // but the module has dropped speed/heading/gear/temp/cabin while plugged in.
    const present = {
      'm.time.utc': 1000,
      'v.b.soc': 50,
      'v.b.power': -6,
      'v.c.charging': true,
      'v.c.mode': 'standard',
      'v.b.voltage': 380,
      'v.b.current': -17,
      'v.p.odometer': 39500,
      // absent: v.p.speed, v.p.direction, v.e.parktime, v.e.temp, v.e.cabintemp, v.e.cabinsetpoint
    }
    const t = loadAbrp({ OvmsMetrics: metricsStub(present) }).__test.createTelemetry()
    // present
    expect(t).toHaveProperty('is_charging', true)
    expect(t).toHaveProperty('is_dcfc', false)
    expect(t).toHaveProperty('soc', 50)
    expect(t).toHaveProperty('odometer', 39500)
    // absent => omitted (NOT present with a falsy/zero value)
    expect(t).not.toHaveProperty('speed')
    expect(t).not.toHaveProperty('heading')
    expect(t).not.toHaveProperty('is_parked')
    expect(t).not.toHaveProperty('ext_temp')
    expect(t).not.toHaveProperty('cabin_temp')
    expect(t).not.toHaveProperty('hvac_setpoint')
  })
})

describe('queueTelemetry overflow drop at the queue cap (MAX_TELEMETRY_QUEUE_SIZE = 100)', () => {
  test('pushing past 100 drops the oldest and holds the cap', () => {
    const abrp = loadAbrp()
    const q = abrp.__test.getQueue()
    q.length = 0
    for (let i = 1; i <= 100; i++) q.push({ utc: i })
    abrp.__test.setCollected([]) // no median to apply
    abrp.__test.queueTelemetry({ utc: 101 }, false)
    const after = abrp.__test.getQueue()
    expect(after).toHaveLength(100) // cap held
    expect(after[0].utc).toBe(2) // oldest (utc 1) dropped
    expect(after[after.length - 1].utc).toBe(101) // newest retained
  })
})

describe('sendBulkTelemetry fail-path resilience', () => {
  test('transport errors keep the batch + clear isSending; a later success drains it with no dup/drop', () => {
    let failsLeft = 2 // fail the first two attempts, then succeed
    const abrp = loadAbrp({
      HTTP: {
        Request: (o) => {
          if (failsLeft > 0) {
            failsLeft--
            o.fail('network unavailable')
          } else {
            o.done({ statusCode: 200, body: JSON.stringify({ status: 'ok' }) })
          }
        },
      },
    })
    const q = abrp.__test.getQueue()
    q.length = 0
    for (let i = 1; i <= 3; i++) q.push({ utc: i })

    abrp.__test.sendBulkTelemetry() // fail #1
    expect(abrp.__test.getQueue()).toHaveLength(3) // batch retained on failure
    abrp.__test.sendBulkTelemetry() // fail #2 (proves isSending was cleared)
    expect(abrp.__test.getQueue()).toHaveLength(3)
    abrp.__test.sendBulkTelemetry() // success
    expect(abrp.__test.getQueue()).toHaveLength(0) // drained exactly once
  })
})

describe('queueTelemetryIfNecessary stale-connection heartbeat boundary (160 s)', () => {
  // not-parked (parktime 0), no speed => 160 s cadence; baseline matches so the
  // only thing that can trigger a send is crossing the 160 s elapsed boundary.
  function atUtc(utc) {
    const present = { 'm.time.utc': utc, 'v.b.soc': 50, 'v.b.power': 5, 'v.e.parktime': 0 }
    const abrp = loadAbrp({ OvmsMetrics: metricsStub(present) })
    abrp.__test.getQueue().length = 0
    abrp.__test.setCollected([])
    abrp.__test.setLastQueued({ utc: 1000, soc: 50, is_parked: false, power: 5 })
    return abrp
  }

  test('exactly 160 s since last queued forces a heartbeat point', () => {
    const abrp = atUtc(1160)
    abrp.__test.queueTelemetryIfNecessary()
    expect(abrp.__test.getQueue()).toHaveLength(1)
  })
  test('159 s since last queued does NOT send', () => {
    const abrp = atUtc(1159)
    abrp.__test.queueTelemetryIfNecessary()
    expect(abrp.__test.getQueue()).toHaveLength(0)
  })
})

describe('lifecycle / event flow', () => {
  // Provide PubSub + OvmsMetrics (no OvmsConfig) so the module's load-time
  // auto-start guard stays OFF and each test starts from a clean subscription set.
  // Pass `config` to additionally satisfy the auto-start + send() config gate.
  function loadWired(present, config) {
    const ps = makePubSub()
    const globals = { PubSub: ps.pubsub, OvmsMetrics: metricsStub(present || {}) }
    if (config) globals.OvmsConfig = config
    return { abrp: loadAbrp(globals), ps }
  }

  test('callbackVehicleOn subscribes ticker.1; callbackVehicleOff unsubscribes it', () => {
    const { abrp, ps } = loadWired({})
    abrp.__test.callbackVehicleOn()
    expect(ps.activeTopics()).toContain('ticker.1')
    abrp.__test.callbackVehicleOff()
    expect(ps.activeTopics()).not.toContain('ticker.1')
  })

  test('manageVehicleStateEvents(true) wires the vehicle/ticker topics + sets active; (false) tears them all down', () => {
    const { abrp, ps } = loadWired({}) // v.e.on absent => vehicle OFF, no cold-boot resume
    abrp.__test.manageVehicleStateEvents(true)
    expect(ps.activeTopics()).toEqual(
      expect.arrayContaining([
        'vehicle.type.set',
        'ticker.10',
        'vehicle.on',
        'vehicle.charge.start',
        'vehicle.off',
        'vehicle.charge.stop',
      ])
    )
    expect(ps.activeTopics()).not.toContain('ticker.1') // not sampling until vehicle on
    expect(abrp.__test.isActive()).toBe(true)

    abrp.__test.manageVehicleStateEvents(false)
    const after = ps.activeTopics()
    expect(after).not.toContain('vehicle.on')
    expect(after).not.toContain('vehicle.off')
    // Symmetric teardown (state-machine fix): vehicle.type.set and ticker.10
    // are unsubscribed too, so send(0)/send(1) cycles cannot stack duplicate
    // sendBulkTelemetry/overrideMetricMap subscriptions.
    expect(after).not.toContain('vehicle.type.set')
    expect(after).not.toContain('ticker.10')
    expect(abrp.__test.isActive()).toBe(false)
  })

  test('cold-boot resume: v.e.on truthy starts ticker.1 sampling immediately', () => {
    const { abrp, ps } = loadWired({ 'v.e.on': true })
    abrp.__test.manageVehicleStateEvents(true)
    expect(ps.activeTopics()).toContain('ticker.1')
  })

  test('checkTime: invalid GPS time leaves time invalid and does not start sending', () => {
    const { abrp } = loadWired({ 'm.time.utc': 0 })
    abrp.__test.checkTime()
    expect(abrp.__test.isTimeValid()).toBe(false)
    expect(abrp.__test.isActive()).toBe(false)
  })

  test('checkTime: valid GPS time marks time valid and starts sending', () => {
    const { abrp } = loadWired(
      { 'm.time.utc': 2000000000 }, // > Jan 1 2000 threshold
      { GetValues: () => ({ user_token: 'tok' }) }
    )
    abrp.__test.checkTime()
    expect(abrp.__test.isTimeValid()).toBe(true)
    expect(abrp.__test.isActive()).toBe(true)
  })

  test('send guard: double start warns "Already running!"; double stop warns "Already stopped!"', () => {
    const { abrp } = loadWired(
      { 'm.time.utc': 2000000000 },
      { GetValues: () => ({ user_token: 'tok' }) }
    )
    const logs = []
    const prevPrint = global.print
    global.print = (s) => logs.push(String(s))
    try {
      abrp.__test.checkTime() // -> time valid + active
      abrp.send(true) // already active
      expect(logs.some((l) => l.indexOf('Already running!') !== -1)).toBe(true)
      abrp.send(false) // stop
      abrp.send(false) // already stopped
      expect(logs.some((l) => l.indexOf('Already stopped!') !== -1)).toBe(true)
    } finally {
      global.print = prevPrint
    }
  })
})

describe('charge/drive overlap state machine', () => {
  // Boots the module through the real checkTime -> send(true) flow so the
  // vehicle events are wired exactly as on-device, then drives the state
  // machine by firing PubSub events while mutating the metric levels — the
  // sampler must track the LEVEL (v.e.on || v.c.charging), not raw edges.
  function boot(initialLevels) {
    const ps = makePubSub()
    const present = Object.assign({
      'm.time.utc': 1700000000, 'v.b.soc': 50, 'v.e.parktime': 100,
      'v.e.on': false, 'v.c.charging': false,
    }, initialLevels)
    const abrp = loadAbrp({
      OvmsConfig: { GetValues: () => ({ user_token: 'T' }) },
      OvmsNotify: { Raise: () => {} },
      PubSub: ps.pubsub,
      OvmsMetrics: metricsStub(present),
    })
    // Valid GPS time: checkTime unsubscribes itself and runs send(true).
    ps.fire('ticker.1')
    return { abrp, present, fire: ps.fire, count: ps.count }
  }

  test('vehicle.on while already charging does not double-subscribe the sampler', () => {
    const { abrp, present, fire, count } = boot()
    abrp.__test.getQueue().length = 0
    present['v.c.charging'] = true
    fire('vehicle.charge.start')
    expect(count('ticker.1')).toBe(1) // sampler on
    present['v.e.on'] = true
    fire('vehicle.on') // driver gets in while still plugged
    expect(count('ticker.1')).toBe(1) // still exactly one sampler
    expect(abrp.__test.getQueue()).toHaveLength(1) // a single session-start bookend
  })

  test('unplugging while the vehicle is on keeps the sampler until vehicle.off', () => {
    const { abrp, present, fire, count } = boot()
    abrp.__test.getQueue().length = 0
    present['v.c.charging'] = true
    fire('vehicle.charge.start')
    present['v.e.on'] = true
    fire('vehicle.on')
    present['v.c.charging'] = false
    fire('vehicle.charge.stop') // unplug; vehicle still on, about to drive away
    expect(count('ticker.1')).toBe(1) // sampler must survive the unplug
    present['v.e.on'] = false
    fire('vehicle.off')
    expect(count('ticker.1')).toBe(0) // session over, sampler stops
    // Exactly one start bookend and one off bookend for the whole session.
    expect(abrp.__test.getQueue()).toHaveLength(2)
  })

  test('send(0)/send(1) cycles do not stack ticker.10 / vehicle.type.set subscriptions', () => {
    const { abrp, count } = boot()
    abrp.send(0)
    abrp.send(1)
    expect(count('ticker.10')).toBe(1)
    expect(count('vehicle.type.set')).toBe(1)
  })

  test('booting while charging (ignition off) starts the session', () => {
    // The charge.start edge fired before the module booted; the level check
    // must catch it or the charge session goes unreported until the next edge.
    const { count } = boot({ 'v.c.charging': true })
    expect(count('ticker.1')).toBe(1) // sampler subscribed at startup
  })
})
