/*
 * dsh-novel-reader · 浏览器半
 *
 * 契约：novel-reader/CONTRACT.md（唯一事实来源）。
 * 只依赖 react；react-dom 仅在 try/catch 里尝试（用于弹层 portal），
 * 拿不到就降级成输入框上方的绝对定位面板。
 *
 * 两个槽位：
 *   - conversation.input.right → 小说选择触发按钮 + 模型选择框样式的弹层
 *   - settings.section          → 设置页（改显示名 / 重置进度 / 刷新 / 创建示例）
 *
 * 所有 Host 调用统一走 ctx.connection.rpc.call('/api', 'novel-reader', {method, payload})，
 * 返回 {ok, value|error}；失败只 throw，UI 用行内小字展示，不白屏。
 */
(function () {
  'use strict';

  var loader = typeof window !== 'undefined' ? window.__ModuleLoader__ : null;
  if (!loader || typeof loader.load !== 'function') return; // 非 Harness 环境静默退出

  loader.load({
    id: 'dsh-novel-reader',
    factory: function (require) {
      var ReactNS = require('react');
      // 不同加载器给的是 ESM namespace 或 default，这里两种都接。
      var React = ReactNS && typeof ReactNS.createElement === 'function'
        ? ReactNS
        : (ReactNS && ReactNS.default ? ReactNS.default : ReactNS);
      if (!React || typeof React.createElement !== 'function') {
        // react 不可用时降级为空模块；宁可按钮不出现，也不要让整个 GUI 加载失败。
        return { inject: [], apply: function () {} };
      }
      var h = React.createElement;
      var useState = React.useState;
      var useEffect = React.useEffect;
      var useRef = React.useRef;
      var useCallback = React.useCallback;

      var createPortal = null;
      try {
        var ReactDomNS = require('react-dom');
        var portalCandidate = ReactDomNS && typeof ReactDomNS.createPortal === 'function'
          ? ReactDomNS.createPortal
          : (ReactDomNS && ReactDomNS.default && typeof ReactDomNS.default.createPortal === 'function'
            ? ReactDomNS.default.createPortal
            : null);
        if (typeof portalCandidate === 'function') createPortal = portalCandidate;
      } catch (error) {
        createPortal = null; // 没有 react-dom 不影响模块加载，弹层降级为绝对定位
      }

      var NS = 'dsh-novel-reader';
      var RPC_ENDPOINT = 'novel-reader';
      var POLL_MS = 2000;
      var Z_INDEX = 2147483000; // 高于输入框区域的层叠上下文，避免被裁切/遮挡
      var SAVED_FLASH_MS = 2200;
      var READING_MARKER = '\u2063';
      var DEFAULT_READING_STYLE = {
        fontSize: 15,
        lineHeight: 1.8,
        letterSpacing: 0,
        paragraphSpacing: 0.8,
        pageHeight: 440,
        pagePadding: 18,
        pageMaxWidth: 0,
        fontFamily: '',
        flip: 'fast',
      };
      // 单章分页结果缓存：追加下一章时只排新章，不再把所有已加载章节重排一遍。
      var readingPageCache = new Map();

      function readingFlipMs(style) {
        var mode = style && style.flip;
        if (mode === 'none') return 0;
        if (mode === 'normal') return 280;
        return 140;
      }

      function readingTextStamp(text) {
        var value = String(text || '');
        var hash = 5381;
        for (var index = 0; index < value.length; index += 1) {
          hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
        }
        return value.length + ':' + (hash >>> 0).toString(36);
      }
      var DEFAULT_GENERATION = {
        mode: 'duration',
        seconds: 4,
        charsPerSecond: 200,
      };
      var readingStyleCache = null;
      var readingStylePending = null;
      var readingStyleListeners = new Set();
      var readingPageMemory = new Map();
      var readingFlipSeq = 0;
      var readerRpc = null;
      var readerT = null;
      var uiDebugLastAt = 0;

      function reportUiDebug(rpc, payload) {
        if (typeof rpc !== 'function') return;
        var now = Date.now();
        if (now - uiDebugLastAt < 1200) return;
        uiDebugLastAt = now;
        try {
          invoke(rpc, 'debug', payload || {}).catch(function () { /* 排障失败不影响阅读 */ });
        } catch (error) { /* 忽略 */ }
      }

      /* ────────────────────────────── 字典 ────────────────────────────── */

      var ZH = {
        'trigger.idle': '阅读模式',
        'popup.title': '选择小说',
        'popup.empty': '固定目录里还没有 txt 文件',
        'chapter.label': '第 {index}/{total} 章',
        'popup.hint': '选择后，发送任意消息即可继续阅读',
        'popup.jumpHint': '也可以直接回复数字（如 3），跳到对应序号的章节',
        'popup.off': '退出阅读模式',
        'popup.seed': '创建示例小说',
        'popup.loading': '加载中…',
        'popup.failed': '读取失败',
        'popup.finished': '已读完',
        nav: '小说阅读',
        'settings.title': '小说阅读',
        'settings.desc': '把 txt 小说放进固定目录，就能在对话里一段一段地读。发送任意消息继续下一段。',
        'settings.folder': '小说目录',
        'settings.dirPick': '选择文件夹…',
        'settings.dirApply': '应用',
        'settings.dirReset': '恢复默认',
        'settings.dirLocked': '目录已被配置固定（cordis.patch.yml 的 directory）；想在这里改，请先把那一项清空。',
        'settings.dirHint': '进度和显示名按目录分别保存；换目录后旧目录里的进度不会带过来。',
        'settings.dirSaved': '已切换目录',
        'settings.dirDefault': '默认目录：{path}',
        'settings.refresh': '刷新列表',
        'settings.seed': '创建示例小说',
        'settings.empty': '固定目录里还没有 txt 文件。把 .txt 放进上面的目录，或创建示例小说。',
        'settings.filename': '文件',
        'settings.displayName': '显示名',
        'settings.save': '保存',
        'settings.saving': '保存中…',
        'settings.saved': '已保存',
        'settings.reset': '重置进度',
        'settings.progress': '已读 {percent}% · {offset} / {chars} 字',
        'settings.error': '操作失败',
        'settings.noSession': '请在会话内使用',
        'settings.style.title': '阅读样式',
        'settings.style.fontSize': '字号（px）',
        'settings.style.lineHeight': '行距（倍）',
        'settings.style.letterSpacing': '字间距（px）',
        'settings.style.paragraphSpacing': '段间距（行）',
        'settings.style.pageHeight': '页高（px）',
        'settings.style.pagePadding': '页边距（px）',
        'settings.style.pageMaxWidth': '最大宽度（px，0=自适应）',
        'settings.style.fontFamily': '字体（CSS font-family，可留空）',
        'settings.style.flip': '翻页效果',
        'settings.style.flipNone': '无动画',
        'settings.style.flipFast': '快速覆盖',
        'settings.style.flipNormal': '标准覆盖',
        'settings.style.save': '保存样式',
        'settings.style.reset': '恢复默认样式',
        'settings.style.saved': '样式已保存',
        'settings.style.hint': '只影响阅读模式下「思考」里的翻页正文；普通模型的思考不受影响。',
        'settings.generation.title': '生成速度',
        'settings.generation.hint': '控制阅读模式下正文出现的节奏；只影响阅读模式，不影响真实模型回复。',
        'settings.generation.mode': '方式',
        'settings.generation.instant': '瞬间生成',
        'settings.generation.duration': '指定秒数',
        'settings.generation.speed': '按字/秒',
        'settings.generation.seconds': '整段秒数',
        'settings.generation.cps': '字/秒',
        'settings.generation.save': '保存速度',
        'settings.generation.reset': '恢复默认速度',
        'settings.generation.saved': '速度已保存',
        'reading.page': '第 {index}/{total} 页',
        'reading.prev': '上一页',
        'reading.next': '下一页',
        'reading.zoneHint': '点击页面左侧上一页、右侧下一页',
        'reading.end': '本章完 · 回复任意消息继续',
        'reading.nextChapter': '下一章',
        'reading.bookEnd': '全书完',
        'reading.loadingNext': '正在载入下一章…',
        'reading.nextChapterHint': '本章最后一页 · 点「下一章」继续读',
        'reading.endBookHint': '全书读完了 · 回复任意消息可换一本',
        'reading.generating': '正在生成本章…',
      };

      var EN = {
        'trigger.idle': 'Reading mode',
        'popup.title': 'Choose a novel',
        'popup.empty': 'No .txt files in the novels folder yet',
        'chapter.label': 'Ch. {index}/{total}',
        'popup.hint': 'After choosing one, send any message to keep reading',
        'popup.jumpHint': 'Or reply with a number (e.g. 3) to jump to that chapter',
        'popup.off': 'Exit reading mode',
        'popup.seed': 'Create sample novels',
        'popup.loading': 'Loading…',
        'popup.failed': 'Failed to load',
        'popup.finished': 'Finished',
        nav: 'Novel reading',
        'settings.title': 'Novel reading',
        'settings.desc': 'Drop txt novels into the fixed folder and read them excerpt by excerpt in the chat. Send any message to continue with the next excerpt.',
        'settings.folder': 'Novels folder',
        'settings.dirPick': 'Choose folder…',
        'settings.dirApply': 'Apply',
        'settings.dirReset': 'Restore default',
        'settings.dirLocked': 'The folder is pinned by `directory` in cordis.patch.yml; clear it there to change it here.',
        'settings.dirHint': 'Progress and display names are stored per folder; switching folders does not carry the old progress over.',
        'settings.dirSaved': 'Folder switched',
        'settings.dirDefault': 'Default: {path}',
        'settings.refresh': 'Refresh list',
        'settings.seed': 'Create sample novels',
        'settings.empty': 'No .txt files in the novels folder yet. Put a .txt file into the folder above, or create the sample novels.',
        'settings.filename': 'File',
        'settings.displayName': 'Display name',
        'settings.save': 'Save',
        'settings.saving': 'Saving…',
        'settings.saved': 'Saved',
        'settings.reset': 'Reset progress',
        'settings.progress': 'Read {percent}% · {offset} / {chars} chars',
        'settings.error': 'Operation failed',
        'settings.noSession': 'Use this inside a session',
        'settings.style.title': 'Reading style',
        'settings.style.fontSize': 'Font size (px)',
        'settings.style.lineHeight': 'Line height (×)',
        'settings.style.letterSpacing': 'Letter spacing (px)',
        'settings.style.paragraphSpacing': 'Paragraph spacing (lines)',
        'settings.style.pageHeight': 'Page height (px)',
        'settings.style.pagePadding': 'Page padding (px)',
        'settings.style.pageMaxWidth': 'Max width (px, 0 = auto)',
        'settings.style.fontFamily': 'Font (CSS font-family, optional)',
        'settings.style.flip': 'Page turn',
        'settings.style.flipNone': 'No animation',
        'settings.style.flipFast': 'Quick cover',
        'settings.style.flipNormal': 'Standard cover',
        'settings.style.save': 'Save style',
        'settings.style.reset': 'Reset style',
        'settings.style.saved': 'Style saved',
        'settings.style.hint': 'Affects only the paged excerpt inside the thinking block; normal model reasoning is untouched.',
        'settings.generation.title': 'Generation speed',
        'settings.generation.hint': 'Controls how fast the reading excerpt appears. Reading mode only; real model replies are unaffected.',
        'settings.generation.mode': 'Mode',
        'settings.generation.instant': 'Instant',
        'settings.generation.duration': 'Fixed seconds',
        'settings.generation.speed': 'Characters per second',
        'settings.generation.seconds': 'Seconds',
        'settings.generation.cps': 'Chars/sec',
        'settings.generation.save': 'Save speed',
        'settings.generation.reset': 'Reset speed',
        'settings.generation.saved': 'Speed saved',
        'reading.page': 'Page {index}/{total}',
        'reading.prev': 'Previous page',
        'reading.next': 'Next page',
        'reading.zoneHint': 'Click the left side for the previous page, the right side for the next',
        'reading.end': 'Chapter end · send any message to continue',
        'reading.nextChapter': 'Next chapter',
        'reading.bookEnd': 'End of book',
        'reading.loadingNext': 'Loading next chapter…',
        'reading.nextChapterHint': 'Last page of this chapter · click Next chapter to keep reading',
        'reading.endBookHint': 'You reached the end of the book · send any message to pick another',
        'reading.generating': 'Generating this chapter…',
      };

      /* ────────────────────────────── 小工具 ────────────────────────────── */

      function hasOwn(target, key) {
        return Object.prototype.hasOwnProperty.call(target, key);
      }

      function toCount(value) {
        return typeof value === 'number' && isFinite(value) && value > 0 ? Math.round(value) : 0;
      }

      function clampNumber(value, min, max) {
        if (!isFinite(value)) return min;
        return Math.min(max, Math.max(min, value));
      }

      function stripExtension(file) {
        var name = typeof file === 'string' ? file : '';
        return name.replace(/\.txt$/i, '');
      }

      function normalizeChapter(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var index = toCount(raw.index);
        var total = toCount(raw.total);
        if (index <= 0 || total <= 0) return null;
        return {
          index: index,
          total: total,
          title: typeof raw.title === 'string' ? raw.title : '',
        };
      }

      function normalizeNovel(raw) {
        if (!raw || typeof raw !== 'object') return null;
        var id = typeof raw.id === 'string' ? raw.id : '';
        if (id === '') return null;
        var file = typeof raw.file === 'string' && raw.file !== '' ? raw.file : id;
        var chars = toCount(raw.chars);
        var offset = toCount(raw.offset);
        var percent = typeof raw.percent === 'number' && isFinite(raw.percent)
          ? Math.round(clampNumber(raw.percent, 0, 100))
          : (chars > 0 ? Math.floor((offset / chars) * 100) : 0);
        return {
          id: id,
          file: file,
          name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : stripExtension(file),
          chars: chars,
          offset: Math.min(offset, chars > 0 ? chars : offset),
          percent: percent,
          finished: typeof raw.finished === 'boolean' ? raw.finished : (chars > 0 && offset >= chars),
          chapters: toCount(raw.chapters),
          chapter: normalizeChapter(raw.chapter),
        };
      }

      function normalizeOverview(value) {
        var source = value && typeof value === 'object' ? value : {};
        var novels = [];
        if (Array.isArray(source.novels)) {
          source.novels.forEach(function (raw) {
            var novel = normalizeNovel(raw);
            if (novel !== null) novels.push(novel);
          });
        }
        return {
          directory: typeof source.directory === 'string' ? source.directory : '',
          defaultDirectory: typeof source.defaultDirectory === 'string' ? source.defaultDirectory : '',
          locked: source.locked === true,
          novels: novels,
        };
      }

      function emptySession() {
        return { active: false, novelId: null, name: '', offset: 0, chars: 0, percent: 0, finished: false };
      }

      function normalizeSession(value) {
        if (!value || typeof value !== 'object') return emptySession();
        var novelId = typeof value.novelId === 'string' && value.novelId !== '' ? value.novelId : null;
        if (value.active !== true || novelId === null) return emptySession();
        var chars = toCount(value.chars);
        var offset = Math.min(toCount(value.offset), chars > 0 ? chars : toCount(value.offset));
        return {
          active: true,
          novelId: novelId,
          name: typeof value.name === 'string' ? value.name : '',
          offset: offset,
          chars: chars,
          percent: typeof value.percent === 'number' && isFinite(value.percent)
            ? Math.round(clampNumber(value.percent, 0, 100))
            : (chars > 0 ? Math.floor((offset / chars) * 100) : 0),
          finished: typeof value.finished === 'boolean' ? value.finished : (chars > 0 && offset >= chars),
          chapters: toCount(value.chapters),
          chapter: normalizeChapter(value.chapter),
        };
      }

      function normalizeError(error, method) {
        var message = error && typeof error.message === 'string'
          ? error.message
          : (typeof error === 'string' ? error : '');
        return new Error(message || ('novel-reader rpc failed: ' + String(method)));
      }

      /** 统一收口：包含同步 throw、bridge 拒绝、{ok:false} 三种失败形态。 */
      function invoke(rpc, method, payload) {
        if (typeof rpc !== 'function') {
          return Promise.reject(new Error('novel-reader: host bridge unavailable'));
        }
        var pending;
        try {
          pending = rpc(method, payload);
        } catch (error) {
          return Promise.reject(normalizeError(error, method));
        }
        return Promise.resolve(pending).then(function (result) {
          if (result && result.ok === true) return result.value;
          if (result && result.ok === false) throw normalizeError(result.error, method);
          return result; // rpc 已包装过，直接是 value
        }, function (error) {
          throw normalizeError(error, method);
        });
      }

      function errorText(error) {
        if (!error) return '';
        if (typeof error === 'string') return error;
        return typeof error.message === 'string' && error.message !== '' ? error.message : String(error);
      }

      function interpolate(template, params) {
        if (typeof template !== 'string' || !params) return template;
        return template.replace(/\{(\w+)\}/g, function (match, name) {
          return hasOwn(params, name) ? String(params[name]) : match;
        });
      }

      function pickFallbackDict() {
        var language = '';
        try {
          language = typeof navigator !== 'undefined' ? String(navigator.language || '') : '';
        } catch (error) {
          language = '';
        }
        return /^zh/i.test(language) ? ZH : EN;
      }

      /** locale 服务缺失时也要有可用的 t；底层若已插值，二次替换不会命中。 */
      function makeTranslate(bound) {
        var dict = pickFallbackDict();
        return function t(key, params) {
          var template;
          if (typeof bound === 'function') {
            try {
              template = params === undefined ? bound(key) : bound(key, params);
            } catch (error) {
              template = undefined;
            }
          }
          if (typeof template !== 'string' || template === '') {
            template = hasOwn(dict, key) ? dict[key] : String(key);
          }
          return interpolate(template, params);
        };
      }

      function resolveConnection(ctx) {
        if (!ctx) return null;
        try {
          if (ctx.connection) return ctx.connection;
        } catch (error) { /* 继续尝试 ctx.get */ }
        try {
          if (typeof ctx.get === 'function') {
            var viaGet = ctx.get('connection');
            if (viaGet) return viaGet;
          }
        } catch (error) { /* 无连接 */ }
        return null;
      }

      /** rpc 在调用时才取 connection：注册阶段连接可能尚未就绪。 */
      function makeRpc(ctx) {
        return function rpc(method, payload, signal) {
          var connection = resolveConnection(ctx);
          var bridge = connection && connection.rpc ? connection.rpc : null;
          if (!bridge || typeof bridge.call !== 'function') {
            return Promise.reject(new Error('novel-reader: host connection unavailable'));
          }
          var pending;
          try {
            pending = bridge.call('/api', RPC_ENDPOINT, { method: method, payload: payload }, signal);
          } catch (error) {
            return Promise.reject(normalizeError(error, method));
          }
          return Promise.resolve(pending).then(function (result) {
            if (result && result.ok === true) return result.value;
            throw normalizeError(result && result.error, method);
          }, function (error) {
            throw normalizeError(error, method);
          });
        };
      }

      function containsNode(node, target) {
        return !!(node && target && typeof node.contains === 'function' && node.contains(target));
      }

      /** 弹层贴住触发按钮右上角向上展开，并夹在视口内。 */
      function menuPlacement(anchor) {
        if (!anchor || typeof window === 'undefined') {
          return { left: 12, bottom: 96, width: 280, maxHeight: 320 };
        }
        var viewportWidth = window.innerWidth || 1024;
        var viewportHeight = window.innerHeight || 768;
        // 目标宽 280px；窄视口时压缩到视口内（最小 200px）。
        var width = Math.round(clampNumber(viewportWidth - 24, 200, 280));
        var left = Math.round(clampNumber(anchor.right - width, 12, Math.max(12, viewportWidth - width - 12)));
        var bottom = Math.round(Math.max(12, viewportHeight - anchor.top + 8));
        var maxHeight = Math.round(clampNumber(anchor.top - 16, 180, 380));
        return { left: left, bottom: bottom, width: width, maxHeight: maxHeight };
      }

      /* ────────────────────────────── 图标 ────────────────────────────── */

      function IconBook() {
        return h('svg', {
          className: 'dnr-trigger-icon',
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
          h('path', { d: 'M2.5 3.5h3.6c.9 0 1.6.7 1.6 1.6v8.1c0-.7-.6-1.2-1.3-1.2H2.5z' }),
          h('path', { d: 'M13.5 3.5H9.9c-.9 0-1.6.7-1.6 1.6v8.1c0-.7.6-1.2 1.3-1.2h3.9z' })
        );
      }

      function IconChevron(props) {
        return h('svg', {
          className: 'dnr-trigger-chevron' + (props && props.open ? ' dnr-trigger-chevron--open' : ''),
          viewBox: '0 0 12 12',
          width: 12,
          height: 12,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        }, h('path', { d: 'M3 7.5 6 4.5l3 3' }));
      }

      /* ────────────────────────────── 样式 ────────────────────────────── */

      var CSS = `
/* ── 触发按钮：对齐 composer 里模型选择器的 ToggleButton 观感 ── */
.dnr-root { position: relative; display: inline-flex; align-items: center; }
.dnr-trigger {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; max-width: 210px; padding: 0 8px;
  box-sizing: border-box;
  border: 1px solid transparent; border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
  font: inherit; font-size: 12px; line-height: 1;
  cursor: pointer; white-space: nowrap;
  transition: background-color .15s ease, color .15s ease;
}
.dnr-trigger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12));
  color: var(--dsw-alias-label-primary, #1f1e1d);
}
.dnr-trigger[aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12));
  color: var(--dsw-alias-label-primary, #1f1e1d);
}
.dnr-trigger:disabled { cursor: default; opacity: .5; }
.dnr-trigger-icon { flex: none; width: 16px; height: 16px; }
.dnr-trigger-label { min-width: 0; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dnr-trigger-chevron { flex: none; width: 12px; height: 12px; opacity: .65; }
.dnr-trigger-chevron--open { transform: rotate(180deg); }

/* ── 弹层：模仿 MenuSurface ── */
.dnr-menu {
  box-sizing: border-box;
  display: flex; flex-direction: column; gap: 2px;
  padding: 4px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .28));
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-2, #ffffff));
  color: var(--dsw-alias-label-primary, #1f1e1d);
  box-shadow: 0 10px 32px rgba(0, 0, 0, .18), 0 2px 8px rgba(0, 0, 0, .08);
  font-size: 13px;
  overflow-x: hidden; overflow-y: auto;
  overscroll-behavior: contain;
}
.dnr-menu:focus { outline: none; }
.dnr-menu--fixed { position: fixed; }
.dnr-menu--anchored { position: absolute; right: 0; bottom: calc(100% + 8px); width: 280px; max-height: 320px; z-index: 60; }
.dnr-menu-title {
  flex: none; padding: 4px 8px 2px;
  font-size: 12px; color: var(--dsw-alias-label-tertiary, #9a9a9a);
}
.dnr-menu-row {
  display: flex; align-items: center; gap: 8px;
  width: 100%; min-height: 32px; padding: 6px 8px;
  box-sizing: border-box;
  border: 0; border-radius: 8px;
  background: transparent; color: inherit;
  font: inherit; font-size: 13px; line-height: 1.3; text-align: left;
  cursor: pointer;
  transition: background-color .12s ease;
}
.dnr-menu-row:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12)); }
.dnr-menu-row:disabled { cursor: default; opacity: .55; }
.dnr-menu-row--selected { color: var(--dsw-alias-label-primary, #1f1e1d); }
.dnr-menu-row--action { color: var(--dsw-alias-brand-primary, #3d63e6); }
.dnr-menu-check { flex: none; width: 14px; font-size: 12px; color: var(--dsw-alias-brand-primary, #3d63e6); }
.dnr-menu-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dnr-menu-meta { flex: none; font-size: 12px; color: var(--dsw-alias-label-tertiary, #9a9a9a); font-variant-numeric: tabular-nums; }
.dnr-menu-divider { flex: none; height: 1px; margin: 2px 6px; background: var(--dsw-alias-border-l1, rgba(127, 127, 127, .22)); }
.dnr-menu-note { flex: none; padding: 8px; font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dnr-menu-error { flex: none; padding: 4px 8px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-primary, #1f1e1d); }
.dnr-menu-hint {
  flex: none; margin-top: 2px; padding: 6px 8px 4px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .22));
  font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, #9a9a9a);
}

/* ── 设置页 ── */
.dnr-settings {
  box-sizing: border-box;
  height: 100%; padding: 24px; overflow: auto;
  display: flex; flex-direction: column; gap: 16px;
  font-size: 13px; color: var(--dsw-alias-label-primary, #1f1e1d);
}
.dnr-settings-head { display: flex; flex-direction: column; gap: 6px; }
.dnr-settings-title { font-size: 14px; font-weight: 600; }
.dnr-settings-desc { margin: 0; font-size: 12px; line-height: 1.65; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dnr-settings-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dnr-settings-folder-label { flex: none; font-size: 12px; color: var(--dsw-alias-label-tertiary, #9a9a9a); }
.dnr-settings-folder-path {
  flex: 1 1 240px; min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .22));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  font-size: 12px; line-height: 1.5; word-break: break-all;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.dnr-input--dir { flex: 1 1 320px; }
.dnr-settings-folder-note {
  font-size: 12px; line-height: 1.65;
  color: var(--dsw-alias-label-tertiary, #9a9a9a);
}
.dnr-settings-folder-note--locked { color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dnr-settings-dir-saved { color: var(--dsw-alias-brand-primary, #3d63e6); }
.dnr-style-card {
  display: flex; flex-direction: column; gap: 10px;
  padding: 14px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .22));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.dnr-style-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dnr-style-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px 12px;
}
.dnr-style-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dnr-style-field--wide { grid-column: 1 / -1; }
.dnr-style-label { font-size: 12px; line-height: 1.4; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dnr-gen-modes { display: flex; flex-wrap: wrap; gap: 8px; }
.dnr-style-flip { display: flex; flex-direction: column; gap: 6px; }
.dnr-gen-mode--active {
  border-color: var(--dsw-alias-brand-primary, #3d63e6);
  color: var(--dsw-alias-brand-primary, #3d63e6);
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12));
}
.dnr-input--style {
  flex: 0 0 auto;
  width: 100%;
  min-width: 0;
  height: 28px;
  box-sizing: border-box;
}
.dnr-settings-list { display: flex; flex-direction: column; gap: 10px; }
.dnr-settings-note { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dnr-settings-error { font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-primary, #1f1e1d); }
.dnr-settings-empty {
  display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
  padding: 16px;
  border: 1px dashed var(--dsw-alias-border-l1, rgba(127, 127, 127, .3));
  border-radius: 10px;
  font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.dnr-novel {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .22));
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.dnr-novel-file { font-size: 12px; line-height: 1.4; word-break: break-all; color: var(--dsw-alias-label-tertiary, #9a9a9a); }
.dnr-novel-main { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dnr-novel-label { flex: none; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dnr-novel-progress {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  font-size: 12px; line-height: 1.5; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.dnr-novel-saved { font-size: 12px; color: var(--dsw-alias-brand-primary, #3d63e6); }
.dnr-input {
  flex: 1 1 200px; min-width: 0; height: 28px;
  box-sizing: border-box; padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .3));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: var(--dsw-alias-label-primary, #1f1e1d);
  font: inherit; font-size: 12px;
}
.dnr-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #3d63e6); }
.dnr-input:disabled { opacity: .6; }
.dnr-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 28px; box-sizing: border-box; padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, .3));
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: var(--dsw-alias-label-primary, #1f1e1d);
  font: inherit; font-size: 12px; line-height: 1; white-space: nowrap;
  cursor: pointer;
  transition: background-color .15s ease;
}
.dnr-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12)); }
.dnr-btn:disabled { cursor: default; opacity: .5; }

.dnr-trigger:focus-visible, .dnr-btn:focus-visible, .dnr-menu-row:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #3d63e6);
  outline-offset: 1px;
}

/* ── 阅读模式：思考里的翻页阅读器 ── */
.dnr-reader { position: relative; display: flex; flex-direction: column; gap: 8px; width: 100%; }
.dnr-reader-box { position: relative; width: 100%; overflow: hidden; border-radius: 10px; }
.dnr-reader-sheet { position: absolute; top: 0; overflow: hidden; }
.dnr-reader-sheet p { margin: 0; }
.dnr-reader-sheet--old { z-index: 1; }
.dnr-reader-sheet--next {
  z-index: 2;
  animation: dnr-flip-next .28s cubic-bezier(.22, .7, .3, 1);
  box-shadow: -14px 0 28px rgba(0, 0, 0, .16);
}
.dnr-reader-sheet--prev {
  z-index: 2;
  animation: dnr-flip-prev .28s cubic-bezier(.22, .7, .3, 1);
  box-shadow: 14px 0 28px rgba(0, 0, 0, .16);
}
.dnr-reader-zone {
  position: absolute; top: 0; bottom: 0; z-index: 3;
  border: 0; margin: 0; padding: 0; background: transparent; cursor: pointer;
}
.dnr-reader-zone--prev { left: 0; width: 28%; cursor: w-resize; }
.dnr-reader-zone--next { right: 0; width: 72%; cursor: e-resize; }
.dnr-reader-zone:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #3d63e6);
  outline-offset: -4px;
}
.dnr-reader-measure { position: absolute; top: 0; left: 0; visibility: hidden; pointer-events: none; z-index: -1; }
.dnr-reader-footer {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-size: 11px; line-height: 1.5; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary, #9a9a9a);
}
.dnr-reader-footer-hint { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
.dnr-reader-nav { flex: 0 0 auto; height: 24px; padding: 0 8px; font-size: 11px; }
.dnr-reader-pageinfo { flex: 1 1 auto; text-align: center; }
.dnr-reader-running { margin-top: 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #9a9a9a); }
@keyframes dnr-flip-next { from { transform: translateX(100%); } to { transform: translateX(0); } }
@keyframes dnr-flip-prev { from { transform: translateX(-100%); } to { transform: translateX(0); } }

@media (prefers-reduced-motion: reduce) {
  .dnr-trigger, .dnr-btn, .dnr-menu-row { transition: none; }
  .dnr-reader-sheet--next, .dnr-reader-sheet--prev { animation: none; }
}
`;

      function StyleTag() {
        // 组件内渲染 <style>，随组件卸载自动移除；重复挂载多条相同规则无副作用。
        return h('style', { dangerouslySetInnerHTML: { __html: CSS } });
      }

      /* ────────────────────────────── 错误边界 ────────────────────────────── */

      // 用类表达式：React.Component 缺失时保持 null，注册处自动跳过包裹。
      var PluginErrorBoundary = typeof React.Component === 'function'
        ? class extends React.Component {
          constructor(props) {
            super(props);
            this.state = { error: null };
          }

          static getDerivedStateFromError(error) {
            return { error: error };
          }

          componentDidCatch(error) {
            try {
              console.warn('[novel-reader] UI error:', error);
            } catch (ignored) { /* 无控制台也不抛 */ }
          }

          render() {
            if (this.state.error === null) return this.props.children;
            var t = this.props.t;
            var label = typeof t === 'function' ? t('popup.failed') : 'novel-reader';
            var detail = errorText(this.state.error);
            return h('div', {
              style: {
                padding: '6px 8px',
                fontSize: '12px',
                lineHeight: 1.5,
                color: 'var(--dsw-alias-label-secondary, #6b6b6b)',
              },
            }, label + '：' + detail);
          }
        }
        : null;

      /** 包一层错误边界：渲染异常时只降级成一行小字，不白屏。 */
      function guard(Component, props, t) {
        if (PluginErrorBoundary === null) return h(Component, props);
        return h(PluginErrorBoundary, { t: t }, h(Component, props));
      }

      /* ────────────────────── 阅读模式「思考」翻页阅读 ────────────────────── */

      function normalizeReadingStyle(value) {
        var source = value && typeof value === 'object' ? value : {};
        var pick = function (name, fallback, min, max) {
          var number = Number(source[name]);
          if (!isFinite(number)) return fallback;
          return Math.min(max, Math.max(min, number));
        };
        return {
          fontSize: pick('fontSize', DEFAULT_READING_STYLE.fontSize, 12, 40),
          lineHeight: pick('lineHeight', DEFAULT_READING_STYLE.lineHeight, 1.2, 3),
          letterSpacing: pick('letterSpacing', DEFAULT_READING_STYLE.letterSpacing, 0, 8),
          paragraphSpacing: pick('paragraphSpacing', DEFAULT_READING_STYLE.paragraphSpacing, 0, 3),
          pageHeight: pick('pageHeight', DEFAULT_READING_STYLE.pageHeight, 240, 1200),
          pagePadding: pick('pagePadding', DEFAULT_READING_STYLE.pagePadding, 0, 64),
          pageMaxWidth: pick('pageMaxWidth', DEFAULT_READING_STYLE.pageMaxWidth, 0, 1400),
          fontFamily: typeof source.fontFamily === 'string' ? source.fontFamily.trim() : '',
          flip: source.flip === 'none' || source.flip === 'fast' || source.flip === 'normal'
            ? source.flip
            : DEFAULT_READING_STYLE.flip,
        };
      }

      function normalizeGeneration(value) {
        var source = value && typeof value === 'object' ? value : {};
        var mode = source.mode === 'instant' || source.mode === 'duration' || source.mode === 'speed'
          ? source.mode
          : DEFAULT_GENERATION.mode;
        var seconds = Number(source.seconds);
        var charsPerSecond = Number(source.charsPerSecond);
        return {
          mode: mode,
          seconds: isFinite(seconds) ? Math.min(60, Math.max(0.5, seconds)) : DEFAULT_GENERATION.seconds,
          charsPerSecond: isFinite(charsPerSecond)
            ? Math.min(5000, Math.max(10, Math.round(charsPerSecond)))
            : DEFAULT_GENERATION.charsPerSecond,
        };
      }

      function fetchReadingStyle(rpc) {
        if (readingStyleCache !== null) return Promise.resolve(readingStyleCache);
        if (readingStylePending !== null) return readingStylePending;
        var pending = invoke(rpc, 'style', {}).then(function (value) {
          readingStyleCache = normalizeReadingStyle(value);
          return readingStyleCache;
        }, function () {
          readingStyleCache = normalizeReadingStyle(null);
          return readingStyleCache;
        });
        readingStylePending = pending;
        return pending.then(function (value) {
          if (readingStylePending === pending) readingStylePending = null;
          return value;
        });
      }

      function invalidateReadingStyle() {
        readingStyleCache = null;
        readingStylePending = null;
        readingStyleListeners.forEach(function (listener) {
          try { listener(); } catch (error) { /* 忽略 */ }
        });
      }

      function subscribeReadingStyle(listener) {
        readingStyleListeners.add(listener);
        return function () { readingStyleListeners.delete(listener); };
      }

      function unescapeReadingMarks(text) {
        return String(text || '').replace(/\\([\\`*_\[\]<>#|+=~.-])/g, '$1');
      }

      /** 把思考正文整理成阅读页的段落数组（去掉隐形标记与 Markdown 转义）。 */
      function readingBlocks(text) {
        var raw = String(text || '').split(READING_MARKER).join('').replace(/\r\n?/g, '\n');
        var clean = function (part) {
          return unescapeReadingMarks(part.replace(/^[ \t\u3000]+/, '').replace(/[ \t\u3000]+$/, ''));
        };
        var blocks = raw.split(/\n{2,}/).map(clean).filter(function (part) { return part.length > 0; });
        if (blocks.length <= 1) {
          blocks = raw.split(/\n+/).map(clean).filter(function (part) { return part.length > 0; });
        }
        return blocks;
      }

      /** 非小说正文的普通思考：交回官方内容工厂，保持原有渲染。 */
      function delegateReasoning(props) {
        if (typeof props.renderFactorySlot === 'function') {
          try {
            return props.renderFactorySlot('conversation.chat.reasoning.content', {
              text: props.text,
              running: props.running,
            });
          } catch (error) { /* 落到纯文本兜底 */ }
        }
        return h('div', { style: { whiteSpace: 'pre-wrap' } }, props.text || '');
      }

      function ReadingReasoningBody(props) {
        var t = typeof props.t === 'function' ? props.t : (typeof readerT === 'function' ? readerT : function (key) { return String(key); });
        var rpc = typeof props.rpc === 'function' ? props.rpc : readerRpc;
        var hasMarker = (typeof props.rawText === 'string' && props.rawText.indexOf(READING_MARKER) !== -1)
          || (typeof props.text === 'string' && props.text.indexOf(READING_MARKER) !== -1);
        var styleState = useState(null);
        var style = styleState[0];
        var setStyle = styleState[1];

        useEffect(function () {
          if (!hasMarker) return undefined;
          var alive = true;
          var load = function () {
            if (typeof rpc !== 'function') return;
            fetchReadingStyle(rpc).then(function (value) {
              if (alive) setStyle(value);
            }, function () { /* 用默认样式 */ });
          };
          load();
          var unsubscribe = subscribeReadingStyle(load);
          return function () {
            alive = false;
            unsubscribe();
          };
        }, [hasMarker]);

        if (!hasMarker) return delegateReasoning(props);
        return h(ReadingPageView, {
          text: props.text,
          running: props.running === true,
          style: style || DEFAULT_READING_STYLE,
          t: t,
          sessionId: props.sessionId,
          rpc: rpc,
        });
      }

      function ReadingPageView(props) {
        var t = typeof props.t === 'function' ? props.t : function (key) { return String(key); };
        var style = props.style || DEFAULT_READING_STYLE;
        var rpc = typeof props.rpc === 'function' ? props.rpc : readerRpc;
        var sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
        var initialDoc = React.useMemo(function () {
          return props.running ? null : [{ text: String(props.text || ''), chapter: null }];
        }, []);
        var docsState = useState(initialDoc);
        var docs = docsState[0];
        var setDocs = docsState[1];
        var chapterState = useState(null);
        var chapterInfo = chapterState[0];
        var setChapterInfo = chapterState[1];
        var loadingState = useState(false);
        var loadingNext = loadingState[0];
        var setLoadingNext = loadingState[1];
        var endedState = useState(false);
        var bookEnded = endedState[0];
        var setBookEnded = endedState[1];
        var errorState = useState('');
        var error = errorState[0];
        var setError = errorState[1];
        var prefetchNonceState = useState(0);
        var prefetchNonce = prefetchNonceState[0];
        var setPrefetchNonce = prefetchNonceState[1];
        var aliveRef = useRef(true);
        var loadingRef = useRef(false);
        var epochRef = useRef(0);
        var prefetchRef = useRef(null);
        var prefetchingRef = useRef(false);
        var prefetchPrepareTimer = useRef(null);
        var commitPendingRef = useRef(null);
        var pendingDocRef = useRef(null);

        var containerRef = useRef(null);
        var measureRef = useRef(null);
        var flipTimer = useRef(null);
        var memoryKeyRef = useRef('');
        var pageIndexRef = useRef(0);

        var pagesState = useState([]);
        var pages = pagesState[0];
        var setPages = pagesState[1];

        var indexState = useState(0);
        var pageIndex = indexState[0];
        var setPageIndex = indexState[1];
        pageIndexRef.current = pageIndex;

        var widthState = useState(0);
        var width = widthState[0];
        var setWidth = widthState[1];

        var flipState = useState(null);
        var flip = flipState[0];
        var setFlip = flipState[1];

        var safetyState = useState(0);
        var safetyExtra = safetyState[0];
        var setSafetyExtra = safetyState[1];
        var availableState = useState(0);
        var availableHeight = availableState[0];
        var setAvailableHeight = availableState[1];
        var effectivePageHeight = style.pageHeight;
        if (availableHeight > 0) {
          // 宿主的思考区域可能有自己的最大高度/滚动容器；页面高度取两者较小值，避免每页都要滚动。
          effectivePageHeight = Math.max(240, Math.min(style.pageHeight, availableHeight - 76));
        }
        var sheetRef = useRef(null);
        var overflowTriesRef = useRef(0);

        var styleKey = [
          style.fontSize, style.lineHeight, style.letterSpacing, style.paragraphSpacing,
          style.pageHeight, style.pagePadding, style.pageMaxWidth, style.fontFamily,
        ].join('|');
        var docCacheBase = styleKey + '|' + width + '|' + effectivePageHeight + '|' + safetyExtra;
        var docBlocks = React.useMemo(function () {
          return (docs || []).map(function (doc) { return readingBlocks(doc.text); });
        }, [docs]);
        var docsKey = React.useMemo(function () {
          if (!docs) return 'none';
          return docs.map(function (doc) { return String(doc.text.length); }).join(',');
        }, [docs]);
        var memoryKey = sessionId + '|' + docsKey;

        useEffect(function () {
          aliveRef.current = true;
          return function () {
            aliveRef.current = false;
            if (flipTimer.current !== null) {
              clearTimeout(flipTimer.current);
              flipTimer.current = null;
            }
            if (prefetchPrepareTimer.current !== null) {
              clearTimeout(prefetchPrepareTimer.current);
              prefetchPrepareTimer.current = null;
            }
          };
        }, []);

        // 首段正文/章节信息同步到 docs；流式结束后再分页。
        useEffect(function () {
          if (props.running) return;
          setDocs(function (previous) {
            var headChapter = previous && previous.length > 0 ? (previous[0].chapter || chapterInfo) : chapterInfo;
            var head = { text: String(props.text || ''), chapter: headChapter || null };
            if (!previous || previous.length === 0) return [head];
            if (previous[0].text === head.text && previous[0].chapter === head.chapter) return previous;
            var next = previous.slice();
            next[0] = head;
            return next;
          });
        }, [props.text, props.running, chapterInfo]);

        useEffect(function () {
          if (!rpc || sessionId === '') return undefined;
          var alive = true;
          invoke(rpc, 'session', { sessionId: sessionId }).then(function (value) {
            if (!alive) return;
            var normalized = normalizeSession(value);
            if (normalized.chapter) setChapterInfo(normalized.chapter);
          }, function () { /* 没有章节信息也能阅读 */ });
          return function () { alive = false; };
        }, []);

        useEffect(function () {
          var node = containerRef.current;
          if (!node) return undefined;
          var update = function () {
            var next = node.clientWidth || 0;
            setWidth(function (previous) { return previous === next ? previous : next; });
          };
          update();
          if (typeof ResizeObserver === 'function') {
            var observer = new ResizeObserver(update);
            observer.observe(node);
            return function () { observer.disconnect(); };
          }
          window.addEventListener('resize', update);
          return function () { window.removeEventListener('resize', update); };
        }, []);

        useEffect(function () {
          var node = containerRef.current;
          if (!node) return undefined;
          var measureAvailability = function () {
            var element = node.parentElement;
            var capped = 0;
            while (element) {
              var computed = window.getComputedStyle(element);
              var maxHeight = computed.maxHeight;
              var limit = maxHeight && maxHeight !== 'none' ? parseFloat(maxHeight) : NaN;
              if (isFinite(limit) && limit > 0) {
                capped = limit;
                break;
              }
              element = element.parentElement;
            }
            var next = capped > 0 ? capped : (window.innerHeight || 800);
            setAvailableHeight(function (previous) { return previous === next ? previous : next; });
          };
          measureAvailability();
          var timer = window.setInterval(measureAvailability, 1500);
          window.addEventListener('resize', measureAvailability);
          return function () {
            window.clearInterval(timer);
            window.removeEventListener('resize', measureAvailability);
          };
        }, []);

        useEffect(function () {
          if (!props.running) return;
          try {
            reportUiDebug(rpc, {
              marker: true,
              stage: 'running',
              textLen: String(props.text || '').length,
              pageHeight: effectivePageHeight,
            });
          } catch (error) { /* 诊断不能影响阅读 */ }
        }, [props.running]);

        var beginFlip = function (target, from) {
          if (target === from || pages.length === 0) return;
          if (flipTimer.current !== null) {
            clearTimeout(flipTimer.current);
            flipTimer.current = null;
          }
          var duration = readingFlipMs(style);
          if (duration <= 0) {
            setFlip(null);
            setPageIndex(target);
            return;
          }
          setFlip({ from: from, dir: target > from ? 1 : -1, ms: duration });
          setPageIndex(target);
          readingFlipSeq += 1;
          flipTimer.current = setTimeout(function () {
            flipTimer.current = null;
            setFlip(null);
          }, duration + 60);
        };

        var paginateDocument = function (docText, blocks) {
          var measure = measureRef.current;
          if (!measure || width <= 0) return null;
          var sheetWidth = style.pageMaxWidth > 0 ? Math.min(width, style.pageMaxWidth) : width;
          var contentWidth = Math.max(80, sheetWidth - style.pagePadding * 2);
          var capacity = Math.max(40, effectivePageHeight - style.pagePadding * 2 - Math.max(4, Math.round(style.fontSize * 0.6)) - safetyExtra);
          measure.style.width = contentWidth + 'px';
          var gap = Math.round(style.paragraphSpacing * style.fontSize);
          var heightOf = function (value) {
            measure.textContent = value;
            return measure.offsetHeight;
          };
          var fitCut = function (value) {
            var low = 1;
            var high = value.length;
            var best = 0;
            while (low <= high) {
              var mid = (low + high) >> 1;
              if (heightOf(value.slice(0, mid)) <= capacity) {
                best = mid;
                low = mid + 1;
              } else {
                high = mid - 1;
              }
            }
            if (best <= 0) return 0;
            var floor = Math.max(1, Math.floor(best * 0.72));
            var sentence = '。！？；…';
            for (var i = best; i > floor; i -= 1) {
              if (sentence.indexOf(value.charAt(i - 1)) !== -1) return i;
            }
            var clause = '，、,;：';
            for (var j = best; j > floor; j -= 1) {
              if (clause.indexOf(value.charAt(j - 1)) !== -1) return j;
            }
            return best;
          };
          var cacheKey = docCacheBase + '|' + readingTextStamp(docText);
          var cachedPages = readingPageCache.get(cacheKey);
          if (Array.isArray(cachedPages)) return cachedPages;
          var pageList = [];
          var current = [];
          var used = 0;
          for (var index = 0; index < blocks.length; index += 1) {
            var remaining = blocks[index];
            while (remaining.length > 0) {
              var height = heightOf(remaining) + (current.length > 0 ? gap : 0);
              if (used + height <= capacity) {
                current.push(remaining);
                used += height;
                remaining = '';
                continue;
              }
              if (current.length > 0) {
                pageList.push(current);
                current = [];
                used = 0;
                continue;
              }
              var cut = fitCut(remaining);
              if (cut <= 0) cut = Math.max(1, Math.min(remaining.length, Math.floor(remaining.length / 2)));
              current.push(remaining.slice(0, cut));
              pageList.push(current);
              current = [];
              used = 0;
              remaining = remaining.slice(cut).replace(/^\s+/, '');
            }
          }
          if (current.length > 0) pageList.push(current);
          if (pageList.length === 0) pageList.push(['']);
          readingPageCache.set(cacheKey, pageList);
          if (readingPageCache.size > 80) {
            var oldestKey = readingPageCache.keys().next();
            if (!oldestKey.done) readingPageCache.delete(oldestKey.value);
          }
          return pageList;
        };

        React.useLayoutEffect(function () {
          if (props.running || docBlocks.length === 0 || width <= 0) {
            if (props.running) setPages([]);
            return;
          }
          var flat = [];
          for (var docIndex = 0; docIndex < docBlocks.length; docIndex += 1) {
            var blocks = docBlocks[docIndex];
            if (!blocks || blocks.length === 0) blocks = [''];
            var docText = docs && docs[docIndex] ? docs[docIndex].text : '';
            var pageList = paginateDocument(docText, blocks);
            if (!pageList) return;
            for (var pageInDoc = 0; pageInDoc < pageList.length; pageInDoc += 1) {
              flat.push({
                doc: docIndex,
                blocks: pageList[pageInDoc],
                index: pageInDoc,
                total: pageList.length,
              });
            }
          }
          setPages(flat);
          var pendingDoc = pendingDocRef.current;
          pendingDocRef.current = null;
          if (pendingDoc !== null) {
            var targetIndex = -1;
            for (var flatIndex = 0; flatIndex < flat.length; flatIndex += 1) {
              if (flat[flatIndex].doc === pendingDoc) { targetIndex = flatIndex; break; }
            }
            if (targetIndex >= 0) {
              beginFlip(targetIndex, pageIndexRef.current);
              try {
                reportUiDebug(rpc, { marker: true, stage: 'next-chapter', targetIndex, pages: flat.length });
              } catch (error) { /* 诊断不能影响阅读 */ }
            }
          } else {
            var remembered = readingPageMemory.get(memoryKey);
            var sameDocument = memoryKeyRef.current === memoryKey;
            memoryKeyRef.current = memoryKey;
            setPageIndex(function (previous) {
              var next;
              if (sameDocument) next = remembered === undefined ? previous : remembered;
              else next = remembered === undefined ? 0 : remembered;
              return Math.max(0, Math.min(next, flat.length - 1));
            });
          }
          var reportSheetWidth = style.pageMaxWidth > 0 ? Math.min(width, style.pageMaxWidth) : width;
          var reportCapacity = Math.max(40, effectivePageHeight - style.pagePadding * 2 - Math.max(4, Math.round(style.fontSize * 0.6)) - safetyExtra);
          var reportContentWidth = Math.max(80, reportSheetWidth - style.pagePadding * 2);
          try {
          reportUiDebug(rpc, {
            marker: true,
            stage: 'pages',
            sessionId: sessionId,
            viewportHeight: typeof window !== 'undefined' ? window.innerHeight : 0,
            readerHeight: containerRef.current ? containerRef.current.offsetHeight : 0,
            sheetClient: sheetRef.current ? sheetRef.current.clientHeight : 0,
            sheetScroll: sheetRef.current ? sheetRef.current.scrollHeight : 0,
            pages: flat.length,
            docs: docBlocks.length,
            pageHeight: effectivePageHeight,
            configuredPageHeight: style.pageHeight,
            availableHeight,
            padding: style.pagePadding,
            capacity: reportCapacity,
            width,
            contentWidth: reportContentWidth,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            safetyExtra,
            ancestors: (function () {
              var list = [];
              var element = containerRef.current;
              for (var level = 0; level < 10 && element; level += 1) {
                var computed = window.getComputedStyle(element);
                list.push({
                  ch: element.clientHeight,
                  sh: element.scrollHeight,
                  oy: computed.overflowY,
                  mh: computed.maxHeight,
                });
                element = element.parentElement;
              }
              return list;
            })(),
          });
          } catch (error) { /* 诊断不能影响阅读 */ }
        }, [docsKey, styleKey, width, props.running, memoryKey, safetyExtra, availableHeight, effectivePageHeight]);

        // 兜底：真实渲染出来的页面如果仍然溢出（字体/缩放差异），自动加大安全余量重排。
        useEffect(function () {
          if (props.running) return;
          var node = sheetRef.current;
          if (!node || pages.length === 0) return;
          if (node.scrollHeight > node.clientHeight + 1 && overflowTriesRef.current < 10) {
            overflowTriesRef.current += 1;
            setSafetyExtra(function (previous) {
              return previous + Math.ceil(style.fontSize * style.lineHeight);
            });
          }
        }, [pages, pageIndex, props.running, style.fontSize, style.lineHeight]);

        useEffect(function () {
          overflowTriesRef.current = 0;
          setSafetyExtra(0);
        }, [memoryKey, styleKey]);

        useEffect(function () {
          if (props.running || pages.length === 0) return;
          readingPageMemory.set(memoryKey, pageIndex);
          if (readingPageMemory.size > 200) {
            var first = readingPageMemory.keys().next();
            if (!first.done) readingPageMemory.delete(first.value);
          }
        }, [pageIndex, memoryKey, pages.length, props.running]);

        var goTo = function (next) {
          beginFlip(Math.max(0, Math.min(next, pages.length - 1)), pageIndex);
        };

        var appendChapter = function (value) {
          var currentCount = docs ? docs.length : 0;
          pendingDocRef.current = currentCount;
          setDocs(function (previous) {
            var base = previous || [];
            return base.concat([{ text: value.text, chapter: value.chapter || null }]);
          });
          if (value.finished === true) setBookEnded(true);
        };

        var loadNextChapter = function () {
          if (loadingRef.current || bookEnded || !rpc || sessionId === '') return;
          if (commitPendingRef.current !== null) {
            loadingRef.current = true;
            setLoadingNext(true);
            var pendingCommit = commitPendingRef.current;
            pendingCommit.then(function () {
              loadingRef.current = false;
              setLoadingNext(false);
              if (aliveRef.current) loadNextChapter();
            });
            return;
          }
          var cached = prefetchRef.current;
          prefetchRef.current = null;
          if (cached) {
            if (cached.finished) {
              setBookEnded(true);
              return;
            }
            epochRef.current += 1;
            // peek 只取正文、没有推进进度；这里补一次正式推进，但不阻塞翻页。
            var pendingCommit = invoke(rpc, 'nextChapter', { sessionId: sessionId }).catch(function () {
              /* 进度落盘失败不影响本地阅读 */
            }).then(function () {
              if (commitPendingRef.current === pendingCommit) commitPendingRef.current = null;
              if (aliveRef.current) setPrefetchNonce(function (previous) { return previous + 1; });
            });
            commitPendingRef.current = pendingCommit;
            appendChapter(cached.value);
            return;
          }
          loadingRef.current = true;
          setLoadingNext(true);
          setError('');
          var epoch = epochRef.current + 1;
          epochRef.current = epoch;
          invoke(rpc, 'nextChapter', { sessionId: sessionId }).then(function (value) {
            if (!aliveRef.current || epoch !== epochRef.current) return;
            loadingRef.current = false;
            setLoadingNext(false);
            if (!value || value.finished === true || typeof value.text !== 'string' || value.text === '') {
              setBookEnded(true);
              return;
            }
            appendChapter(value);
          }, function (failure) {
            if (!aliveRef.current || epoch !== epochRef.current) return;
            loadingRef.current = false;
            setLoadingNext(false);
            setError(errorText(failure));
          });
        };

        var schedulePrefetchPagination = function (text) {
          if (prefetchPrepareTimer.current !== null) clearTimeout(prefetchPrepareTimer.current);
          var run = function () {
            prefetchPrepareTimer.current = null;
            if (!aliveRef.current) return;
            try {
              paginateDocument(text, readingBlocks(text));
            } catch (error) { /* 预排失败时点击后还会再排一次 */ }
          };
          if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
            prefetchPrepareTimer.current = window.setTimeout(function () {
              if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
                window.requestIdleCallback(run, { timeout: 1500 });
              } else {
                run();
              }
            }, 80);
          } else {
            prefetchPrepareTimer.current = window.setTimeout(run, 120);
          }
        };

        // 有正文页后立刻在后台预取下一章（只取正文不推进进度），并把新章分页也预先排好。
        useEffect(function () {
          if (props.running || pages.length === 0) return;
          if (bookEnded || loadingRef.current || prefetchingRef.current || prefetchRef.current !== null) return;
          if (commitPendingRef.current !== null) return;
          if (!rpc || sessionId === '') return;
          var epoch = epochRef.current;
          prefetchingRef.current = true;
          invoke(rpc, 'nextChapter', { sessionId: sessionId, peek: true }).then(function (value) {
            prefetchingRef.current = false;
            if (!aliveRef.current || epoch !== epochRef.current) return;
            if (!value || value.finished === true || typeof value.text !== 'string' || value.text === '') {
              prefetchRef.current = { finished: true };
              return;
            }
            prefetchRef.current = { value: value };
            schedulePrefetchPagination(value.text);
          }, function () {
            prefetchingRef.current = false;
          });
        }, [pages.length, props.running, bookEnded, sessionId, rpc, prefetchNonce]);

        var gapPx = Math.round(style.paragraphSpacing * style.fontSize);
        var typography = {
          fontSize: style.fontSize + 'px',
          lineHeight: style.lineHeight,
          letterSpacing: style.letterSpacing + 'px',
          fontFamily: style.fontFamily || undefined,
          color: 'var(--dsw-alias-label-primary, #1f1e1d)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowWrap: 'anywhere',
        };
        var sheetWidth = style.pageMaxWidth > 0 && width > 0 ? Math.min(width, style.pageMaxWidth) : width;
        var sheetLeft = width > 0 ? Math.max(0, Math.round((width - sheetWidth) / 2)) : 0;
        var sheetStyle = {
          position: 'absolute',
          top: 0,
          left: sheetLeft + 'px',
          width: sheetWidth > 0 ? sheetWidth + 'px' : '100%',
          height: effectivePageHeight + 'px',
          boxSizing: 'border-box',
          padding: style.pagePadding + 'px',
          overflow: 'hidden',
          background: 'var(--dsw-alias-bg-base, #ffffff)',
          animationDuration: readingFlipMs(style) + 'ms',
        };
        var renderSheet = function (page, className, isCurrent) {
          var list = page && page.blocks ? page.blocks : [];
          var content = list.map(function (block, index) {
            return h('p', {
              key: index,
              style: { margin: index === list.length - 1 ? 0 : '0 0 ' + gapPx + 'px' },
            }, block);
          });
          return h('div', {
            ref: isCurrent ? sheetRef : undefined,
            className: 'dnr-reader-sheet ' + className,
            style: sheetStyle,
          }, h('div', { style: typography }, content));
        };

        var currentPage = pages[pageIndex] || null;
        var currentChapter = null;
        if (currentPage && docs && docs[currentPage.doc] && docs[currentPage.doc].chapter) {
          currentChapter = docs[currentPage.doc].chapter;
        } else if (currentPage && currentPage.doc === 0) {
          currentChapter = chapterInfo;
        }
        var pageText = currentPage ? t('reading.page', { index: currentPage.index + 1, total: currentPage.total }) : '';
        var chapterText = currentChapter ? t('chapter.label', currentChapter) : '';
        var footerInfo = chapterText !== '' ? chapterText + ' · ' + pageText : pageText;
        var atLastPage = pages.length > 0 && pageIndex >= pages.length - 1;
        var nextDisabled = pages.length === 0 || loadingNext || (atLastPage && bookEnded);
        var nextLabel = atLastPage
          ? (bookEnded ? t('reading.bookEnd') : (loadingNext ? t('reading.loadingNext') : t('reading.nextChapter')))
          : t('reading.next');
        var runningText = unescapeReadingMarks(String(props.text || '').split(READING_MARKER).join('').trim());
        var runningStyle = {
          position: 'relative',
          width: '100%',
          height: effectivePageHeight + 'px',
          boxSizing: 'border-box',
          padding: style.pagePadding + 'px',
          overflow: 'hidden',
          background: 'var(--dsw-alias-bg-base, #ffffff)',
        };
        var hintText;
        if (props.running) hintText = t('reading.generating');
        else if (error !== '') hintText = t('settings.error') + '：' + error;
        else if (loadingNext) hintText = t('reading.loadingNext');
        else if (atLastPage && bookEnded) hintText = t('reading.endBookHint');
        else if (atLastPage) hintText = t('reading.nextChapterHint');
        else hintText = t('reading.zoneHint');

        return h('div', { className: 'dnr-reader', ref: containerRef },
          StyleTag(),
          props.running
            ? h('div', { className: 'dnr-reader-sheet', style: runningStyle },
              h('div', { style: typography }, runningText),
              h('div', { className: 'dnr-reader-running' }, t('reading.generating')))
            : h('div', { className: 'dnr-reader-box', style: { position: 'relative', height: effectivePageHeight + 'px', width: '100%' } },
              flip !== null && pages[flip.from] ? renderSheet(pages[flip.from], 'dnr-reader-sheet--old', false) : null,
              renderSheet(currentPage, flip === null ? '' : (flip.dir > 0 ? 'dnr-reader-sheet--next' : 'dnr-reader-sheet--prev'), true),
              h('button', {
                type: 'button',
                className: 'dnr-reader-zone dnr-reader-zone--prev',
                'aria-label': t('reading.prev'),
                onClick: function () { goTo(pageIndex - 1); },
              }),
              h('button', {
                type: 'button',
                className: 'dnr-reader-zone dnr-reader-zone--next',
                'aria-label': atLastPage ? t('reading.nextChapter') : t('reading.next'),
                onClick: function () { if (atLastPage) loadNextChapter(); else goTo(pageIndex + 1); },
              })
            ),
          h('div', { className: 'dnr-reader-measure', ref: measureRef, style: typography }),
          h('div', { className: 'dnr-reader-footer' },
            h('button', {
              type: 'button',
              className: 'dnr-btn dnr-reader-nav',
              disabled: pages.length === 0 || pageIndex <= 0,
              onClick: function () { goTo(pageIndex - 1); },
            }, '‹ ' + t('reading.prev')),
            h('span', { className: 'dnr-reader-pageinfo' }, footerInfo),
            h('button', {
              type: 'button',
              className: 'dnr-btn dnr-reader-nav',
              disabled: nextDisabled,
              onClick: function () { if (atLastPage) loadNextChapter(); else goTo(pageIndex + 1); },
            }, nextLabel + (atLastPage && bookEnded ? '' : ' ›'))),
          h('div', { className: 'dnr-reader-footer-hint' }, hintText)
        );
      }

      /* ────────────────────────────── 触发按钮 + 弹层 ────────────────────────────── */

      function NovelTrigger(props) {
        var t = typeof props.t === 'function' ? props.t : function (key) { return String(key); };
        var sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
        var rpcRef = useRef(props.rpc);
        rpcRef.current = props.rpc;

        var sessionState = useState(null);
        var session = sessionState[0];
        var setSession = sessionState[1];

        var openState = useState(false);
        var open = openState[0];
        var setOpen = openState[1];

        var anchorState = useState(null);
        var anchor = anchorState[0];
        var setAnchor = anchorState[1];

        var overviewState = useState(null);
        var overview = overviewState[0];
        var setOverview = overviewState[1];

        var listLoadingState = useState(false);
        var listLoading = listLoadingState[0];
        var setListLoading = listLoadingState[1];

        var errorState = useState('');
        var error = errorState[0];
        var setError = errorState[1];

        var busyState = useState(null);
        var busy = busyState[0];
        var setBusy = busyState[1];

        var rootRef = useRef(null);
        var panelRef = useRef(null);
        var aliveRef = useRef(true);
        var sessionIdRef = useRef(sessionId);
        sessionIdRef.current = sessionId;

        var canPortal = typeof createPortal === 'function'
          && typeof document !== 'undefined'
          && document !== null
          && document.body !== null
          && document.body !== undefined;

        var fetchSession = useCallback(function () {
          var id = sessionIdRef.current;
          if (id === '') return Promise.resolve();
          return invoke(rpcRef.current, 'session', { sessionId: id }).then(function (value) {
            // 会话已切走或组件已卸载时丢弃这次结果，避免旧会话状态覆盖新会话。
            if (!aliveRef.current || sessionIdRef.current !== id) return;
            setSession(normalizeSession(value));
          }, function () {
            // 轮询失败（Host 未就绪 / 连接断开）保持原状态，不打扰用户。
          });
        }, []);

        // 挂载即拉一次，之后每 2s 轮询；页面不可见时跳过，卸载清定时器。
        useEffect(function () {
          aliveRef.current = true;
          if (sessionIdRef.current === '') {
            setSession(emptySession());
            return function () {
              aliveRef.current = false;
            };
          }
          void fetchSession();
          var timer = setInterval(function () {
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
            void fetchSession();
          }, POLL_MS);
          return function () {
            aliveRef.current = false;
            clearInterval(timer);
          };
        }, [sessionId, fetchSession]);

        // 打开时拉小说列表（每次打开都刷新，避免吃到旧目录）。
        useEffect(function () {
          if (!open) return undefined;
          var cancelled = false;
          setListLoading(true);
          setError('');
          invoke(rpcRef.current, 'overview', {}).then(function (value) {
            if (cancelled) return;
            setOverview(normalizeOverview(value));
          }, function (failure) {
            if (cancelled) return;
            setError(errorText(failure));
          }).then(function () {
            if (cancelled) return;
            setListLoading(false);
          });
          void fetchSession();
          return function () {
            cancelled = true;
          };
        }, [open, fetchSession]);

        // 打开时把焦点移入面板，方便 Esc / 键盘操作。
        useEffect(function () {
          if (!open) return;
          var node = panelRef.current;
          if (node && typeof node.focus === 'function') {
            try { node.focus({ preventScroll: true }); } catch (ignored) { /* 老浏览器忽略参数 */ }
          }
        }, [open]);

        // 点击外部 / Escape 关闭。
        useEffect(function () {
          if (!open) return undefined;
          var onPointerDown = function (event) {
            var target = event.target;
            if (containsNode(rootRef.current, target) || containsNode(panelRef.current, target)) return;
            setOpen(false);
          };
          var onKeyDown = function (event) {
            if (event.key === 'Escape') setOpen(false);
          };
          document.addEventListener('mousedown', onPointerDown, true);
          document.addEventListener('keydown', onKeyDown, true);
          return function () {
            document.removeEventListener('mousedown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
          };
        }, [open]);

        // portal 形态下跟随窗口尺寸/滚动重新贴住按钮。
        useEffect(function () {
          if (!open || !canPortal) return undefined;
          var place = function () {
            var node = rootRef.current;
            if (!node || typeof node.getBoundingClientRect !== 'function') return;
            var rect = node.getBoundingClientRect();
            setAnchor(function (previous) {
              if (previous && Math.abs(previous.right - rect.right) < 0.5 && Math.abs(previous.top - rect.top) < 0.5) {
                return previous;
              }
              return { right: rect.right, top: rect.top };
            });
          };
          place();
          window.addEventListener('resize', place);
          window.addEventListener('scroll', place, true);
          return function () {
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
          };
        }, [open, canPortal]);

        var readable = sessionId !== '';

        var toggle = function () {
          if (!readable) return;
          if (open) {
            setOpen(false);
            return;
          }
          var node = rootRef.current;
          var rect = node && typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
          setAnchor(rect ? { right: rect.right, top: rect.top } : null);
          setOpen(true);
        };

        var choose = function (novelId) {
          var id = sessionIdRef.current;
          if (id === '') {
            setError(t('settings.noSession'));
            return;
          }
          if (busy !== null) return;
          setBusy(novelId === null ? '__off__' : String(novelId));
          setError('');
          invoke(rpcRef.current, 'select', { sessionId: id, novelId: novelId }).then(function (value) {
            if (!aliveRef.current) return;
            setSession(normalizeSession(value));
            setOpen(false);
          }, function (failure) {
            if (!aliveRef.current) return;
            setError(errorText(failure));
          }).then(function () {
            if (!aliveRef.current) return;
            setBusy(null);
          });
        };

        var seed = function () {
          if (busy !== null) return;
          setBusy('__seed__');
          setError('');
          invoke(rpcRef.current, 'seedDemo', {}).then(function (value) {
            if (!aliveRef.current) return;
            setOverview(normalizeOverview(value));
          }, function (failure) {
            if (!aliveRef.current) return;
            setError(errorText(failure));
          }).then(function () {
            if (!aliveRef.current) return;
            setBusy(null);
          });
        };

        var active = session !== null && session.active === true;
        var label = t('trigger.idle');
        if (active) {
          var shownName = session.name !== '' ? session.name : t('trigger.idle');
          var chapterLabel = session.chapter
            ? t('chapter.label', session.chapter)
            : String(session.percent) + '%';
          label = shownName + ' · ' + chapterLabel;
        }
        var disabled = !readable;

        var trigger = h('button', {
          type: 'button',
          className: 'dnr-trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': active ? label : t('trigger.idle'),
          title: disabled ? t('settings.noSession') : (active ? label : t('trigger.idle')),
          'data-active': active ? 'true' : 'false',
          disabled: disabled,
          onClick: toggle,
        },
          h(IconBook, null),
          h('span', { className: 'dnr-trigger-label' }, label),
          h(IconChevron, { open: open })
        );

        var menuChildren = buildMenuChildren({
          t: t,
          session: session,
          overview: overview,
          listLoading: listLoading,
          error: error,
          busy: busy,
          onChoose: choose,
          onSeed: seed,
        });

        var placement = menuPlacement(anchor);
        var menuStyle = canPortal
          ? {
            position: 'fixed',
            left: placement.left + 'px',
            bottom: placement.bottom + 'px',
            width: placement.width + 'px',
            maxHeight: placement.maxHeight + 'px',
            zIndex: Z_INDEX,
          }
          : undefined;

        var menuNode = h('div', {
          ref: panelRef,
          className: 'dnr-menu ' + (canPortal ? 'dnr-menu--fixed' : 'dnr-menu--anchored'),
          style: menuStyle,
          role: 'group',
          'aria-label': t('popup.title'),
          'aria-busy': listLoading || busy !== null ? 'true' : 'false',
          tabIndex: -1,
        }, menuChildren);

        var menuInDom = null;
        if (open) {
          menuInDom = canPortal ? createPortal(menuNode, document.body) : menuNode;
        }

        return h('div', { className: 'dnr-root', ref: rootRef },
          StyleTag(),
          trigger,
          menuInDom
        );
      }

      /** 弹层内容（纯展示，无 hooks）。 */
      function buildMenuChildren(context) {
        var t = context.t;
        var session = context.session;
        var overview = context.overview;
        var listLoading = context.listLoading;
        var error = context.error;
        var busy = context.busy;
        var children = [];
        var hasChapterJump = false;

        children.push(h('div', { key: 'title', className: 'dnr-menu-title' }, t('popup.title')));

        if (typeof error === 'string' && error !== '') {
          children.push(h('div', {
            key: 'error',
            className: 'dnr-menu-error',
            role: 'alert',
          }, t('popup.failed') + '：' + error));
        }

        if (listLoading && overview === null) {
          children.push(h('div', { key: 'loading', className: 'dnr-menu-note' }, t('popup.loading')));
        } else {
          var novels = overview !== null ? overview.novels : [];
          if (novels.length === 0) {
            children.push(h('div', { key: 'empty', className: 'dnr-menu-note' }, t('popup.empty')));
            children.push(h('button', {
              key: 'seed',
              type: 'button',
              className: 'dnr-menu-row dnr-menu-row--action',
              disabled: busy !== null,
              onClick: context.onSeed,
            }, h('span', { className: 'dnr-menu-name' }, busy === '__seed__' ? t('popup.loading') : t('popup.seed'))));
          } else {
            var current = session !== null && session.active === true ? session.novelId : null;
            novels.forEach(function (novel) {
              var selected = current === novel.id;
              if (novel.chapter !== null && !novel.finished) hasChapterJump = true;
              var meta = novel.finished
                ? t('popup.finished')
                : (novel.chapter !== null ? t('chapter.label', novel.chapter) : String(novel.percent) + '%');
              children.push(h('button', {
                key: novel.id,
                type: 'button',
                className: 'dnr-menu-row' + (selected ? ' dnr-menu-row--selected' : ''),
                'aria-pressed': selected,
                disabled: busy !== null,
                title: novel.file,
                onClick: function () { context.onChoose(novel.id); },
              },
                h('span', { className: 'dnr-menu-check', 'aria-hidden': 'true' }, selected ? '✓' : ''),
                h('span', { className: 'dnr-menu-name' }, novel.name),
                h('span', { className: 'dnr-menu-meta' }, busy === novel.id ? t('popup.loading') : meta)
              ));
            });

            children.push(h('div', { key: 'divider', className: 'dnr-menu-divider' }));

            var offSelected = !(session !== null && session.active === true);
            children.push(h('button', {
              key: 'off',
              type: 'button',
              className: 'dnr-menu-row' + (offSelected ? ' dnr-menu-row--selected' : ''),
              'aria-pressed': offSelected,
              disabled: busy !== null,
              onClick: function () { context.onChoose(null); },
            },
              h('span', { className: 'dnr-menu-check', 'aria-hidden': 'true' }, offSelected ? '✓' : ''),
              h('span', { className: 'dnr-menu-name' }, t('popup.off')),
              busy === '__off__' ? h('span', { className: 'dnr-menu-meta' }, t('popup.loading')) : null
            ));
          }
        }

        children.push(h('div', { key: 'hint', className: 'dnr-menu-hint' }, t('popup.hint')));
        if (hasChapterJump) {
          children.push(h('div', { key: 'jump-hint', className: 'dnr-menu-hint' }, t('popup.jumpHint')));
        }
        return children;
      }

      /* ────────────────────────────── 设置页 ────────────────────────────── */

      function NovelSettings(props) {
        var t = typeof props.t === 'function' ? props.t : function (key) { return String(key); };
        var rpcRef = useRef(props.rpc);
        rpcRef.current = props.rpc;

        var overviewState = useState(null);
        var overview = overviewState[0];
        var setOverview = overviewState[1];

        var statusState = useState('loading');
        var status = statusState[0];
        var setStatus = statusState[1];

        var errorState = useState('');
        var error = errorState[0];
        var setError = errorState[1];

        var busyState = useState('');
        var busy = busyState[0];
        var setBusy = busyState[1];

        var draftsState = useState({});
        var drafts = draftsState[0];
        var setDrafts = draftsState[1];

        var savedState = useState(null);
        var savedId = savedState[0];
        var setSavedId = savedState[1];

        var dirDraftState = useState('');
        var dirDraft = dirDraftState[0];
        var setDirDraft = dirDraftState[1];

        var dirNoticedState = useState(false);
        var dirNoticed = dirNoticedState[0];
        var setDirNoticed = dirNoticedState[1];

        var styleDraftState = useState(null);
        var styleDraft = styleDraftState[0];
        var setStyleDraft = styleDraftState[1];

        var styleDefaultsState = useState(null);
        var styleDefaults = styleDefaultsState[0];
        var setStyleDefaults = styleDefaultsState[1];

        var styleBusyState = useState(false);
        var styleBusy = styleBusyState[0];
        var setStyleBusy = styleBusyState[1];

        var styleNoticedState = useState(false);
        var styleNoticed = styleNoticedState[0];
        var setStyleNoticed = styleNoticedState[1];

        var genDraftState = useState(null);
        var genDraft = genDraftState[0];
        var setGenDraft = genDraftState[1];

        var genDefaultsState = useState(null);
        var genDefaults = genDefaultsState[0];
        var setGenDefaults = genDefaultsState[1];

        var genBusyState = useState(false);
        var genBusy = genBusyState[0];
        var setGenBusy = genBusyState[1];

        var genNoticedState = useState(false);
        var genNoticed = genNoticedState[0];
        var setGenNoticed = genNoticedState[1];

        var aliveRef = useRef(true);
        var requestSeq = useRef(0);
        var savedTimer = useRef(null);
        var dirTimer = useRef(null);
        var styleTimer = useRef(null);
        var genTimer = useRef(null);

        useEffect(function () {
          aliveRef.current = true;
          return function () {
            aliveRef.current = false;
            if (savedTimer.current !== null) {
              clearTimeout(savedTimer.current);
              savedTimer.current = null;
            }
            if (dirTimer.current !== null) {
              clearTimeout(dirTimer.current);
              dirTimer.current = null;
            }
            if (styleTimer.current !== null) {
              clearTimeout(styleTimer.current);
              styleTimer.current = null;
            }
            if (genTimer.current !== null) {
              clearTimeout(genTimer.current);
              genTimer.current = null;
            }
          };
        }, []);

        useEffect(function () {
          invoke(rpcRef.current, 'style', {}).then(function (value) {
            if (!aliveRef.current) return;
            var normalized = normalizeReadingStyle(value);
            setStyleDraft(normalized);
            setStyleDefaults(value && value.defaults ? normalizeReadingStyle(value.defaults) : normalizeReadingStyle(null));
          }, function () {
            if (aliveRef.current) setStyleDraft(normalizeReadingStyle(null));
          });
          invoke(rpcRef.current, 'generation', {}).then(function (value) {
            if (!aliveRef.current) return;
            setGenDraft(normalizeGeneration(value));
            setGenDefaults(value && value.defaults ? normalizeGeneration(value.defaults) : normalizeGeneration(null));
          }, function () {
            if (aliveRef.current) setGenDraft(normalizeGeneration(null));
          });
        }, []);

        // method 区分：进页面用 'overview'，按钮“刷新列表”用 'refresh'（重新扫描目录）。
        var loadOverview = useCallback(function (method, busyKey) {
          var seq = ++requestSeq.current;
          setBusy(busyKey || '');
          setError('');
          invoke(rpcRef.current, method === 'refresh' ? 'refresh' : 'overview', {}).then(function (value) {
            if (!aliveRef.current || seq !== requestSeq.current) return;
            var next = normalizeOverview(value);
            setOverview(next);
            setStatus('ready');
            setDirDraft(next.directory);
            setDrafts(function (previous) {
              var merged = {};
              next.novels.forEach(function (novel) {
                merged[novel.id] = hasOwn(previous, novel.id) ? previous[novel.id] : novel.name;
              });
              return merged;
            });
          }, function (failure) {
            if (!aliveRef.current || seq !== requestSeq.current) return;
            setStatus(function (previous) { return previous === 'ready' ? 'ready' : 'error'; });
            setError(errorText(failure));
          }).then(function () {
            if (!aliveRef.current || seq !== requestSeq.current) return;
            setBusy('');
          });
        }, []);

        useEffect(function () {
          void loadOverview('overview', '');
        }, [loadOverview]);

        var flashSaved = function (novelId) {
          setSavedId(novelId);
          if (savedTimer.current !== null) clearTimeout(savedTimer.current);
          savedTimer.current = setTimeout(function () {
            savedTimer.current = null;
            if (aliveRef.current) setSavedId(null);
          }, SAVED_FLASH_MS);
        };

        var applyOverview = function (value, replacedId) {
          var next = normalizeOverview(value);
          setOverview(next);
          setStatus('ready');
          setDirDraft(next.directory);
          setError(''); // 成功动作清掉上一轮的错误提示
          setDrafts(function (previous) {
            var merged = {};
            next.novels.forEach(function (novel) {
              if (replacedId !== undefined && novel.id === replacedId) merged[novel.id] = novel.name;
              else merged[novel.id] = hasOwn(previous, novel.id) ? previous[novel.id] : novel.name;
            });
            return merged;
          });
        };

        var editStyleField = function (name, raw) {
          setStyleDraft(function (previous) {
            var next = Object.assign({}, previous || DEFAULT_READING_STYLE);
            next[name] = raw;
            return next;
          });
          setStyleNoticed(false);
        };

        var stylePayloadFromDraft = function (draft) {
          var source = draft || {};
          var payload = {};
          ['fontSize', 'lineHeight', 'letterSpacing', 'paragraphSpacing', 'pageHeight', 'pagePadding', 'pageMaxWidth'].forEach(function (name) {
            var number = Number(source[name]);
            if (isFinite(number)) payload[name] = number;
          });
          payload.fontFamily = typeof source.fontFamily === 'string' ? source.fontFamily : '';
          if (source.flip === 'none' || source.flip === 'fast' || source.flip === 'normal') payload.flip = source.flip;
          return payload;
        };

        var saveReadingStyle = function (payload) {
          if (styleBusy) return;
          setStyleBusy(true);
          setError('');
          setStyleNoticed(false);
          invoke(rpcRef.current, 'setStyle', { style: payload }).then(function (value) {
            if (!aliveRef.current) return;
            setStyleDraft(normalizeReadingStyle(value));
            setStyleDefaults(value && value.defaults ? normalizeReadingStyle(value.defaults) : normalizeReadingStyle(null));
            invalidateReadingStyle();
            setStyleNoticed(true);
            if (styleTimer.current !== null) clearTimeout(styleTimer.current);
            styleTimer.current = setTimeout(function () {
              styleTimer.current = null;
              if (aliveRef.current) setStyleNoticed(false);
            }, SAVED_FLASH_MS);
          }, function (failure) {
            if (!aliveRef.current) return;
            setError(errorText(failure));
          }).then(function () {
            if (!aliveRef.current) return;
            setStyleBusy(false);
          });
        };

        var styleFields = [
          ['fontSize', 'number', '1'],
          ['lineHeight', 'number', '0.05'],
          ['letterSpacing', 'number', '0.5'],
          ['paragraphSpacing', 'number', '0.1'],
          ['pageHeight', 'number', '10'],
          ['pagePadding', 'number', '1'],
          ['pageMaxWidth', 'number', '10'],
        ];
        var styleFieldNodes = styleFields.map(function (entry) {
          var key = entry[0];
          var value = styleDraft ? styleDraft[key] : '';
          return h('label', { key: key, className: 'dnr-style-field' },
            h('span', { className: 'dnr-style-label' }, t('settings.style.' + key)),
            h('input', {
              className: 'dnr-input dnr-input--style',
              type: entry[1],
              step: entry[2],
              value: value === undefined || value === null ? '' : String(value),
              onChange: function (event) { editStyleField(key, event.target.value); },
            }));
        });
        styleFieldNodes.push(h('label', { key: 'fontFamily', className: 'dnr-style-field dnr-style-field--wide' },
          h('span', { className: 'dnr-style-label' }, t('settings.style.fontFamily')),
          h('input', {
            className: 'dnr-input dnr-input--style',
            type: 'text',
            value: styleDraft && typeof styleDraft.fontFamily === 'string' ? styleDraft.fontFamily : '',
            onChange: function (event) { editStyleField('fontFamily', event.target.value); },
          })));
        var flipModeNodes = [
          ['none', 'settings.style.flipNone'],
          ['fast', 'settings.style.flipFast'],
          ['normal', 'settings.style.flipNormal'],
        ].map(function (entry) {
          var active = styleDraft !== null && styleDraft.flip === entry[0];
          return h('button', {
            key: entry[0],
            type: 'button',
            className: 'dnr-btn dnr-gen-mode' + (active ? ' dnr-gen-mode--active' : ''),
            'aria-pressed': active,
            disabled: styleBusy,
            onClick: function () { editStyleField('flip', entry[0]); },
          }, t(entry[1]));
        });
        var styleCard = h('div', { className: 'dnr-style-card' },
          h('div', { className: 'dnr-style-head' },
            h('div', { className: 'dnr-settings-title' }, t('settings.style.title')),
            styleNoticed ? h('span', { className: 'dnr-novel-saved' }, t('settings.style.saved')) : null),
          h('p', { className: 'dnr-settings-folder-note' }, t('settings.style.hint')),
          h('div', { className: 'dnr-style-grid' }, styleFieldNodes),
          h('div', { className: 'dnr-style-flip' },
            h('span', { className: 'dnr-style-label' }, t('settings.style.flip')),
            h('div', { className: 'dnr-gen-modes' }, flipModeNodes)),
          h('div', { className: 'dnr-settings-toolbar' },
            h('button', {
              type: 'button',
              className: 'dnr-btn',
              disabled: styleBusy,
              onClick: function () { saveReadingStyle(stylePayloadFromDraft(styleDraft)); },
            }, styleBusy ? t('settings.saving') : t('settings.style.save')),
            h('button', {
              type: 'button',
              className: 'dnr-btn',
              disabled: styleBusy,
              onClick: function () {
                saveReadingStyle(stylePayloadFromDraft(styleDefaults || normalizeReadingStyle(null)));
              },
            }, t('settings.style.reset'))));

        var saveName = function (novel) {
          if (busy !== '') return;
          var raw = hasOwn(drafts, novel.id) ? drafts[novel.id] : novel.name;
          setBusy('rename:' + novel.id);
          setError('');
          invoke(rpcRef.current, 'rename', {
            novelId: novel.id,
            name: typeof raw === 'string' ? raw : String(raw === undefined ? '' : raw),
          }).then(function (value) {
            if (!aliveRef.current) return;
            applyOverview(value, novel.id);
            flashSaved(novel.id);
          }, function (failure) {
            if (!aliveRef.current) return;
            setError(errorText(failure));
          }).then(function () {
            if (!aliveRef.current) return;
            setBusy('');
          });
        };

        var resetNovel = function (novel) {
          if (busy !== '') return;
          setBusy('reset:' + novel.id);
          setError('');
          invoke(rpcRef.current, 'reset', { novelId: novel.id }).then(function (value) {
            if (!aliveRef.current) return;
            applyOverview(value);
          }, function (failure) {
            if (!aliveRef.current) return;
            setError(errorText(failure));
          }).then(function () {
            if (!aliveRef.current) return;
            setBusy('');
          });
        };

        var seed = function () {
          if (busy !== '') return;
          setBusy('seed');
          setError('');
          invoke(rpcRef.current, 'seedDemo', {}).then(function (value) {
            if (!aliveRef.current) return;
            applyOverview(value);
          }, function (failure) {
            if (!aliveRef.current) return;
            setError(errorText(failure));
          }).then(function () {
            if (!aliveRef.current) return;
            setBusy('');
          });
        };

        var flashDirectory = function () {
          setDirNoticed(true);
          if (dirTimer.current !== null) clearTimeout(dirTimer.current);
          dirTimer.current = setTimeout(function () {
            dirTimer.current = null;
            if (aliveRef.current) setDirNoticed(false);
          }, SAVED_FLASH_MS);
        };

        /** 切换小说目录；value 为空表示恢复默认目录。 */
        var changeDirectory = function (value) {
          if (busy !== '' || overview === null || overview.locked) return;
          setBusy('directory');
          setError('');
          setDirNoticed(false);
          invoke(rpcRef.current, 'setDirectory', { directory: value }).then(function (result) {
            if (!aliveRef.current) return;
            applyOverview(result);
            setDirDraft(result && typeof result.directory === 'string' ? result.directory : '');
            flashDirectory();
          }, function (failure) {
            if (!aliveRef.current) return;
            setError(errorText(failure));
          }).then(function () {
            if (!aliveRef.current) return;
            setBusy('');
          });
        };

        var browseDirectory = function () {
          if (busy !== '' || overview === null || overview.locked) return;
          if (typeof props.pickDirectory !== 'function') return;
          var pending;
          try {
            pending = props.pickDirectory();
          } catch (error) {
            pending = Promise.resolve(null);
          }
          Promise.resolve(pending).then(function (picked) {
            if (!aliveRef.current || typeof picked !== 'string' || picked === '') return;
            setDirDraft(picked);
          });
        };

        var editName = function (novelId, value) {
          setDrafts(function (previous) {
            var next = {};
            Object.keys(previous).forEach(function (key) { next[key] = previous[key]; });
            next[novelId] = value;
            return next;
          });
          if (savedId === novelId) setSavedId(null);
        };

        var saveGeneration = function (payload) {
          if (genBusy) return;
          setGenBusy(true);
          setError('');
          setGenNoticed(false);
          invoke(rpcRef.current, 'setGeneration', { generation: payload }).then(function (value) {
            if (!aliveRef.current) return;
            setGenDraft(normalizeGeneration(value));
            setGenDefaults(value && value.defaults ? normalizeGeneration(value.defaults) : normalizeGeneration(null));
            setGenNoticed(true);
            if (genTimer.current !== null) clearTimeout(genTimer.current);
            genTimer.current = setTimeout(function () {
              genTimer.current = null;
              if (aliveRef.current) setGenNoticed(false);
            }, SAVED_FLASH_MS);
          }, function (failure) {
            if (!aliveRef.current) return;
            setError(errorText(failure));
          }).then(function () {
            if (!aliveRef.current) return;
            setGenBusy(false);
          });
        };

        var editGeneration = function (name, raw) {
          setGenDraft(function (previous) {
            var next = Object.assign({}, previous || DEFAULT_GENERATION);
            next[name] = raw;
            return next;
          });
          setGenNoticed(false);
        };

        var generationPayloadFromDraft = function (draft) {
          var source = draft || DEFAULT_GENERATION;
          return {
            mode: source.mode,
            seconds: Number(source.seconds),
            charsPerSecond: Number(source.charsPerSecond),
          };
        };

        var generationModeNodes = [
          ['instant', 'settings.generation.instant'],
          ['duration', 'settings.generation.duration'],
          ['speed', 'settings.generation.speed'],
        ].map(function (entry) {
          var active = genDraft !== null && genDraft.mode === entry[0];
          return h('button', {
            key: entry[0],
            type: 'button',
            className: 'dnr-btn dnr-gen-mode' + (active ? ' dnr-gen-mode--active' : ''),
            'aria-pressed': active,
            disabled: genBusy,
            onClick: function () {
              var next = Object.assign({}, genDraft || DEFAULT_GENERATION);
              next.mode = entry[0];
              setGenDraft(next);
              setGenNoticed(false);
              // 点选即生效：不再依赖用户再按一次「保存速度」。
              saveGeneration(generationPayloadFromDraft(next));
            },
          }, t(entry[1]));
        });

        var generationValueNode = null;
        if (genDraft !== null && genDraft.mode === 'duration') {
          generationValueNode = h('label', { className: 'dnr-style-field' },
            h('span', { className: 'dnr-style-label' }, t('settings.generation.seconds')),
            h('input', {
              className: 'dnr-input dnr-input--style',
              type: 'number',
              step: '0.5',
              value: genDraft.seconds === undefined ? '' : String(genDraft.seconds),
              onChange: function (event) { editGeneration('seconds', event.target.value); },
              onBlur: function () { saveGeneration(generationPayloadFromDraft(genDraft)); },
            }));
        } else if (genDraft !== null && genDraft.mode === 'speed') {
          generationValueNode = h('label', { className: 'dnr-style-field' },
            h('span', { className: 'dnr-style-label' }, t('settings.generation.cps')),
            h('input', {
              className: 'dnr-input dnr-input--style',
              type: 'number',
              step: '10',
              value: genDraft.charsPerSecond === undefined ? '' : String(genDraft.charsPerSecond),
              onChange: function (event) { editGeneration('charsPerSecond', event.target.value); },
              onBlur: function () { saveGeneration(generationPayloadFromDraft(genDraft)); },
            }));
        }

        var generationCard = h('div', { className: 'dnr-style-card' },
          h('div', { className: 'dnr-style-head' },
            h('div', { className: 'dnr-settings-title' }, t('settings.generation.title')),
            genNoticed ? h('span', { className: 'dnr-novel-saved' }, t('settings.generation.saved')) : null),
          h('p', { className: 'dnr-settings-folder-note' }, t('settings.generation.hint')),
          h('div', { className: 'dnr-gen-modes' }, generationModeNodes),
          generationValueNode,
          h('div', { className: 'dnr-settings-toolbar' },
            h('button', {
              type: 'button',
              className: 'dnr-btn',
              disabled: genBusy,
              onClick: function () { saveGeneration(generationPayloadFromDraft(genDraft)); },
            }, genBusy ? t('settings.saving') : t('settings.generation.save')),
            h('button', {
              type: 'button',
              className: 'dnr-btn',
              disabled: genBusy,
              onClick: function () { saveGeneration(generationPayloadFromDraft(genDefaults || normalizeGeneration(null))); },
            }, t('settings.generation.reset'))));

        var rowNodes = [];
        if (overview !== null) {
          overview.novels.forEach(function (novel) {
            var draft = hasOwn(drafts, novel.id) ? drafts[novel.id] : novel.name;
            var renaming = busy === 'rename:' + novel.id;
            var resetting = busy === 'reset:' + novel.id;
            var inputId = 'dnr-name-' + novel.id;
            rowNodes.push(h('div', { key: novel.id, className: 'dnr-novel' },
              h('div', { className: 'dnr-novel-file', title: novel.file }, t('settings.filename') + ' · ' + novel.file),
              h('div', { className: 'dnr-novel-main' },
                h('label', { className: 'dnr-novel-label', htmlFor: inputId }, t('settings.displayName')),
                h('input', {
                  id: inputId,
                  className: 'dnr-input',
                  type: 'text',
                  value: typeof draft === 'string' ? draft : '',
                  maxLength: 80,
                  placeholder: novel.name,
                  disabled: busy !== '',
                  onChange: function (event) { editName(novel.id, event.target.value); },
                  onKeyDown: function (event) {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      saveName(novel);
                    }
                  },
                }),
                h('button', {
                  type: 'button',
                  className: 'dnr-btn',
                  disabled: busy !== '',
                  onClick: function () { saveName(novel); },
                }, renaming ? t('settings.saving') : t('settings.save')),
                savedId === novel.id ? h('span', { className: 'dnr-novel-saved' }, t('settings.saved')) : null
              ),
              h('div', { className: 'dnr-novel-progress' },
                h('span', null, (novel.chapter !== null ? t('chapter.label', novel.chapter) + ' · ' : '') + t('settings.progress', {
                  percent: novel.percent,
                  offset: novel.offset,
                  chars: novel.chars,
                })),
                h('button', {
                  type: 'button',
                  className: 'dnr-btn',
                  disabled: busy !== '',
                  onClick: function () { resetNovel(novel); },
                }, resetting ? t('popup.loading') : t('settings.reset'))
              )
            ));
          });
        }

        var listNode = null;
        if (overview !== null && overview.novels.length === 0) {
          listNode = h('div', { className: 'dnr-settings-empty' },
            h('div', null, t('settings.empty')),
            h('button', {
              type: 'button',
              className: 'dnr-btn',
              disabled: busy !== '',
              onClick: seed,
            }, busy === 'seed' ? t('popup.loading') : t('settings.seed'))
          );
        } else if (rowNodes.length > 0) {
          listNode = h('div', { className: 'dnr-settings-list' }, rowNodes);
        }

        return h('div', { className: 'dnr-settings' },
          StyleTag(),
          h('div', { className: 'dnr-settings-head' },
            h('div', { className: 'dnr-settings-title' }, t('settings.title')),
            h('p', { className: 'dnr-settings-desc' }, t('settings.desc'))
          ),
          h('div', { className: 'dnr-settings-toolbar dnr-settings-toolbar--dir' },
            h('span', { className: 'dnr-settings-folder-label' }, t('settings.folder')),
            h('input', {
              className: 'dnr-input dnr-input--dir',
              value: dirDraft,
              spellCheck: false,
              disabled: overview !== null && overview.locked,
              placeholder: overview !== null ? overview.defaultDirectory : '',
              'aria-label': t('settings.folder'),
              onChange: function (event) { setDirDraft(event.target.value); },
              onKeyDown: function (event) {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  changeDirectory(dirDraft);
                }
              },
            }),
            overview !== null && overview.locked
              ? null
              : h('button', {
                type: 'button',
                className: 'dnr-btn',
                disabled: busy !== '',
                onClick: browseDirectory,
              }, t('settings.dirPick')),
            overview !== null && overview.locked
              ? null
              : h('button', {
                type: 'button',
                className: 'dnr-btn',
                disabled: busy !== '',
                onClick: function () { changeDirectory(dirDraft); },
              }, busy === 'directory' ? t('popup.loading') : t('settings.dirApply')),
            overview !== null && overview.locked
              ? null
              : h('button', {
                type: 'button',
                className: 'dnr-btn',
                disabled: busy !== '',
                onClick: function () { changeDirectory(''); },
              }, t('settings.dirReset')),
            h('button', {
              type: 'button',
              className: 'dnr-btn',
              disabled: busy !== '',
              onClick: function () { void loadOverview('refresh', 'refresh'); },
            }, busy === 'refresh' ? t('popup.loading') : t('settings.refresh'))
          ),
          h('div', {
            className: 'dnr-settings-folder-note' + (overview !== null && overview.locked ? ' dnr-settings-folder-note--locked' : ''),
          }, overview !== null && overview.locked
            ? t('settings.dirLocked')
            : t('settings.dirDefault', { path: overview !== null ? overview.defaultDirectory : '' }) + ' · ' + t('settings.dirHint')),
          dirNoticed
            ? h('div', { className: 'dnr-settings-note dnr-settings-dir-saved', role: 'status' }, t('settings.dirSaved'))
            : null,
          styleCard,
          generationCard,
          status === 'loading' && overview === null
            ? h('div', { className: 'dnr-settings-note' }, t('popup.loading'))
            : null,
          error !== ''
            ? h('div', { className: 'dnr-settings-error', role: 'alert' }, t('settings.error') + '：' + error)
            : null,
          listNode
        );
      }

      /* ────────────────────────────── 挂载 ────────────────────────────── */

      /** 原生目录选择（可用时）；没有就返回 null，由用户手动输入路径。 */
      function makeDirectoryPicker(ctx) {
        return function pickDirectory() {
          try {
            var workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null;
            if (workspace && typeof workspace.pickDirectory === 'function') {
              return Promise.resolve(workspace.pickDirectory()).catch(function () { return null; });
            }
          } catch (error) { /* 降级为手动输入 */ }
          return Promise.resolve(null);
        };
      }

      function apply(ctx) {
        var bound = null;
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            var registerDicts = function () {
              return ctx.locale.register(NS, { zh: ZH, en: EN });
            };
            if (typeof ctx.effect === 'function') {
              ctx.effect(registerDicts, 'novel-reader: dictionaries');
            } else {
              registerDicts();
            }
            if (typeof ctx.locale.bind === 'function') bound = ctx.locale.bind(NS);
          }
        } catch (failure) {
          // 字典注册失败不阻断功能：makeTranslate 内置中英文兜底。
          try { console.warn('[novel-reader] locale register failed:', failure); } catch (ignored) { /* 忽略 */ }
          bound = null;
        }

        var t = makeTranslate(bound);
        var rpc = makeRpc(ctx);
        var pickDirectory = makeDirectoryPicker(ctx);
        readerRpc = rpc;
        readerT = t;

        // 「思考」正文：始终以更小优先级覆盖官方渲染器；只有带隐形标记的阅读正文才分页，
        // 其它情况（真实模型思考）原样交回官方内容工厂，行为不变。
        try {
          ctx.slots.inject('conversation.chat.reasoning.body', function () {
            return ctx.slots.register({
              name: 'conversation.chat.reasoning.body',
              priority: 50,
              locale: NS,
            }, function (slotProps) {
              return guard(ReadingReasoningBody, slotProps, t);
            });
          });
        } catch (failure) {
          try { console.warn('[novel-reader] reasoning body registration failed:', failure); } catch (ignored) { /* 忽略 */ }
        }

        try {
          ctx.slots.inject('conversation.input.right', function () {
            return ctx.slots.register({
              name: 'conversation.input.right',
              id: 'novel-reader-trigger',
              order: 900,
              locale: NS,
              inject: function (sessionId) {
                return {
                  sessionId: sessionId,
                  t: t,
                  rpc: rpc,
                };
              },
            }, function (slotProps) {
              return guard(NovelTrigger, slotProps, t);
            });
          });
        } catch (failure) {
          try { console.warn('[novel-reader] trigger slot registration failed:', failure); } catch (ignored) { /* 忽略 */ }
        }

        try {
          ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'novel-reader',
              order: 55,
              label: function () { return t('nav'); },
              locale: NS,
              inject: function () {
                return { t: t, rpc: rpc, pickDirectory: pickDirectory };
              },
            }, function (slotProps) {
              return guard(NovelSettings, slotProps, t);
            });
          });
        } catch (failure) {
          try { console.warn('[novel-reader] settings slot registration failed:', failure); } catch (ignored) { /* 忽略 */ }
        }
      }

      return { inject: ['slots', 'locale', 'connection'], apply: apply };
    },
  });
})();
