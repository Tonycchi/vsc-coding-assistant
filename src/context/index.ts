export { collectEditorContext } from './editorContext';
export type { EditorContext } from './editorContext';
export {
  collectFileAttachments,
  MAX_FILE_ATTACHMENT_SIZE_BYTES,
  MAX_SAFE_WORKSPACE_READ_BYTES,
  readWorkspaceFilePrefix,
  readWorkspaceFileSafely,
  SecureAttachmentError,
} from './fileAttachments';
export type {
  AttachmentFileSystem,
  FileAttachment,
  SafeWorkspaceFileReaderDependencies,
} from './fileAttachments';
