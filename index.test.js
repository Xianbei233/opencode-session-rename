import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, messageText, OLLAMA_URL, OLLAMA_MODEL, setup } from './index.js';
import { RenameRPC } from './rename-rpc.js';

test('RPC contract has a named state snapshot and live state event', () => {
  assert.equal(RenameRPC.id, 'local-session-rename');
  assert.deepEqual(Object.keys(RenameRPC.methods), ['getState']);
  assert.deepEqual(Object.keys(RenameRPC.events), ['state']);
});

test('RPC state is keyed by the same public execution event id and reaches a terminal title', async () => {
  let release;
  const h = harness({ fetchImpl: async () => new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ response: '最新语义标题' }) }); }) });
  h.emit();
  await tick();
  assert.deepEqual(await h.state('root', 'execution-1'), { sessionID: 'root', executionID: 'execution-1', status: 'pending', title: '' });
  assert.equal((await h.state('root', 'unrelated-execution')).status, 'unknown');
  release();
  await tick(); await tick();
  assert.deepEqual(await h.state('root', 'execution-1'), { sessionID: 'root', executionID: 'execution-1', status: 'renamed', title: '最新语义标题' });
  await h.close(h.cleanup);
});

test('cleans wrappers and newlines without truncating titles', () => {
  assert.equal(cleanTitle('标题： “修复登录\n流程”'), '修复登录 流程');
  assert.equal(cleanTitle('中'.repeat(25)), '中'.repeat(25));
  assert.equal(cleanTitle('x'.repeat(25)), 'x'.repeat(25));
  assert.equal(cleanTitle('🙂'.repeat(25)), '🙂'.repeat(25));
  assert.equal(cleanTitle('短标题'), '短标题');
  assert.equal(cleanTitle('x'.repeat(100)).length, 100);
  assert.equal(cleanTitle('```js\nignored\n```Title'), 'Title');
});

test('accepts a title at 30 Unicode codepoints without hard truncation', async () => {
  const accepted = '题'.repeat(30);
  let calls = 0;
  const h = harness({ fetchImpl: async (_url, options) => {
    calls++;
    assert.match(JSON.parse(options.body).prompt, /最多30个Unicode字符/);
    return { ok: true, json: async () => ({ response: accepted }) };
  } });
  h.emit(); await tick();
  assert.equal(calls, 1); assert.deepEqual(h.renamed, [accepted]);
  await h.close(h.cleanup);
});

test('context retains initial user topic and latest progress within a small budget', () => {
  const context = messageText([
    { type: 'user', text: '为插件增加会话标题语义压缩功能' },
    { type: 'assistant', content: [{ type: 'text', text: '已经修改很多中间实现细节。'.repeat(100) }] },
    { type: 'user', text: '目前正在验证两轮重写和失败时保留原标题。' },
  ]);
  assert.match(context, /增加会话标题语义压缩功能/);
  assert.match(context, /验证两轮重写和失败时保留原标题/);
  assert.ok(Array.from(context).length <= 1600);
});

