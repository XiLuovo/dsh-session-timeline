// 本地模拟验证：模拟浏览器的 __ModuleLoader__，加载 client.js bundle，
// 确认 factory 注册成功、exports.apply 可调用、ctx.get 路径正确。
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

// 最小 document mock（apply 里注入滚动条样式用）
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  head: { appendChild: () => {} },
};

let registered = null;
const win = { __ModuleLoader__: { load: (handoff) => { registered = handoff; } } };
const fn = new Function('window', source);
fn(win);

if (!registered) {
  console.error('FAIL: bundle did not register via __ModuleLoader__.load');
  process.exit(1);
}
if (registered.id !== 'dsh-session-timeline') {
  console.error('FAIL: bundle id mismatch:', registered.id);
  process.exit(1);
}

// 模拟 require：只有 react 需要真实提供；其他模块若被请求则报错（我们不应依赖）
const reactMock = {
  createElement: (type) => ({ type }),
  useState: () => [],
  useEffect: () => {},
  useMemo: () => [],
  useRef: () => ({ current: null }),
  useCallback: (f) => f,
};
const madeRequire = (spec) => {
  if (spec === 'react') return reactMock;
  throw new Error('unexpected require: ' + spec);
};

const mod = registered.factory(madeRequire);
if (typeof mod.apply !== 'function') {
  console.error('FAIL: factory did not export apply');
  process.exit(1);
}

// 调用 apply，用假 ctx：slots/sessions 均存在
const registrations = [];
const fakeSlots = {
  inject: (key, cb) => { registrations.push({ key, cb }); return () => {}; },
  register: (options, component) => { return () => {}; },
};
const fakeCtx = {
  get: (name) => {
    if (name === 'slots') return fakeSlots;
    if (name === 'sessions') return { binding: () => undefined };
    return undefined;
  },
};
mod.apply(fakeCtx);
if (registrations.length !== 1 || registrations[0].key !== 'shell.overlay') {
  console.error('FAIL: apply did not register shell.overlay:', registrations);
  process.exit(1);
}
// 渲染注册的组件，确认不抛错
const comp = registrations[0].cb();
const props = { useSessions: () => undefined };
try {
  comp(props);
} catch (error) {
  console.error('FAIL: component render threw:', error.message);
  process.exit(1);
}
console.log('OK: bundle id, factory, apply, shell.overlay registration, and component render all pass');
