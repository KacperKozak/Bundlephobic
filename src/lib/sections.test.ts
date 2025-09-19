import { describe, expect, test } from 'bun:test'
import { parseDependenciesFromText } from './sections'

const sample = `{
  "name": "demo",
  "version": "1.0.0",
  "dependencies": {
    "react": "18.3.1",
    "vue": "^3.5.0"
  },
  "devDependencies": {
    "typescript": "5.6.2"
  }
}`

describe('sections parser', () => {
    test('finds deps in sections', () => {
        const items = parseDependenciesFromText(sample)
        const names = items.map((i) => i.name).sort()
        expect(names).toEqual(['react', 'typescript', 'vue'])
    })
})