function harness({ messages = [{ type: 'user', id: 'u1', text: '你好' }], parentID, fetchImpl, timeoutMs, subscriptionFailures = 0 } = {}) {
  const events = [];
  let wake;
  let closed = false;
  const renamed = [];
  let status;
  let rpcHandlers;
  const rpcListeners = new Set();
  let eventID = 0;
  const ctx = {
    rpc: { register: async (_definition, handlers) => { rpcHandlers = handlers; return { handlers, events: { emit: async (_name, state) => { for (const listener of rpcListeners) listener({ data: state }); } }, dispose: async () => {} }; } },
    event: { subscribe: async function* ({ signal }) {
      if (subscriptionFailures > 0) { subscriptionFailures--; throw new Error('transient subscription failure'); }
      while (!signal.aborted && !closed) {
        if (!events.length) await new Promise((resolve) => { wake = resolve; });
        if (signal.aborted || closed) return;
        yield events.shift();
      }
    } },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, parentID: parentID ?? (sessionID === 'child' ? 'root' : undefined) }),
      context: async () => messages,
      update: async ({ title }) => renamed.push(title),
    },
  };
  const emit = (type = 'session.execution.succeeded', sessionID = 'root') => { events.push({ id: `execution-${++eventID}`, type, data: type === 'session.status' ? { sessionID, status: { type: status ?? 'idle' } } : { sessionID } }); wake?.(); };
  const close = async (cleanup) => { closed = true; wake?.(); await (await cleanup)(); };
  return { renamed, emit, close, setMessages: (value) => { messages = value; }, setStatus: (value) => { status = value; }, state: (sessionID, executionID) => rpcHandlers.getState({ sessionID, executionID }), cleanup: setup(ctx, { fetchImpl: fetchImpl ?? (async (url, options) => ({ ok: true, json: async () => ({ response: '标题：本地标题' }), url, options })), timeoutMs }) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('V2 execution completion triggers only root nonempty conversation; ignores unrelated events', async () => {
  assert.equal(messageText([{ type: 'user', text: 'hi' }, { type: 'assistant', content: [{ type: 'text', text: 'hello' }] }]), 'hi\nhello');
  const h = harness();
  h.emit('session.renamed'); h.emit('session.execution.succeeded', 'child'); await tick();
  h.emit(); await tick();
  assert.deepEqual(h.renamed, ['本地标题']);
  await h.close(h.cleanup);
  const empty = harness({ messages: [] }); empty.emit(); await tick();
  assert.deepEqual(empty.renamed, []); await empty.close(empty.cleanup);
  const child = harness({ parentID: 'root' }); child.emit(); await tick();
  assert.deepEqual(child.renamed, []); await child.close(child.cleanup);
});

test('V2 failures do not title; successful execution and legacy idle both do', async () => {
  const h = harness();
  h.emit('session.execution.started'); await tick();
  h.emit('session.execution.failed'); await tick();
  assert.deepEqual(h.renamed, []);
  h.emit('session.execution.started'); await tick();
  h.emit('session.execution.succeeded'); await tick();
  assert.deepEqual(h.renamed, ['本地标题']);
  await h.close(h.cleanup);

  const legacy = harness(); legacy.emit('session.idle'); await tick();
  assert.deepEqual(legacy.renamed, ['本地标题']); await legacy.close(legacy.cleanup);
});

test('deduplicates concurrent and completed executions; uses loopback Ollama only', async () => {
  let calls = 0;
  let release;
  const h = harness({ fetchImpl: async (url, options) => {
    calls++; assert.equal(url, OLLAMA_URL); assert.match(url, /^http:\/\/127\.0\.0\.1:/);
    const body = JSON.parse(options.body);
    assert.equal(body.model, OLLAMA_MODEL); assert.equal(body.stream, false); assert.equal(body.keep_alive, 0);
    await new Promise((resolve) => { release = resolve; });
    return { ok: true, json: async () => ({ response: '本地标题' }) };
  } });
  h.emit(); await tick(); h.emit(); await tick();
  assert.equal(calls, 1); release(); await tick(); h.emit(); await tick();
  assert.equal(calls, 1); assert.deepEqual(h.renamed, ['本地标题']); await h.close(h.cleanup);
});

test('accepts a short title and semantically retries one overlong candidate', async () => {
  let calls = 0;
  const h = harness({ fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    calls++;
    assert.equal(body.options.num_ctx, 2048); assert.equal(body.keep_alive, 0);
    if (calls === 1) return { ok: true, json: async () => ({ response: '题'.repeat(31) }) };
    assert.match(body.prompt, new RegExp(`候选：${'题'.repeat(31)}`));
    assert.match(body.prompt, /最多30个Unicode字符/);
    return { ok: true, json: async () => ({ response: '插件标题语义压缩验证' }) };
  } });
  h.emit(); await tick();
  assert.equal(calls, 2); assert.deepEqual(h.renamed, ['插件标题语义压缩验证']);
  await h.close(h.cleanup);
});

