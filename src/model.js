import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


export const POLICY = Object.freeze({ algorithm: 'reachable-product-bfs-v1', tieBreak: 'event-id-ascii-order-v1', acceptance: 'final-state-including-empty-word-v1', evidence: 'all-declared-states-known-v1' });
export const POLICY_HASH = hash(POLICY);
const safeId = (value, max) => word(value) && value.length <= max && !['constructor', 'prototype', '__proto__'].includes(value);
const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const roles = ['old', 'new'];

export function validateInput(input) {
  if (!keys(input, ['comparisonId', 'title', 'acceptanceDefinition', 'events', 'old', 'new'])
    || !word(input.comparisonId) || !line(input.title, 40) || !line(input.acceptanceDefinition, 100)
    || !Array.isArray(input.events) || input.events.length < 1 || input.events.length > 3) throw new Error('Provide a comparison ID, title, acceptance definition and one to three common events.');
  const eventIds = new Set();
  for (const event of input.events) {
    if (!keys(event, ['id', 'label']) || !safeId(event.id, 12) || !line(event.label, 30) || eventIds.has(event.id)) throw new Error('Events need unique safe IDs and descriptive labels.');
    eventIds.add(event.id);
  }
  const result = structuredClone(input); result.events.sort(byId);
  for (const role of roles) {
    const machine = result[role];
    if (!keys(machine, ['label', 'initialState', 'states', 'transitions']) || !line(machine.label, 30)
      || !Array.isArray(machine.states) || machine.states.length < 1 || machine.states.length > 4
      || !Array.isArray(machine.transitions) || machine.transitions.length !== machine.states.length * eventIds.size) throw new Error('Each machine needs one to four states and one transition for every state/event pair.');
    const stateIds = new Set();
    for (const state of machine.states) {
      if (!keys(state, ['id', 'meaning']) || !safeId(state.id, 16) || !line(state.meaning, 70) || stateIds.has(state.id)) throw new Error('States need unique safe IDs and meanings.');
      stateIds.add(state.id);
    }
    if (!stateIds.has(machine.initialState)) throw new Error('The initial state must be declared.');
    const pairs = new Set();
    for (const transition of machine.transitions) {
      if (!keys(transition, ['from', 'event', 'to']) || !stateIds.has(transition.from) || !stateIds.has(transition.to) || !eventIds.has(transition.event)) throw new Error('Transitions must reference declared states and common events.');
      const pair = `${transition.from}:${transition.event}`;
      if (pairs.has(pair)) throw new Error('A state/event pair must have exactly one transition.');
      pairs.add(pair);
    }
    machine.states.sort(byId);
    machine.transitions.sort((a,b) => a.from < b.from ? -1 : a.from > b.from ? 1 : a.event < b.event ? -1 : a.event > b.event ? 1 : 0);
  }
  return result;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact domain owner UUID and label.');
  return structuredClone(config);
}
export function tasksFor(rawInput) {
  const input = validateInput(rawInput);
  return roles.flatMap(role => input[role].states.map(state => ({ id: `${role}:${state.id}`, role, stateId: state.id, meaning: state.meaning })));
}
export function parseAcceptance(text) {
  if (text === 'Unknown') return { kind: 'unknown', accepting: null };
  if (text === 'Accepting') return { kind: 'known', accepting: true };
  if (text === 'Nonaccepting') return { kind: 'known', accepting: false };
  throw new Error('Reply exactly Accepting, Nonaccepting, or Unknown.');
}
export function requestFor(rawInput, config, taskId, attemptId) {
  const input = validateInput(rawInput); validateConfig(config);
  const task = tasksFor(input).find(task => task.id === taskId);
  if (!task || !isId(attemptId)) throw new Error('Invalid state or attempt.');
  const prompt = `${input.title}\nComparison: ${input.comparisonId}\nMachine: ${task.role} (${input[task.role].label})\nState: ${task.stateId} — ${task.meaning}\nAccepting means: ${input.acceptanceDefinition}\nWhen the sequence ends here, reply Accepting, Nonaccepting, or Unknown.`;
  if (prompt.length > 500) throw new Error('State prompt exceeds 500 characters.');
  const key = `protocol-${attemptId}`;
  return { prompt, context: `To ${config.participant.id}`, text_input: { placeholder: 'Accepting, Nonaccepting, or Unknown', max_length: 60 },
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), machine_hash: hash(input[task.role]), policy_hash: POLICY_HASH, task_id: taskId, attempt_id: attemptId }, idempotencyKey: key };
}

