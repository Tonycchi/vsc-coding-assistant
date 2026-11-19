import type * as vscode from 'vscode';

export interface EditorContext {
  filePath: string;
  fileContent: string;
  selectedText: string;
}

export function collectEditorContext(
  editor: Pick<vscode.TextEditor, 'document' | 'selection'> | undefined
): EditorContext | undefined {
  if (!editor) {
    return undefined;
  }

  const { document, selection } = editor;

  return {
    filePath: document.uri.fsPath,
    fileContent: document.getText(),
    selectedText: selection.isEmpty ? '' : document.getText(selection),
  };
}
