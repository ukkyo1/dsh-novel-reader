// 无浏览器控制时的宿主半验证：用假 ctx 装载 index.js，走真实 RPC envelope 与
// llm/stream 监听器，验证扫描/选书/切段/流式/中断/标题/压缩/改名/重置/持久化。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginFile = fileURLToPath(new URL('../index.js', import.meta.url));
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'novel-reader-test-'));
// 所有设置/状态都落在假 DSH_HOME 下，绝不碰用户真实目录。
const fakeHome = path.join(tempDir, 'fake-home');
await mkdir(fakeHome, { recursive: true });
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = fakeHome;

function makeCtx() {
  const state = { routes: [], streamListener: null, effects: [] };
  const connection = {
    fetch: {
      register(route) {
        state.routes.push(route);
        return async () => {};
      },
    },
  };
  const ctx = {
    get(name) {
      return name === 'connection' ? connection : undefined;
    },
    on(name, listener) {
      if (name === 'llm/stream') state.streamListener = listener;
      return () => {
        if (state.streamListener === listener) state.streamListener = null;
      };
    },
    effect(callback) {
      const disposer = callback();
      state.effects.push(disposer);
      return disposer;
    },
    logger: { warn: (...args) => console.warn('[plugin:warn]', ...args) },
  };
  return { ctx, state };
}

function loadPlugin(directory, overrides = {}) {
  const { ctx, state } = makeCtx();
  instances.push(state);
  return import(`${pathToFileURL(pluginFile).href}?v=${Date.now()}-${Math.random()}`).then(async (module) => {
    module.apply(ctx, { directory, chunkChars: 200, streamMode: 'instant', firstTokenDelayMs: 0, ...overrides });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.ok(state.routes.length === 1, '应注册 1 条 RPC 路由');
    assert.ok(typeof state.streamListener === 'function', '应注册 llm/stream 监听器');
    return { state, module };
  });
}

async function rpc(state, method, payload = {}) {
  const route = state.routes[0];
  assert.ok(route, 'RPC 路由存在');
  assert.equal(route.path, '/api/novel-reader');
  assert.deepEqual(route.methods, ['POST']);
  assert.equal(route.requestBody, 'buffered');
  const request = new Request('http://127.0.0.1:61797/api/novel-reader', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'harness-1',
      method: 'novel-reader',
      payload: { method, payload },
    }),
  });
  const response = await route.fetch(request);
  assert.equal(response.status, 200, `${method} 应返回 200`);
  const body = await response.json();
  assert.equal(body.type, 'server-response');
  return body.result;
}

async function rpcOk(state, method, payload = {}) {
  const result = await rpc(state, method, payload);
  assert.equal(result.ok, true, `${method} 应成功：${JSON.stringify(result.error)}`);
  return result.value;
}

