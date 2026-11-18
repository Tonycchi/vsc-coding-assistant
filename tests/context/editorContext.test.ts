import type * as vscode from 'vscode';

import { collectEditorContext } from '../../src/context';

describe('collectEditorContext', () => {
  it('returns the active file path, contents, and selection', () => {
    const selection = { isEmpty: false } as vscode.Selection;
    const document = {
      uri: { fsPath: '/workspace/src/example.ts' },
      getText: jest.fn((range?: vscode.Range) =>
        range ? 'selected code' : 'const value = 1;'
      ),
    } as unknown as vscode.TextDocument;
    const editor = { document, selection } as vscode.TextEditor;

    expect(collectEditorContext(editor)).toEqual({
      filePath: '/workspace/src/example.ts',
      fileContent: 'const value = 1;',
      selectedText: 'selected code',
    });
    expect(document.getText).toHaveBeenNthCalledWith(1);
    expect(document.getText).toHaveBeenNthCalledWith(2, selection);
  });

  it('returns an empty selection when no text is selected', () => {
    const document = {
      uri: { fsPath: '/workspace/src/example.ts' },
      getText: jest.fn(() => 'const value = 1;'),
    } as unknown as vscode.TextDocument;
    const editor = {
      document,
      selection: { isEmpty: true } as vscode.Selection,
    } as vscode.TextEditor;

    expect(collectEditorContext(editor)).toEqual({
      filePath: '/workspace/src/example.ts',
      fileContent: 'const value = 1;',
      selectedText: '',
    });
    expect(document.getText).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when there is no active editor', () => {
    expect(collectEditorContext(undefined)).toBeUndefined();
  });
});
