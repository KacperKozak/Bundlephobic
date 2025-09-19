export const SEMVER_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/

export const extractPinnedVersion = (raw: string) => {
    const match = raw.match(SEMVER_RE)
    if (match) return match[0]
    return raw.replace(/^\s*[~^]/, '').trim()
}

export const DEP_SECTION_HEADER_RE =
    /^\s*"(dependencies|[A-Za-z]+Dependencies)"\s*:\s*\{?/

export const DEP_LINE_RE = /^\s*"([^\"]+)"\s*:\s*"([^\"]+)"/

export const OPEN_BRACE_RE = /\{/g
export const CLOSE_BRACE_RE = /\}/g
