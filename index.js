/**
 * dsh-novel-reader — Host half.
 *
 * 把固定目录里的 txt 小说切成小段，在「阅读模式」会话里替换正常聊天请求的
 * 模型输出：用户每发一条消息，助手回复就是下一段正文；进度按小说持久化。
 *
 * 架构：
 *   1. 扫描 <DSH_HOME>/novels（或 config.directory）下的 *.txt；
 *   2. 状态文件 <novels>/.reader-state.json 保存显示名、每本进度、会话→小说映射；
 *   3. 监听 `llm/stream` 瀑布：命中阅读模式的会话时接管流式输出；
 *   4. 通过 `ctx.connection.rpc.intercept('/api', ...)` 给浏览器半提供 RPC。
 */
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const inject = ['connection'];

const PLUGIN_ID = 'dsh-novel-reader';
const RPC_ENDPOINT = 'novel-reader';
const STATE_FILE = '.reader-state.json';
const STATE_VERSION = 1;
/** 运行中代码的代次标记：写进状态文件，便于确认热重载后真的换成了新代码。 */
const BUILD_MARKER = '2026-11-10-smooth-chapter-v14';
const DEFAULT_CHUNK_CHARS = 420;
const DEFAULT_FIRST_TOKEN_DELAY_MS = 350;
// 每个流式片段的字数：4 字 + 55ms 左右 ≈ 60-90 字/秒，接近真实模型中文出词速度。
const DELTA_CHARS = 4;
/** 正文放到「思考」里、可见回答是一段固定总结（更像正常 AI 回复）。 */
const DEFAULT_DISPLAY_MODE = 'thinking';
/** 默认可见总结：刻意写得长一些，让回复占满正常 AI 报告该有的高度。 */
const DEFAULT_SUMMARY_TEMPLATE = [
  '### 已完成',
  '',
  '本次处理已完成。过程记录在上面的「思考」里，下面是要点汇总。',
  '',
  '#### 处理范围',
  '',
  '- 已对当前上下文做完整梳理，确认与上一轮结果自然衔接；',
  '- 已按原有顺序处理本次需要覆盖的内容，没有跳段或重复；',
  '- 已记录当前停留位置，后续可以从这里继续。',
  '',
  '#### 处理结果',
  '',
  '1. 内容结构保持不变，段落拆分与之前一致；',
  '2. 上下文信息完整，没有出现需要中断确认的问题；',
  '3. 本次输出可直接使用，不需要额外修正。',
  '',
  '| 项目 | 状态 |',
  '| --- | --- |',
  '| 内容梳理 | 已完成 |',
  '| 上下文衔接 | 正常 |',
  '| 待确认事项 | 无 |',
  '| 后续处理 | 可继续 |',
  '',
  '当前整体进度：约 {percent}%。',
  '',
  '#### 说明',
  '',
  '- 如果只是想让流程继续，直接回复任意消息即可；',
  '- 如果想调整方向、长度或处理方式，直接说明就行；',
  '- 更详细的过程都在「思考」里，点击展开即可查看。',
  '',
  '#### 下一步',
  '',
  '需要我继续处理下一部分时直接回复；想先停在这里也可以，随时可以接着往下做。',
].join('\n');

/** 「思考」正文开头的隐形标记：浏览器半看到它就切换成翻页阅读器，正常模型思考没有这个标记。 */
const READING_MARKER = '\u2063';
/** 阅读页面的默认排版；cordis.patch.yml 和设置页都可以覆盖。 */
const DEFAULT_READING_STYLE = {
  fontSize: 15,
  lineHeight: 1.8,
  letterSpacing: 0,
  paragraphSpacing: 0.8,
  pageHeight: 440,
  pagePadding: 18,
  pageMaxWidth: 0,
  fontFamily: '',
  // 翻页效果：none=直接切换；fast=140ms 快速覆盖；normal=280ms 标准覆盖
  flip: 'fast',
};
/** 正文出字方式：instant=瞬间、duration=整段用固定秒数、speed=固定字/秒。 */
const DEFAULT_GENERATION = {
  mode: 'instant',
  seconds: 4,
  charsPerSecond: 200,
};

