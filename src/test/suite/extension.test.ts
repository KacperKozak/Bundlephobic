import * as assert from 'assert'
import * as vscode from 'vscode'

suite('Bundlephobic', () => {
    const openWithContent = async (lines: string[]) => {
        const doc = await vscode.workspace.openTextDocument({
            language: 'plaintext',
            content: lines.join('\n'),
        })
        const editor = await vscode.window.showTextDocument(doc)
        return editor
    }

    test('activates', async () => {
        const ext = vscode.extensions.getExtension('code-cooking.Bundlephobic')
        assert.ok(ext, 'Extension not found')
        await ext.activate()
        assert.ok(ext.isActive, 'Extension should be active')
    })
})
