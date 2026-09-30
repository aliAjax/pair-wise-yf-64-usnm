// 会议同传领域模型：发言↔频道绑定、译员交接状态机、分段版本化字幕、草稿失效。
// 本文件为纯函数模块，不依赖 Qwik / DOM（localStorage 持久化在 UI 层完成）。

export type SpeechStatus = 'queued' | 'speaking' | 'done' | 'skipped';
export type ChannelStatus = 'active' | 'handoff' | 'standby';
export type HandoffStage = 'frozen' | 'pending' | 'confirmed' | 'failed';
export const OPEN_HANDOFF_STAGES: ReadonlyArray<HandoffStage> = ['frozen', 'pending', 'failed'];

export type AuditKind =
  | 'binding'
  | 'speech'
  | 'queue'
  | 'handoff'
  | 'draft'
  | 'caption'
  | 'term'
  | 'room'
  | 'note';

export interface Room {
  id: string;
  name: string;
  topic: string;
  simultaneousChannels: number;
}

export interface Speech {
  id: string;
  roomId: string;
  speaker: string;
  delegation: string;
  language: string;
  topic: string;
  plannedSeconds: number;
  remainingSeconds: number;
  status: SpeechStatus;
  startedAt: string | null;
  updatedAt: string;
}

export interface Channel {
  id: string;
  roomId: string;
  language: string;
  interpreter: string;
  status: ChannelStatus;
  health: number;
}

export interface Term {
  id: string;
  phrase: string;
  translation: string;
  language: string;
  approved: boolean;
}

/** 发言与频道的接续绑定：一条发言在一个频道上由谁署名，交接确认前不可变。 */
export interface Assignment {
  speechId: string;
  channelId: string;
  roomId: string;
  language: string;
  interpreter: string;
  boundAt: string;
}

export interface CaptionVersion {
  version: number;
  interpreter: string;
  text: string;
  publishedAt: string;
}

/**
 * 字幕段：同一段发言同传输出的连续修正共享 segmentSeq。
 * frozen=true 表示交接边界已定，任何人只能追加新版本到新段，不能再改本段。
 */
export interface Caption {
  id: string;
  speechId: string;
  channelId: string;
  roomId: string;
  segmentSeq: number;
  frozen: boolean;
  versions: CaptionVersion[];
  createdAt: string;
  updatedAt: string;
}

/** 未提交草稿：带属主演员与 epoch；epoch 落后即作废，杜绝旧稿以新译员名义发出。 */
export interface Draft {
  channelId: string;
  roomId: string;
  speechId: string;
  interpreter: string;
  text: string;
  epoch: number;
  updatedAt: string;
}

export interface Handoff {
  id: string;
  channelId: string;
  roomId: string;
  speechId: string;
  outgoingInterpreter: string;
  incomingInterpreter: string;
  stage: HandoffStage;
  /** 边界段：该段及之前归原译员，确认后下一段起归新译员。启动时确定，重试不改变。 */
  boundarySegmentSeq: number;
  /** 每次新交接递增；草稿 epoch 落后即失效。 */
  epoch: number;
  attempt: number;
  startedAt: string;
  updatedAt: string;
  confirmedAt: string | null;
}

export interface Audit {
  id: string;
  seq: number;
  at: string;
  roomId: string;
  kind: AuditKind;
  message: string;
  refs?: {
    speechId?: string;
    channelId?: string;
    captionId?: string;
    handoffId?: string;
    segmentSeq?: number;
    version?: number;
    interpreter?: string;
  };
}

export interface ConferenceState {
  version: 2;
  handoffEpoch: number;
  rooms: Room[];
  activeRoomId: string;
  speechQueue: Speech[];
  channels: Channel[];
  terms: Term[];
  assignments: Assignment[];
  captions: Caption[];
  drafts: Draft[];
  handoffs: Handoff[];
  audits: Audit[];
  lowLatency: boolean;
}

export const STORAGE_KEY = 'conference-interpretation-v2';