/** 固定目录的根：尊重 DSH_HOME，宿主进程一定有。 */
function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function novelIdOf(fileName) {
  // 文件名决定 id：改名等于换一本（README 里有说明）。
  return createHash('sha1').update(fileName).digest('hex').slice(0, 16);
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function clampFloat(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/** 合并并校验阅读样式；未知字段忽略，越界值收敛到合法范围。 */
function sanitizeReadingStyle(input, base) {
  const style = { ...base };
  if (!input || typeof input !== 'object') return style;
  if (input.fontSize !== undefined) style.fontSize = clampInt(input.fontSize, 12, 40, style.fontSize);
  if (input.lineHeight !== undefined) style.lineHeight = clampFloat(input.lineHeight, 1.2, 3, style.lineHeight);
  if (input.letterSpacing !== undefined) style.letterSpacing = clampFloat(input.letterSpacing, 0, 8, style.letterSpacing);
  if (input.paragraphSpacing !== undefined) style.paragraphSpacing = clampFloat(input.paragraphSpacing, 0, 3, style.paragraphSpacing);
  if (input.pageHeight !== undefined) style.pageHeight = clampInt(input.pageHeight, 240, 1200, style.pageHeight);
  if (input.pagePadding !== undefined) style.pagePadding = clampInt(input.pagePadding, 0, 64, style.pagePadding);
  if (input.pageMaxWidth !== undefined) style.pageMaxWidth = clampInt(input.pageMaxWidth, 0, 1400, style.pageMaxWidth);
  if (input.fontFamily !== undefined) style.fontFamily = String(input.fontFamily).trim().slice(0, 80);
  if (input.flip === 'none' || input.flip === 'fast' || input.flip === 'normal') style.flip = input.flip;
  return style;
}

/** 校验出字速度设置。 */
function sanitizeGeneration(input, base) {
  const generation = { ...base };
  if (!input || typeof input !== 'object') return generation;
  if (input.mode === 'instant' || input.mode === 'duration' || input.mode === 'speed') generation.mode = input.mode;
  if (input.seconds !== undefined) generation.seconds = clampFloat(input.seconds, 0.5, 60, generation.seconds);
  if (input.charsPerSecond !== undefined) generation.charsPerSecond = clampInt(input.charsPerSecond, 10, 5000, generation.charsPerSecond);
  return generation;
}

/** 从 text[offset] 起取一段：尽量在段落换行处收尾，长度为 chunkChars 的 1~1.6 倍。 */
function takeChunk(text, offset, size) {
  const length = text.length;
  let start = Math.min(Math.max(0, Math.trunc(offset)), length);
  while (start < length && /\s/.test(text[start])) start += 1;
  if (start >= length) return { start: length, end: length, text: '' };
  const target = Math.min(length, start + size);
  let end = target;
  if (target < length) {
    const newline = text.indexOf('\n', target);
    // 最多多看 60% 的篇幅找段落边界，找不到就硬切。
    if (newline !== -1 && newline - target <= Math.max(80, Math.floor(size * 0.6))) {
      end = newline + 1;
    }
  }
  if (end > start && end < length) {
    const last = text.charCodeAt(end - 1);
    // 不要把代理对切成两半。
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  const piece = text.slice(start, end).replace(/\s+$/, '');
  return { start, end, text: piece };
}

/**
 * 把小说原文的一个片段整理成「正常 AI 回复」的排版：
 *   1. 每一行原文是一个自然段，段与段之间用空行（Markdown 段落）分隔，字体/行距就与模型回复一致；
 *   2. 去掉行首缩进和行尾空白，避免被 Markdown 当成代码块；
 *   3. 转义 `*`、`` ` ``、`[]`、`<>` 与行首的 `#`/`-`/`>` 等块级标记，
 *      否则正文里的符号会被渲染成标题、列表、引用、代码，露馅且难看。
 * 返回的每一项带 rawLen（原文占用的字符数），中断时按整段回退进度。
 */
function displayParagraphs(raw) {
  const segments = [];
  let cursor = 0;
  while (true) {
    const newline = raw.indexOf('\n', cursor);
    const end = newline === -1 ? raw.length : newline;
    segments.push({
      line: raw.slice(cursor, end).replace(/\r$/, ''),
      rawLen: (newline === -1 ? raw.length : newline + 1) - cursor,
    });
    if (newline === -1) break;
    cursor = newline + 1;
  }
  const entries = [];
  let pending = 0;
  for (const segment of segments) {
    const trimmed = segment.line.replace(/^[ \t\u3000]+/, '').replace(/[ \t\u3000]+$/, '');
    if (trimmed.length === 0) {
      pending += segment.rawLen;
      continue;
    }
    let display = '';
    for (const character of trimmed) {
      display += '\\`*_[]<>'.includes(character) ? `\\${character}` : character;
    }
    if ('#>-|+=~'.includes(display[0])) {
      display = `\\${display}`;
    } else {
      const numbered = /^(\d{1,3})([.)])(\s|$)/.exec(display);
      if (numbered) display = `${numbered[1]}\\${display.slice(numbered[1].length)}`;
    }
    entries.push({ display, rawLen: pending + segment.rawLen });
    pending = 0;
  }
  return entries;
}

function abortError(signal) {
  const reason = signal && signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('novel-reader: stream aborted');
  error.name = 'AbortError';
  return error;
}

/** 常见章节标题：第X章/节/回/话/篇、Chapter N，以及楔子/序章/番外等。 */
const CHAPTER_HEADING_PATTERN = /^\s*(?:第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章节回话篇]|chapter\s+[0-9ivxlcdm]+|序章|楔子|引子|前言|序言|尾声|终章|后记|番外)/i;

/**
 * 按行扫描章节标题，返回按出现顺序编号的章节表（1 起）。
 * 第一个标题之前的正文（书名页、作者的话）并入第 1 章，保证「第一章」仍是序号 1。
 */
function detectChapters(text) {
  const headings = [];
  let cursor = 0;
  while (true) {
    const newline = text.indexOf('\n', cursor);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(cursor, end).replace(/\r$/, '').replace(/^[ \t\u3000]+/, '').replace(/[ \t\u3000]+$/, '');
    if (
      line.length > 0
      && line.length <= 80
      && !line.includes('。')
      && CHAPTER_HEADING_PATTERN.test(line)
    ) {
      headings.push({ title: line, start: cursor });
    }
    if (newline === -1) break;
    cursor = newline + 1;
  }
  if (headings.length === 0) return [];
  return headings.map((heading, index) => ({
    index: index + 1,
    title: heading.title,
    start: index === 0 ? 0 : heading.start,
    end: index + 1 < headings.length ? headings[index + 1].start : text.length,
  }));
}

/** 返回 offset 所在的章节（offset 恰好在末章末尾时归末章）。 */
function chapterAt(chapters, offset) {
  for (const chapter of chapters) {
    if (offset < chapter.end) return chapter;
  }
  return chapters[chapters.length - 1];
}

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

/** 本轮用户是否只发了一个序号（跳过运行时注入的上下文消息）。 */
function requestedChapterNumber(messages) {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'user') continue;
    const source = message.source;
    if (source && source.kind !== 'user') continue;
    const match = /^\s*(\d{1,4})\s*$/.exec(messageText(message));
    return match ? Number(match[1]) : null;
  }
  return null;
}

