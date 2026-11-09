// 用真实小说文件验证章节检测/整章阅读/数字跳章（复制到临时目录，不碰用户目录）。
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = process.argv[2];
if (!source) {
  console.log('用法：node test/chapter-check.mjs <小说.txt 的绝对路径>');
  process.exit(2);
}
const pluginFile = fileURLToPath(new URL('../index.js', import.meta.url));
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'novel-chapter-check-'));
const fileName = path.basename(source);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = { routes: [], listener: null, effects: [] };
const connection = { fetch: { register(route) { state.routes.push(route); return async () => {}; } } };
const ctx = {
  get: (name) => (name === 'connection' ? connection : undefined),
  on(name, fn) { if (name === 'llm/stream') state.listener = fn; return () => {}; },
  effect(fn) { state.effects.push(fn()); return () => {}; },
  logger: { warn: (...args) => console.warn('[warn]', ...args) },
};

async function rpc(method, payload = {}) {
  const request = new Request('http://127.0.0.1:61797/api/novel-reader', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId: 'check', method: 'novel-reader', payload: { method, payload },
    }),
  });
  const response = await state.routes[0].fetch(request);
  const body = await response.json();
  assert.equal(body.result.ok, true, `${method} 失败：${JSON.stringify(body.result.error)}`);
  return body.result.value;
}

async function consume(options) {
  const chunks = [];
  for await (const chunk of state.listener(options, () => { throw new Error('unexpected next()'); })) chunks.push(chunk);
  return {
    text: chunks.filter((chunk) => chunk.type === 'text-delta' || chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''),
    chunks,
  };
}

try {
  await copyFile(source, path.join(tempDir, fileName));
  const module = await import(`${pathToFileURL(pluginFile).href}?v=${Date.now()}`);
  module.apply(ctx, { directory: tempDir, chapterDelayMs: 0, streamDelayMs: 0, firstTokenDelayMs: 0, display: 'answer' });
  await sleep(700);

  const overview = await rpc('overview');
  const novel = overview.novels.find((item) => item.file === fileName);
  assert.ok(novel, '真实小说被扫描到');
  console.log(`文件：${novel.file}`);
  console.log(`总字符：${novel.chars}，检测到章节：${novel.chapters}，初始章节：${JSON.stringify(novel.chapter)}`);
  if (novel.chapters === 0) {
    console.log('（未检测到章节：请检查 txt 是否是 UTF-8、标题是否单独成行）');
  }

  const sessionId = 'session-real-check';
  await rpc('select', { sessionId, novelId: novel.id });
  const first = await consume({ sessionId, messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续' }] }], signal: new AbortController().signal });
  const afterFirst = await rpc('session', { sessionId });
  console.log(`第一条回复字符：${first.text.length}，进度：${afterFirst.offset}，下一章：${JSON.stringify(afterFirst.chapter)}`);
  console.log('第一段预览：', first.text.slice(0, 60).replace(/\n/g, ' / '));

  const numeric = await consume({
    sessionId,
    messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '5' }] }],
    signal: new AbortController().signal,
  });
  const afterJump = await rpc('session', { sessionId });
  console.log(`发「5」后进度：${afterJump.offset}，章节：${JSON.stringify(afterJump.chapter)}`);
  console.log('第 5 章开头预览：', numeric.text.slice(0, 60).replace(/\n/g, ' / '));
  assert.ok(numeric.text.includes('第五章'), '数字 5 应读出第五章');
  assert.equal(afterJump.chapter.index, 6, '读完第五章后当前位置指向第六章');
  assert.ok(numeric.text.length > 100, '跳章后应有正文');
  if (novel.chapters > 0) console.log('OK 真实小说章节检测/整章阅读/数字跳章通过');
} finally {
  await sleep(200);
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}
