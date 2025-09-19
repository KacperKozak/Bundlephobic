export interface DefaultCatalogMap {
    [packageName: string]: string
}

const stripQuotes = (value: string) => value.replace(/^['"]|['"]$/g, '')

export const parseDefaultCatalogFromYaml = (yamlText: string): DefaultCatalogMap => {
    const result: DefaultCatalogMap = {}
    const lines = yamlText.split(/\r?\n/)

    let inside = false
    let catalogIndent = 0

    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i]
        const line = rawLine.replace(/#.*$/, '')
        if (!inside) {
            const m = line.match(/^(\s*)catalog\s*:\s*$/)
            if (m) {
                inside = true
                catalogIndent = m[1].length
            }
            continue
        }

        if (!line.trim()) continue

        const leadingSpaces = line.match(/^\s*/)?.[0].length ?? 0
        if (leadingSpaces <= catalogIndent) {
            break
        }

        const kvMatch = line.match(/^[\s-]*(["'][^"']+["']|[^:\s][^:]*)\s*:\s*(.+?)\s*$/)
        if (!kvMatch) continue
        const key = stripQuotes(kvMatch[1].trim())
        const value = stripQuotes(kvMatch[2].trim())
        if (key && value) {
            result[key] = value
        }
    }

    return result
}

export const parseDefaultCatalogFromPackageJson = (
    pkgJson: unknown,
): DefaultCatalogMap => {
    const result: DefaultCatalogMap = {}
    if (!pkgJson || typeof pkgJson !== 'object') return result
    const obj = pkgJson as Record<string, unknown>

    const tryAssign = (src: unknown) => {
        if (src && typeof src === 'object') {
            for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
                if (typeof v === 'string') result[k] = v
            }
        }
    }

    // Top-level catalog (non-standard, but support it if present)
    if (obj.catalog) tryAssign(obj.catalog)

    const pnpm = obj.pnpm as Record<string, unknown> | undefined
    if (pnpm) {
        if (pnpm.catalog) tryAssign(pnpm.catalog)
        const catalogs = pnpm.catalogs as Record<string, unknown> | undefined
        if (catalogs && typeof catalogs.default === 'object') tryAssign(catalogs.default)
    }

    return result
}

export interface NormalizeResult {
    skip: boolean
    resolvedVersion?: string
    fromCatalog?: boolean
}

export const normalizeVersionForMonorepo = (
    packageName: string,
    rawVersion: string,
    defaultCatalog: DefaultCatalogMap,
): NormalizeResult => {
    const trimmed = rawVersion.trim()

    if (trimmed.startsWith('workspace:')) return { skip: true }

    if (trimmed.startsWith('catalog:')) {
        const after = trimmed.slice('catalog:'.length).trim()
        if (!after || after === '.') {
            const resolved = defaultCatalog[packageName]
            if (resolved)
                return { skip: false, resolvedVersion: resolved, fromCatalog: true }
            return { skip: true }
        }
        // When an alias is provided (catalog:alias), we do not support named catalogs here.
        // Fallback to skip to avoid incorrect network calls.
        return { skip: true }
    }

    return { skip: false, resolvedVersion: trimmed }
}
