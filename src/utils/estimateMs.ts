export const estimateMs = (bytes: number, throughputBytesPerSec: number) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return 0
    return Math.round((bytes / throughputBytesPerSec) * 1000)
}
