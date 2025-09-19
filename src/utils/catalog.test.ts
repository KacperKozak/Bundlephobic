import { describe, expect, test } from 'bun:test'
import {
    normalizeVersionForMonorepo,
    parseDefaultCatalogFromYaml,
    parseDefaultCatalogFromPackageJson,
} from './catalog'

describe('catalog parsing', () => {
    test('parses default catalog from yaml', () => {
        const yaml = `
catalog:
  "@letsdeel/deel-it-global": "^1.2.3"
  '@letsdeel/deel-it-i18n': 3.4.5
  @letsdeel/deel-it-rest: ^2.0.0
        `.trim()
        const map = parseDefaultCatalogFromYaml(yaml)
        expect(map['@letsdeel/deel-it-global']).toBe('^1.2.3')
        expect(map['@letsdeel/deel-it-i18n']).toBe('3.4.5')
        expect(map['@letsdeel/deel-it-rest']).toBe('^2.0.0')
    })

    test('parses default catalog from package.json shapes', () => {
        const pkg = {
            pnpm: {
                catalog: {
                    '@a/one': '1.0.0',
                },
                catalogs: {
                    default: {
                        '@b/two': '^2.0.0',
                    },
                },
            },
            catalog: {
                '@c/three': '~3.0.0',
            },
        }
        const map = parseDefaultCatalogFromPackageJson(pkg)
        expect(map['@a/one']).toBe('1.0.0')
        expect(map['@b/two']).toBe('^2.0.0')
        expect(map['@c/three']).toBe('~3.0.0')
    })
})

describe('normalizeVersionForMonorepo', () => {
    const catalog = {
        '@letsdeel/deel-it-global': '^1.2.3',
    }

    test('skips workspace protocol', () => {
        const r = normalizeVersionForMonorepo(
            '@letsdeel/dev-tools',
            'workspace:*',
            catalog,
        )
        expect(r.skip).toBe(true)
    })

    test('resolves catalog protocol with default map', () => {
        const r = normalizeVersionForMonorepo(
            '@letsdeel/deel-it-global',
            'catalog:',
            catalog,
        )
        expect(r.skip).toBe(false)
        expect(r.resolvedVersion).toBe('^1.2.3')
    })

    test('passes through explicit versions', () => {
        const r = normalizeVersionForMonorepo('react', '^18.3.1', catalog)
        expect(r.skip).toBe(false)
        expect(r.resolvedVersion).toBe('^18.3.1')
    })
})
