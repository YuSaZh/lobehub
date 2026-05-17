import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getClaudeCodeSessionHistory } from './claudeCodeHistory';

const encodeClaudeProjectDir = (cwd: string) =>
  path
    .resolve(cwd)
    .replaceAll('\\', '/')
    .replaceAll(/[^A-Z0-9]/gi, '-');

const writeJsonl = async (filePath: string, rows: unknown[]) => {
  await writeFile(filePath, rows.map((row) => JSON.stringify(row)).join('\n'));
};

describe('getClaudeCodeSessionHistory', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), 'lobe-cc-history-'));
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(homeDir, { force: true, recursive: true });
  });

  it('loads visible user, assistant, tool, and tool_use messages from the matching session file', async () => {
    const sessionId = 'session-1';
    const cwd = path.join(homeDir, 'workspace');
    const projectDir = path.join(homeDir, '.claude', 'projects', encodeClaudeProjectDir(cwd));
    await mkdir(projectDir, { recursive: true });
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);

    await writeJsonl(sessionFile, [
      { isMeta: true, type: 'summary' },
      {
        message: { content: 'hello', id: 'msg-user-1', role: 'user' },
        sessionId,
        timestamp: '2026-05-16T00:00:00.000Z',
        uuid: 'uuid-user-1',
      },
      {
        message: {
          content: [
            { text: 'I will read it.', type: 'text' },
            { id: 'toolu_1', input: { file_path: 'src/a.ts' }, name: 'Read', type: 'tool_use' },
            { id: 'toolu_2', input: { pattern: 'needle' }, name: 'Grep', type: 'tool_use' },
          ],
          id: 'msg-assistant-1',
          role: 'assistant',
        },
        parentUuid: 'uuid-user-1',
        sessionId,
        uuid: 'uuid-assistant-1',
      },
      {
        message: {
          content: [
            { content: 'file content', tool_use_id: 'toolu_1', type: 'tool_result' },
            {
              content: [{ text: 'grep content', type: 'text' }],
              tool_use_id: 'toolu_2',
              type: 'tool_result',
            },
          ],
          role: 'user',
        },
        parentUuid: 'uuid-assistant-1',
        sessionId,
        uuid: 'uuid-tool-1',
      },
    ]);

    const result = await getClaudeCodeSessionHistory({ sessionId, workingDirectory: cwd });

    expect(result.status).toBe('found');
    expect(result.sessionFile).toBe(sessionFile);
    expect(result.messages).toMatchObject([
      {
        content: 'hello',
        lineNumber: 2,
        messageId: 'msg-user-1',
        role: 'user',
        uuid: 'uuid-user-1',
      },
      {
        content: 'I will read it.',
        lineNumber: 3,
        messageId: 'msg-assistant-1',
        parentUuid: 'uuid-user-1',
        role: 'assistant',
        tools: [
          { arguments: '{\n  "file_path": "src/a.ts"\n}', id: 'toolu_1', name: 'Read' },
          { arguments: '{\n  "pattern": "needle"\n}', id: 'toolu_2', name: 'Grep' },
        ],
        uuid: 'uuid-assistant-1',
      },
      {
        content: 'file content',
        lineNumber: 4,
        parentUuid: 'uuid-assistant-1',
        role: 'tool',
        toolCallId: 'toolu_1',
        uuid: 'uuid-tool-1',
      },
      {
        content: 'grep content',
        lineNumber: 4,
        parentUuid: 'uuid-assistant-1',
        role: 'tool',
        toolCallId: 'toolu_2',
        uuid: 'uuid-tool-1',
      },
    ]);
  });

  it('rejects session ids with path separators before reading session files', async () => {
    const cwd = path.join(homeDir, 'workspace');
    const leakDir = path.join(homeDir, 'tmp');
    await mkdir(leakDir, { recursive: true });
    await writeJsonl(path.join(leakDir, 'leak.jsonl'), [
      {
        message: { content: 'leaked history', role: 'user' },
        uuid: 'uuid-leak',
      },
    ]);

    const unsafeSessionIds = ['../../tmp/leak', '..\\..\\tmp\\leak', '/tmp/leak', 'C:\\tmp\\leak'];

    for (const sessionId of unsafeSessionIds) {
      await expect(
        getClaudeCodeSessionHistory({ sessionId, workingDirectory: cwd }),
      ).resolves.toEqual({
        messages: [],
        sessionId,
        status: 'invalid_request',
      });
    }
  });

  it('returns missing when the session file cannot be found', async () => {
    const result = await getClaudeCodeSessionHistory({
      sessionId: 'missing-session',
      workingDirectory: path.join(homeDir, 'workspace'),
    });

    expect(result).toEqual({ messages: [], sessionId: 'missing-session', status: 'missing' });
  });
});
