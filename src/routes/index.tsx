import { $, component$, useSignal, useStore, useVisibleTask$ } from '@builder.io/qwik';
import { Progress } from '@qwik-ui/headless';
import { useForm, zodForm$ } from '@modular-forms/qwik';
import { useSpeakLocale } from 'qwik-speak';
import { z } from 'zod';
import type { DocumentHead } from '@builder.io/qwik-city';
import {
  STORAGE_KEY,
  activateChannel,
  addSpeech,
  advanceHandoffToPending,
  approveTerm,
  changeSpeechStatus,
  confirmHandoff,
  editDraft,
  failHandoff,
  getAssignment,
  getChannelCaptions,
  getCurrentSpeech,
  getLatestHandoff,
  getOpenHandoff,
  migrateState,
  publishDraft,
  retryHandoff,
  selectRoom,
  startHandoff,
  type AuditKind,
  type ConferenceState,
  type Handoff,
  type HandoffStage
} from '~/domain/conference';

const queueSchema = z.object({
  speaker: z.string().min(2, '请输入发言人'),
  delegation: z.string().min(2, '请输入代表团'),
  language: z.string().min(2),
  topic: z.string().min(3, '请输入议题'),
  plannedSeconds: z.coerce.number().min(60).max(3600)
});
type QueueForm = z.infer<typeof queueSchema>;

