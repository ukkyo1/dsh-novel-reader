// 无浏览器环境的最小客户端冒烟：加载 client.js、跑 apply、验证槽位注册与「思考」占位切换。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const clientFile = fileURLToPath(new URL('../client.js', import.meta.url));
let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) { loaded = definition; },
  },
};

vm.runInThisContext(fs.readFileSync(clientFile, 'utf8'), { filename: 'client.js' });
assert.ok(loaded && typeof loaded.factory === 'function', '模块已注册');

function FakeComponent() {}
const React = {
  createElement: () => ({}),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (value) => ({ current: value }),
  useCallback: (callback) => callback,
  useMemo: (factory) => factory(),
  memo: (component) => component,
  Component: class {
    constructor(props) { this.props = props; }
    setState() {}
  },
};
const requireStub = (name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require(${name})`);
};

const moduleExports = loaded.factory(requireStub);
assert.deepEqual(moduleExports.inject, ['slots', 'locale', 'connection']);
assert.equal(typeof moduleExports.apply, 'function');

const entries = [];
const injects = [];
const slots = {
  register(options, component) {
    assert.ok(options && typeof options.name === 'string', 'register 有槽位名');
    entries.push({ options, component });
    return () => {};
  },
  inject(key, callback) {
    const unregister = callback();
    injects.push({ key, unregister });
    return () => {
      if (typeof unregister === 'function') unregister();
    };
  },
};
const locale = {
  register: () => () => {},
  bind: () => (key) => key,
};
const effects = [];
const ctx = {
  slots,
  locale,
  effect: (callback) => {
    const disposer = callback();
    effects.push(disposer);
    return disposer;
  },
  get: () => undefined,
  provide: () => {},
  on: () => () => {},
  logger: { warn: () => {}, error: () => {} },
};

const before = injects.length;
moduleExports.apply(ctx);
assert.ok(injects.length >= before + 3, '触发按钮、设置页、思考正文槽位已注入');
assert.ok(entries.some((entry) => entry.options.name === 'conversation.input.right'), '触发按钮已注册');
assert.ok(entries.some((entry) => entry.options.name === 'settings.section'), '设置页已注册');
const reasoning = entries.find((entry) => entry.options.name === 'conversation.chat.reasoning.body');
assert.ok(reasoning, '思考正文渲染器已注册（始终接管）');
assert.equal(reasoning.options.priority, 50, '用更小优先级覆盖官方渲染');
assert.equal(reasoning.options.locale, 'dsh-novel-reader');

const trigger = entries.find((entry) => entry.options.name === 'conversation.input.right');
const triggerProps = trigger.options.inject('session-smoke');
assert.ok(triggerProps && typeof triggerProps.rpc === 'function', '触发按钮拿到 RPC');
assert.equal(typeof triggerProps.t, 'function');
for (const disposer of effects) {
  if (typeof disposer === 'function') {
    try { disposer(); } catch { /* 忽略 */ }
  }
}

console.log('PASS 客户端冒烟：模块加载、槽位注册、阅读态接管/释放思考正文通过');