test('two invalid title responses skip update, and second response is not applied after content changes', async () => {
  let calls = 0;
  const h = harness({ fetchImpl: async () => ({ ok: true, json: async () => ({ response: (++calls === 1 ? '超'.repeat(31) : '仍'.repeat(31)) }) }) });
  h.emit(); await tick();
  assert.equal(calls, 2); assert.deepEqual(h.renamed, []);
  await h.close(h.cleanup);

  let release;
  calls = 0;
  const changing = harness({ fetchImpl: async () => {
    calls++;
    if (calls === 1) return { ok: true, json: async () => ({ response: '超'.repeat(31) }) };
    await new Promise((resolve) => { release = resolve; });
    return { ok: true, json: async () => ({ response: '有效标题' }) };
  } });
  changing.emit(); await tick(); await tick();
  changing.setMessages([{ type: 'user', text: '更新后的会话内容' }]); release(); await tick();
  assert.deepEqual(changing.renamed, []); await changing.close(changing.cleanup);
});

test('skips stale content and busy sessions', async () => {
  let release;
  const h = harness({ fetchImpl: async () => { await new Promise((resolve) => { release = resolve; }); return { ok: true, json: async () => ({ response: '过时标题' }) }; } });
  h.emit(); await tick(); h.setMessages([{ type: 'user', id: 'u2', text: 'changed' }]); release(); await tick();
  assert.deepEqual(h.renamed, []); await h.close(h.cleanup);
  let finish;
  const busy = harness({ fetchImpl: async () => { await new Promise((resolve) => { finish = resolve; }); return { ok: true, json: async () => ({ response: '标题' }) }; } });
  busy.emit(); await tick(); busy.setStatus('busy'); busy.emit('session.status'); await tick(); finish(); await tick();
  assert.deepEqual(busy.renamed, []); await busy.close(busy.cleanup);
});

test('queues a completion arriving during generation and names the latest content', async () => {
  let calls = 0;
  const releases = [];
  const h = harness({ fetchImpl: async () => {
    calls++;
    await new Promise((resolve) => releases.push(resolve));
    return { ok: true, json: async () => ({ response: calls === 1 ? '旧标题' : '新标题' }) };
  } });
  h.emit(); await tick();
  h.setMessages([{ type: 'user', id: 'u2', text: '最新内容' }]); h.emit(); await tick();
  releases.shift()(); await tick(); await tick();
  assert.equal(calls, 2);
  releases.shift()(); await tick();
  assert.deepEqual(h.renamed, ['新标题']);
  await h.close(h.cleanup);
});

test('local failure and timeout do not prevent later events; cleanup aborts subscription/request', async () => {
  let calls = 0;
  const h = harness({ fetchImpl: async (_url, { signal }) => {
    calls++;
    if (calls === 1) throw new Error('offline');
    return { ok: true, json: async () => ({ response: '恢复标题' }) };
  } });
  h.emit(); await tick(); h.emit(); await tick();
  assert.equal(calls, 2); assert.deepEqual(h.renamed, ['恢复标题']); await h.close(h.cleanup);
  let timedCalls = 0;
  const timed = harness({ timeoutMs: 5, fetchImpl: async (_url, { signal }) => {
    timedCalls++;
    if (timedCalls === 1) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
    return { ok: true, json: async () => ({ response: '超时后恢复' }) };
  } });
  timed.emit(); await tick(); await tick(); timed.emit(); await tick();
  assert.equal(timedCalls, 2); assert.deepEqual(timed.renamed, ['超时后恢复']); await timed.close(timed.cleanup);
  let requestSignal;
  const pending = harness({ fetchImpl: async (_url, options) => { requestSignal = options.signal; return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } });
  pending.emit(); await tick(); await pending.close(pending.cleanup);
  assert.equal(requestSignal.aborted, true);
});

test('retries a failed event subscription without losing later V2 completion events', async () => {
  const h = harness({ subscriptionFailures: 1 });
  await new Promise((resolve) => setTimeout(resolve, 280));
  h.emit(); await tick();
  assert.deepEqual(h.renamed, ['本地标题']);
  await h.close(h.cleanup);
});
