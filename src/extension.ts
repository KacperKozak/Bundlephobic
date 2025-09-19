import * as vscode from 'vscode'
import * as https from 'node:https'
import type { IncomingMessage } from 'node:http'
import { formatBytes } from './utils/formatBytes'
import { estimateMs } from './utils/estimateMs'
import { extractPinnedVersion } from './utils/regexp'
import { Limiter, makeLimiter } from './lib/limiter'
import { collectDependencies, isPackageJson } from './lib/sections'
import {
    normalizeVersionForMonorepo,
    parseDefaultCatalogFromPackageJson,
    parseDefaultCatalogFromYaml,
    type DefaultCatalogMap,
} from './utils/catalog'

const output = vscode.window.createOutputChannel('Bundlephobic')
const log = (...parts: unknown[]) => {
    try {
        const msg = parts
            .map((p) => {
                if (typeof p === 'string') return p
                try {
                    return JSON.stringify(p)
                } catch {
                    return String(p)
                }
            })
            .join(' ')
        output.appendLine(msg)
    } catch {}
}

let maxConcurrent = 2
let scheduleRequest: Limiter = makeLimiter(maxConcurrent)

interface BundlephobiaSizes {
    size: number
    gzip: number
    version?: string
    dependencyCount?: number
}

interface CachedSizeInfo {
    text: string
    version?: string
    size?: number
    gzip?: number
    dependencyCount?: number
}

const cache = new Map<string, CachedSizeInfo>()
const inFlight = new Map<string, Promise<CachedSizeInfo>>()
let debounceTimer: ReturnType<typeof setTimeout> | undefined

interface NpmPackageJsonLike {
    name?: string
    version?: string
    repository?: { url?: string } | string
    homepage?: string
}

interface NpmLinks {
    githubUrl?: string
    npmUrl: string
}

const fetchNpmMetadata = async (
    name: string,
    version: string,
): Promise<NpmPackageJsonLike | undefined> => {
    try {
        const encodedName = encodeURIComponent(name)
        const encodedVersion = encodeURIComponent(version)
        const url = `https://registry.npmjs.org/${encodedName}/${encodedVersion}`
        const json = (await requestJson(url)) as NpmPackageJsonLike | undefined
        return json
    } catch {
        return undefined
    }
}

const npmMetaCache = new Map<string, { githubUrl?: string }>()
const npmInFlight = new Map<string, Promise<{ githubUrl?: string }>>()
const npmMetaErrorAt = new Map<string, number>()

const getNpmLinks = async (name: string, pinned: string): Promise<NpmLinks> => {
    const key = `${name}@${pinned}`
    const cached = npmMetaCache.get(key)
    if (cached) {
        return {
            npmUrl: `https://www.npmjs.com/package/${encodeURIComponent(name)}/v/${encodeURIComponent(
                pinned,
            )}`,
            githubUrl: cached.githubUrl,
        }
    }

    const lastError = npmMetaErrorAt.get(key)
    const now = Date.now()
    const backoffMs = 5 * 60 * 1000
    if (lastError && now - lastError < backoffMs) {
        return {
            npmUrl: `https://www.npmjs.com/package/${encodeURIComponent(name)}/v/${encodeURIComponent(
                pinned,
            )}`,
        }
    }

    const inflight = npmInFlight.get(key)
    if (inflight) {
        const { githubUrl } = await inflight
        return {
            npmUrl: `https://www.npmjs.com/package/${encodeURIComponent(name)}/v/${encodeURIComponent(
                pinned,
            )}`,
            githubUrl,
        }
    }

    const promise = (async () => {
        const meta = await fetchNpmMetadata(name, pinned)
        if (!meta) {
            npmMetaErrorAt.set(key, Date.now())
            return { githubUrl: undefined as string | undefined }
        }
        const repoOrHome =
            (typeof meta.repository === 'string'
                ? meta.repository
                : meta.repository?.url) || meta.homepage
        const githubUrl = repoOrHome?.replace(/^git\+/, '').replace(/\.git$/, '')
        npmMetaErrorAt.delete(key)
        return { githubUrl }
    })().finally(() => {
        npmInFlight.delete(key)
    })

    npmInFlight.set(key, promise)
    const { githubUrl } = await promise
    npmMetaCache.set(key, { githubUrl })
    return {
        npmUrl: `https://www.npmjs.com/package/${encodeURIComponent(name)}/v/${encodeURIComponent(
            pinned,
        )}`,
        githubUrl,
    }
}

