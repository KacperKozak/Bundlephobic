import { describe, expect, test } from 'bun:test'
import {
    DEP_LINE_RE,
    DEP_SECTION_HEADER_RE,
    SEMVER_RE,
    extractPinnedVersion,
} from './regexp'

describe('regexp utils', () => {
    test('SEMVER_RE matches semantic versions', () => {
        const text = 'vite:^5.4.2 some 1.2.3-beta.1 and 0.0.1'
        const m = text.match(SEMVER_RE)
        expect(m?.[0]).toBe('5.4.2')
    })

    test('extractPinnedVersion strips range operators', () => {
        expect(extractPinnedVersion('^1.2.3')).toBe('1.2.3')
        expect(extractPinnedVersion('~2.0.0')).toBe('2.0.0')
        expect(extractPinnedVersion('  ^3.4.5 ')).toBe('3.4.5')
        expect(extractPinnedVersion('workspace:*')).toBe('workspace:*')
    })

    test('dependency section header', () => {
        expect(DEP_SECTION_HEADER_RE.test('  "dependencies": {')).toBe(true)
        expect(DEP_SECTION_HEADER_RE.test('  "devDependencies": {')).toBe(true)
        expect(DEP_SECTION_HEADER_RE.test('  "scripts": {')).toBe(false)
    })

    test('dependency line', () => {
        const m = '  "react": "18.3.1",'.match(DEP_LINE_RE)
        expect(m?.[1]).toBe('react')
        expect(m?.[2]).toBe('18.3.1')
    })
})
