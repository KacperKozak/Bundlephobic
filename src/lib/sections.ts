import type * as vscode from 'vscode'
import {
    CLOSE_BRACE_RE,
    DEP_LINE_RE,
    DEP_SECTION_HEADER_RE,
    OPEN_BRACE_RE,
} from '../utils/regexp'

export interface DependencyLocation {
    name: string
    version: string
    packageQuery: string
    line: number
}

export const isPackageJson = (doc: vscode.TextDocument) =>
    doc.fileName.endsWith('/package.json') || doc.fileName.endsWith('\\package.json')

export const parseDependenciesFromText = (text: string) => {
    const items: DependencyLocation[] = []
    const lines = text.split(/\r?\n/)

    const sectionNames = new Set([
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies',
    ])

    let insideSection = false
    let braceDepth = 0

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const lineText = lines[lineIndex]

        if (!insideSection) {
            const m = lineText.match(DEP_SECTION_HEADER_RE)
            if (m && sectionNames.has(m[1])) {
                insideSection = true
                const openCount = (lineText.match(OPEN_BRACE_RE) || []).length
                const closeCount = (lineText.match(CLOSE_BRACE_RE) || []).length
                braceDepth = openCount - closeCount
                if (braceDepth <= 0) insideSection = false
            }
            continue
        }

        braceDepth += (lineText.match(OPEN_BRACE_RE) || []).length
        braceDepth -= (lineText.match(CLOSE_BRACE_RE) || []).length
        if (braceDepth <= 0) {
            insideSection = false
            braceDepth = 0
            continue
        }

        const depMatch = lineText.match(DEP_LINE_RE)
        if (!depMatch) continue

        const name = depMatch[1]
        const version = depMatch[2]
        const packageQuery = `${name}@${version}`
        items.push({ name, version, packageQuery, line: lineIndex })
    }

    return items
}

export const collectDependencies = (doc: vscode.TextDocument) =>
    parseDependenciesFromText(doc.getText())
