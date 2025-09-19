import { describe, expect, test } from 'bun:test'
import { formatBytes } from './formatBytes'

describe('utils', () => {
    test('formatBytes', () => {
        expect(formatBytes(-1)).toBe('n/e')
        expect(formatBytes(0)).toBe('0B')
        expect(formatBytes(999)).toBe('999B')
        expect(formatBytes(1024)).toBe('1.0kB')
        expect(formatBytes(1024 * 1024)).toBe('1.0MB')
    })
})
