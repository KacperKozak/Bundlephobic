import { describe, expect, test } from 'bun:test'
import { estimateMs } from './estimateMs'

describe('utils', () => {
    test('estimateMs', () => {
        expect(estimateMs(NaN as unknown as number, 1)).toBe(0)
        expect(estimateMs(0, 1)).toBe(0)
        expect(estimateMs(1024, 1024)).toBe(1000)
    })
})
