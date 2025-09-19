import * as vscode from 'vscode'
import * as https from 'node:https'
import type { IncomingMessage } from 'node:http'

interface BundlephobiaSizes {
    size: number
    gzip: number
}

interface DependencyLocation {
    name: string
    version: string
    packageQuery: string
    range: vscode.Range
}

const decorationType = vscode.window.createTextEditorDecorationType({
    after: {
        margin: '0 0 0 1ch',
    },
})

const cache = new Map<string, string>()
let debounceTimer: ReturnType<typeof setTimeout> | undefined
let currentSessionId = 0

const isPackageJson = (doc: vscode.TextDocument) =>
    doc.fileName.endsWith('/package.json') || doc.fileName.endsWith('\\package.json')

const formatBytes = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes < 0) return 'n/a'
    if (bytes < 1024) return `${bytes}B`
    const kb = bytes / 1024
    if (kb < 1024) return `${kb.toFixed(1)}kB`
    const mb = kb / 1024
    return `${mb.toFixed(1)}MB`
}

const requestJson = (url: string) =>
    new Promise<unknown>((resolve) => {
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
                if (status >= 400) {
                    res.resume()
                    resolve(undefined)
                    return
                }
                let data = ''
                res.setEncoding('utf8')
                res.on('data', (chunk: string) => (data += chunk))
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data))
                    } catch {
                        resolve(undefined)
                    }
                })
            },
        )
        req.on('error', () => resolve(undefined))
        req.end()
    })

const fetchPackageSizes = async (pkgSpecifier: string) => {
    if (cache.has(pkgSpecifier)) return cache.get(pkgSpecifier) as string
    const apiUrl = `https://bundlephobia.com/api/size?package=${encodeURIComponent(pkgSpecifier)}`
    const json = (await requestJson(apiUrl)) as Partial<BundlephobiaSizes> | undefined
    if (!json || typeof json.size !== 'number' || typeof json.gzip !== 'number') {
        cache.set(pkgSpecifier, 'n/a')
        return 'n/a'
    }
    const text = `${formatBytes(json.size)} (${formatBytes(json.gzip)})`
    cache.set(pkgSpecifier, text)
    return text
}

const collectDependencies = (editor: vscode.TextEditor) => {
    const items: DependencyLocation[] = []
    const doc = editor.document
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
            const m = text.match(/^\s*"([A-Za-z]+Dependencies)"\s*:\s*\{?/) // eslint-disable-line no-useless-escape
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
        const end = line.range.end
        const range = new vscode.Range(end, end)
        items.push({ name, version, packageQuery, range })
    }

    return items
}

const decorateEditor = async (editor: vscode.TextEditor) => {
    if (!isPackageJson(editor.document)) {
        editor.setDecorations(decorationType, [])
        return
    }

    const sessionId = ++currentSessionId

    const deps = collectDependencies(editor)
    const initialDecorations: vscode.DecorationOptions[] = deps.map((d) => ({
        range: d.range,
        renderOptions: { after: { contentText: '…' } },
        hoverMessage: `Bundle size for ${d.name}`,
    }))
    editor.setDecorations(decorationType, initialDecorations)

    const results = await Promise.all(
        deps.map(async (d) => {
            const text = await fetchPackageSizes(d.packageQuery)
            return { d, text }
        }),
    )

    if (sessionId !== currentSessionId) return

    const finalDecorations: vscode.DecorationOptions[] = results.map(({ d, text }) => ({
        range: d.range,
        renderOptions: { after: { contentText: `// ${text}` } },
        hoverMessage: `Bundlephobia: ${d.name}@${d.version} → ${text}`,
    }))

    editor.setDecorations(decorationType, finalDecorations)
}

export const activate = (context: vscode.ExtensionContext) => {
    const handleActive = (editor: vscode.TextEditor | undefined) => {
        if (!editor) return
        if (!isPackageJson(editor.document)) return
        decorateEditor(editor)
    }

    const debouncedRefresh = (editor: vscode.TextEditor) => {
        if (debounceTimer) globalThis.clearTimeout(debounceTimer)
        debounceTimer = globalThis.setTimeout(() => decorateEditor(editor), 250)
    }

    const commands = [
        vscode.commands.registerCommand('bundlephobic.open', () => {
            const editor = vscode.window.activeTextEditor
            if (!editor) return
            if (!isPackageJson(editor.document)) return
            // Open bundlephobia.com for the word under cursor, if it looks like a dep key
            const position = editor.selection.active
            const wordRange = editor.document.getWordRangeAtPosition(
                position,
                /[@A-Za-z0-9_\-\/]+/,
            )
            if (!wordRange) return
            const word = editor.document.getText(wordRange)
            const url = `https://bundlephobia.com/package/${encodeURIComponent(word)}`
            vscode.env.openExternal(vscode.Uri.parse(url))
        }),
    ]

    context.subscriptions.push(...commands)

    if (vscode.window.activeTextEditor) handleActive(vscode.window.activeTextEditor)

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((e: vscode.TextEditor | undefined) =>
            handleActive(e),
        ),
        vscode.workspace.onDidChangeTextDocument((e: vscode.TextDocumentChangeEvent) => {
            const editor = vscode.window.activeTextEditor
            if (!editor) return
            if (e.document !== editor.document) return
            if (!isPackageJson(editor.document)) return
            debouncedRefresh(editor)
        }),
    )
}

export const deactivate = () => {}
