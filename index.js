// dsh-session-timeline — host half.
// Registers a session projection that incrementally folds the whole-session
// user-message list plus each one's AI reply text (seq/time/text/reply) as
// events stream in. The projection value is persisted by the framework's
// projection cache, so a page reload reads the folded value instantly instead
// of re-reading the whole session log. The browser half reads it via
// session.projections.faceOf('timelineUserMessages').

import { z } from 'zod';

// 紧凑档截断：tooltip 显示能力（用户消息 1 行 ≈ 20 中文字，回复 3 行 ≈ 60 中文字），
// 留 ~2 倍余量防止字体宽度差异与未来加宽
const TEXT_LIMIT = 60;   // 用户消息预览上限（字符）
const REPLY_LIMIT = 160; // AI 回复预览上限（字符）

function countText(content) {
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += ' ' + block.text;
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

export const name = 'dsh-session-timeline';

// 投影键：整会话用户消息列表 + 每条对应的 AI 回复文本。
// 口径与客户端 user/steering 节点一致（user/message 且 source.kind === 'user'）；
// 回复文本来自 user/message 之后、下一条用户消息之前的 assistant/message 事件。
export const TIMELINE_PROJECTION_KEY = 'timelineUserMessages';

export function apply(ctx) {
  const projections = ctx.get('sessionProjections');
  if (projections === undefined) return;

  projections.register({
    key: TIMELINE_PROJECTION_KEY,
    schema: z.array(z.object({
      seq: z.number(),
      time: z.number(),
      text: z.string(),
      reply: z.string(),
    })),
    init: () => [],
    // 纯同步 fold：
    // - user/message（真实用户输入）-> 追加 { seq, time, text, reply: '' }
    // - assistant/message（该轮回复）-> 把文本块拼进最后一条用户消息的 reply
    // 其他事件返回同引用（零开销）
    apply(state, event) {
      if (event && event.type === 'user/message' && event.data && event.data.source && event.data.source.kind === 'user') {
        const next = state.slice();
        next.push({
          seq: event.seq,
          time: event.time,
          text: countText(event.data.content).slice(0, TEXT_LIMIT),
          reply: '',
        });
        return next;
      }
      if (event && event.type === 'assistant/message' && event.data && event.data.message && state.length > 0) {
        const replyText = countText(event.data.message.content).slice(0, REPLY_LIMIT);
        if (!replyText) return state;
        const next = state.slice();
        const last = next[next.length - 1];
        next[next.length - 1] = {
          seq: last.seq,
          time: last.time,
          text: last.text,
          reply: last.reply ? (last.reply + '\n' + replyText).slice(0, REPLY_LIMIT) : replyText,
        };
        return next;
      }
      return state;
    },
    view: (state) => state,
    // v3：文本按紧凑档截断（text 60 / reply 160），丢弃 v2 未截断的旧缓存
    stateVersion: 3,
  });
}
