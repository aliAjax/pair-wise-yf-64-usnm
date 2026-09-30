import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';

type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';
type InterpreterStatus = 'active' | 'handoff' | 'standby';
type Room = { id: string; name: string; topic: string; simultaneousChannels: number };
type Speech = { id: string; roomId: string; speaker: string; delegation: string; language: string; topic: string; plannedSeconds: number; remainingSeconds: number; status: SpeechStatus; updatedAt: string };
type CaptionDraft = { text: string; interpreter: string; frozen: boolean; at: string };
type HandoffState = { state: 'pending' | 'failed'; from: string; to: string; at: string; attempts: number };
type Channel = { id: string; roomId: string; language: string; interpreter: string; status: InterpreterStatus; health: number; boundSpeechId?: string; draft?: CaptionDraft; handoff?: HandoffState };
type Term = { id: string; phrase: string; translation: string; language: string; approved: boolean };
type Caption = { id: string; speechId: string; roomId: string; language: string; interpreter: string; text: string; revision: number; at: string };
type Audit = { id: string; at: string; roomId: string; message: string };

interface ConferenceState {
  rooms: Room[];
  activeRoomId: string;
  speechQueue: Speech[];
  channels: Channel[];
  terms: Term[];
  captions: Caption[];
  audits: Audit[];
  lowLatency: boolean;
}

const now = new Date().toISOString();
const seed: ConferenceState = {
  rooms: [
    { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6 },
    { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4 }
  ],
  activeRoomId: 'hall-a',
  speechQueue: [
    { id: 'speech-1', roomId: 'hall-a', speaker: 'Amina Diallo', delegation: '塞内加尔', language: '英语', topic: '适应性融资缺口', plannedSeconds: 600, remainingSeconds: 214, status: 'speaking', updatedAt: now },
    { id: 'speech-2', roomId: 'hall-a', speaker: '李明远', delegation: '中国', language: '中文', topic: '绿色基础设施机制', plannedSeconds: 600, remainingSeconds: 600, status: 'queued', updatedAt: now },
    { id: 'speech-3', roomId: 'hall-b', speaker: 'Maria Silva', delegation: '巴西', language: '葡萄牙语', topic: '边缘算力与能源', plannedSeconds: 420, remainingSeconds: 420, status: 'queued', updatedAt: now }
  ],
  channels: [
    { id: 'ch-a-zh', roomId: 'hall-a', language: '中文', interpreter: '周雨', status: 'active', health: 96, boundSpeechId: 'speech-1', draft: { text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', interpreter: '周雨', frozen: false, at: now } },
    { id: 'ch-a-es', roomId: 'hall-a', language: '西班牙语', interpreter: 'Lucía M.', status: 'active', health: 91, boundSpeechId: 'speech-1' },
    { id: 'ch-a-fr', roomId: 'hall-a', language: '法语', interpreter: 'Noah B.', status: 'standby', health: 88 },
    { id: 'ch-b-zh', roomId: 'hall-b', language: '中文', interpreter: '何佳', status: 'active', health: 94 }
  ],
  terms: [
    { id: 'term-1', phrase: 'loss and damage', translation: '损失与损害', language: '中文', approved: true },
    { id: 'term-2', phrase: 'edge inference', translation: '边缘推理', language: '中文', approved: true },
    { id: 'term-3', phrase: 'just transition', translation: '公正转型', language: '中文', approved: false }
  ],
  captions: [
    { id: 'caption-1', speechId: 'speech-1', roomId: 'hall-a', language: '中文', interpreter: '周雨', text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', revision: 2, at: now }
  ],
  audits: [
    { id: 'audit-1', at: now, roomId: 'hall-a', message: 'Amina Diallo 开始发言，中文频道由周雨接续' },
    { id: 'audit-2', at: new Date(Date.now() - 90000).toISOString(), roomId: 'hall-a', message: '临时插话申请已插入队列第2位' }
  ],
  lowLatency: false
};

const captionSchema = z.object({ text: z.string().min(1, '字幕不能为空') });
const queueSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600)
});
type QueueForm = z.infer<typeof queueSchema>;
type CaptionForm = z.infer<typeof captionSchema>;

function readState(): ConferenceState {
  if (typeof localStorage === 'undefined') return seed;
  try { return JSON.parse(localStorage.getItem('conference-interpretation-v1') ?? 'null') as ConferenceState ?? seed; } catch { return seed; }
}

function logAudit(state: ConferenceState, roomId: string, message: string) {
  state.audits.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), roomId, message });
}

