export interface Limiter {
    <T>(run: () => Promise<T>): Promise<T>
}

export const makeLimiter = (limit: number): Limiter => {
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