const buildHoverMarkdown = (
    name: string,
    pinned: string,
    info?: CachedSizeInfo,
    links?: NpmLinks,
) => {
    const slow3gMs = estimateMs(info?.gzip ?? 0, 50 * 1024)
    const emerging4gMs = estimateMs(info?.gzip ?? 0, 870 * 1024)
    const sizeText = `**Bundle size**: ${formatBytes(info?.size ?? NaN)}  |  ${formatBytes(
        info?.gzip ?? NaN,
    )} (gzip)\n\n`
    const downloadText =
        `**Download time**: ${slow3gMs >= 1000 ? `${(slow3gMs / 1000).toFixed(1)}s` : `${slow3gMs}ms`} (slow 3G), ` +
        `${emerging4gMs}ms (emerging 4G)\n\n`
    const depsText =
        typeof info?.dependencyCount === 'number'
            ? `**Dependencies**: ${info?.dependencyCount}\n\n`
            : ``
    const bundleUrl = `https://bundlephobia.com/package/${encodeURIComponent(name)}@${encodeURIComponent(
        pinned,
    )}`
    const linkText =
        `[bundlephobia.com](${bundleUrl})` +
        (links
            ? `  |  [npm](${links.npmUrl})` +
              (links.githubUrl ? `  |  [GitHub](${links.githubUrl})` : ``)
            : ``)
    const md = new vscode.MarkdownString(sizeText + downloadText + depsText + linkText)
    md.isTrusted = true
    return md
}

const requestJson = (url: string) =>
    scheduleRequest(
        () =>
            new Promise<unknown>((resolve) => {
                log('HTTP GET', url)
                const req = https.get(
                    url,
                    {
                        headers: {
                            'User-Agent': 'bundlephobic-vscode-extension',
                            'Accept': 'application/json',
                        },
                    },
                    (res: IncomingMessage) => {
                        const status = res.statusCode || 0
                        log('HTTP status', status)
                        if (status >= 400) {
                            res.resume()
                            log('HTTP error for', url)
                            resolve(undefined)
                            return
                        }
                        let data = ''
                        res.setEncoding('utf8')
                        res.on('data', (chunk: string) => (data += chunk))
                        res.on('end', () => {
                            try {
                                const json = JSON.parse(data)
                                resolve(json)
                            } catch {
                                log('HTTP parse error for', url)
                                resolve(undefined)
                            }
                        })
                    },
                )
                req.on('error', (err) => {
                    log('HTTP network error for', url, err?.message || String(err))
                    resolve(undefined)
                })
                req.end()
            }),
    )

const fetchPackageSizes = async (pkgSpecifier: string) => {
    if (cache.has(pkgSpecifier)) {
        log('cache hit', pkgSpecifier)
        return cache.get(pkgSpecifier) as CachedSizeInfo
    }
    if (inFlight.has(pkgSpecifier)) {
        log('inFlight hit', pkgSpecifier)
        return inFlight.get(pkgSpecifier) as Promise<CachedSizeInfo>
    }

    const promise = (async () => {
        const apiUrl = `https://bundlephobia.com/api/size?package=${encodeURIComponent(pkgSpecifier)}`
        const json = (await requestJson(apiUrl)) as Partial<BundlephobiaSizes> | undefined
        if (!json || typeof json.size !== 'number' || typeof json.gzip !== 'number') {
            const miss: CachedSizeInfo = { text: 'error' }
            log('invalid response for', pkgSpecifier)
            cache.set(pkgSpecifier, miss)
            return miss
        }
        const text = `${formatBytes(json.size)} (${formatBytes(json.gzip)})`
        const value: CachedSizeInfo = {
            text,
            version: json.version,
            size: json.size,
            gzip: json.gzip,
            dependencyCount: json.dependencyCount,
        }
        log('fetched sizes', { pkgSpecifier, value })
        cache.set(pkgSpecifier, value)
        return value
    })().finally(() => {
        inFlight.delete(pkgSpecifier)
    })

    inFlight.set(pkgSpecifier, promise)
    return promise
}