// 发言开始后，同厅 active 频道接续绑定到当前发言；发言结束/跳过时解绑。
const advanceSpeech$ = $((state: ConferenceState, id: string, status: SpeechStatus) => {
  const speech = state.speechQueue.find((item) => item.id === id);
  if (!speech) return;
  state.speechQueue = state.speechQueue.map((item) => item.id === id ? { ...item, status, updatedAt: new Date().toISOString() } : item);
  if (status === 'speaking') {
    state.speechQueue = state.speechQueue.map((item) => item.id !== id && item.roomId === speech.roomId && item.status === 'speaking' ? { ...item, status: 'done' } : item);
    state.channels = state.channels.map((channel) => channel.roomId === speech.roomId && channel.status === 'active' ? { ...channel, boundSpeechId: id } : channel);
    const onDuty = state.channels.filter((channel) => channel.roomId === speech.roomId && channel.status === 'active').map((channel) => `${channel.language}·${channel.interpreter}`).join('、');
    logAudit(state, speech.roomId, `${speech.speaker} 开始发言，频道接续绑定：${onDuty}`);
  } else {
    state.channels = state.channels.map((channel) => channel.roomId === speech.roomId && channel.boundSpeechId === id ? { ...channel, boundSpeechId: undefined } : channel);
    logAudit(state, speech.roomId, `发言 ${speech.speaker} 状态更新为 ${status}，频道解除接续`);
  }
});

// 启动交接：冻结当前草稿，原译员只能完成（发布）当前字幕，交接期间不可再发。
const handoff$ = $((state: ConferenceState, channelId: string) => {
  const channel = state.channels.find((item) => item.id === channelId);
  if (!channel || channel.status === 'handoff') return;
  const from = channel.interpreter;
  state.channels = state.channels.map((item) => item.id === channelId ? {
    ...item,
    status: 'handoff',
    handoff: { state: 'pending', from, to: '', at: new Date().toISOString(), attempts: 0 },
    draft: item.draft ? { ...item.draft, frozen: true } : item.draft
  } : item);
    logAudit(state, channel.roomId, `${channel.language} 频道启动译员交接（${from} → 待确认），当前字幕草稿已冻结，交接期间不可发布`);
});

// 交接失败：回到待确认步骤，原译员仍在岗、草稿保持冻结，可重试。
const failHandoff$ = $((state: ConferenceState, channelId: string) => {
  const channel = state.channels.find((item) => item.id === channelId);
  if (!channel || channel.status !== 'handoff' || !channel.handoff || channel.handoff.state !== 'pending') return;
  state.channels = state.channels.map((item) => item.id === channelId ? { ...item, handoff: { ...item.handoff!, state: 'failed' } } : item);
  logAudit(state, channel.roomId, `${channel.language} 频道交接失败（待重试），原译员 ${channel.interpreter} 仍在岗，草稿保持冻结`);
});

// 重试：从待确认步骤继续，归属不变（仍为原译员），不影响已发布字幕。
const retryHandoff$ = $((state: ConferenceState, channelId: string) => {
  const channel = state.channels.find((item) => item.id === channelId);
  if (!channel || channel.status !== 'handoff' || !channel.handoff || channel.handoff.state !== 'failed') return;
  state.channels = state.channels.map((item) => item.id === channelId ? { ...item, handoff: { ...item.handoff!, state: 'pending', at: new Date().toISOString(), attempts: item.handoff!.attempts + 1 } } : item);
  logAudit(state, channel.roomId, `${channel.language} 频道交接重试（第 ${channel.handoff.attempts + 1} 次），从待确认步骤继续，字幕归属不变`);
});

// 完成交接：仅待确认可执行；更新译员后旧草稿立即失效，后续字幕归属新译员，从下一段输入开始署名。
const completeHandoff$ = $((state: ConferenceState, channelId: string, interpreter: string) => {
  const channel = state.channels.find((item) => item.id === channelId);
  if (!channel || channel.status !== 'handoff' || !channel.handoff || channel.handoff.state !== 'pending') return;
  const from = channel.handoff.from;
  state.channels = state.channels.map((item) => item.id === channelId ? {
    ...item,
    interpreter,
    status: 'active',
    health: Math.min(100, item.health + 2),
    handoff: undefined,
    draft: undefined
  } : item);
  logAudit(state, channel.roomId, `${channel.language} 频道交接完成（${from} → ${interpreter}），旧草稿已失效，后续字幕归属新译员，从下一段输入开始署名`);
});