async function consume(state, options, optionsNext) {
  const iterable = state.streamListener(options, optionsNext ?? (() => {
    throw new Error('next() 不应被调用');
  }));
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

function textOf(chunks) {
  return chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
}

function validateChunkStream(chunks) {
  assert.ok(chunks.length >= 3, '至少 block-start/delta/finish');
  assert.equal(chunks[0].type, 'block-start');
  assert.equal(chunks[0].blockType, 'text');
  assert.ok(chunks.some((chunk) => chunk.type === 'text-delta'));
  const end = chunks.find((chunk) => chunk.type === 'block-end');
  assert.ok(end, '有 block-end');
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  assert.deepEqual(finish.reason, { kind: 'stop' });
  // block-end 的完整文本必须等于全部 delta 拼接，否则 UI/日志会错位
  assert.equal(end.block.text, textOf(chunks));
}

/** 还原 Markdown 转义，得到用户看到的原文。 */
function unescapeMarkdown(text) {
  return text.replace(/\\([\\`*_\[\]<>#|+=~.-])/g, '$1');
}

/** 断言「像一个正常 AI 回复」的排版：Markdown 自然段，段间空行，无行首缩进。 */
function assertChatLike(display) {
  assert.ok(!/(^|[^\n])\n([^\n]|$)/.test(display), '段落之间必须空行分隔，不能出现单个换行');
  const paragraphs = display.split('\n\n');
  for (const paragraph of paragraphs) {
    assert.ok(paragraph.length > 0, '不能有空段落');
    assert.ok(!/^[ \t\u3000]/.test(paragraph), '段落不能以空白开头（避免被当成代码块）');
  }
  return paragraphs;
}

/** 检查这些段落确实来自原文（按顺序、允许被转义）。 */
function assertParagraphsFromSource(paragraphs, source) {
  const plain = source.replace(/\r/g, '');
  let cursor = 0;
  for (const paragraph of paragraphs) {
    const text = unescapeMarkdown(paragraph);
    const found = plain.indexOf(text, cursor);
    assert.ok(found !== -1, `段落不在原文里：${text.slice(0, 24)}`);
    cursor = found + text.length;
  }
}

const sessionId = 'session-harness-1';
const instances = [];
let first;
try {
  // ---- 1. 空目录 + seedDemo ------------------------------------------------
  first = await loadPlugin(tempDir, { display: 'answer' });
  let overview = await rpcOk(first.state, 'overview');
  assert.equal(overview.directory, tempDir);
  assert.equal(overview.novels.length, 0, '新目录为空');

  overview = await rpcOk(first.state, 'seedDemo');
  assert.equal(overview.novels.length, 3, '示例小说复制成功');
  assert.equal(overview.copied, 3);
  const seeded = await rpcOk(first.state, 'seedDemo');
  assert.equal(seeded.copied, 0, '重复 seed 不覆盖');

  const novel = overview.novels[0];
  assert.ok(novel.id && novel.name && novel.chars > 1000, '小说元数据完整');
  assert.equal(novel.offset, 0);
  assert.equal(novel.percent, 0);

  // ---- 2. 选书 / 会话状态 --------------------------------------------------
  let session = await rpcOk(first.state, 'session', { sessionId });
  assert.equal(session.active, false);
  session = await rpcOk(first.state, 'select', { sessionId, novelId: novel.id });
  assert.equal(session.active, true);
  assert.equal(session.novelId, novel.id);
  assert.equal(session.name, novel.name);

  // ---- 3. 正文流式：第一段（排版/字数/来源） -------------------------------
  const options = { sessionId, messages: [], purpose: undefined, signal: new AbortController().signal };
  const chunks1 = await consume(first.state, options);
  validateChunkStream(chunks1);
  const text1 = textOf(chunks1);
  assert.ok(text1.length >= 100, `每段应至少约 100 字（chunkChars=200），实际 ${text1.length}`);
  assert.ok(text1.length <= 560, `每段不应超过约 1.6 倍配置字数 + 排版开销，实际 ${text1.length}`);
  const paragraphs1 = assertChatLike(text1);

  const file1 = await readFile(path.join(tempDir, novel.file), 'utf8');
  session = await rpcOk(first.state, 'session', { sessionId });
  assert.ok(session.offset > 0, '进度已推进');
  assertParagraphsFromSource(paragraphs1, file1.slice(0, session.offset));

  // ---- 4. 第二段接着读 -----------------------------------------------------
  const chunks2 = await consume(first.state, options);
  validateChunkStream(chunks2);
  const text2 = textOf(chunks2);
  const paragraphs2 = assertChatLike(text2);
  const session2 = await rpcOk(first.state, 'session', { sessionId });
  assert.ok(session2.offset > session.offset, '偏移继续推进');
  assertParagraphsFromSource(paragraphs2, file1.slice(session.offset, session2.offset));
  assert.notEqual(text1, text2, '两段内容不同');

  // ---- 5. 中断后从整段断点续读 --------------------------------------------
  const controller = new AbortController();
  const iterable = first.state.streamListener({ ...options, signal: controller.signal }, () => {
    throw new Error('next() 不应被调用');
  });
  const seen = [];
  let aborted = false;
  try {
    for await (const chunk of iterable) {
      seen.push(chunk);
      if (chunk.type === 'text-delta') controller.abort();
    }
  } catch (error) {
    aborted = true;
    assert.equal(error.name, 'AbortError');
  }
  assert.equal(aborted, true, '中断应抛出 abort');
  assert.ok(textOf(seen).length > 0, '中断前已输出部分正文');
  const afterAbort = await rpcOk(first.state, 'session', { sessionId });
  assert.ok(afterAbort.offset >= session2.offset, '中断后不会倒退');
  const chunks3 = await consume(first.state, options);
  validateChunkStream(chunks3);
  const text3 = textOf(chunks3);
  const paragraphs3 = assertChatLike(text3);
  const afterResume = await rpcOk(first.state, 'session', { sessionId });
  assert.ok(afterResume.offset > session2.offset, '续读继续推进');
  assertParagraphsFromSource(paragraphs3, file1.slice(afterAbort.offset, afterResume.offset));

  // ---- 5.5 Markdown 危险标记的排版（伪装成正常 AI 回复） -----------------
  const hazardLines = [
    '# 第一章 标记测试',
    '- 这不是列表',
    '1. 这不是编号',
    '> 这不是引用',
    '*这不是斜体*',
    '`这不是代码`',
    '[文本](链接) <b>标签</b>',
    '',
    '  普通段落一',
    '普通段落二',
  ];
  await writeFile(path.join(tempDir, 'markdown-hazard.txt'), `${hazardLines.join('\n')}\n`, 'utf8');
  const hazardOverview = await rpcOk(first.state, 'refresh');
  const hazard = hazardOverview.novels.find((item) => item.file === 'markdown-hazard.txt');
  assert.ok(hazard, '危险标记测试文件被扫描到');
  const hazardSession = 'session-hazard';
  await rpcOk(first.state, 'select', { sessionId: hazardSession, novelId: hazard.id });
  const hazardChunks = await consume(first.state, { ...options, sessionId: hazardSession });
  validateChunkStream(hazardChunks);
  const hazardText = textOf(hazardChunks);
  const hazardParagraphs = assertChatLike(hazardText);
  const expectedHazard = hazardLines.filter((line) => line.trim().length > 0).map((line) => line.trim());
  assert.equal(hazardParagraphs.length, expectedHazard.length, '每个非空原文行 = 一个自然段');
  expectedHazard.forEach((line, index) => {
    assert.equal(unescapeMarkdown(hazardParagraphs[index]), line);
    const numbered = /^\d{1,3}[.)](\s|$)/.test(line);
    const marker = /^[#>|+=~-]/.test(line);
    if (numbered) {
      assert.match(hazardParagraphs[index], /^\d{1,3}\\[.)]/, `编号标记必须转义：${line}`);
    } else if (marker) {
      assert.equal(hazardParagraphs[index][0], '\\', `块级标记必须转义：${line}`);
    }
  });
  assert.ok(hazardText.includes('\n\n'), '段间用空行');
  const hazardFinished = await rpcOk(first.state, 'session', { sessionId: hazardSession });
  assert.equal(hazardFinished.finished, true, '一次读完短文本');
  await rpcOk(first.state, 'select', { sessionId: hazardSession, novelId: null });

  // ---- 5.6 「正文放思考、可见固定总结」模式 ------------------------------
  const summaryTemplate = '### 已完成\n\n- 固定总结测试：{percent}% / {offset} / {total} / {title}';
  const thinkingPlugin = await loadPlugin(tempDir, { display: 'thinking', summaryTemplate });
  const thinkingSession = 'session-thinking';
  await rpcOk(thinkingPlugin.state, 'select', { sessionId: thinkingSession, novelId: novel.id });
  const thinkingChunks = await consume(thinkingPlugin.state, { ...options, sessionId: thinkingSession });
  const reasoningStart = thinkingChunks.find((chunk) => chunk.type === 'block-start' && chunk.blockType === 'reasoning');
  assert.ok(reasoningStart, '思考块存在');
  const reasoningRaw = thinkingChunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join('');
  const reasoningEnd = thinkingChunks.find((chunk) => chunk.type === 'block-end' && chunk.block && chunk.block.type === 'reasoning');
  assert.ok(reasoningEnd, '思考块有 block-end');
  assert.equal(reasoningEnd.block.text, reasoningRaw, '思考块内容 = delta 拼接');
  assert.ok(reasoningRaw.startsWith('\u2063'), '阅读模式思考正文带隐形翻页标记');
  const reasoningText = reasoningRaw.split('\u2063').join('').trim();
  const reasoningParagraphs = assertChatLike(reasoningText);
  assertParagraphsFromSource(reasoningParagraphs, await readFile(path.join(tempDir, novel.file), 'utf8'));
  const textStart = thinkingChunks.find((chunk) => chunk.type === 'block-start' && chunk.blockType === 'text');
  assert.ok(textStart, '可见回答块存在');
  const visible = thinkingChunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
  const thinkingState = await rpcOk(thinkingPlugin.state, 'session', { sessionId: thinkingSession });
  const expectedSummary = `### 已完成\n\n- 固定总结测试：${thinkingState.percent}% / ${thinkingState.offset} / ${thinkingState.chars} / ${thinkingState.name}`;
  assert.equal(visible, expectedSummary, '可见回复是固定总结模板（占位符已替换）');
  assert.ok(!visible.includes('老邮局'), '可见回复不泄漏小说正文');
  const visibleEnd = thinkingChunks.find((chunk) => chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text');
  assert.equal(visibleEnd.block.text, visible, '可见回答 block-end 完整');
  const types = thinkingChunks.map((chunk) => chunk.type);
  assert.ok(types.indexOf('reasoning-delta') < types.indexOf('text-delta'), '先输出思考再输出固定总结');
  assert.ok(thinkingState.offset > 0, '思考模式同样记录进度');

  // ---- 5.7 章节检测 + 每条消息一章 + 数字跳章 ------------------------------
  const chapterLines = [
    '第一章 出发',
    '清晨的雾还没有散，林舟把背包放到门口，又回头看了一眼还在睡着的院子，心里有些不舍。',
    '他沿着村口的小路一直走到公路边，远处的山被云遮住了一半，风从山谷里吹过来，带着潮湿的凉意。',
    '第二章 雨夜',
    '傍晚时分下起了雨，客栈的屋檐水成了一条线，他坐在窗边翻着旧地图，盘算着明天要走的路线。',
    '隔壁桌的人在低声说着山路塌方的事，他听得不太真切，却把每一句都记在了心里。',
    '第三章 归途',
    '天亮时雨停了，山道上积着薄薄的水，他加快了脚步，只想在天黑之前赶回那个熟悉的小院。',
    '路过最后一个垭口时，他回头望了一眼来时的路，忽然觉得这一趟已经和出发时不一样了。',
  ];
  const chapterText = `${chapterLines.join('\n')}\n`;
  await writeFile(path.join(tempDir, 'chaptered-novel.txt'), chapterText, 'utf8');
  const chapterOverview = await rpcOk(first.state, 'refresh');
  const chapterNovel = chapterOverview.novels.find((item) => item.file === 'chaptered-novel.txt');
  assert.ok(chapterNovel, '章节测试文件被扫描到');
  assert.equal(chapterNovel.chapters, 3, '自动检测到 3 章');
  assert.equal(chapterNovel.chapter.index, 1, '初始位置在第 1 章');
  assert.equal(chapterNovel.chapter.total, 3, '总章数进入列表数据');
  const chapterSession = 'session-chapter';
  await rpcOk(first.state, 'select', { sessionId: chapterSession, novelId: chapterNovel.id });
  const ch1 = await consume(first.state, { ...options, sessionId: chapterSession });
  validateChunkStream(ch1);
  const ch1Text = textOf(ch1);
  const ch1Paragraphs = assertChatLike(ch1Text);
  assert.equal(ch1Paragraphs.length, 3, '第一章 = 标题 + 2 段');
  assert.equal(unescapeMarkdown(ch1Paragraphs[0]), '第一章 出发');
  const ch2Start = chapterText.indexOf('第二章');
  const afterCh1 = await rpcOk(first.state, 'session', { sessionId: chapterSession });
  assert.equal(afterCh1.offset, ch2Start, '读完整章后进度停在第二章开头');
  assert.equal(afterCh1.chapter.index, 2, '当前位置是第 2 章');
  assert.equal(afterCh1.chapter.total, 3);

  // 数字跳章：消息里只有数字（运行时上下文消息应被跳过）
  const numericOptions = (text) => ({
    ...options,
    sessionId: chapterSession,
    messages: [
      { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
      { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '（运行时上下文）' }] },
    ],
  });
  const jumpOut = await consume(first.state, numericOptions('9'));
  assert.ok(textOf(jumpOut).includes('一共 3 章'), '越界序号给出总章数提示');
  const afterJumpOut = await rpcOk(first.state, 'session', { sessionId: chapterSession });
  assert.equal(afterJumpOut.offset, ch2Start, '越界时不改进度');

  const jump2 = await consume(first.state, numericOptions('2'));
  validateChunkStream(jump2);
  assert.ok(textOf(jump2).includes('第二章 雨夜'), '数字 2 直接读出第二章');
  const afterJump2 = await rpcOk(first.state, 'session', { sessionId: chapterSession });
  assert.equal(afterJump2.offset, chapterText.indexOf('第三章'), '第二章读完停在第三章开头');

  const jump1 = await consume(first.state, numericOptions('1'));
  assert.ok(textOf(jump1).includes('第一章 出发'), '数字 1 跳回第一章');
  const jump3 = await consume(first.state, numericOptions('3'));
  assert.ok(textOf(jump3).includes('第三章 归途'), '数字 3 读出第三章');
  const afterAll = await rpcOk(first.state, 'session', { sessionId: chapterSession });
  assert.equal(afterAll.finished, true, '最后一章读完');

  // 没有章节标题的书：数字给出提示、保持原进度
  await rpcOk(first.state, 'select', { sessionId: hazardSession, novelId: hazard.id });
  const noChapterJump = await consume(first.state, { ...options, sessionId: hazardSession, messages: numericOptions('2').messages });
  assert.ok(textOf(noChapterJump).includes('没有检测到章节标题'), '无章节书提示序号不可用');

  // 关闭章节模式时，纯数字提示已关闭
  const chunkPlugin = await loadPlugin(tempDir, { display: 'answer', chapters: false, chapterDelayMs: 0 });
  await rpcOk(chunkPlugin.state, 'select', { sessionId: 'session-chapters-off', novelId: chapterNovel.id });
  const offJump = await consume(chunkPlugin.state, {
    ...options,
    sessionId: 'session-chapters-off',
    messages: numericOptions('2').messages,
  });
  assert.ok(textOf(offJump).includes('章节跳转已在配置里关闭'), '关闭章节模式后的提示');
  await rpcOk(first.state, 'select', { sessionId: chapterSession, novelId: null });
  await rpcOk(first.state, 'select', { sessionId: hazardSession, novelId: null });

  // ---- 5.8 目录可修改（设置页） -------------------------------------------
  {
    const dirPlugin = await loadPlugin(undefined, { display: 'answer', chapterDelayMs: 0 });
    const initialOverview = await rpcOk(dirPlugin.state, 'overview');
    assert.equal(initialOverview.directory, path.join(fakeHome, 'novels'), '默认目录跟随 DSH_HOME');
    assert.equal(initialOverview.defaultDirectory, path.join(fakeHome, 'novels'));
    assert.equal(initialOverview.locked, false, '未配置 directory 时可改');

    const libraryA = path.join(tempDir, 'library-a');
    await mkdir(libraryA, { recursive: true });
    await writeFile(path.join(libraryA, 'a.txt'), '目录 A 的正文。\n第二段。\n', 'utf8');
    const switched = await rpcOk(dirPlugin.state, 'setDirectory', { directory: libraryA });
    assert.equal(switched.directory, libraryA, '目录已切换');
    assert.equal(switched.novels.length, 1, '新目录被重新扫描');
    assert.equal(switched.novels[0].file, 'a.txt');

    const dirPlugin2 = await loadPlugin(undefined, { display: 'answer', chapterDelayMs: 0 });
    const remembered = await rpcOk(dirPlugin2.state, 'overview');
    assert.equal(remembered.directory, libraryA, '目录设置持久化到固定位置');

    const restored = await rpcOk(dirPlugin2.state, 'setDirectory', { directory: '' });
    assert.equal(restored.directory, path.join(fakeHome, 'novels'), '恢复默认目录');

    const lockedPlugin = await loadPlugin(tempDir, { display: 'answer', chapterDelayMs: 0 });
    const lockedResult = await rpc(lockedPlugin.state, 'setDirectory', { directory: libraryA });
    assert.equal(lockedResult.ok, false, '配置固定目录时拒绝修改');
    assert.ok(lockedResult.error.message.includes('固定'), '固定目录给出原因');
  }

  // ---- 5.9 阅读样式 RPC（设置页「阅读样式」） ------------------------------
  const styleDefaultsPayload = await rpcOk(first.state, 'style');
  assert.equal(styleDefaultsPayload.fontSize, 15, '默认字号');
  assert.equal(styleDefaultsPayload.pageHeight, 440, '默认页高');
  assert.equal(styleDefaultsPayload.lineHeight, 1.8, '默认行距');
  assert.ok(styleDefaultsPayload.defaults && styleDefaultsPayload.defaults.fontSize === 15, '返回配置默认值');
  const styled = await rpcOk(first.state, 'setStyle', {
    style: {
      fontSize: 19,
      lineHeight: 2.1,
      letterSpacing: 1,
      paragraphSpacing: 1.2,
      pageHeight: 520,
      pagePadding: 22,
      pageMaxWidth: 720,
      fontFamily: '"Noto Serif SC", serif',
    },
  });
  assert.equal(styled.fontSize, 19);
  assert.equal(styled.pageHeight, 520);
  assert.equal(styled.lineHeight, 2.1);
  assert.equal(styled.pageMaxWidth, 720);
  assert.equal(styled.fontFamily, '"Noto Serif SC", serif');
  const clampedStyle = await rpcOk(first.state, 'setStyle', { style: { fontSize: 99, pageHeight: 10, lineHeight: 0.1 } });
  assert.equal(clampedStyle.fontSize, 40, '字号越界收敛');
  assert.equal(clampedStyle.pageHeight, 240, '页高越界收敛');
  assert.equal(clampedStyle.lineHeight, 1.2, '行距越界收敛');
  await rpcOk(first.state, 'setStyle', { style: styleDefaultsPayload.defaults });
  const resetStyle = await rpcOk(first.state, 'style');
  assert.equal(resetStyle.fontSize, 15, '恢复默认样式');
  await rpcOk(first.state, 'setStyle', { style: { fontSize: 18 } });
  const styleReload = await loadPlugin(tempDir, { display: 'answer', chapterDelayMs: 0 });
  const persistedStyle = await rpcOk(styleReload.state, 'style');
  assert.equal(persistedStyle.fontSize, 18, '样式设置持久化');
  await rpcOk(styleReload.state, 'setStyle', { style: styleDefaultsPayload.defaults });

  // ---- 5.10 生成速度 RPC（设置页「生成速度」） -----------------------------
  const generationDefaults = await rpcOk(first.state, 'generation');
  assert.equal(generationDefaults.mode, 'instant', '测试配置默认瞬间生成');
  assert.ok(generationDefaults.defaults && generationDefaults.defaults.mode === 'instant', '返回速度默认值');
  const generationSpeed = await rpcOk(first.state, 'setGeneration', {
    generation: { mode: 'speed', charsPerSecond: 123 },
  });
  assert.equal(generationSpeed.mode, 'speed');
  assert.equal(generationSpeed.charsPerSecond, 123);
  const generationClamped = await rpcOk(first.state, 'setGeneration', {
    generation: { mode: 'duration', seconds: 0.1, charsPerSecond: 99999 },
  });
  assert.equal(generationClamped.mode, 'duration');
  assert.equal(generationClamped.seconds, 0.5, '秒数越界收敛');
  assert.equal(generationClamped.charsPerSecond, 5000, '字/秒越界收敛');
  await rpcOk(first.state, 'setGeneration', { generation: generationDefaults.defaults });
  const generationReset = await rpcOk(first.state, 'generation');
  assert.equal(generationReset.mode, 'instant', '恢复默认速度');
  await rpcOk(first.state, 'setGeneration', { generation: { mode: 'speed', charsPerSecond: 300 } });
  const generationReload = await loadPlugin(tempDir, { display: 'answer' });
  const generationPersisted = await rpcOk(generationReload.state, 'generation');
  assert.equal(generationPersisted.mode, 'speed', '速度设置持久化');
  assert.equal(generationPersisted.charsPerSecond, 300);
  await rpcOk(generationReload.state, 'setGeneration', { generation: generationDefaults.defaults });

  // ---- 6. 标题 / 压缩 / 非聊天 purpose 分流 --------------------------------
  const titleChunks = await consume(first.state, { ...options, purpose: 'session-title' });
  const defaultTitle = textOf(titleChunks);
  assert.ok(defaultTitle.length >= 2 && !defaultTitle.includes('《'), '标题里不出现书名');
  assert.ok(
    ['内容整理', '继续处理', '分段梳理', '续接推进', '长文处理', '整体梳理'].includes(defaultTitle),
    '标题来自普通工作型标题池',
  );
  const titlePlugin = await loadPlugin(tempDir, { display: 'answer', sessionTitle: '自定义标题', chapterDelayMs: 0 });
  await rpcOk(titlePlugin.state, 'select', { sessionId: 'session-title', novelId: novel.id });
  const overrideTitle = await consume(titlePlugin.state, { ...options, sessionId: 'session-title', purpose: 'session-title' });
  assert.equal(textOf(overrideTitle), '自定义标题', 'sessionTitle 配置可覆盖默认标题');
  const compactionChunks = await consume(first.state, { ...options, purpose: 'compaction' });
  assert.ok(textOf(compactionChunks).includes('阅读模式'), '压缩返回阅读模式摘要');
  const passthrough = [];
  const passthroughIterable = first.state.streamListener({ ...options, purpose: 'other-purpose' }, async function* () {
    passthrough.push('next-called');
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  for await (const _chunk of passthroughIterable) { /* 消费 */ }
  assert.deepEqual(passthrough, ['next-called'], '其他 purpose 透传');

  // ---- 7. 改名 / 重置 ------------------------------------------------------
  overview = await rpcOk(first.state, 'rename', { novelId: novel.id, name: '我的小说' });
  assert.ok(overview.novels.some((item) => item.id === novel.id && item.name === '我的小说'));
  session = await rpcOk(first.state, 'session', { sessionId });
  assert.equal(session.name, '我的小说');
  overview = await rpcOk(first.state, 'reset', { novelId: novel.id });
  assert.equal(overview.novels.find((item) => item.id === novel.id).offset, 0);
  const chunks4 = await consume(first.state, options);
  assert.ok(textOf(chunks4).length > 0, '重置后能重新从头读');

  // ---- 8. 未知方法 ---------------------------------------------------------
  const unknown = await rpc(first.state, 'nope');
  assert.equal(unknown.ok, false);
  assert.equal(typeof unknown.error.message, 'string');

  // ---- 9. 退出阅读模式后透传 ----------------------------------------------
  await rpcOk(first.state, 'select', { sessionId, novelId: null });
  session = await rpcOk(first.state, 'session', { sessionId });
  assert.equal(session.active, false);
  let nextCalled = false;
  const offIterable = first.state.streamListener(options, async function* () {
    nextCalled = true;
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  for await (const _chunk of offIterable) { /* 消费 */ }
  assert.equal(nextCalled, true, '退出阅读模式后走真实模型');

  // ---- 10. 持久化：重装插件后进度/名字仍在 --------------------------------
  const overviewBeforeReload = await rpcOk(first.state, 'overview');
  const beforeReload = overviewBeforeReload.novels.find((item) => item.id === novel.id);
  const stateFile = await readFile(path.join(tempDir, '.reader-state.json'), 'utf8');
  assert.ok(stateFile.includes('我的小说'), '状态文件保存显示名');
  const second = await loadPlugin(tempDir);
  const overviewAfterReload = await rpcOk(second.state, 'overview');
  const reloaded = overviewAfterReload.novels.find((item) => item.id === novel.id);
  assert.equal(reloaded.name, '我的小说', '重启后显示名恢复');
  assert.equal(reloaded.offset, beforeReload.offset, '重启后进度恢复');
  const sessionAfterReload = await rpcOk(second.state, 'session', { sessionId });
  // select 被清成 null，所以会话不再处于阅读模式，但进度仍在。
  assert.equal(sessionAfterReload.active, false);

  console.log('PASS 宿主半验证：扫描/示例/选书/目录切换与持久化/阅读样式/生成速度/章节检测与整章阅读/数字跳章/切段/流式/中断续读/标题/压缩/改名/重置/持久化/RPC envelope 全部通过');
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  for (const state of instances) {
    for (const disposer of state.effects) {
      if (typeof disposer === 'function') {
        try { disposer(); } catch { /* 忽略 */ }
      }
    }
  }
  // 给插件的串行落盘留出收尾时间，再删测试目录。
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