/** 会话标题池：阅读模式的会话标题不该出现书名，用普通的工作型标题代替。 */
const SESSION_TITLE_POOL = ['内容整理', '继续处理', '分段梳理', '续接推进', '长文处理', '整体梳理'];

function sessionTitleFor(sessionId, override) {
  if (typeof override === 'string' && override.length > 0) return override;
  let hash = 0;
  for (const character of String(sessionId)) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return SESSION_TITLE_POOL[hash % SESSION_TITLE_POOL.length];
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError(signal));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function apply(ctx, rawConfig) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const defaultDirectory = path.join(dshHome(), 'novels');
  const configuredDirectory = typeof config.directory === 'string' ? config.directory.trim() : '';
  const directoryLocked = configuredDirectory.length > 0;
  const lockedDirectory = directoryLocked
    ? (path.isAbsolute(configuredDirectory) ? configuredDirectory : path.join(dshHome(), configuredDirectory))
    : '';
  // 当前目录优先级：cordis.patch.yml 的 directory > 设置页保存的目录 > <DSH_HOME>/novels。
  let directory = directoryLocked ? lockedDirectory : defaultDirectory;
  let statePath = path.join(directory, STATE_FILE);
  // 设置页选的目录写在 <DSH_HOME> 下的固定文件里，不跟着小说目录走，换目录后仍能记住。
  const settingsPath = path.join(dshHome(), 'novel-reader.settings.json');
  const settings = { directory: '', readingStyle: null, generation: null };
  const chunkChars = clampInt(config.chunkChars, 80, 4000, DEFAULT_CHUNK_CHARS);
  const firstTokenDelayMs = clampInt(config.firstTokenDelayMs, 0, 3000, DEFAULT_FIRST_TOKEN_DELAY_MS);
  const displayMode = config.display === 'answer' ? 'answer' : DEFAULT_DISPLAY_MODE;
  const summaryTemplate = typeof config.summaryTemplate === 'string' && config.summaryTemplate.trim().length > 0
    ? config.summaryTemplate.trim()
    : DEFAULT_SUMMARY_TEMPLATE;
  // 章节模式：识别 txt 里的章节标题，一条消息读一整章；没有章节标题时自动退回按字数切段。
  const chaptersEnabled = config.chapters !== false;
  const numberedJumpEnabled = config.numberedJump !== false;
  const maxChapterChars = clampInt(config.maxChapterChars, 0, 200000, 0);
  const sessionTitleOverride = typeof config.sessionTitle === 'string' ? config.sessionTitle.trim().slice(0, 80) : '';
  // 阅读排版：config 里的默认值，设置页保存的覆盖值在 settings.readingStyle。
  const configReadingStyle = sanitizeReadingStyle({
    fontSize: config.readingFontSize,
    lineHeight: config.readingLineHeight,
    letterSpacing: config.readingLetterSpacing,
    paragraphSpacing: config.readingParagraphSpacing,
    pageHeight: config.readingPageHeight,
    pagePadding: config.readingPagePadding,
    pageMaxWidth: config.readingPageMaxWidth,
    fontFamily: config.readingFontFamily,
    flip: config.readingFlip,
  }, DEFAULT_READING_STYLE);
  function effectiveReadingStyle() {
    return sanitizeReadingStyle(settings.readingStyle, configReadingStyle);
  }
  // 出字速度：config 默认值 + 设置页覆盖。
  const configGeneration = sanitizeGeneration({
    mode: config.streamMode,
    seconds: config.streamSeconds,
    charsPerSecond: config.streamCharsPerSecond,
  }, DEFAULT_GENERATION);
  function effectiveGeneration() {
    return sanitizeGeneration(settings.generation, configGeneration);
  }
  const samplesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'samples');

  /** 持久状态：显示名 / 每本进度 / 会话→小说。 */
  const state = {
    version: STATE_VERSION,
    names: Object.create(null),
    progress: Object.create(null),
    sessions: Object.create(null),
    // 首次收到浏览器半 RPC 的时间：用于确认界面↔宿主的通道已经打通。
    clientContactAt: 0,
    // 当前运行的代码代次（见 BUILD_MARKER）。
    build: '',
    // 浏览器半最近一次上报的翻页渲染诊断（排障用）。
    uiDebug: null,
  };
  /** 已扫描到的小说目录：id -> { id, file, path, chars }。 */
  let catalog = new Map();
  /** 正文缓存：id -> { mtimeMs, size, text }。 */
  const textCache = new Map();
  let readySettled = false;
  let saveTimer = null;
  let saveSeq = 0;
  let saveChain = Promise.resolve();

  async function ensureDirectory() {
    await fsp.mkdir(directory, { recursive: true });
  }

  async function loadSettings() {
    try {
      const parsed = JSON.parse(stripBom(await fsp.readFile(settingsPath, 'utf8')));
      if (parsed && typeof parsed.directory === 'string' && parsed.directory.trim().length > 0) {
        settings.directory = parsed.directory.trim();
      }
      if (parsed && parsed.readingStyle && typeof parsed.readingStyle === 'object') {
        settings.readingStyle = sanitizeReadingStyle(parsed.readingStyle, DEFAULT_READING_STYLE);
      }
      if (parsed && parsed.generation && typeof parsed.generation === 'object') {
        settings.generation = sanitizeGeneration(parsed.generation, DEFAULT_GENERATION);
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        ctx.logger?.warn?.(`${PLUGIN_ID}: 读取设置文件失败：${String(error.message || error)}`);
      }
    }
  }

  async function saveSettings() {
    await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
    const temp = `${settingsPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await fsp.writeFile(temp, JSON.stringify({
      version: 1,
      directory: settings.directory,
      readingStyle: settings.readingStyle,
      generation: settings.generation,
    }), 'utf8');
    try {
      await fsp.rename(temp, settingsPath);
    } catch (error) {
      if (error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EEXIST')) {
        await fsp.rm(settingsPath, { force: true });
        await fsp.rename(temp, settingsPath);
      } else {
        await fsp.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
    }
  }

  /** 设置页切换小说目录；空字符串表示恢复默认目录。 */
  async function setDirectory(target) {
    if (directoryLocked) {
      throw new Error('目录已被 cordis.patch.yml 的 directory 固定。请先把那一项清空，再来这里修改。');
    }
    const raw = typeof target === 'string' ? target.trim() : '';
    let next;
    let stored = '';
    if (raw.length === 0) {
      next = defaultDirectory;
    } else {
      next = path.isAbsolute(raw) ? raw : path.join(dshHome(), raw);
      stored = next;
    }
    await fsp.mkdir(next, { recursive: true });
    await fsp.readdir(next); // 顺便确认目录可读
    directory = next;
    statePath = path.join(next, STATE_FILE);
    settings.directory = stored;
    await saveSettings();
    // 进度/显示名/会话映射都跟着目录走：换目录等于换一个书库。
    catalog = new Map();
    textCache.clear();
    state.names = Object.create(null);
    state.progress = Object.create(null);
    state.sessions = Object.create(null);
    await loadState();
    await refreshCatalog();
    return overview();
  }

  /** 当前生效的阅读排版 + 配置默认值（设置页「恢复默认」用）。 */
  function readingStylePayload() {
    return { ...effectiveReadingStyle(), defaults: { ...configReadingStyle } };
  }

  /** 保存设置页改的阅读排版；与默认值一致时清掉覆盖值。 */
  async function setReadingStyle(stylePatch) {
    const next = sanitizeReadingStyle(stylePatch, effectiveReadingStyle());
    settings.readingStyle = JSON.stringify(next) === JSON.stringify(configReadingStyle) ? null : next;
    await saveSettings();
    return readingStylePayload();
  }

  /** 当前出字速度 + 配置默认值。 */
  function generationPayload() {
    return { ...effectiveGeneration(), defaults: { ...configGeneration } };
  }

  /** 保存设置页改的出字速度；与默认值一致时清掉覆盖值。 */
  async function setGeneration(generationPatch) {
    const next = sanitizeGeneration(generationPatch, effectiveGeneration());
    settings.generation = JSON.stringify(next) === JSON.stringify(configGeneration) ? null : next;
    await saveSettings();
    return generationPayload();
  }

  /** 取当前进度之后的下一段/下一章，并推进进度；给翻页阅读器的「下一章」按钮用。 */
  async function nextChapterForSession(sessionId, peek) {
    const active = activeNovelForSession(sessionId);
    if (!active) throw new Error('会话不在阅读模式');
    if (active.missing) throw new Error('小说文件不存在，请刷新列表');
    const meta = active.meta;
    const { text, chapters } = await readNovelText(meta);
    const total = text.length;
    const chapterMode = chaptersEnabled && chapters.length > 0;
    const offset = offsetOf(meta.id, total);
    if (offset >= total) {
      return { text: '', chapter: null, offset: total, finished: true, hasMore: false, name: displayName(meta) };
    }
    let from = offset;
    let to = offset;
    let chapterInfo = null;
    if (chapterMode) {
      const chapter = chapterAt(chapters, offset);
      from = Math.max(offset, chapter.start);
      to = chapter.end;
      chapterInfo = { index: chapter.index, total: chapters.length, title: chapter.title };
    } else {
      const chunk = takeChunk(text, offset, chunkChars);
      from = chunk.start;
      to = chunk.end;
    }
    if (to <= from) {
      return { text: '', chapter: chapterInfo, offset, finished: true, hasMore: false, name: displayName(meta) };
    }
    const display = displayParagraphs(text.slice(from, to))
      .map((paragraph) => paragraph.display)
      .join('\n\n');
    if (peek !== true) {
      state.progress[meta.id] = to;
      await saveNow().catch(() => {});
    }
    return {
      text: display,
      chapter: chapterInfo,
      offset: to,
      finished: to >= total,
      hasMore: to < total,
      name: displayName(meta),
    };
  }

  async function loadState() {
    try {
      const parsed = JSON.parse(stripBom(await fsp.readFile(statePath, 'utf8')));
      if (!parsed || typeof parsed !== 'object') return;
      if (parsed.names && typeof parsed.names === 'object') {
        for (const [key, value] of Object.entries(parsed.names)) {
          if (typeof value === 'string' && value.trim().length > 0) state.names[key] = value.trim().slice(0, 80);
        }
      }
      if (parsed.progress && typeof parsed.progress === 'object') {
        for (const [key, value] of Object.entries(parsed.progress)) {
          const offset = Number(value);
          if (Number.isFinite(offset) && offset >= 0) state.progress[key] = Math.trunc(offset);
        }
      }
      if (parsed.sessions && typeof parsed.sessions === 'object') {
        for (const [key, value] of Object.entries(parsed.sessions)) {
          if (typeof value === 'string' && value.length > 0) state.sessions[key] = value;
        }
      }
      if (typeof parsed.clientContactAt === 'number' && Number.isFinite(parsed.clientContactAt)) {
        state.clientContactAt = parsed.clientContactAt;
      }
      if (typeof parsed.build === 'string') state.build = parsed.build;
      if (parsed.uiDebug && typeof parsed.uiDebug === 'object') state.uiDebug = parsed.uiDebug;
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        ctx.logger?.warn?.(`${PLUGIN_ID}: 读取状态文件失败：${String(error.message || error)}`);
      }
    }
  }

  function scheduleSave() {
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow().catch(() => {});
    }, 120);
  }

  function saveNow() {
    // 串行化写入，避免两个原子写互相覆盖。
    saveChain = saveChain.then(async () => {
      await ensureDirectory();
      const payload = JSON.stringify({
        version: STATE_VERSION,
        names: state.names,
        progress: state.progress,
        sessions: state.sessions,
        clientContactAt: state.clientContactAt,
        build: state.build,
        uiDebug: state.uiDebug,
      });
      // 唯一临时名：热重载时新旧实例可能同进程并发写同一状态文件。
      const temp = `${statePath}.${process.pid}.${++saveSeq}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      await fsp.writeFile(temp, payload, 'utf8');
      try {
        await fsp.rename(temp, statePath);
      } catch (error) {
        // Windows 上目标被短暂占用时 rename 可能 EPERM；退化为先删再改名。
        if (error && (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EEXIST')) {
          await fsp.rm(statePath, { force: true });
          await fsp.rename(temp, statePath);
        } else {
          await fsp.rm(temp, { force: true }).catch(() => {});
          throw error;
        }
      }
    }).catch((error) => {
      ctx.logger?.warn?.(`${PLUGIN_ID}: 保存状态失败：${String(error?.message || error)}`);
    });
    return saveChain;
  }

  async function readNovelText(meta) {
    const stat = await fsp.stat(meta.path);
    const cached = textCache.get(meta.id);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { text: cached.text, chapters: cached.chapters, changed: false };
    }
    const text = stripBom(await fsp.readFile(meta.path, 'utf8'));
    const chapters = detectChapters(text);
    textCache.set(meta.id, { mtimeMs: stat.mtimeMs, size: stat.size, text, chapters });
    meta.chars = text.length;
    return { text, chapters, changed: true };
  }

  async function refreshCatalog() {
    await ensureDirectory();
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      ctx.logger?.warn?.(`${PLUGIN_ID}: 读取小说目录失败：${String(error?.message || error)}`);
      entries = [];
    }
    const next = new Map();
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('.')) continue;
      if (!/\.txt$/i.test(entry.name)) continue;
      const id = novelIdOf(entry.name);
      const full = path.join(directory, entry.name);
      let meta;
      try {
        meta = await readNovelText({ id, path: full, chars: 0 });
      } catch (error) {
        ctx.logger?.warn?.(`${PLUGIN_ID}: 读取 ${entry.name} 失败：${String(error?.message || error)}`);
        continue;
      }
      next.set(id, { id, file: entry.name, path: full, chars: meta.text.length });
    }
    catalog = next;
    // 清掉已经消失的小说缓存。
    for (const key of [...textCache.keys()]) if (!catalog.has(key)) textCache.delete(key);
    return catalog;
  }

  function displayName(meta) {
    const custom = state.names[meta.id];
    if (typeof custom === 'string' && custom.trim().length > 0) return custom.trim();
    return meta.file.replace(/\.txt$/i, '');
  }

  function offsetOf(id, chars) {
    const raw = state.progress[id];
    const offset = Number.isFinite(raw) ? raw : 0;
    return Math.min(Math.max(0, offset), chars);
  }

  function percentOf(offset, chars) {
    if (!Number.isFinite(chars) || chars <= 0) return offset > 0 ? 100 : 0;
    return Math.min(100, Math.max(0, Math.floor((offset / chars) * 100)));
  }

  function novelView(meta) {
    const offset = offsetOf(meta.id, meta.chars);
    const cached = textCache.get(meta.id);
    const chapters = cached && Array.isArray(cached.chapters) ? cached.chapters : [];
    const chapter = chapters.length === 0 ? undefined : chapterAt(chapters, Math.min(offset, meta.chars));
    return {
      id: meta.id,
      file: meta.file,
      name: displayName(meta),
      chars: meta.chars,
      offset,
      percent: percentOf(offset, meta.chars),
      finished: meta.chars > 0 && offset >= meta.chars,
      chapters: chapters.length,
      ...chapter === undefined ? {} : { chapter: { index: chapter.index, total: chapters.length, title: chapter.title } },
    };
  }

  function overview() {
    const novels = [...catalog.values()]
      .map(novelView)
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
    return { directory, defaultDirectory, locked: directoryLocked, novels };
  }

  function sessionState(sessionId) {
    const id = typeof sessionId === 'string' ? state.sessions[sessionId] : undefined;
    if (!id) return { novelId: null, active: false };
    const meta = catalog.get(id);
    if (!meta) {
      delete state.sessions[sessionId];
      scheduleSave();
      return { novelId: null, active: false };
    }
    const view = novelView(meta);
    const cached = textCache.get(id);
    const chapters = cached && Array.isArray(cached.chapters) ? cached.chapters : [];
    return {
      novelId: id,
      name: view.name,
      offset: view.offset,
      chars: view.chars,
      percent: view.percent,
      finished: view.finished,
      active: true,
      chapters: chapters.length,
      ...chapters.length === 0 ? {} : (() => {
        const chapter = chapterAt(chapters, view.offset);
        return { chapter: { index: chapter.index, title: chapter.title, total: chapters.length } };
      })(),
    };
  }

  function activeNovelForSession(sessionId) {
    const id = state.sessions[sessionId];
    if (!id) return undefined;
    const meta = catalog.get(id);
    if (!meta) return { missing: true, name: state.names[id] || '' };
    return { missing: false, meta, name: displayName(meta) };
  }

  // ---- 流式接管 -----------------------------------------------------------

  async function* textStream(text) {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }

  function renderSummary(meta, offset) {
    return summaryTemplate
      .replace(/\{title\}/g, displayName(meta))
      .replace(/\{percent\}/g, String(percentOf(offset, meta.chars)))
      .replace(/\{offset\}/g, String(offset))
      .replace(/\{total\}/g, String(meta.chars));
  }

  async function* novelStream(active, options) {
    const signal = options.signal;
    const meta = active.meta;
    let text;
    let chapters;
    try {
      ({ text, chapters } = await readNovelText(meta));
    } catch (error) {
      yield* textStream(`（《${active.name}》读取失败，请在设置里刷新列表或检查文件。）`);
      return;
    }
    const total = text.length;
    const chapterMode = chaptersEnabled && chapters.length > 0;
    const finishedNotice = `《${active.name}》已经读完了。可以在「设置 → 小说阅读」里重置进度，或者换一本。`;
    let start = offsetOf(meta.id, total);

    // 用户只发了一个数字：跳到对应序号的章节，并直接把这一章读出来。
    const requested = numberedJumpEnabled ? requestedChapterNumber(options.messages) : null;
    if (requested !== null) {
      if (!chapterMode) {
        yield* textStream(chaptersEnabled
          ? '这本书里没有检测到章节标题（需要像「第一章 ……」这样单独成行），序号跳转暂不可用，已保持原进度。'
          : '章节跳转已在配置里关闭，已保持原进度。');
        return;
      }
      if (requested < 1 || requested > chapters.length) {
        yield* textStream(`这本书一共 ${chapters.length} 章，序号请用 1-${chapters.length}。`);
        return;
      }
      start = chapters[requested - 1].start;
      state.progress[meta.id] = start;
      await saveNow().catch(() => {});
    }

    if (start >= total) {
      yield* textStream(finishedNotice);
      return;
    }

    let from;
    let end;
    if (chapterMode) {
      const chapter = chapterAt(chapters, start);
      from = Math.min(Math.max(start, chapter.start), chapter.end);
      end = chapter.end;
      // 极端长的章节可以用 maxChapterChars 截成多次；0 表示整章一次读完。
      if (maxChapterChars > 0) end = Math.min(end, from + maxChapterChars);
    } else {
      const chunk = takeChunk(text, start, chunkChars);
      from = chunk.start;
      end = chunk.end;
    }
    if (end <= from) {
      state.progress[meta.id] = total;
      await saveNow().catch(() => {});
      yield* textStream(finishedNotice);
      return;
    }
    const paragraphs = displayParagraphs(text.slice(from, end));
    if (paragraphs.length === 0) {
      state.progress[meta.id] = end;
      await saveNow().catch(() => {});
      yield* textStream(finishedNotice);
      return;
    }
    const thinking = displayMode === 'thinking';
    const generation = effectiveGeneration();
    const contentIndex = 0;
    const textIndex = thinking ? 1 : 0;
    const deltaType = thinking ? 'reasoning-delta' : 'text-delta';
    const summary = thinking ? renderSummary(meta, end) : '';
    const displayText = paragraphs.map((paragraph) => paragraph.display).join('\n\n');
    const reasoningText = thinking ? `${READING_MARKER}\n\n${displayText}` : displayText;

    // 瞬间生成：整段只发一两个 delta。逐 4 字发会有上千个 chunk，光调度/渲染开销就要十来秒。
    if (generation.mode === 'instant') {
      try {
        yield { type: 'block-start', index: contentIndex, blockType: thinking ? 'reasoning' : 'text' };
        yield { type: deltaType, index: contentIndex, text: reasoningText };
        yield {
          type: 'block-end',
          index: contentIndex,
          block: thinking ? { type: 'reasoning', text: reasoningText } : { type: 'text', text: reasoningText },
        };
        if (thinking) {
          yield { type: 'block-start', index: textIndex, blockType: 'text' };
          yield { type: 'text-delta', index: textIndex, text: summary };
          yield { type: 'block-end', index: textIndex, block: { type: 'text', text: summary } };
        }
        state.progress[meta.id] = end;
        await saveNow().catch(() => {});
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      } catch (error) {
        state.progress[meta.id] = end;
        await saveNow().catch(() => {});
        throw error;
      }
    }

    // duration/speed 模式：把每片放大到几十字，片数控制在几十个，人工延迟才不会被单 chunk 开销吃掉。
    const totalChars = displayText.length + summary.length;
    let chunkSize = DELTA_CHARS;
    if (generation.mode === 'duration') {
      const targetPieces = Math.min(120, Math.max(12, Math.ceil(totalChars / 50)));
      chunkSize = Math.max(DELTA_CHARS, Math.ceil(totalChars / targetPieces));
    } else {
      chunkSize = Math.max(8, Math.min(80, Math.round(generation.charsPerSecond / 5)));
    }
    const contentPieces = paragraphs.reduce(
      (count, paragraph) => count + Math.ceil(paragraph.display.length / chunkSize),
      0,
    ) + Math.max(0, paragraphs.length - 1);
    const summaryPieces = summary.length > 0 ? Math.ceil(summary.length / chunkSize) : 0;
    const totalPieces = Math.max(1, contentPieces + summaryPieces);
    const pieceDelay = generation.mode === 'duration'
      ? (generation.seconds * 1000) / totalPieces
      : (chunkSize * 1000) / generation.charsPerSecond;
    const pace = function () {
      if (pieceDelay <= 0) return Promise.resolve();
      const jitter = generation.mode === 'speed' ? 0.9 + Math.random() * 0.2 : 1;
      return sleep(Math.max(1, Math.round(pieceDelay * jitter)), signal);
    };
    // 真实模型有首字延迟，先停一下再开始出字，观感更像一次正常请求。
    if (firstTokenDelayMs > 0) await sleep(firstTokenDelayMs, signal);
    yield { type: 'block-start', index: contentIndex, blockType: thinking ? 'reasoning' : 'text' };
    // 「思考」正文前加一个隐形标记：浏览器半看到它就切换到翻页阅读器；正常模型思考没有这个标记。
    if (thinking) {
      yield { type: 'reasoning-delta', index: contentIndex, text: `${READING_MARKER}\n\n` };
    }
    // 中断时只回退到最后一个完整自然段，避免把半段文字算作已读。
    let consumed = 0;
    try {
      for (let index = 0; index < paragraphs.length; index += 1) {
        if (signal && signal.aborted) throw abortError(signal);
        const paragraph = paragraphs[index];
        if (index > 0) {
          yield { type: deltaType, index: contentIndex, text: '\n\n' };
          await pace();
        }
        const display = paragraph.display;
        for (let offset = 0; offset < display.length; offset += chunkSize) {
          if (signal && signal.aborted) throw abortError(signal);
          yield { type: deltaType, index: contentIndex, text: display.slice(offset, offset + chunkSize) };
          if (offset + chunkSize < display.length) await pace();
        }
        consumed += paragraph.rawLen;
      }
    } catch (error) {
      state.progress[meta.id] = Math.min(end, from + consumed);
      await saveNow().catch(() => {});
      throw error;
    }
    yield {
      type: 'block-end',
      index: contentIndex,
      block: thinking ? { type: 'reasoning', text: reasoningText } : { type: 'text', text: reasoningText },
    };
    // 「思考」里的正文已经完整发出：先把进度落盘，再补固定总结。
    if (thinking) {
      try {
        yield { type: 'block-start', index: textIndex, blockType: 'text' };
        for (let offset = 0; offset < summary.length; offset += chunkSize) {
          if (signal && signal.aborted) throw abortError(signal);
          yield { type: 'text-delta', index: textIndex, text: summary.slice(offset, offset + chunkSize) };
          if (offset + chunkSize < summary.length) await pace();
        }
        yield { type: 'block-end', index: textIndex, block: { type: 'text', text: summary } };
      } catch (error) {
        // 总结被打断也不影响「这一章已读」，进度按整章推进。
        state.progress[meta.id] = end;
        await saveNow().catch(() => {});
        throw error;
      }
    }
    state.progress[meta.id] = end;
    await saveNow().catch(() => {});
    yield { type: 'finish', reason: { kind: 'stop' } };
  }

  function onStream(options, next) {
    try {
      if (!options || typeof options !== 'object') return next();
      const sessionId = options.sessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return next();
      if (!readySettled) return next();
      const purpose = options.purpose;
      const active = activeNovelForSession(sessionId);
      if (!active) return next();
      if (active.missing) {
        return textStream('（阅读模式：找不到这本小说文件。请在「设置 → 小说阅读」里刷新列表，或重新选择。）');
      }
      if (purpose === 'session-title') {
        // 标题里不出现书名/章节名，取一个普通的工作型标题，读起来像正常会话。
        return textStream(sessionTitleFor(sessionId, sessionTitleOverride));
      }
      if (purpose === 'compaction') {
        const meta = active.meta;
        const offset = offsetOf(meta.id, meta.chars);
        return textStream(
          `阅读模式：本会话正在阅读《${active.name}》，已读至 ${percentOf(offset, meta.chars)}%。`
          + '此前的用户消息是继续阅读指令，助手消息是小说正文节选，不需要在摘要里保留。',
        );
      }
      if (purpose !== undefined) return next();
      return novelStream(active, options);
    } catch (error) {
      ctx.logger?.warn?.(`${PLUGIN_ID}: 接管对话流失败：${String(error?.message || error)}`);
      return next();
    }
  }

  ctx.effect(() => ctx.on('llm/stream', onStream), 'novel-reader: 接管阅读模式会话的模型输出');

  // ---- RPC ----------------------------------------------------------------

  async function seedDemo() {
    let samples;
    try {
      samples = await fsp.readdir(samplesDir, { withFileTypes: true });
    } catch (error) {
      throw new Error('插件包内没有示例小说');
    }
    await ensureDirectory();
    let copied = 0;
    for (const entry of samples) {
      if (!entry.isFile() || !/\.txt$/i.test(entry.name)) continue;
      const target = path.join(directory, entry.name);
      try {
        await fsp.access(target);
        continue; // 已存在则跳过，不覆盖用户文件。
      } catch {}
      await fsp.copyFile(path.join(samplesDir, entry.name), target);
      copied += 1;
    }
    await refreshCatalog();
    return { copied, ...overview() };
  }

  async function dispatch(method, args) {
    if (state.clientContactAt === 0) {
      state.clientContactAt = Date.now();
      scheduleSave();
    }
    switch (method) {
      case 'overview':
        await refreshCatalog();
        return overview();
      case 'refresh':
        await refreshCatalog();
        return overview();
      case 'session':
        return sessionState(args && args.sessionId);
      case 'select': {
        const sessionId = args && args.sessionId;
        if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('缺少 sessionId');
        const novelId = args.novelId;
        if (novelId === null || novelId === undefined) {
          delete state.sessions[sessionId];
        } else {
          await refreshCatalog();
          if (!catalog.has(String(novelId))) throw new Error('没有这本小说，请刷新列表后重试');
          state.sessions[sessionId] = String(novelId);
        }
        await saveNow();
        return sessionState(sessionId);
      }
      case 'rename': {
        const novelId = args && args.novelId;
        if (typeof novelId !== 'string' || novelId.length === 0) throw new Error('缺少 novelId');
        await refreshCatalog();
        if (!catalog.has(novelId)) throw new Error('没有这本小说，请刷新列表后重试');
        const name = typeof args.name === 'string' ? args.name.trim().slice(0, 80) : '';
        if (name.length === 0) delete state.names[novelId];
        else state.names[novelId] = name;
        await saveNow();
        return overview();
      }
      case 'reset': {
        const novelId = args && args.novelId;
        if (typeof novelId !== 'string' || novelId.length === 0) throw new Error('缺少 novelId');
        state.progress[novelId] = 0;
        await saveNow();
        return overview();
      }
      case 'seedDemo':
        return seedDemo();
      case 'setDirectory':
        return setDirectory(args && args.directory);
      case 'style':
        return readingStylePayload();
      case 'setStyle': {
        const patch = args && args.style && typeof args.style === 'object' ? args.style : {};
        return setReadingStyle(patch);
      }
      case 'generation':
        return generationPayload();
      case 'setGeneration': {
        const patch = args && args.generation && typeof args.generation === 'object' ? args.generation : {};
        return setGeneration(patch);
      }
      case 'nextChapter': {
        const sessionId = args && args.sessionId;
        if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('缺少 sessionId');
        return nextChapterForSession(sessionId, args.peek === true);
      }
      case 'debug': {
        if (args && typeof args === 'object') {
          state.uiDebug = { ...args, at: Date.now() };
          scheduleSave();
        }
        return { ok: true };
      }
      default:
        throw new Error(`未知方法：${String(method)}`);
    }
  }

  // 浏览器半的 RPC 载体：注册精确的 POST /api/novel-reader 路由。
  // 不用 connection.rpc.intercept('/api', …)：共享 RPC 通道只允许一个拦截器，
  // 本 profile 里已被其他插件占用；精确路由是多个插件可以并存的公开做法。
  const connection = ctx.get('connection');
  const routePath = `/api/${RPC_ENDPOINT}`;
  const fetchRegistry = connection?.fetch;
  if (fetchRegistry && typeof fetchRegistry.register === 'function') {
    ctx.effect(() => {
      const dispose = fetchRegistry.register({
        path: routePath,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
          let url;
          try {
            url = new URL(request.url, 'http://localhost');
          } catch {
            url = undefined;
          }
          if (url !== undefined && !url.pathname.endsWith(routePath)) {
            return new Response('not found', { status: 404 });
          }
          if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
          const contentType = (request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
          if (contentType !== 'application/json') return new Response('content type must be application/json', { status: 415 });
          let body;
          try {
            body = await request.json();
          } catch {
            return new Response('body is not JSON', { status: 400 });
          }
          const rpcId = body && typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request';
          const reply = (result) => Response.json({ type: 'server-response', rpcId, result });
          const reject = (why) => reply({ ok: false, error: { code: 'gateway/bad-request', message: why, details: {} } });
          if (!body || body.type !== 'client-request') return reject('invalid client-request message');
          if (body.method !== RPC_ENDPOINT) return reject('invalid endpoint');
          const call = body.payload && typeof body.payload === 'object' ? body.payload : null;
          if (call === null || typeof call.method !== 'string' || call.method.length === 0) {
            return reject('missing call payload');
          }
          const args = call.payload && typeof call.payload === 'object' ? call.payload : {};
          try {
            const value = await dispatch(call.method, args);
            return reply({ ok: true, value });
          } catch (error) {
            return reply({
              ok: false,
              error: { code: `${PLUGIN_ID}/failed`, message: String(error?.message || error), details: {} },
            });
          }
        },
      });
      return () => {
        if (typeof dispose === 'function') Promise.resolve(dispose()).catch(() => {});
      };
    }, 'novel-reader: RPC 路由');
  } else {
    ctx.logger?.warn?.(`${PLUGIN_ID}: 当前宿主没有 connection.fetch.register，界面将不可用`);
  }

  // 启动即建目录、读状态、建目录索引；失败也不影响插件加载。
  const ready = (async () => {
    await loadSettings();
    if (!directoryLocked && settings.directory.length > 0) {
      const stored = settings.directory;
      directory = path.isAbsolute(stored) ? stored : path.join(dshHome(), stored);
      statePath = path.join(directory, STATE_FILE);
    }
    await ensureDirectory();
    await loadState();
    await refreshCatalog();
    if (state.build !== BUILD_MARKER) {
      state.build = BUILD_MARKER;
      await saveNow();
    }
  })()
    .catch((error) => {
      ctx.logger?.warn?.(`${PLUGIN_ID}: 初始化失败：${String(error?.message || error)}`);
    })
    .finally(() => {
      readySettled = true;
    });
  void ready;

  ctx.effect(() => () => {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    void saveNow();
  }, 'novel-reader: 卸载前保存状态');
}