// 发布新版字幕：按发言+语言追加版本链（不覆盖已发布版本），署名当前译员。
const appendCaption$ = $((state: ConferenceState, channelId: string, text: string) => {
  const channel = state.channels.find((item) => item.id === channelId);
  const speech = state.speechQueue.find((item) => item.id === channel?.boundSpeechId);
  if (!channel || !speech || !text.trim()) return;
  const versions = state.captions.filter((item) => item.speechId === speech.id && item.language === channel.language);
  const revision = versions.length ? Math.max(...versions.map((item) => item.revision)) + 1 : 1;
  const at = new Date().toISOString();
  const trimmed = text.trim();
  state.captions.unshift({ id: crypto.randomUUID(), speechId: speech.id, roomId: speech.roomId, language: channel.language, interpreter: channel.interpreter, text: trimmed, revision, at });
  channel.draft = { text: trimmed, interpreter: channel.interpreter, frozen: false, at };
  logAudit(state, channel.roomId, `字幕 v${revision} 已发布（${channel.language}），归属译员 ${channel.interpreter}，发言：${speech.speaker}`);
});

const approveTerm$ = $((state: ConferenceState, id: string) => {
  const term = state.terms.find((item) => item.id === id);
  if (!term) return;
  state.terms = state.terms.map((item) => item.id === id ? { ...item, approved: true } : item);
  logAudit(state, state.activeRoomId, `术语已批准：${term.phrase}`);
});