export const activate = (context: vscode.ExtensionContext) => {
    log('activate')
    const applyConfig = () => {
        const cfg = vscode.workspace.getConfiguration('bundlephobic')
        const next = Math.max(1, Number(cfg.get('maxConcurrentRequests') || 2))
        if (next !== maxConcurrent) {
            maxConcurrent = next
            scheduleRequest = makeLimiter(maxConcurrent)
            log('updated maxConcurrentRequests to', maxConcurrent)
        }
    }
    applyConfig()
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('bundlephobic.maxConcurrentRequests')) {
                applyConfig()
            }
        }),
    )
    const decorationType = vscode.window.createTextEditorDecorationType({
        after: { margin: '0 0 0 1ch' },
    })

    const isInlayHintsEnabled = (doc: vscode.TextDocument) => {
        const setting = vscode.workspace
            .getConfiguration('editor', doc)
            .get<unknown>('inlayHints.enabled')
        if (typeof setting === 'boolean') return setting
        if (typeof setting === 'string') return setting !== 'off'
        return true
    }

    const renderDecorations = async (editor: vscode.TextEditor) => {
        log('renderDecorations start', editor.document.fileName)
        if (!isPackageJson(editor.document)) {
            editor.setDecorations(decorationType, [])
            log('not package.json, cleared decorations')
            return
        }
        if (isInlayHintsEnabled(editor.document)) {
            editor.setDecorations(decorationType, [])
            log('inlay hints enabled, skip decorations')
            return
        }

        const deps = collectDependencies(editor.document)
        log('found deps (decorations)', deps.length)
        const defaultCatalog = await readDefaultCatalog(editor.document)

        const normalized = deps
            .map((d) => {
                const norm = normalizeVersionForMonorepo(
                    d.name,
                    d.version,
                    defaultCatalog,
                )
                if (norm.skip || !norm.resolvedVersion) return undefined
                return {
                    ...d,
                    resolvedVersion: norm.resolvedVersion,
                    fromCatalog: !!norm.fromCatalog,
                    packageQuery: `${d.name}@${norm.resolvedVersion}`,
                }
            })
            .filter(Boolean) as Array<
            ReturnType<typeof collectDependencies>[number] & {
                resolvedVersion: string
                fromCatalog?: boolean
            }
        >

        const results = await Promise.all(
            normalized.map(async (d) => ({
                d,
                result: await fetchPackageSizes(d.packageQuery),
            })),
        )

        const decos: vscode.DecorationOptions[] = await Promise.all(
            results.map(async ({ d, result }) => {
                const endPos = editor.document.lineAt(d.line).range.end
                const range = new vscode.Range(endPos, endPos)
                const pinned =
                    extractPinnedVersion(d.resolvedVersion) ||
                    (result as { version?: string }).version ||
                    d.resolvedVersion
                const links = await getNpmLinks(d.name, pinned)
                const hover = buildHoverMarkdown(
                    d.name,
                    pinned,
                    result as CachedSizeInfo,
                    links,
                )
                return {
                    range,
                    renderOptions: {
                        after: {
                            contentText: d.fromCatalog
                                ? ` //→ ${pinned} · ${(result as any).text ?? 'error'}`
                                : ` //→ ${(result as any).text ?? 'error'}`,
                        },
                    },
                    hoverMessage: hover,
                }
            }),
        )

        editor.setDecorations(decorationType, decos)
        log('decorations set', decos.length)
    }

    const emitter = new vscode.EventEmitter<void>()

    const provider: vscode.InlayHintsProvider = {
        onDidChangeInlayHints: emitter.event,
        provideInlayHints: async (doc, _range, _token) => {
            log('provideInlayHints for', doc.fileName)
            if (!isPackageJson(doc)) {
                log('skip non-package.json')
                return []
            }

            const deps = collectDependencies(doc)
            log('found deps (hints)', deps.length)
            const defaultCatalog = await readDefaultCatalog(doc)

            const normalized = deps
                .map((d) => {
                    const norm = normalizeVersionForMonorepo(
                        d.name,
                        d.version,
                        defaultCatalog,
                    )
                    if (norm.skip || !norm.resolvedVersion) return undefined
                    return {
                        ...d,
                        resolvedVersion: norm.resolvedVersion,
                        fromCatalog: !!norm.fromCatalog,
                        packageQuery: `${d.name}@${norm.resolvedVersion}`,
                    }
                })
                .filter(Boolean) as Array<
                ReturnType<typeof collectDependencies>[number] & {
                    resolvedVersion: string
                    fromCatalog?: boolean
                }
            >

            for (const d of normalized) {
                if (!cache.has(d.packageQuery)) {
                    log('kickoff fetch for', d.packageQuery)
                    void fetchPackageSizes(d.packageQuery).then(() => emitter.fire())
                }
            }

            const hints: vscode.InlayHint[] = []
            for (const d of normalized) {
                const info = cache.get(d.packageQuery)
                const pos = doc.lineAt(d.line).range.end
                const version =
                    extractPinnedVersion(d.resolvedVersion) ||
                    info?.version ||
                    d.resolvedVersion
                const url = vscode.Uri.parse(
                    `https://bundlephobia.com/package/${encodeURIComponent(d.name)}@${encodeURIComponent(
                        version,
                    )}`,
                )
                const cachedGitHub = npmMetaCache.get(`${d.name}@${version}`)?.githubUrl
                const md = info
                    ? buildHoverMarkdown(d.name, version, info, {
                          npmUrl: `https://www.npmjs.com/package/${encodeURIComponent(
                              d.name,
                          )}/v/${encodeURIComponent(version)}`,
                          githubUrl: cachedGitHub,
                      })
                    : new vscode.MarkdownString('Loading bundle size…')
                md.isTrusted = true

                const parts: vscode.InlayHintLabelPart[] = [
                    {
                        value: (d as any).fromCatalog
                            ? `→ ${version} · ${info?.text ?? '…'}`
                            : `→ ${info?.text ?? '…'}`,
                        tooltip: md,
                        command: {
                            command: 'vscode.open',
                            title: 'Open in bundlephobia',
                            arguments: [url],
                        },
                    },
                ]
                const hint = new vscode.InlayHint(pos, parts, vscode.InlayHintKind.Type)
                hint.paddingLeft = true
                hints.push(hint)
            }
            log('returning hints', hints.length)
            return hints
        },
    }

    context.subscriptions.push(
        vscode.languages.registerInlayHintsProvider(
            [{ language: 'json' }, { language: 'jsonc' }],
            provider,
        ),
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (!isPackageJson(e.document)) return
            log('onDidChangeTextDocument', e.document.fileName)
            if (debounceTimer) globalThis.clearTimeout(debounceTimer)
            debounceTimer = globalThis.setTimeout(() => {
                emitter.fire()
                const editor = vscode.window.activeTextEditor
                if (editor && editor.document === e.document)
                    void renderDecorations(editor)
            }, 250)
        }),
        vscode.window.onDidChangeActiveTextEditor((ed) => {
            if (!ed) return
            if (!isPackageJson(ed.document)) return
            log('onDidChangeActiveTextEditor', ed.document.fileName)
            emitter.fire()
            void renderDecorations(ed)
        }),
    )

    if (
        vscode.window.activeTextEditor &&
        isPackageJson(vscode.window.activeTextEditor.document)
    ) {
        log(
            'active editor is package.json',
            vscode.window.activeTextEditor.document.fileName,
        )
        void renderDecorations(vscode.window.activeTextEditor)
        emitter.fire()
    }
}