/** Exhaust the reachable product; the first disagreement has a shortest event word. */
export function compareMachines(rawInput, accepting) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!keys(accepting, tasks.map(task => task.id)) || tasks.some(task => typeof accepting[task.id] !== 'boolean')) throw new Error('Every declared state needs a Boolean acceptance judgment.');
  const tables = Object.fromEntries(roles.map(role => [role, new Map(input[role].transitions.map(row => [`${row.from}:${row.event}`, row.to]))]));
  const queue = [{ oldState: input.old.initialState, newState: input.new.initialState, word: [], oldTrace: [input.old.initialState], newTrace: [input.new.initialState] }];
  const seen = new Set([`${input.old.initialState}:${input.new.initialState}`]), reachablePairs = [];
  let counterexample = null;
  for (let index = 0; index < queue.length; index++) {
    const pair = queue[index], oldAccepts = accepting[`old:${pair.oldState}`], newAccepts = accepting[`new:${pair.newState}`];
    if (counterexample === null && oldAccepts !== newAccepts) counterexample = { word: pair.word, length: pair.word.length, oldTrace: pair.oldTrace, newTrace: pair.newTrace, oldAccepts, newAccepts };
    const transitions = input.events.map(event => {
      const oldState = tables.old.get(`${pair.oldState}:${event.id}`), newState = tables.new.get(`${pair.newState}:${event.id}`), key = `${oldState}:${newState}`;
      if (!seen.has(key)) {
        seen.add(key); queue.push({ oldState, newState, word: [...pair.word, event.id], oldTrace: [...pair.oldTrace, oldState], newTrace: [...pair.newTrace, newState] });
      }
      return { event: event.id, oldState, newState };
    });
    reachablePairs.push({ ...pair, oldAccepts, newAccepts, agree: oldAccepts === newAccepts, transitions });
  }
  return { equivalent: counterexample === null, productStateBound: input.old.states.length * input.new.states.length, reachablePairCount: reachablePairs.length, reachablePairs, counterexample };
}
export function protocolEquivalence(rawInput, answers) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!Array.isArray(answers) || answers.length !== tasks.length || Array.from(answers).some((row,index) => !keys(row, ['taskId','text']) || row.taskId !== tasks[index].id || row.text !== null && typeof row.text !== 'string')) throw new Error('Provide an ordered answer or missing outcome for every declared state.');
  const judgments = answers.map(row => row.text === null ? { accepting: null } : parseAcceptance(row.text));
  if (judgments.some(row => row.accepting === null)) return { status: 'incomplete', comparison: null };
  return { status: 'complete', comparison: compareMachines(input, Object.fromEntries(tasks.map((task,index) => [task.id, judgments[index].accepting]))) };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || state.credentialHash.length !== 64 || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > tasks.length || iso(state.startedAt) !== state.startedAt) {
    throw new Error('Invalid state or changed protocol models. Restore the original inputs.');
  }
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set();
  let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'taskId', 'createdAt', 'request', 'questionId', 'status', 'observation'])
      || !isId(attempt.id) || ids.has(attempt.id) || attempt.taskId !== tasks[index].id
      || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.taskId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) {
      throw new Error('Invalid saved state judgment request.');
    }
    ids.add(attempt.id);
    previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);
      validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS
        || attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates creation intent.');
      previous = attempt.observation.checkedAt;
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) {
      throw new Error('Only the last task may have an active Question.');
    }
  }
  return state;
}

export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = tasksFor(input).map(task => {
    const attempt = state.attempts.find(row => row.taskId === task.id), answer = attempt?.observation?.answer;
    return { taskId: task.id, role: task.role, stateId: task.stateId, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      text: answer?.text ?? null, kind: answer?.kind ?? null, accepting: answer?.accepting ?? null,
      questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null, responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const calculation = protocolEquivalence(input, answers.map(({ taskId, text }) => ({ taskId, text })));
  const active = answers.find(row => ['create_unknown', 'pending'].includes(row.status));
  const status = active?.status ?? (answers.some(row => row.status === 'unasked') ? 'ready' : calculation.status);
  return { comparisonId: input.comparisonId, source: input, sourceHash: hash(input), configHash: hash(state.config), policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, answers, comparison: calculation.comparison, applicationInspected: false, protocolExecuted: false, status };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['text', 'kind', 'accepting', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || hash(parseAcceptance(answer.text)) !== hash({ kind: answer.kind, accepting: answer.accepting })
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved accepting evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered tasks must not contain accepting evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || hash(q.text_input) !== hash(request.text_input) || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== 0) throw new Error('Question does not match the saved task, room, or domain owner.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.value !== null || answer.label !== null || answer.responder?.id !== request.target_user_id || typeof answer.text !== 'string' || answer.text.length > 60) throw new Error('Invalid text answer.');
      observation.answer = { text: answer.text, ...parseAcceptance(answer.text), responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