export default component$(() => {
  const locale = useSpeakLocale();
  const state = useStore<ConferenceState>(readState());
  const captionLoader = useSignal<CaptionForm>({ text: '' });
  const [captionForm, { Form: CaptionForm, Field: CaptionField }] = useForm<CaptionForm>({
    loader: captionLoader,
    validate: zodForm$(captionSchema)
  });
  const queueLoader = useSignal<QueueForm>({ speaker: '', delegation: '', language: '英语', topic: '', plannedSeconds: 300 });
  const [queueForm, { Form: QueueForm, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueSchema)
  });

  const defaultCaptionChannelId = () => {
    const speech = state.speechQueue.find((item) => item.roomId === state.activeRoomId && item.status === 'speaking');
    const active = state.channels.filter((item) => item.roomId === state.activeRoomId && item.status === 'active');
    return (active.find((item) => item.boundSpeechId === speech?.id) ?? active[0])?.id ?? '';
  };
  const captionChannelId = useSignal<string>(defaultCaptionChannelId());

  useVisibleTask$(({ track }) => {
    track(() => state);
    localStorage.setItem('conference-interpretation-v1', JSON.stringify(state));
  });

  const activeRoom = () => state.rooms.find((room) => room.id === state.activeRoomId) ?? state.rooms[0];
  const roomQueue = () => state.speechQueue.filter((item) => item.roomId === state.activeRoomId);
  const roomChannels = () => state.channels.filter((item) => item.roomId === state.activeRoomId);
  const currentSpeech = () => roomQueue().find((item) => item.status === 'speaking');
  const captionChannel = () => state.channels.find((item) => item.id === captionChannelId.value);
  const captionFrozen = () => {
    const channel = captionChannel();
    return !channel || channel.status === 'handoff' || !!channel.handoff || !!channel.draft?.frozen;
  };
  const captionBound = () => {
    const channel = captionChannel();
    const speech = currentSpeech();
    return !!channel && !!speech && channel.boundSpeechId === speech.id;
  };
  const currentCaptions = () => currentSpeech()
    ? state.captions.filter((item) => item.speechId === currentSpeech()!.id).sort((a, b) => a.revision - b.revision)
    : [];

  const selectRoom$ = $((roomId: string) => {
    state.activeRoomId = roomId;
    logAudit(state, roomId, `切换到 ${state.rooms.find((room) => room.id === roomId)?.name}`);
  });

  const addSpeech$ = $((values: QueueForm) => {
    state.speechQueue.push({ id: crypto.randomUUID(), roomId: state.activeRoomId, ...values, remainingSeconds: values.plannedSeconds, status: 'queued', updatedAt: new Date().toISOString() });
    logAudit(state, state.activeRoomId, `${values.speaker} 已加入发言队列`);
  });

  const onCaptionInput$ = $((text: string) => {
    captionLoader.value.text = text;
    const channel = state.channels.find((item) => item.id === captionChannelId.value);
    if (channel && channel.status !== 'handoff' && !channel.handoff) {
      channel.draft = { text, interpreter: channel.interpreter, frozen: false, at: new Date().toISOString() };
    }
  });

  const onCaptionChannelChange$ = $((event: Event) => {
    const id = (event.target as HTMLSelectElement).value;
    captionChannelId.value = id;
    const channel = state.channels.find((item) => item.id === id);
    captionLoader.value.text = channel?.draft?.text ?? '';
  });

  const onCompleteHandoff$ = $((channelId: string, interpreter: string) => {
    completeHandoff$(state, channelId, interpreter);
    if (captionChannelId.value === channelId) captionLoader.value.text = '';
  });

  const publishCaption$ = $(async (values: CaptionForm) => {
    const channel = state.channels.find((item) => item.id === captionChannelId.value);
    const speech = state.speechQueue.find((item) => item.roomId === state.activeRoomId && item.status === 'speaking');
    if (!channel || !speech) return;
    const refuse = (message: string) => logAudit(state, channel.roomId, message);
    if (channel.boundSpeechId !== speech.id) return refuse(`频道 ${channel.language} 未接续当前发言，字幕未发布`);
    if (channel.status === 'handoff' || channel.handoff || channel.draft?.frozen) return refuse(`交接冻结中（${channel.language}），草稿不可发布`);
    if (channel.draft && channel.draft.interpreter !== channel.interpreter) {
      const previous = channel.draft.interpreter;
      channel.draft = undefined;
      return refuse(`草稿归属与当前译员不符（${previous} → ${channel.interpreter}），已作废`);
    }
    await appendCaption$(state, channel.id, values.text);
  });

  return (
    <main class={`conference-shell ${state.lowLatency ? 'low-latency' : ''}`}>
      <header class="hero">
        <div><span class="pill">{locale.lang}</span><h1>同声传译与发言队列</h1><p>{activeRoom().name} · {activeRoom().topic}</p></div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <select value={state.activeRoomId} onChange$={(event) => selectRoom$((event.target as HTMLSelectElement).value)}>{state.rooms.map((room) => <option value={room.id}>{room.name}</option>)}</select>
          <button class="secondary" onClick$={() => state.lowLatency = !state.lowLatency}>{state.lowLatency ? '退出低延迟' : '低延迟模式'}</button>
        </div>
      </header>

      <section class="grid">
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center"><h2>发言队列</h2><span class="pill">{roomQueue().length} 条 · {activeRoom().simultaneousChannels} 个同传频道</span></div>
          {roomQueue().map((speech, index) => (
            <div class={`queue-row ${speech.status === 'speaking' ? 'active' : ''}`} key={speech.id}>
              <strong>#{index + 1}</strong>
              <div><b>{speech.speaker}</b><div style="color:#638087;font-size:13px">{speech.delegation} · {speech.language} · {speech.topic}</div></div>
              <span class="pill">{speech.status}</span>
              <div style="display:flex;gap:6px">
                {speech.status === 'queued' && <button onClick$={() => advanceSpeech$(state, speech.id, 'speaking')}>开始</button>}
                {speech.status === 'speaking' && <><button onClick$={() => advanceSpeech$(state, speech.id, 'done')}>结束</button><button class="secondary" onClick$={() => speech.remainingSeconds = Math.max(0, speech.remainingSeconds - 60)}>减1分钟</button></>}
                {speech.status === 'queued' && <button class="danger" onClick$={() => advanceSpeech$(state, speech.id, 'skipped')}>跳过</button>}
              </div>
            </div>
          ))}
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:18px">
            <QueueForm onSubmit$={addSpeech$}>
              <QueueField name="speaker">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="发言人" />}</QueueField>
              <QueueField name="delegation">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="代表团" />}</QueueField>
              <QueueField name="topic">{(field, props) => <input {...props} value={field.value} onInput$={(event) => field.value = (event.target as HTMLInputElement).value} placeholder="议题" />}</QueueField>
              <QueueField name="plannedSeconds" type="number">{(field, props) => <input {...props} type="number" value={field.value} onInput$={(event) => field.value = Number((event.target as HTMLInputElement).value)} placeholder="计划秒数" />}</QueueField>
              <button type="submit">加入队列</button>
            </QueueForm>
          </div>
        </article>

        <aside class="panel">
          <h2>频道与译员</h2>
          {roomChannels().map((channel) => {
            const boundSpeech = state.speechQueue.find((item) => item.id === channel.boundSpeechId);
            const handoffLabel = channel.handoff?.state === 'failed' ? '交接失败·待重试' : channel.handoff ? '交接待确认' : channel.status;
            return (
              <div style="padding:12px 0;border-bottom:1px solid #e6efee" key={channel.id}>
                <div style="display:flex;justify-content:space-between"><b>{channel.language} · {channel.interpreter}</b><span class="pill">{handoffLabel}</span></div>
                <div style="color:#638087;font-size:13px;margin:4px 0">
                  {boundSpeech ? `接续发言：${boundSpeech.speaker}` : '未接续发言'}
                  {channel.draft?.frozen ? ' · 草稿已冻结' : ''}
                </div>
                <div class="decorative" style="margin:8px 0"><Progress.Root value={channel.health} max={100} /></div>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  {channel.status !== 'handoff' && <button class="secondary" onClick$={() => handoff$(state, channel.id)}>开始交接</button>}
                  {channel.status === 'handoff' && channel.handoff?.state === 'pending' && (
                    <>
                      <button onClick$={() => onCompleteHandoff$(channel.id, `替补译员-${channel.language}`)}>确认交接</button>
                      <button class="danger secondary" onClick$={() => failHandoff$(state, channel.id)}>标记失败</button>
                    </>
                  )}
                  {channel.status === 'handoff' && channel.handoff?.state === 'failed' && (
                    <button onClick$={() => retryHandoff$(state, channel.id)}>重试确认{channel.handoff?.attempts ? `（第${channel.handoff.attempts + 1}次）` : ''}</button>
                  )}
                </div>
                {channel.handoff && (
                  <div style="color:#b45309;font-size:12px;margin-top:6px">
                    交接：{channel.handoff.from} → 替补译员-{channel.language} · {channel.handoff.state === 'failed' ? '失败待重试' : '待确认'}
                    {channel.handoff.attempts > 0 ? ` · 已重试 ${channel.handoff.attempts} 次` : ''}
                  </div>
                )}
              </div>
            );
          })}
          <h3>实时字幕修正</h3>
          {currentSpeech() ? (
            <>
              <div style="margin:8px 0">
                <select value={captionChannelId.value} onChange$={onCaptionChannelChange$}>
                  {roomChannels().filter((channel) => channel.status === 'active').map((channel) => <option value={channel.id}>{`${channel.language} · ${channel.interpreter}`}</option>)}
                </select>
              </div>
              {!captionBound() && <p style="color:#b45309">该频道未接续当前发言，字幕不可发布。</p>}
              {captionFrozen() && <p style="color:#b45309">交接已冻结当前草稿，完成后由新译员从下一段输入开始署名。</p>}
              <CaptionForm onSubmit$={publishCaption$}>
                <CaptionField name="text">
                  {(field, props) => (
                    <textarea
                      {...props}
                      rows={3}
                      value={field.value}
                      disabled={captionFrozen() || !captionBound()}
                      onInput$={(event) => { field.value = (event.target as HTMLTextAreaElement).value; onCaptionInput$((event.target as HTMLTextAreaElement).value); }}
                      placeholder="输入或修正当前字幕"
                    />
                  )}
                </CaptionField>
                <button type="submit" disabled={captionFrozen() || !captionBound()}>提交新版字幕</button>
              </CaptionForm>
              <h4>当前发言字幕版本</h4>
              {currentCaptions().map((caption) => (
                <div style="margin-top:10px;padding:10px;background:#f1f8f7;border-radius:10px" key={caption.id}>
                  <b>{caption.interpreter} · v{caption.revision}</b> <small>{new Date(caption.at).toLocaleTimeString()}</small>
                  <p>{caption.text}</p>
                </div>
              ))}
            </>
          ) : <p>当前没有发言中的代表。</p>}
        </aside>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <h2>术语库</h2>
          {state.terms.map((term) => <div class="queue-row" key={term.id}><span/><div><b>{term.phrase}</b><div>{term.translation} · {term.language}</div></div><span class="pill">{term.approved ? '已批准' : '待审'}</span><button disabled={term.approved} onClick$={() => approveTerm$(state, term.id)}>批准</button></div>)}
        </article>
        <article class="panel">
          <h2>操作与交接时间线</h2>
          {state.audits.filter((audit) => audit.roomId === state.activeRoomId).slice(0, 12).map((audit) => <div style="padding:10px 0;border-bottom:1px solid #e6efee" key={audit.id}><small>{new Date(audit.at).toLocaleTimeString()}</small><div>{audit.message}</div></div>)}
        </article>
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [{ name: 'description', content: '发言队列、多语种频道、术语、译员交接与实时字幕修正原型' }]
};
