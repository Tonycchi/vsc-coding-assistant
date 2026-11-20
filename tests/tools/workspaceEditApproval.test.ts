import { WorkspaceEditApproval } from '../../src/tools/workspaceEditApproval';
import type { WorkspaceFileRead } from '../../src/tools/readFile';

const file = (path: string, before: string | null, after: string) => ({
  path,
  before,
  after,
  diff: 'preview',
});

const existing = (content: string): WorkspaceFileRead => ({
  kind: 'file',
  bytes: Buffer.from(content),
  truncated: false,
});

describe('workspace edit approval', () => {
  const read = jest.fn();
  const write = jest.fn();
  let service: WorkspaceEditApproval;

  beforeEach(() => {
    read.mockReset();
    write.mockReset();
    service = new WorkspaceEditApproval(read, write);
  });

  it('applies only the immutable approved bytes once', async () => {
    const change = file('src/example.ts', '\uFEFFbefore', '\uFEFFafter');
    const pending = service.request({ files: [change] });
    change.after = 'mutated';
    read.mockResolvedValue(existing('\uFEFFbefore'));
    write.mockResolvedValue('applied');

    await expect(service.approve('wrong')).resolves.toEqual({ status: 'not-pending', files: [] });
    expect(read).not.toHaveBeenCalled();
    const approved = service.approve(pending.id);
    await expect(service.approve(pending.id)).resolves.toEqual({
      status: 'not-pending',
      files: [],
    });
    await expect(approved).resolves.toEqual({
      status: 'applied',
      files: [{ path: 'src/example.ts', status: 'applied' }],
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      'src/example.ts',
      Buffer.from('\uFEFFbefore'),
      Buffer.from('\uFEFFafter')
    );
  });

  it('invalidates rejected, superseded or cleared approvals', async () => {
    const preview = { files: [file('file.txt', null, 'contents')] };
    const first = service.request(preview);
    const second = service.request(preview);
    expect(service.reject(first.id)).toBe(false);
    expect(service.reject(second.id)).toBe(true);
    const third = service.request(preview);
    service.clear();
    for (const { id } of [first, second, third]) {
      await expect(service.approve(id)).resolves.toEqual({ status: 'not-pending', files: [] });
    }
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('does not write any file if preflight finds stale state', async () => {
    const pending = service.request({
      files: [file('new.txt', null, 'new'), file('old.txt', 'before', 'after')],
    });
    read.mockResolvedValueOnce({ kind: 'missing' }).mockResolvedValueOnce(existing('changed'));

    await expect(service.approve(pending.id)).resolves.toEqual({
      status: 'stale',
      files: [
        { path: 'new.txt', status: 'skipped' },
        { path: 'old.txt', status: 'stale' },
      ],
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('reports the applied file and skips later edits after a write failure', async () => {
    const pending = service.request({
      files: ['first', 'second', 'third'].map((name) => file(`${name}.txt`, null, 'new')),
    });
    read.mockResolvedValue({ kind: 'missing' });
    write.mockResolvedValueOnce('applied').mockRejectedValueOnce(new Error('Write failed'));

    await expect(service.approve(pending.id)).resolves.toEqual({
      status: 'failed',
      files: [
        { path: 'first.txt', status: 'applied' },
        { path: 'second.txt', status: 'failed' },
        { path: 'third.txt', status: 'skipped' },
      ],
    });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it.each(['unsupported-filesystem', 'outside-workspace', 'unreadable'])(
    'fails closed on preflight failure %s',
    async (kind) => {
      const pending = service.request({ files: [file('file.txt', 'before', 'after')] });
      read.mockResolvedValue({ kind });
      await expect(service.approve(pending.id)).resolves.toEqual({
        status: 'failed',
        files: [{ path: 'file.txt', status: 'failed' }],
      });
      expect(write).not.toHaveBeenCalled();
    }
  );

  it('rejects unsafe paths, duplicate paths and invalid UTF-8 previews', () => {
    expect(() => service.request({ files: [file('../file.txt', null, 'after')] })).toThrow();
    expect(() => service.request({ files: [file('file.txt', null, '\uD800')] })).toThrow();
    expect(() =>
      service.request({
        files: [file('file.txt', null, 'first'), file('file.txt', null, 'second')],
      })
    ).toThrow();
  });
});