export const deactivate = () => {}
const catalogCache = new Map<string, DefaultCatalogMap>()

const readDefaultCatalog = async (
    doc: vscode.TextDocument,
): Promise<DefaultCatalogMap> => {
    try {
        const folder = vscode.workspace.getWorkspaceFolder(doc.uri)
        const rootUri = folder?.uri
        if (!rootUri) return {}
        const cacheKey = rootUri.toString()
        const hit = catalogCache.get(cacheKey)
        if (hit) return hit

        const merged: DefaultCatalogMap = {}

        try {
            const yamlUri = vscode.Uri.joinPath(rootUri, 'pnpm-workspace.yaml')
            await vscode.workspace.fs.stat(yamlUri)
            const yamlDoc = await vscode.workspace.openTextDocument(yamlUri)
            const yamlCatalog = parseDefaultCatalogFromYaml(yamlDoc.getText())
            for (const [k, v] of Object.entries(yamlCatalog)) merged[k] = v
        } catch {}

        try {
            const pkgUri = vscode.Uri.joinPath(rootUri, 'package.json')
            await vscode.workspace.fs.stat(pkgUri)
            const pkgDoc = await vscode.workspace.openTextDocument(pkgUri)
            const pkg = JSON.parse(pkgDoc.getText()) as unknown
            const pkgCatalog = parseDefaultCatalogFromPackageJson(pkg)
            for (const [k, v] of Object.entries(pkgCatalog)) merged[k] = v
        } catch {}

        catalogCache.set(cacheKey, merged)
        return merged
    } catch {
        return {}
    }
}
