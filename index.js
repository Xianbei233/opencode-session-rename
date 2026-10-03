import { Plugin } from '@opencode/plugin';
import { RenameRPC } from './rename-rpc.js';

export const OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';
export const OLLAMA_MODEL = 'qwen2.5:0.5b';
const MAX_CONTEXT = 1600;
const MAX_TITLE = 30;
const REQUEST_TIMEOUT = 120_000;

export function cleanTitle(value) {
  const title = String(value ?? '').replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*(?:标题|title)\s*[:：]\s*/i, '').replace(/[\r\n]+/g, ' ')
    .replace(/["'“”‘’`]/g, '').replace(/\s+/g, ' ').trim();
  return title;
}

export function messageText(messages = []) {
  const entries = messages.flatMap((message) => {
    if (message.type === 'user') {
      if (typeof message.text === 'string') return [message.text];
      return (message.parts ?? []).filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text);
    }
    if (message.type === 'assistant') {
      if (typeof message.content === 'string') return [message.content];
      if (Array.isArray(message.content)) return message.content.filter((p) => p.type === 'text').map((p) => p.text);
      return (message.parts ?? []).filter((p) => p.type === 'text' && typeof p.text === 'string').map((p) => p.text);
    }
    return [];
  }).filter(Boolean);
  const topic = Array.from(entries[0] ?? '').slice(0, 400).join('');
  let recent = Array.from(entries.join('\n')).slice(-1200).join('');
  if (topic && recent.startsWith(`${topic}\n`)) recent = recent.slice(topic.length + 1);
  return [topic, recent].filter(Boolean).join('\n').slice(-MAX_CONTEXT);
}

const titlePrompt = (text) => `请为这段对话写一个自然、简洁的中文标题，最多30个Unicode字符。标题应同时概括核心主题和最新进展/当前状态，避免泛泛而谈；不要凭空声称已完成。只输出标题，不要解释。示例：会话标题插件：完成本地接入\n对话：\n${text}`;
const rewritePrompt = (candidate, text) => `请将候选标题压缩并改写为自然中文标题，最多30个Unicode字符。保留核心主题和最新进展/当前状态，不要凭空声称已完成，只输出标题。\n候选：${candidate}\n主题与最新对话：\n${text}`;
const validTitle = (title) => {
  const count = Array.from(title).length;
  return count > 0 && count <= MAX_TITLE && !/(标题是|标题为|以下是|这个标题|我认为|因为|所以|：.{0,30}，)/.test(title);
};

async function localTitle(text, { fetchImpl, signal, model, candidate }) {
  const response = await fetchImpl(OLLAMA_URL, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt: candidate === undefined ? titlePrompt(text) : rewritePrompt(candidate, text), stream: false, keep_alive: 0, options: { num_ctx: 2048, num_predict: 64, temperature: 0.1 } }),
  });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
  return cleanTitle((await response.json()).response);
}

export async function setup(ctx, { fetchImpl = globalThis.fetch, model = OLLAMA_MODEL, timeoutMs = REQUEST_TIMEOUT } = {}) {
  const controller = new AbortController();
  const running = new Map();
  const completed = new Map();
  const rerun = new Map();
  const busy = new Set();
  const states = new Map();
  let registration;
  const publish = async (state) => { states.set(state.executionID, state); while (states.size > 256) states.delete(states.keys().next().value); try { await registration?.events.emit('state', state); } catch { /* disconnected TUI does not block local naming */ } };
  const terminal = async (sessionID, executionID, status, previous = states.get(executionID)) => {
    if (!executionID || states.get(executionID)?.sessionID !== sessionID) return;
    await publish({ sessionID, executionID, status, title: previous?.title ?? '' });
  };
  const processIdle = async (sessionID, executionID) => {
    if (!sessionID || controller.signal.aborted) return;
    if (running.has(sessionID)) { rerun.set(sessionID, executionID); return; }
    const task = (async () => {
      const session = await ctx.session.get({ sessionID });
      if (session.parentID || busy.has(sessionID)) { await terminal(sessionID, executionID, 'skipped'); return; }
      const messages = await ctx.session.context({ sessionID });
      const fingerprint = messageText(messages);
      if (!fingerprint) { await terminal(sessionID, executionID, 'skipped'); return; }
      if (completed.get(sessionID) === fingerprint) { await terminal(sessionID, executionID, 'unchanged'); return; }
      const requestController = new AbortController();
      const abort = () => requestController.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, timeoutMs);
      let title;
       try {
         title = await localTitle(fingerprint, { fetchImpl, signal: requestController.signal, model });
         if (!validTitle(title)) {
           const rewritten = await localTitle(fingerprint, { fetchImpl, signal: requestController.signal, model, candidate: title });
           title = validTitle(rewritten) ? rewritten : '';
         }
       }
      finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', abort); }
        if (!title || controller.signal.aborted) { await terminal(sessionID, executionID, 'skipped'); return; }
      const latest = await ctx.session.context({ sessionID });
        if (messageText(latest) !== fingerprint || busy.has(sessionID)) { await terminal(sessionID, executionID, 'skipped'); return; }
      const current = await ctx.session.get({ sessionID });
        if (current.parentID || busy.has(sessionID)) { await terminal(sessionID, executionID, 'skipped'); return; }
       await ctx.session.update({ sessionID, title });
       completed.set(sessionID, fingerprint);
       await terminal(sessionID, executionID, 'renamed', { ...states.get(executionID), title });
    })().catch(async () => { console.warn('[session-rename] Local title request failed; skipped.'); await terminal(sessionID, executionID, 'failed'); }).finally(() => {
      running.delete(sessionID);
      const nextExecutionID = rerun.get(sessionID);
      rerun.delete(sessionID);
      if (nextExecutionID && !controller.signal.aborted) void processIdle(sessionID, nextExecutionID);
    });
    running.set(sessionID, task);
    await task;
  };
  registration = await ctx.rpc.register(RenameRPC, {
    getState: async ({ sessionID, executionID }) => states.get(executionID) ?? { sessionID, executionID, status: 'unknown', title: '' },
  });
  const loop = (async () => {
    while (!controller.signal.aborted) {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === 'session.status') {
            if (event.data.status.type === 'busy') busy.add(event.data.sessionID);
            else busy.delete(event.data.sessionID);
          }
          if (event.type === 'session.execution.started') busy.add(event.data.sessionID);
           if (event.type === 'session.execution.failed' || event.type === 'session.execution.interrupted') { busy.delete(event.data.sessionID); void publish({ sessionID: event.data.sessionID, executionID: event.id, status: 'failed', title: '' }); }
           if (event.type === 'session.execution.succeeded') { busy.delete(event.data.sessionID); void publish({ sessionID: event.data.sessionID, executionID: event.id, status: 'pending', title: '' }).then(() => processIdle(event.data.sessionID, event.id)); }
           if (event.type === 'session.idle') { busy.delete(event.data.sessionID); void processIdle(event.data.sessionID); }
          if (controller.signal.aborted) break;
        }
      } catch { if (!controller.signal.aborted) console.warn('[session-rename] Event subscription failed; retrying.'); }
      if (!controller.signal.aborted) await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 250);
        controller.signal.addEventListener('abort', done, { once: true });
      });
    }
  })();
  return async () => {
    controller.abort();
    await registration.dispose();
    await Promise.allSettled([...running.values()]);
    await loop;
  };
}

export default Plugin.define({ id: 'local.session-rename', setup: (ctx) => setup(ctx) });
