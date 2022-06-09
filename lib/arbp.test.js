const { medianPowerMetrics, omitNil, round } = require('./abrp')

describe('medianPowerMetrics', () => {
  test('should return null with no array elements', () => {
    expect(medianPowerMetrics([])).toBeNull()
  })
  test('should work as expected with odd number of elements', () => {
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
  test('should work as expected with even number of elements', () => {
    expect(
      medianPowerMetrics([
        { power: 1, speed: 10 },
        { power: 3, speed: 3 },
        { power: 4, speed: 2 },
        { power: 10, speed: 1 },
      ])
    ).toEqual({ power: 3.5, speed: 2.5 })
    expect(
      medianPowerMetrics([
        { power: 10, speed: 1 },
        { power: 1, speed: 10 },
        { power: 4, speed: 2 },
        { power: 3, speed: 3 },
      ])
    ).toEqual({ power: 3.5, speed: 2.5 })
  })
})

describe('omitNil', () => {
  test('should work as expected', () => {
    expect(
      omitNil({
        foo: 'foo',
        bar: 'bar',
        spaz: null,
      })
    ).toEqual({
      foo: 'foo',
      bar: 'bar',
    })
  })
})

describe('round', () => {
  test('should default to no decimal', () => {
    expect(round(12)).toBe(12)
    expect(round(12.34567)).toBe(12)
  })
  test('should use provided precision', () => {
    expect(round(12.34567, 2)).toBe(12.35)
    expect(round(12.34, 6)).toBe(12.34)
  })
})
