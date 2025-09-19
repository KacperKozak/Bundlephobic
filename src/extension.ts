import * as vscode from 'vscode'
import * as https from 'node:https'
import type { IncomingMessage } from 'node:http'

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

type Limiter = <T>(run: () => Promise<T>) => Promise<T>

const makeLimiter = (limit: number): Limiter => {
    let activeCount = 0
    type Task<T> = {
        run: () => Promise<T>
        resolve: (value: T) => void
        reject: (reason?: unknown) => void
    }
    const queue: Array<Task<any>> = []

    const runNext = () => {
        if (activeCount >= limit) return
        const task = queue.shift()
        if (!task) return
        activeCount++
        ;(async () => task.run())()
            .then((value) => task.resolve(value))
            .catch((err) => task.reject(err))
            .finally(() => {
                activeCount--
                runNext()
            })
    }

    return <T>(run: () => Promise<T>) =>
        new Promise<T>((resolve, reject) => {
            queue.push({ run, resolve, reject })
            runNext()
        })
}

let maxConcurrent = 2
let scheduleRequest: Limiter = makeLimiter(maxConcurrent)

interface BundlephobiaSizes {
    size: number
    gzip: number
    version?: string
    dependencyCount?: number
}

interface DependencyLocation {
    name: string
    version: string
    packageQuery: string
    line: number
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

const isPackageJson = (doc: vscode.TextDocument) =>
    doc.fileName.endsWith('/package.json') || doc.fileName.endsWith('\\package.json')

const formatBytes = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes < 0) return 'n/e'
    if (bytes < 1024) return `${bytes}B`
    const kb = bytes / 1024
    if (kb < 1024) return `${kb.toFixed(1)}kB`
    const mb = kb / 1024
    return `${mb.toFixed(1)}MB`
}

const estimateMs = (bytes: number, throughputBytesPerSec: number) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return 0
    return Math.round((bytes / throughputBytesPerSec) * 1000)
}

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
        `[Open ${name}@${pinned} in bundlephobia.com](${bundleUrl})` +
        (links
            ? `  |  [npm](${links.npmUrl})` +
              (links.githubUrl ? `  |  [GitHub](${links.githubUrl})` : ``)
            : ``)
    const md = new vscode.MarkdownString(sizeText + downloadText + depsText + linkText)
    md.isTrusted = true
    return md
}

const extractPinnedVersion = (raw: string) => {
    const match = raw.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)
    if (match) return match[0]
    return raw.replace(/^\s*[~^]/, '').trim()
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

const collectDependencies = (doc: vscode.TextDocument) => {
    const items: DependencyLocation[] = []
    const lineCount = doc.lineCount

    const sectionNames = new Set([
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
    ])

    let insideSection = false
    let braceDepth = 0

    for (let lineIndex = 0; lineIndex < lineCount; lineIndex++) {
        const line = doc.lineAt(lineIndex)
        const text = line.text

        if (!insideSection) {
            const m = text.match(/^\s*"(dependencies|[A-Za-z]+Dependencies)"\s*:\s*\{?/) // eslint-disable-line no-useless-escape
            if (m && sectionNames.has(m[1])) {
                insideSection = true
                const openCount = (text.match(/\{/g) || []).length
                const closeCount = (text.match(/\}/g) || []).length
                braceDepth = openCount - closeCount
                if (braceDepth <= 0) insideSection = false
            }
            continue
        }

        // Update brace depth
        braceDepth += (text.match(/\{/g) || []).length
        braceDepth -= (text.match(/\}/g) || []).length
        if (braceDepth <= 0) {
            insideSection = false
            braceDepth = 0
            continue
        }

        const depMatch = text.match(/^\s*"([^\"]+)"\s*:\s*"([^\"]+)"/) // eslint-disable-line no-useless-escape
        if (!depMatch) continue

        const name = depMatch[1]
        const version = depMatch[2]
        const packageQuery = `${name}@${version}`
        items.push({ name, version, packageQuery, line: lineIndex })
    }

    return items
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
        const results = await Promise.all(
            deps.map(async (d) => ({
                d,
                result: await fetchPackageSizes(d.packageQuery),
            })),
        )

        const decos: vscode.DecorationOptions[] = await Promise.all(
            results.map(async ({ d, result }) => {
                const endPos = editor.document.lineAt(d.line).range.end
                const range = new vscode.Range(endPos, endPos)
                const pinned =
                    extractPinnedVersion(d.version) ||
                    (result as { version?: string }).version ||
                    d.version
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
                        after: { contentText: ` // ${(result as any).text ?? 'error'}` },
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

            for (const d of deps) {
                if (!cache.has(d.packageQuery)) {
                    log('kickoff fetch for', d.packageQuery)
                    void fetchPackageSizes(d.packageQuery).then(() => emitter.fire())
                }
            }

            const hints: vscode.InlayHint[] = []
            for (const d of deps) {
                const info = cache.get(d.packageQuery)
                const pos = doc.lineAt(d.line).range.end
                const version =
                    extractPinnedVersion(d.version) || info?.version || d.version
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
                        value: `${info?.text ?? '…'}`,
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