const uid = (prefix: string): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `${prefix}-${crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const iso = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString();

function addAudit(
  state: ConferenceState,
  roomId: string,
  kind: AuditKind,
  message: string,
  refs?: Audit['refs']
): void {
  const seq = state.audits.length > 0 ? Math.max(...state.audits.map((item) => item.seq)) + 1 : 1;
  state.audits.unshift({ id: uid('audit'), seq, at: iso(), roomId, kind, message, refs });
}

// ---------------------------------------------------------------- 选择器

export function getCurrentSpeech(state: ConferenceState, roomId: string): Speech | undefined {
  return state.speechQueue.find((item) => item.roomId === roomId && item.status === 'speaking');
}

export function getAssignment(
  state: ConferenceState,
  speechId: string,
  channelId: string
): Assignment | undefined {
  return state.assignments.find((item) => item.speechId === speechId && item.channelId === channelId);
}

/** 频道上最近一次未闭合的交接（frozen/pending/failed）。 */
export function getOpenHandoff(state: ConferenceState, channelId: string): Handoff | undefined {
  return [...state.handoffs]
    .reverse()
    .find((item) => item.channelId === channelId && OPEN_HANDOFF_STAGES.includes(item.stage));
}

export function getLatestHandoff(state: ConferenceState, channelId: string): Handoff | undefined {
  return [...state.handoffs].reverse().find((item) => item.channelId === channelId);
}

export function getDraft(state: ConferenceState, channelId: string): Draft | undefined {
  return state.drafts.find((item) => item.channelId === channelId);
}

export function getChannelCaptions(
  state: ConferenceState,
  speechId: string,
  channelId: string
): Caption[] {
  return state.captions
    .filter((item) => item.speechId === speechId && item.channelId === channelId)
    .sort((a, b) => a.segmentSeq - b.segmentSeq);
}

function getLastCaption(
  state: ConferenceState,
  speechId: string,
  channelId: string
): Caption | undefined {
  const list = getChannelCaptions(state, speechId, channelId);
  return list[list.length - 1];
}

// ---------------------------------------------------------------- 发言与绑定

/** 发言开始：同厅其他发言自动结束；厅内活跃频道与当前发言绑定（带译员快照）。 */
export function startSpeech(state: ConferenceState, speechId: string): string | null {
  const speech = state.speechQueue.find((item) => item.id === speechId);
  if (!speech) return '发言不存在';
  if (speech.status === 'speaking') return null;

  for (const other of state.speechQueue.filter(
    (item) => item.roomId === speech.roomId && item.status === 'speaking'
  )) {
    other.status = 'done';
    other.updatedAt = iso();
    addAudit(state, other.roomId, 'speech', `${other.speaker} 的发言因新发言开始而自动结束`, {
      speechId: other.id
    });
  }

  speech.status = 'speaking';
  speech.startedAt = iso();
  speech.remainingSeconds = speech.plannedSeconds;
  speech.updatedAt = iso();

  const bound: string[] = [];
  for (const channel of state.channels.filter(
    (item) => item.roomId === speech.roomId && item.status === 'active'
  )) {
    if (!getAssignment(state, speech.id, channel.id)) {
      state.assignments.push({
        speechId: speech.id,
        channelId: channel.id,
        roomId: speech.roomId,
        language: channel.language,
        interpreter: channel.interpreter,
        boundAt: iso()
      });
    }
    bound.push(`${channel.language}=${channel.interpreter}`);
  }

  addAudit(
    state,
    speech.roomId,
    'binding',
    `${speech.speaker} 开始发言，频道接续绑定：${bound.join('、') || '厅内暂无活跃频道'}`,
    { speechId: speechId }
  );
  return null;
}

export function changeSpeechStatus(
  state: ConferenceState,
  speechId: string,
  status: SpeechStatus
): string | null {
  const speech = state.speechQueue.find((item) => item.id === speechId);
  if (!speech) return '发言不存在';
  if (status === 'speaking') return startSpeech(state, speechId);

  speech.status = status;
  speech.updatedAt = iso();
  const label = status === 'done' ? '结束' : status === 'skipped' ? '跳过' : '重新排队';
  addAudit(state, speech.roomId, 'speech', `${speech.speaker} 的发言已${label}`, {
    speechId: speech.id
  });
  return null;
}

export function addSpeech(
  state: ConferenceState,
  values: {
    speaker: string;
    delegation: string;
    language: string;
    topic: string;
    plannedSeconds: number;
  }
): string | null {
  state.speechQueue.push({
    id: uid('speech'),
    roomId: state.activeRoomId,
    speaker: values.speaker,
    delegation: values.delegation,
    language: values.language,
    topic: values.topic,
    plannedSeconds: values.plannedSeconds,
    remainingSeconds: values.plannedSeconds,
    status: 'queued',
    startedAt: null,
    updatedAt: iso()
  });
  addAudit(state, state.activeRoomId, 'queue', `${values.speaker} 已加入发言队列`);
  return null;
}

/** 备用频道上线：与当前发言绑定后才能接稿。 */
export function activateChannel(state: ConferenceState, channelId: string): string | null {
  const channel = state.channels.find((item) => item.id === channelId);
  if (!channel) return '频道不存在';
  if (channel.status === 'handoff') return '交接中的频道不能改状态';
  if (channel.status === 'active') return null;
  const speech = getCurrentSpeech(state, channel.roomId);
  channel.status = 'active';
  if (speech && !getAssignment(state, speech.id, channelId)) {
    state.assignments.push({
      speechId: speech.id,
      channelId: channel.id,
      roomId: channel.roomId,
      language: channel.language,
      interpreter: channel.interpreter,
      boundAt: iso()
    });
    addAudit(
      state,
      channel.roomId,
      'binding',
      `${channel.language}频道上线，${channel.interpreter} 与当前发言 ${speech.speaker} 绑定`,
      { channelId, speechId: speech.id, interpreter: channel.interpreter }
    );
  }
  return null;
}

// ---------------------------------------------------------------- 交接状态机

function removeStaleDraft(
  state: ConferenceState,
  channelId: string,
  message: string
): void {
  const draft = getDraft(state, channelId);
  if (!draft) return;
  state.drafts = state.drafts.filter((item) => item.channelId !== channelId);
  addAudit(state, draft.roomId, 'draft', message, {
    channelId,
    speechId: draft.speechId,
    interpreter: draft.interpreter
  });
}

/**
 * 启动交接：冻结当前段（定下边界）、抬升 epoch 作废旧草稿、频道进入 handoff。
 * 冻结后原译员只能完成当前段——而当前段已冻结，不能再产生任何修改。
 */
export function startHandoff(
  state: ConferenceState,
  channelId: string,
  incomingInterpreter: string
): string | null {
  const channel = state.channels.find((item) => item.id === channelId);
  if (!channel) return '频道不存在';
  if (channel.status !== 'active') return '频道当前状态不可启动交接';
  if (getOpenHandoff(state, channelId)) return '该频道已有进行中的交接';

  const speech = getCurrentSpeech(state, channel.roomId);
  if (!speech) return '当前没有进行中的发言，无法交接';

  const incoming = incomingInterpreter.trim();
  if (incoming.length < 2) return '请填写接班译员姓名';

  let assignment = getAssignment(state, speech.id, channelId);
  if (!assignment) {
    assignment = {
      speechId: speech.id,
      channelId: channel.id,
      roomId: channel.roomId,
      language: channel.language,
      interpreter: channel.interpreter,
      boundAt: iso()
    };
    state.assignments.push(assignment);
  }
  const outgoing = assignment.interpreter;

  const lastCaption = getLastCaption(state, speech.id, channelId);
  if (lastCaption && !lastCaption.frozen) {
    lastCaption.frozen = true;
    lastCaption.updatedAt = iso();
  }
  const boundarySegmentSeq = lastCaption?.segmentSeq ?? 0;

  state.handoffEpoch += 1;
  const handoff: Handoff = {
    id: uid('handoff'),
    channelId,
    roomId: channel.roomId,
    speechId: speech.id,
    outgoingInterpreter: outgoing,
    incomingInterpreter: incoming,
    stage: 'frozen',
    boundarySegmentSeq,
    epoch: state.handoffEpoch,
    attempt: 1,
    startedAt: iso(),
    updatedAt: iso(),
    confirmedAt: null
  };
  state.handoffs.unshift(handoff);
  channel.status = 'handoff';

  removeStaleDraft(
    state,
    channelId,
    `${outgoing} 未提交的草稿已随交接冻结作废（边界：第 ${boundarySegmentSeq || 0} 段）`
  );
  addAudit(
    state,
    channel.roomId,
    'handoff',
    `交接启动：${channel.language}频道 ${outgoing} → ${incoming}，第 ${boundarySegmentSeq || 0} 段已冻结，原译员只能完成当前段`,
    { channelId, speechId: speech.id, handoffId: handoff.id, segmentSeq: boundarySegmentSeq }
  );
  return null;
}

/** frozen → pending：交接状态更新，任何残留草稿立即失效。 */
export function advanceHandoffToPending(state: ConferenceState, handoffId: string): string | null {
  const handoff = state.handoffs.find((item) => item.id === handoffId);
  if (!handoff) return '交接记录不存在';
  if (handoff.stage !== 'frozen') return '只有已冻结步骤可以进入待确认';

  handoff.stage = 'pending';
  handoff.updatedAt = iso();
  removeStaleDraft(state, handoff.channelId, '交接进入待确认，旧草稿立即失效');
  addAudit(state, handoff.roomId, 'handoff', `交接进入待确认：${handoff.incomingInterpreter} 等待接续确认`, {
    handoffId,
    channelId: handoff.channelId,
    speechId: handoff.speechId
  });
  return null;
}

/** 模拟交接失败：frozen/pending → failed，可从待确认步骤重试。 */
export function failHandoff(state: ConferenceState, handoffId: string, reason: string): string | null {
  const handoff = state.handoffs.find((item) => item.id === handoffId);
  if (!handoff) return '交接记录不存在';
  if (handoff.stage === 'confirmed') return '交接已确认，不能标记失败';
  if (handoff.stage === 'failed') return null;

  handoff.stage = 'failed';
  handoff.updatedAt = iso();
  addAudit(
    state,
    handoff.roomId,
    'handoff',
    `交接失败（第 ${handoff.attempt} 次尝试）：${reason}；可从待确认步骤重试，已发布字幕不受影响`,
    { handoffId, channelId: handoff.channelId, speechId: handoff.speechId }
  );
  return null;
}

/** failed → pending：从待确认步骤重试。仅增加尝试计数，不改归属、不覆盖字幕。 */
export function retryHandoff(state: ConferenceState, handoffId: string): string | null {
  const handoff = state.handoffs.find((item) => item.id === handoffId);
  if (!handoff) return '交接记录不存在';
  if (handoff.stage !== 'failed') return '只有失败的交接可以重试';

  handoff.stage = 'pending';
  handoff.attempt += 1;
  handoff.updatedAt = iso();
  removeStaleDraft(state, handoff.channelId, '交接重试，交接期间的草稿一律作废');
  addAudit(
    state,
    handoff.roomId,
    'handoff',
    `从待确认步骤重试交接（第 ${handoff.attempt} 次尝试）：${handoff.outgoingInterpreter} → ${handoff.incomingInterpreter}；边界仍为第 ${handoff.boundarySegmentSeq || 0} 段，归属与已发布字幕不变`,
    { handoffId, channelId: handoff.channelId, speechId: handoff.speechId, segmentSeq: handoff.boundarySegmentSeq }
  );
  return null;
}

/** pending → confirmed：幂等关键——仅 pending 可确认，重复确认不会重复归属。 */
export function confirmHandoff(state: ConferenceState, handoffId: string): string | null {
  const handoff = state.handoffs.find((item) => item.id === handoffId);
  if (!handoff) return '交接记录不存在';
  if (handoff.stage === 'confirmed') return null; // 幂等：重复确认无副作用
  if (handoff.stage === 'failed') return '交接处于失败状态，请先从待确认步骤重试';
  if (handoff.stage === 'frozen') return '请先进入待确认步骤';

  const channel = state.channels.find((item) => item.id === handoff.channelId);
  if (channel) {
    channel.interpreter = handoff.incomingInterpreter;
    channel.status = 'active';
  }

  // 当前发言在该频道的署名改为新译员；只影响下一段起的字幕。
  const assignment = getAssignment(state, handoff.speechId, handoff.channelId);
  if (assignment) assignment.interpreter = handoff.incomingInterpreter;
  else {
    state.assignments.push({
      speechId: handoff.speechId,
      channelId: handoff.channelId,
      roomId: handoff.roomId,
      language: channel?.language ?? '',
      interpreter: handoff.incomingInterpreter,
      boundAt: iso()
    });
  }

  handoff.stage = 'confirmed';
  handoff.confirmedAt = iso();
  handoff.updatedAt = iso();

  removeStaleDraft(state, handoff.channelId, `交接完成，${handoff.outgoingInterpreter} 的旧草稿全部作废`);
  addAudit(
    state,
    handoff.roomId,
    'handoff',
    `交接确认：${handoff.outgoingInterpreter} → ${handoff.incomingInterpreter}，第 ${handoff.attempt} 次尝试成功；第 ${handoff.boundarySegmentSeq || 0} 段及之前归原译员，新译员从下一段开始署名`,
    {
      handoffId,
      channelId: handoff.channelId,
      speechId: handoff.speechId,
      segmentSeq: handoff.boundarySegmentSeq,
      interpreter: handoff.incomingInterpreter
    }
  );
  return null;
}

// ---------------------------------------------------------------- 草稿与字幕

/** 编辑草稿：仅在无开放交接、且绑定译员与当前一致时允许；记录属主与 epoch。 */
export function editDraft(state: ConferenceState, channelId: string, text: string): string | null {
  const channel = state.channels.find((item) => item.id === channelId);
  if (!channel) return '频道不存在';
  const speech = getCurrentSpeech(state, channel.roomId);
  if (!speech) return '当前没有进行中的发言';
  const assignment = getAssignment(state, speech.id, channelId);
  if (!assignment) return '该频道尚未与当前发言绑定';

  const open = getOpenHandoff(state, channelId);
  if (open) {
    if (open.stage === 'frozen') return '交接已冻结：原译员只能查看当前段，草稿暂停';
    if (open.stage === 'pending') return '交接待确认，草稿已失效，请等待新译员接续';
    return '交接失败待重试，请从待确认步骤重试后再继续';
  }

  const existing = getDraft(state, channelId);
  if (existing) {
    existing.text = text;
    existing.interpreter = assignment.interpreter;
    existing.epoch = state.handoffEpoch;
    existing.updatedAt = iso();
  } else {
    state.drafts.unshift({
      channelId,
      roomId: channel.roomId,
      speechId: speech.id,
      interpreter: assignment.interpreter,
      text,
      epoch: state.handoffEpoch,
      updatedAt: iso()
    });
  }
  return null;
}

/**
 * 提交草稿。防护顺序：
 * 1) 必须有进行中的发言且草稿属于该发言；
 * 2) 开放交接期间禁止提交；
 * 3) 属主/epoch 不匹配（交接已发生）→ 拒绝并丢弃草稿，绝不以新译员名义发出旧稿；
 * 4) 当前段已冻结 → 自动开新段，新段归绑定译员（即新译员）。
 * 已发布版本只追加，永不覆盖。
 */
export function publishDraft(state: ConferenceState, channelId: string): string | null {
  const channel = state.channels.find((item) => item.id === channelId);
  if (!channel) return '频道不存在';
  const speech = getCurrentSpeech(state, channel.roomId);
  if (!speech) return '当前没有进行中的发言';
  const draft = getDraft(state, channelId);
  if (!draft || !draft.text.trim()) return '草稿为空，无法提交';

  const open = getOpenHandoff(state, channelId);
  if (open) {
    const hint =
      open.stage === 'frozen'
        ? '交接冻结中，当前段已定稿，不能再提交'
        : open.stage === 'pending'
          ? '交接待确认，草稿已失效，不能提交'
          : '交接失败待重试，请从待确认步骤重试';
    return hint;
  }

  const assignment = getAssignment(state, speech.id, channelId);
  if (!assignment) return '该频道尚未与当前发言绑定';

  if (draft.epoch !== state.handoffEpoch || draft.interpreter !== assignment.interpreter) {
    state.drafts = state.drafts.filter((item) => item.channelId !== channelId);
    addAudit(
      state,
      channel.roomId,
      'draft',
      `拦截过期草稿：${draft.interpreter} 的未提交稿在交接后试图发出，已丢弃；当前署名人是 ${assignment.interpreter}`,
      { channelId, speechId: speech.id, interpreter: assignment.interpreter }
    );
    return '草稿已随交接失效，内容已丢弃，请由新译员重新输入';
  }

  if (draft.speechId !== speech.id) {
    state.drafts = state.drafts.filter((item) => item.channelId !== channelId);
    return '草稿属于上一段发言，已丢弃，请从当前发言重新输入';
  }

  const text = draft.text.trim();
  const timestamp = iso();
  const lastCaption = getLastCaption(state, speech.id, channelId);

  if (lastCaption && !lastCaption.frozen) {
    const version: CaptionVersion = {
      version: lastCaption.versions.length + 1,
      interpreter: assignment.interpreter,
      text,
      publishedAt: timestamp
    };
    lastCaption.versions.push(version);
    lastCaption.updatedAt = timestamp;
    addAudit(
      state,
      channel.roomId,
      'caption',
      `字幕第 ${lastCaption.segmentSeq} 段发布修正版 v${version.version}，署名 ${assignment.interpreter}`,
      {
        channelId,
        speechId: speech.id,
        captionId: lastCaption.id,
        segmentSeq: lastCaption.segmentSeq,
        version: version.version,
        interpreter: assignment.interpreter
      }
    );
  } else {
    const segmentSeq = lastCaption ? lastCaption.segmentSeq + 1 : 1;
    const caption: Caption = {
      id: uid('caption'),
      speechId: speech.id,
      channelId,
      roomId: channel.roomId,
      segmentSeq,
      frozen: false,
      versions: [
        { version: 1, interpreter: assignment.interpreter, text, publishedAt: timestamp }
      ],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    state.captions.unshift(caption);
    const reason = lastCaption
      ? `前序段已冻结，开启第 ${segmentSeq} 段`
      : `第 1 段首次发布`;
    addAudit(
      state,
      channel.roomId,
      'caption',
      `字幕第 ${segmentSeq} 段 v1 发布，署名 ${assignment.interpreter}（${reason}）`,
      {
        channelId,
        speechId: speech.id,
        captionId: caption.id,
        segmentSeq,
        version: 1,
        interpreter: assignment.interpreter
      }
    );
  }

  state.drafts = state.drafts.filter((item) => item.channelId !== channelId);
  return null;
}

// ---------------------------------------------------------------- 术语与会议厅

export function approveTerm(state: ConferenceState, id: string): string | null {
  const term = state.terms.find((item) => item.id === id);
  if (!term || term.approved) return null;
  term.approved = true;
  addAudit(state, state.activeRoomId, 'term', `术语已批准：${term.phrase}`);
  return null;
}

export function selectRoom(state: ConferenceState, roomId: string): string | null {
  const room = state.rooms.find((item) => item.id === roomId);
  if (!room || roomId === state.activeRoomId) return null;
  state.activeRoomId = roomId;
  addAudit(state, roomId, 'room', `切换到 ${room.name}（其他厅的交接与字幕不受影响）`);
  return null;
}

// ---------------------------------------------------------------- 初始数据

const t0 = iso();
const tMinus = (seconds: number) => iso(-seconds * 1000);

export function createSeedState(): ConferenceState {
  return {
    version: 2,
    handoffEpoch: 1,
    rooms: [
      { id: 'hall-a', name: 'A厅 · 全体会议', topic: '全球气候融资', simultaneousChannels: 6 },
      { id: 'hall-b', name: 'B厅 · 技术分会', topic: '人工智能基础设施', simultaneousChannels: 4 }
    ],
    activeRoomId: 'hall-a',
    speechQueue: [
      {
        id: 'speech-1', roomId: 'hall-a', speaker: 'Amina Diallo', delegation: '塞内加尔',
        language: '英语', topic: '适应性融资缺口', plannedSeconds: 600, remainingSeconds: 214,
        status: 'speaking', startedAt: tMinus(386), updatedAt: tMinus(386)
      },
      {
        id: 'speech-2', roomId: 'hall-a', speaker: '李明远', delegation: '中国',
        language: '中文', topic: '绿色基础设施机制', plannedSeconds: 600, remainingSeconds: 600,
        status: 'queued', startedAt: null, updatedAt: t0
      },
      {
        id: 'speech-3', roomId: 'hall-b', speaker: 'Maria Silva', delegation: '巴西',
        language: '葡萄牙语', topic: '边缘算力与能源', plannedSeconds: 420, remainingSeconds: 420,
        status: 'queued', startedAt: null, updatedAt: t0
      }
    ],
    channels: [
      { id: 'ch-a-zh', roomId: 'hall-a', language: '中文', interpreter: '周雨', status: 'active', health: 96 },
      { id: 'ch-a-es', roomId: 'hall-a', language: '西班牙语', interpreter: 'Lucía M.', status: 'active', health: 91 },
      { id: 'ch-a-fr', roomId: 'hall-a', language: '法语', interpreter: 'Noah B.', status: 'standby', health: 88 },
      { id: 'ch-b-zh', roomId: 'hall-b', language: '中文', interpreter: '何佳', status: 'active', health: 94 }
    ],
    terms: [
      { id: 'term-1', phrase: 'loss and damage', translation: '损失与损害', language: '中文', approved: true },
      { id: 'term-2', phrase: 'edge inference', translation: '边缘推理', language: '中文', approved: true },
      { id: 'term-3', phrase: 'just transition', translation: '公正转型', language: '中文', approved: false }
    ],
    assignments: [
      { speechId: 'speech-1', channelId: 'ch-a-zh', roomId: 'hall-a', language: '中文', interpreter: '周雨', boundAt: tMinus(386) },
      { speechId: 'speech-1', channelId: 'ch-a-es', roomId: 'hall-a', language: '西班牙语', interpreter: 'Lucía M.', boundAt: tMinus(386) }
    ],
    captions: [
      {
        id: 'caption-1', speechId: 'speech-1', channelId: 'ch-a-zh', roomId: 'hall-a',
        segmentSeq: 1, frozen: false,
        createdAt: tMinus(200), updatedAt: tMinus(40),
        versions: [
          { version: 1, interpreter: '周雨', text: '我们需要把适应资金与韧性目标绑定。', publishedAt: tMinus(200) },
          { version: 2, interpreter: '周雨', text: '我们需要把适应资金与可衡量的社区韧性目标绑定。', publishedAt: tMinus(40) }
        ]
      }
    ],
    drafts: [],
    handoffs: [],
    audits: [
      {
        id: 'audit-seed-1', seq: 2, at: tMinus(90), roomId: 'hall-a', kind: 'queue',
        message: '临时插话申请已插入队列第2位'
      },
      {
        id: 'audit-seed-2', seq: 1, at: tMinus(386), roomId: 'hall-a', kind: 'binding',
        message: 'Amina Diallo 开始发言，频道接续绑定：中文=周雨、西班牙语=Lucía M.',
        refs: { speechId: 'speech-1' }
      }
    ],
    lowLatency: false
  };
}

export function migrateState(raw: unknown): ConferenceState {
  if (
    raw &&
    typeof raw === 'object' &&
    (raw as ConferenceState).version === 2 &&
    Array.isArray((raw as ConferenceState).assignments)
  ) {
    return raw as ConferenceState;
  }
  return createSeedState();
}
