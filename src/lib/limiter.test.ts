import { describe, expect, test } from 'bun:test'
import { makeLimiter } from './limiter'

describe('makeLimiter', () => {
    test('limits concurrency', async () => {
        const limiter = makeLimiter(2)

        const order: number[] = []
        const start = Date.now()

        const mk = (id: number, ms: number) =>
            limiter(async () => {
                order.push(id)
                await new Promise((r) => setTimeout(r, ms))
                return id
            })

        const r = await Promise.all([mk(1, 50), mk(2, 50), mk(3, 10), mk(4, 10)])

        expect(r.sort()).toEqual([1, 2, 3, 4])
        expect(order.slice(0, 2).sort()).toEqual([1, 2])
        expect(Date.now() - start >= 60).toBe(true)
    })
})