function readState(): ConferenceState {
  if (typeof localStorage === 'undefined') return migrateState(null);
  try {
    return migrateState(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return migrateState(null);
  }
}

const KIND_LABEL: Record<AuditKind, string> = {
  binding: '绑定',
  speech: '发言',
  queue: '队列',
  handoff: '交接',
  draft: '草稿',
  caption: '字幕',
  term: '术语',
  room: '会议厅',
  note: '备注'
};

const STAGE_LABEL: Record<HandoffStage, string> = {
  frozen: '① 已冻结',
  pending: '② 待确认',
  confirmed: '③ 已确认',
  failed: '✕ 失败'
};

function clock(value: string): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

export default component$(() => {
  const locale = useSpeakLocale();
  const state = useStore<ConferenceState>(readState(), { deep: true });
  const notice = useSignal<{ text: string; tone: 'ok' | 'warn' } | null>(null);
  const selectedChannelId = useSignal<string>('');
  const incomingNames = useStore<Record<string, string>>({});
  const draftInputs = useStore<Record<string, string>>({});
  const failReasons = useStore<Record<string, string>>({});

  const queueLoader = useSignal<QueueForm>({
    speaker: '',
    delegation: '',
    language: '英语',
    topic: '',
    plannedSeconds: 300
  });
  const [, { Form: QueueForm, Field: QueueField }] = useForm<QueueForm>({
    loader: queueLoader,
    validate: zodForm$(queueSchema)
  });

  useVisibleTask$(({ track }) => {
    track(() => state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });

  const flash$ = $(async (error: string | null, okText: string) => {
    notice.value = error ? { text: error, tone: 'warn' } : { text: okText, tone: 'ok' };
  });

  const activeRoom = () => state.rooms.find((room) => room.id === state.activeRoomId) ?? state.rooms[0];
  const roomQueue = () => state.speechQueue.filter((item) => item.roomId === state.activeRoomId);
  const roomChannels = () => state.channels.filter((item) => item.roomId === state.activeRoomId);
  const currentSpeech = () => getCurrentSpeech(state, state.activeRoomId);

  const selectedChannel = () => {
    const channels = roomChannels();
    return (
      channels.find((channel) => channel.id === selectedChannelId.value) ??
      channels.find((channel) => channel.status === 'active') ??
      channels[0]
    );
  };

  const onSelectRoom$ = $((roomId: string) => {
    selectRoom(state, roomId);
    selectedChannelId.value = '';
    notice.value = null;
  });

  const onAdvanceSpeech$ = $(async (speechId: string, status: 'speaking' | 'done' | 'skipped' | 'queued') => {
    const error = changeSpeechStatus(state, speechId, status);
    await flash$(error, '发言状态已更新，频道接续绑定完成');
  });

  const onAddSpeech$ = $(async (values: QueueForm) => {
    const error = addSpeech(state, values);
    await flash$(error, `${values.speaker} 已加入队列`);
  });

  const onActivateChannel$ = $(async (channelId: string) => {
    const error = activateChannel(state, channelId);
    await flash$(error, '频道已上线并与当前发言绑定');
  });

  const onStartHandoff$ = $(async (channelId: string) => {
    const error = startHandoff(state, channelId, incomingNames[channelId] ?? `替补译员-${state.channels.find((c) => c.id === channelId)?.language ?? ''}`);
    await flash$(error, '交接已启动：当前段冻结，草稿已作废');
  });

  const onToPending$ = $(async (handoffId: string) => {
    const error = advanceHandoffToPending(state, handoffId);
    await flash$(error, '交接状态更新为待确认，草稿立即失效');
  });

  const onFail$ = $(async (handoffId: string) => {
    const handoff = state.handoffs.find((item) => item.id === handoffId);
    const error = failHandoff(state, handoffId, failReasons[handoffId] || '信号抖动，确认未送达');
    await flash$(error, handoff ? `已模拟失败，可重试（第 ${handoff.attempt} 次尝试）` : '操作完成');
  });

  const onRetry$ = $(async (handoffId: string) => {
    const error = retryHandoff(state, handoffId);
    await flash$(error, '已从待确认步骤重试：归属不变，已发布字幕不受影响');
  });

  const onConfirm$ = $(async (handoffId: string) => {
    const error = confirmHandoff(state, handoffId);
    await flash$(error, '交接确认完成：新译员从下一段开始署名');
  });

  const onDraftInput$ = $((channelId: string, text: string) => {
    draftInputs[channelId] = text;
    const error = editDraft(state, channelId, text);
    if (error) notice.value = { text: error, tone: 'warn' };
  });

  const onPublish$ = $(async (channelId: string) => {
    const error = publishDraft(state, channelId);
    if (!error) draftInputs[channelId] = '';
    await flash$(error, '字幕已发布：版本只追加，历史版本不被覆盖');
  });

  const onApproveTerm$ = $((id: string) => {
    approveTerm(state, id);
  });

  const roomAudits = () =>
    state.audits
      .filter((audit) => audit.roomId === state.activeRoomId)
      .slice()
      .sort((a, b) => b.seq - a.seq)
      .slice(0, 14);

  const channelHandoffHistory = (channelId: string): Handoff[] =>
    state.handoffs.filter((item) => item.channelId === channelId).slice(0, 3);

  return (
    <main class={`conference-shell ${state.lowLatency ? 'low-latency' : ''}`}>
      <header class="hero">
        <div>
          <span class="pill">{locale.lang}</span>
          <h1>同声传译与发言队列</h1>
          <p>
            {activeRoom().name} · {activeRoom().topic}
          </p>
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          <select value={state.activeRoomId} onChange$={(event) => onSelectRoom$((event.target as HTMLSelectElement).value)}>
            {state.rooms.map((room) => (
              <option value={room.id}>{room.name}</option>
            ))}
          </select>
          <button
            class="secondary"
            onClick$={() => {
              state.lowLatency = !state.lowLatency;
            }}
          >
            {state.lowLatency ? '退出低延迟' : '低延迟模式'}
          </button>
        </div>
      </header>

      {notice.value && (
        <div class={`notice ${notice.value.tone === 'warn' ? 'warn' : 'ok'}`}>{notice.value.text}</div>
      )}

      <section class="grid">
        {/* 发言队列 */}
        <article class="panel">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h2>发言队列</h2>
            <span class="pill">{roomQueue().length} 条 · {activeRoom().simultaneousChannels} 个同传频道</span>
          </div>
          {roomQueue().map((speech, index) => (
            <div class={`queue-row ${speech.status === 'speaking' ? 'active' : ''}`} key={speech.id}>
              <strong>#{index + 1}</strong>
              <div>
                <b>{speech.speaker}</b>
                <div style="color:#638087;font-size:13px">
                  {speech.delegation} · {speech.language} · {speech.topic}
                  {speech.status === 'speaking' && (
                    <div class="bind-line">
                      接续频道：
                      {roomChannels()
                        .map((channel) => getAssignment(state, speech.id, channel.id))
                        .filter((binding): binding is NonNullable<typeof binding> => Boolean(binding))
                        .map((binding) => `${binding.language}→${binding.interpreter}`)
                        .join('、') || '尚未绑定'}
                    </div>
                  )}
                </div>
              </div>
              <span class="pill">{speech.status}</span>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                {speech.status === 'queued' && (
                  <>
                    <button onClick$={() => onAdvanceSpeech$(speech.id, 'speaking')}>开始</button>
                    <button class="danger" onClick$={() => onAdvanceSpeech$(speech.id, 'skipped')}>跳过</button>
                  </>
                )}
                {speech.status === 'speaking' && (
                  <>
                    <button onClick$={() => onAdvanceSpeech$(speech.id, 'done')}>结束</button>
                    <button
                      class="secondary"
                      onClick$={() => {
                        speech.remainingSeconds = Math.max(0, speech.remainingSeconds - 60);
                      }}
                    >
                      减1分钟
                    </button>
                  </>
                )}
                {speech.status === 'done' && (
                  <button class="secondary" onClick$={() => onAdvanceSpeech$(speech.id, 'queued')}>重新排队</button>
                )}
              </div>
            </div>
          ))}
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:18px">
            <QueueForm onSubmit$={onAddSpeech$}>
              <QueueField name="speaker">
                {(field, props) => (
                  <input
                    {...props}
                    value={field.value}
                    onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)}
                    placeholder="发言人"
                  />
                )}
              </QueueField>
              <QueueField name="delegation">
                {(field, props) => (
                  <input
                    {...props}
                    value={field.value}
                    onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)}
                    placeholder="代表团"
                  />
                )}
              </QueueField>
              <QueueField name="topic">
                {(field, props) => (
                  <input
                    {...props}
                    value={field.value}
                    onInput$={(event) => (field.value = (event.target as HTMLInputElement).value)}
                    placeholder="议题"
                  />
                )}
              </QueueField>
              <QueueField name="plannedSeconds" type="number">
                {(field, props) => (
                  <input
                    {...props}
                    type="number"
                    value={field.value}
                    onInput$={(event) => (field.value = Number((event.target as HTMLInputElement).value))}
                    placeholder="计划秒数"
                  />
                )}
              </QueueField>
              <button type="submit">加入队列</button>
            </QueueForm>
          </div>
        </article>

        {/* 频道、交接与字幕 */}
        <aside class="panel">
          <h2>频道与译员</h2>
          {roomChannels().map((channel) => {
            const speech = currentSpeech();
            const binding = speech ? getAssignment(state, speech.id, channel.id) : undefined;
            const open = getOpenHandoff(state, channel.id);
            const last = getLatestHandoff(state, channel.id);
            const draft = state.drafts.find((item) => item.channelId === channel.id);
            const captions = speech ? getChannelCaptions(state, speech.id, channel.id) : [];
            const isSelected = selectedChannel()?.id === channel.id;
            return (
              <div class={`channel-card ${isSelected ? 'selected' : ''} ${open ? 'is-handoff' : ''}`} key={channel.id}>
                <div style="display:flex;justify-content:space-between;gap:8px;align-items:center">
                  <b>
                    {channel.language} · {channel.interpreter}
                  </b>
                  <div style="display:flex;gap:6px;align-items:center">
                    {open && <span class="pill handoff-pill">{STAGE_LABEL[open.stage]}</span>}
                    {!open && <span class="pill">{channel.status === 'active' ? '在岗' : channel.status === 'standby' ? '备用' : '交接'}</span>}
                    {!isSelected && (
                      <button class="secondary" onClick$={() => (selectedChannelId.value = channel.id)}>
                        查看
                      </button>
                    )}
                  </div>
                </div>
                <div style="color:#638087;font-size:12.5px;margin-top:2px">
                  当前发言绑定：
                  {binding && speech ? `${speech.speaker} → ${binding.interpreter}` : speech ? '未绑定' : '无发言'}
                  {open && (
                    <span>
                      {' '}· 边界：第 {open.boundarySegmentSeq || 0} 段 · 第 {open.attempt} 次尝试
                    </span>
                  )}
                </div>

                <div class="decorative" style="margin:8px 0">
                  <Progress.Root value={channel.health} max={100} />
                </div>

                {/* 交接操作区：步骤化、可重试 */}
                {open ? (
                  <div class="handoff-box">
                    <div class="steps">
                      <span class={open.stage === 'frozen' ? 'step current' : 'step'}>①冻结</span>
                      <span class={open.stage === 'pending' ? 'step current' : open.stage === 'failed' ? 'step bad' : 'step'}>
                        ②待确认
                      </span>
                      <span class={open.stage === 'confirmed' ? 'step current' : 'step'}>③确认</span>
                    </div>
                    <div style="font-size:13px">
                      {open.outgoingInterpreter} → {open.incomingInterpreter}
                    </div>
                    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">
                      {open.stage === 'frozen' && (
                        <button onClick$={() => onToPending$(open.id)}>进入待确认</button>
                      )}
                      {(open.stage === 'frozen' || open.stage === 'pending') && (
                        <>
                          <input
                            value={failReasons[open.id] ?? ''}
                            onInput$={(event) => (failReasons[open.id] = (event.target as HTMLInputElement).value)}
                            placeholder="失败原因（可选，模拟用）"
                            style="flex:1;min-width:150px"
                          />
                          <button class="danger" onClick$={() => onFail$(open.id)}>
                            模拟确认失败
                          </button>
                        </>
                      )}
                      {open.stage === 'pending' && <button onClick$={() => onConfirm$(open.id)}>确认交接</button>}
                      {open.stage === 'failed' && (
                        <>
                          <button onClick$={() => onRetry$(open.id)}>从待确认重试</button>
                          <button class="secondary" onClick$={() => onConfirm$(open.id)} disabled>
                            请先重试
                          </button>
                        </>
                      )}
                    </div>
                    <div style="font-size:12px;color:#7a5c17;margin-top:6px">
                      {open.stage === 'frozen' && '冻结生效：原译员不能再改当前段，未提交草稿已丢弃。'}
                      {open.stage === 'pending' && '待确认期间频道不收稿；重试与确认都不会动已发布字幕。'}
                      {open.stage === 'failed' && '失败后从待确认步骤重试：不重复归属、不覆盖已发布字幕。'}
                    </div>
                  </div>
                ) : (
                  <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                    {channel.status === 'standby' ? (
                      <button class="secondary" onClick$={() => onActivateChannel$(channel.id)}>
                        频道上线并绑定当前发言
                      </button>
                    ) : (
                      <>
                        <input
                          value={incomingNames[channel.id] ?? ''}
                          onInput$={(event) => (incomingNames[channel.id] = (event.target as HTMLInputElement).value)}
                          placeholder="接班译员姓名"
                          style="max-width:170px"
                        />
                        <button class="secondary" disabled={!speech} onClick$={() => onStartHandoff$(channel.id)}>
                          启动交接
                        </button>
                      </>
                    )}
                  </div>
                )}

                {last && !open && (
                  <div style="font-size:12px;color:#4f7a6b;margin-top:6px">
                    上次交接：{last.outgoingInterpreter} → {last.incomingInterpreter}，第 {last.attempt} 次尝试确认 · 边界第 {last.boundarySegmentSeq || 0} 段
                  </div>
                )}

                {/* 展开的频道：草稿 + 字幕段 */}
                {isSelected && (
                  <div class="caption-zone">
                    {speech ? (
                      <>
                        <div class="caption-segments">
                          {captions.length === 0 && <div style="color:#638087;font-size:13px">该频道还没有字幕段。</div>}
                          {captions.map((caption) => {
                            const head = caption.versions[0];
                            const current = caption.versions[caption.versions.length - 1];
                            return (
                              <div class={`segment ${caption.frozen ? 'frozen' : ''}`} key={caption.id}>
                                <div class="segment-head">
                                  <b>第 {caption.segmentSeq} 段 · v{current.version}</b>
                                  <span class="pill">{caption.frozen ? '已冻结' : '当前段'}</span>
                                </div>
                                <p>{current.text}</p>
                                <div class="version-meta">
                                  起：{head.interpreter}（{clock(head.publishedAt)}） · 最新：{current.interpreter}（{clock(current.publishedAt)}）
                                </div>
                                {caption.versions.length > 1 && (
                                  <details class="decorative">
                                    <summary>历史版本（{caption.versions.length} 个，只追加不覆盖）</summary>
                                    {caption.versions.map((version) => (
                                      <div class="old-version" key={version.version}>
                                        <b>v{version.version} · {version.interpreter}</b>
                                        <span>{clock(version.publishedAt)}</span>
                                        <p>{version.text}</p>
                                      </div>
                                    ))}
                                  </details>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        <textarea
                          rows={3}
                          value={draftInputs[channel.id] ?? ''}
                          disabled={Boolean(open) || !binding}
                          placeholder={
                            open
                              ? STAGE_LABEL[open.stage] + '：草稿已失效/冻结，不可输入'
                              : binding
                                ? `${binding.interpreter} 的实时草稿（署名以绑定为准）`
                                : '频道未绑定当前发言'
                          }
                          onInput$={(event) => onDraftInput$(channel.id, (event.target as HTMLTextAreaElement).value)}
                        />
                        {draft && (
                          <div style="font-size:12px;color:#59747b;margin-top:4px">
                            草稿归属：{draft.interpreter} · epoch {draft.epoch}
                          </div>
                        )}
                        <div style="margin-top:6px">
                          <button disabled={Boolean(open) || !binding} onClick$={() => onPublish$(channel.id)}>
                            {captions.some((caption) => !caption.frozen) ? '提交修正版（追加版本）' : '提交并开启下一段'}
                          </button>
                        </div>
                      </>
                    ) : (
                      <p style="color:#638087;font-size:13px">本厅当前没有发言中的代表。</p>
                    )}
                  </div>
                )}

                {isSelected && channelHandoffHistory(channel.id).length > 0 && (
                  <div class="caption-zone decorative" style="font-size:12px;color:#59747b">
                    本频道交接记录：
                    {channelHandoffHistory(channel.id).map((handoff) => (
                      <div key={handoff.id}>
                        {clock(handoff.startedAt)} · {handoff.outgoingInterpreter} → {handoff.incomingInterpreter} ·{' '}
                        {STAGE_LABEL[handoff.stage]} · 尝试 {handoff.attempt} 次
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </aside>
      </section>

      <section class="grid" style="margin-top:18px">
        <article class="panel">
          <h2>术语库</h2>
          {state.terms.map((term) => (
            <div class="queue-row" key={term.id}>
              <span />
              <div>
                <b>{term.phrase}</b>
                <div>
                  {term.translation} · {term.language}
                </div>
              </div>
              <span class="pill">{term.approved ? '已批准' : '待审'}</span>
              <button disabled={term.approved} onClick$={() => onApproveTerm$(term.id)}>
                批准
              </button>
            </div>
          ))}
        </article>

        <article class="panel">
          <h2>时间线（发言 · 绑定 · 交接 · 字幕版本）</h2>
          {roomAudits().map((audit) => (
            <div class="timeline-row" key={audit.id}>
              <span class={`kind kind-${audit.kind}`}>{KIND_LABEL[audit.kind]}</span>
              <div>
                <small>#{audit.seq} · {clock(audit.at)}</small>
                <div>{audit.message}</div>
              </div>
            </div>
          ))}
        </article>
      </section>
    </main>
  );
});

export const head: DocumentHead = {
  title: '国际会议同声传译控制台',
  meta: [
    { name: 'description', content: '发言与频道接续绑定、译员交接状态机、分段版本化字幕与跨厅隔离' }
  ]
};
