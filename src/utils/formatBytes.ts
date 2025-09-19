export const formatBytes = (bytes: number) => {
    if (!Number.isFinite(bytes) || bytes < 0) return 'n/e'
    if (bytes < 1024) return `${bytes}B`
    const kb = bytes / 1024
    if (kb < 1024) return `${kb.toFixed(1)}kB`
    const mb = kb / 1024
    return `${mb.toFixed(1)}MB`
}
