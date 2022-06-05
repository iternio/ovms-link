const { average, median, omitNil, round } = require('./abrp')

describe('average', () => {
  test('should return null with no array elements', () => {
    expect(average([])).toBeNull()
  })
  test('should work as expected', () => {
    expect(average([1, 2, 3, 4, 10])).toBe(4)
  })
})

describe('median', () => {
  test('should return null with no array elements', () => {
    expect(median([])).toBeNull()
  })
  test('should work as expected with odd number of elements', () => {
    expect(median([1, 2, 3, 4, 10])).toBe(3)
    expect(median([10, 4, 2, 3, 1])).toBe(3)
  })
  test('should work as expected with even number of elements', () => {
    expect(median([1, 3, 4, 10])).toBe(3.5)
    expect(median([10, 1, 4, 3])).toBe(3.5)
  })
})

describe('omitNil', () => {
  test('should work as expected', () => {
    expect(omitNil({
      foo: 'foo',
      bar: 'bar',
      spaz: null
    })).toEqual({
      foo: 'foo',
      bar: 'bar'
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