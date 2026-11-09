import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportComparison } from '../src/engine.js';
import { readJson, atomicJson, acquireLock, atomicText } from '../src/storage.js';
import { validateInput, validateState, tasksFor, parseAcceptance, protocolEquivalence, compareMachines, POLICY, POLICY_HASH, TOKEN, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/protocol.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = () => structuredClone(example);
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-protocol-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later state judgments; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'Nonaccepting'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options = [{value:'yes',label:'Yes'}]; }, (q) => { q.text_input.max_length = 30; }, (q) => { q.text_input = null; },
    (q) => { q.data.task_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('misattributed, malformed or non-text answers never resolve a state judgment', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = '1e2'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'Nonaccepting'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.comparison, null);
    assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across state judgments', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), 'Nonaccepting'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).observedStatus, 'expired'); assert.equal((await localReport(s.directory, s.options.input)).comparison, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'Nonaccepting');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'Nonaccepting'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'Nonaccepting'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing operator before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'Nonaccepting');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'Nonaccepting'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).comparison, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});



const answersFor = (input, values) => tasksFor(input).map((task,index)=>({taskId:task.id,text:values[index]}));
const labelsFor = (input, values) => Object.fromEntries(tasksFor(input).map((task,index)=>[task.id,values[index]]));
function smallMachine(count, table, symbols=['a','b']) {
  return {label:'Practice machine',initialState:'q0',states:Array.from({length:count},(_,i)=>({id:`q${i}`,meaning:`Practice state ${i}`})),
    transitions:Array.from({length:count},(_,i)=>symbols.map((event,j)=>({from:`q${i}`,event,to:`q${table[i*symbols.length+j]}`}))).flat()};
}
function pair(oldMachine,newMachine,symbols=['a','b']) {
  return {comparisonId:'fixture-v1',title:'Practice comparison',acceptanceDefinition:'The practice sequence has completed.',events:symbols.map(id=>({id,label:`Event ${id}`})),old:oldMachine,new:newMachine};
}
function runWord(machine, word) {
  let current=machine.initialState;const trace=[current];
  for(const event of word){current=machine.transitions.find(row=>row.from===current&&row.event===event).to;trace.push(current);}
  return trace;
}
// A shortest distinguishing path cannot repeat a product state: bound n*m−1.
function wordOracle(input, labels) {
  const symbols=input.events.map(row=>row.id).sort(),bound=input.old.states.length*input.new.states.length-1;
  let words=[[]];
  for(let length=0;length<=bound;length++){
    for(const word of words){const oldTrace=runWord(input.old,word),newTrace=runWord(input.new,word),oldAccepts=labels[`old:${oldTrace.at(-1)}`],newAccepts=labels[`new:${newTrace.at(-1)}`];
      if(oldAccepts!==newAccepts)return {word,length,oldTrace,newTrace,oldAccepts,newAccepts};}
    words=words.flatMap(word=>symbols.map(symbol=>[...word,symbol]));
  }
  return null;
}
// Refine a disjoint union by final-state labels and successor blocks, without product traversal.
function partitionOracle(input, labels) {
  const states=['old','new'].flatMap(role=>input[role].states.map(state=>({role,id:state.id,key:`${role}:${state.id}`}))),symbols=input.events.map(row=>row.id);
  let blocks=Object.fromEntries(states.map(state=>[state.key,Number(labels[state.key])]));
  for(;;){
    const signatures=new Map(),next={};
    for(const state of states){const targets=symbols.map(event=>{const to=input[state.role].transitions.find(row=>row.from===state.id&&row.event===event).to;return blocks[`${state.role}:${to}`];});
      const signature=JSON.stringify([labels[state.key],...targets]);if(!signatures.has(signature))signatures.set(signature,signatures.size);next[state.key]=signatures.get(signature);}
    const stable=states.every(a=>states.every(b=>(blocks[a.key]===blocks[b.key])===(next[a.key]===next[b.key])));blocks=next;
    if(stable)return blocks[`old:${input.old.initialState}`]===blocks[`new:${input.new.initialState}`];
  }
}

test('acceptance grammar preserves Nonaccepting false and rejects normalization guesses',()=>{
  assert.deepEqual(parseAcceptance('Accepting'),{kind:'known',accepting:true});assert.deepEqual(parseAcceptance('Nonaccepting'),{kind:'known',accepting:false});assert.deepEqual(parseAcceptance('Unknown'),{kind:'unknown',accepting:null});
  for(const text of ['',null,true,'accepting','NonAccepting','Unknown\n','Accepting\r\n','Accepting\u2028','Accepting\u2029',' Accepting','Nonaccepting ','Ａccepting','\ud800'])assert.throws(()=>parseAcceptance(text));
});

test('renamed but behaviorally identical machines prove equivalent over their reachable closure',()=>{
  const input=simple(),labels=labelsFor(input,[false,true,false,true]),result=compareMachines(input,labels);
  assert.equal(result.equivalent,true);assert.equal(result.counterexample,null);assert.equal(result.productStateBound,4);assert.equal(result.reachablePairCount,2);
  assert.deepEqual(result.reachablePairs.map(row=>[row.oldState,row.newState]),[['off','dark'],['on','lit']]);
  assert.ok(result.reachablePairs.every(row=>row.agree));
  const reachable=new Set(result.reachablePairs.map(row=>`${row.oldState}:${row.newState}`));
  for(const row of result.reachablePairs)for(const next of row.transitions)assert.ok(reachable.has(`${next.oldState}:${next.newState}`));
});

test('empty word is the shortest difference when initial acceptance labels disagree',()=>{
  const input=simple(),result=compareMachines(input,labelsFor(input,[false,true,true,true]));
  assert.equal(result.equivalent,false);assert.deepEqual(result.counterexample,{word:[],length:0,oldTrace:['off'],newTrace:['dark'],oldAccepts:false,newAccepts:true});
});

test('4096 two-state binary DFA pairs match independently enumerated words through length three',()=>{
  let checked=0;
  for(let left=0;left<16;left++)for(let right=0;right<16;right++)for(let mask=0;mask<16;mask++){
    const table=code=>Array.from({length:4},(_,i)=>(code>>i)&1),input=pair(smallMachine(2,table(left)),smallMachine(2,table(right))),labels=labelsFor(input,Array.from({length:4},(_,i)=>Boolean(mask&(1<<i))));
    const expected=wordOracle(input,labels),actual=compareMachines(input,labels);
    assert.equal(actual.equivalent,expected===null);assert.deepEqual(actual.counterexample,expected);assert.ok(actual.reachablePairCount<=4);checked++;
  }
  assert.equal(checked,4096);
});

test('512 larger deterministic models match disjoint-union partition refinement',()=>{
  let seed=193;const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let trial=0;trial<512;trial++){
    const countA=1+next()%4,countB=1+next()%4,symbols=['a','b','c'].slice(0,1+next()%3);
    const input=pair(smallMachine(countA,Array.from({length:countA*symbols.length},()=>next()%countA),symbols),smallMachine(countB,Array.from({length:countB*symbols.length},()=>next()%countB),symbols),symbols);
    const labels=labelsFor(input,tasksFor(input).map(()=>Boolean(next()&16))),result=compareMachines(input,labels);
    assert.equal(result.equivalent,partitionOracle(input,labels));assert.ok(result.reachablePairCount<=countA*countB);
    if(result.counterexample){const w=result.counterexample;assert.deepEqual(w.oldTrace,runWord(input.old,w.word));assert.deepEqual(w.newTrace,runWord(input.new,w.word));assert.notEqual(w.oldAccepts,w.newAccepts);assert.ok(w.length<countA*countB);}
  }
});

test('equal-length counterexamples use lexicographic event IDs regardless of input array order',()=>{
  const input=pair(smallMachine(2,[1,1,1,1]),smallMachine(2,[0,0,0,0])),labels=labelsFor(input,[false,true,false,true]);
  input.events.reverse();input.old.states.reverse();input.new.states.reverse();input.old.transitions.reverse();input.new.transitions.reverse();
  const result=compareMachines(input,labels);assert.deepEqual(result.counterexample.word,['a']);assert.equal(result.counterexample.length,1);
});

test('unreachable disagreeing state labels do not change languages but still require known evidence',()=>{
  const input=pair(smallMachine(2,[0,0,1,1]),smallMachine(2,[0,0,1,1]));
  const known=protocolEquivalence(input,answersFor(input,['Nonaccepting','Accepting','Nonaccepting','Nonaccepting']));assert.equal(known.comparison.equivalent,true);assert.equal(known.comparison.reachablePairCount,1);
  const unknown=protocolEquivalence(input,answersFor(input,['Nonaccepting','Unknown','Nonaccepting','Nonaccepting']));assert.deepEqual(unknown,{status:'incomplete',comparison:null});
});

test('one-state cycles and all-accepting or all-rejecting finite machines terminate',()=>{
  const input=pair(smallMachine(1,[0],['a']),smallMachine(1,[0],['a']),['a']);
  for(const accepted of [false,true]){const result=compareMachines(input,labelsFor(input,[accepted,accepted]));assert.equal(result.equivalent,true);assert.equal(result.reachablePairCount,1);assert.equal(result.productStateBound,1);}
});

test('a long counterexample traverses distinct pairs before revealing the changed behavior',()=>{
  const input=pair(smallMachine(4,[1,1,2,2,3,3,3,3]),smallMachine(4,[1,1,2,2,3,3,3,3]));
  const labels=labelsFor(input,[false,false,false,true,false,false,false,false]),result=compareMachines(input,labels);
  assert.deepEqual(result.counterexample.word,['a','a','a']);assert.deepEqual(result.counterexample.oldTrace,['q0','q1','q2','q3']);assert.equal(result.counterexample.newAccepts,false);
});

test('canonical arrays preserve hashes while state meanings, event labels and transitions remain bound',()=>{
  const input=simple(),canonical=validateInput(input),before=structuredClone(input),reordered=structuredClone(input);reordered.events.reverse();
  for(const role of ['old','new']){reordered[role].states.reverse();reordered[role].transitions.reverse();}
  assert.deepEqual(validateInput(reordered),canonical);assert.deepEqual(input,before);assert.equal(hash(validateInput(reordered)),hash(canonical));
  reordered.old.states[0].meaning='A different interpretation.';assert.notEqual(hash(validateInput(reordered)),hash(canonical));
});

test('schemas reject partial, nondeterministic, out-of-alphabet and malformed machines',()=>{
  const input=simple();
  for(const mutate of [v=>v.old.transitions.pop(),v=>v.old.transitions[1]=v.old.transitions[0],v=>v.old.transitions[0].to='missing',v=>v.old.transitions[0].from='missing',v=>v.old.transitions[0].event='missing',v=>v.old.initialState='missing',v=>v.old.states[1].id=v.old.states[0].id,v=>v.old.states=[],v=>v.old.states.push({id:'a',meaning:'a'},{id:'b',meaning:'b'},{id:'c',meaning:'c'}),v=>v.events[1].id=v.events[0].id,v=>v.events=[],v=>v.events.push({id:'a',label:'a'},{id:'b',label:'b'}),v=>v.new.extra=true,v=>v.old.transitions[0].extra=true,v=>v.old.states[0].id='constructor',v=>v.events[0].id='prototype',v=>v.title='x\n',v=>v.acceptanceDefinition='x\u2028y',v=>v.old.states[0].meaning='\ud800',v=>v.extra=true]){
    const bad=structuredClone(input);mutate(bad);assert.throws(()=>validateInput(bad));
  }
  const unicode=simple();unicode.title='模型比較';unicode.old.states[0].meaning='المصباح مطفأ';assert.equal(validateInput(unicode).title,unicode.title);
  for(const labels of [{},labelsFor(input,[false,true,false,null]),{...labelsFor(input,[false,true,false,true]),extra:true}])assert.throws(()=>compareMachines(input,labels));
});

test('maximum labels and eight-state requests retain substantive meanings within SDK bounds',()=>{
  const input=pair(smallMachine(4,Array(12).fill(0),['a','b','c']),smallMachine(4,Array(12).fill(0),['a','b','c']),['a','b','c']);
  input.title='t'.repeat(40);input.comparisonId='c'.repeat(40);input.acceptanceDefinition='d'.repeat(100);for(const role of ['old','new']){input[role].label='m'.repeat(30);for(const state of input[role].states)state.meaning='s'.repeat(70);}
  assert.equal(tasksFor(input).length,8);
  for(const task of tasksFor(input)){const request=requestFor(input,CONFIG,task.id,id(42));assert.ok(request.prompt.length<=500);assert.ok(request.context.length<=40);assert.ok(request.prompt.includes(input.acceptanceDefinition));assert.ok(request.prompt.includes(task.meaning));assert.ok(request.prompt.includes(task.role));assert.equal(request.data.machine_hash,hash(validateInput(input)[task.role]));assert.equal(request.data.policy_hash,POLICY_HASH);assert.equal(request.data.input_hash,hash(validateInput(input)));assert.equal(request.ttl,900);assert.equal(request.text_input.max_length,60);assert.equal(request.responder_scope,'direct');assert.equal(request.target_user_id,CONFIG.participant.id);}
});

test('missing, Unknown, sparse, reordered and surplus evidence never produces a comparison',()=>{
  const input=simple();for(const values of [[null,'Accepting','Nonaccepting','Accepting'],['Nonaccepting','Unknown','Nonaccepting','Accepting']])assert.deepEqual(protocolEquivalence(input,answersFor(input,values)),{status:'incomplete',comparison:null});
  for(const rows of [[],Array(4),answersFor(input,['Nonaccepting','Accepting','Nonaccepting','Accepting']).reverse(),[...answersFor(input,['Nonaccepting','Accepting','Nonaccepting','Accepting']),{taskId:'extra',text:'Unknown'}],answersFor(input,[false,true,false,true])])assert.throws(()=>protocolEquivalence(input,rows));
});

test('both equivalence and known differences export complete attributed private JSON',async t=>{
  for(const [values,equivalent] of [[['Nonaccepting','Accepting','Nonaccepting','Accepting'],true],[['Nonaccepting','Accepting','Nonaccepting','Nonaccepting'],false]]){
    const s=await setup(t),result=await decide(s,values);assert.equal(result.status,'complete');assert.equal(result.comparison.equivalent,equivalent);assert.equal(result.applicationInspected,false);assert.equal(result.protocolExecuted,false);assert.deepEqual(result.source,validateInput(s.options.input));
    assert.ok(result.answers.every(row=>row.questionId&&row.attemptId&&row.responderId===CONFIG.participant.id&&row.askerId===ASKER&&row.answeredAt));const calls=s.api.calls.length;
    const exported=await exportComparison(s.directory,s.options.input);assert.equal(exported.comparison.equivalent,equivalent);assert.equal(s.api.calls.length,calls);
    const path=join(s.directory,'comparison.json'),first=await readFile(path,'utf8');assert.deepEqual(JSON.parse(first),exported);await exportComparison(s.directory,s.options.input);assert.equal(await readFile(path,'utf8'),first);assert.equal((await stat(path)).mode&0o777,0o600);assert.equal(sends(s.api),4);
  }
});

test('Unknown and malformed labels remain incomplete after all other states resolve',async t=>{
  for(const text of ['Unknown','accepting']){const s=await setup(t),result=await decide(s,['Nonaccepting','Accepting','Nonaccepting',text]);assert.equal(result.status,'incomplete');assert.equal(result.comparison,null);await assert.rejects(exportComparison(s.directory,s.options.input));await assert.rejects(readFile(join(s.directory,'comparison.json')),{code:'ENOENT'});}
});

test('cancelled state judgments remain missing while the rest can be collected',async t=>{
  const s=await setup(t);await s.run();s.api.terminal(id(1),'cancelled');assert.equal((await s.run()).status,'ready');const result=await decide(s,['Accepting','Nonaccepting','Accepting']);assert.equal(result.status,'incomplete');assert.equal(result.comparison,null);await assert.rejects(exportComparison(s.directory,s.options.input));
});

test('changed topology, policy or forged Boolean labels fail before a network read',async t=>{
  const s=await setup(t);await s.run();s.api.answer(id(1),'Nonaccepting');await s.run();const original=await s.saved();
  for(const mutate of [state=>state.attempts[0].observation.answer.accepting=true,state=>state.attempts[0].observation.answer.kind='unknown',state=>state.attempts[0].request.data.policy_hash='bad',state=>state.attempts[0].request.data.machine_hash='bad']){
    const saved=structuredClone(original);mutate(saved);await atomicJson(s.directory,'state.json',saved);const calls=s.api.calls.length;await assert.rejects(s.run());assert.equal(s.api.calls.length,calls);
  }
  await atomicJson(s.directory,'state.json',original);const input=simple();input.old.transitions[0].to='on';const calls=s.api.calls.length;await assert.rejects(s.run({input}));assert.equal(s.api.calls.length,calls);
});

test('tokens and identifiers reject trailing line terminators',()=>{
  for(const suffix of ['\n','\r\n','\u2028','\u2029']){assert.equal(TOKEN.test('token'+suffix),false);assert.equal(isId(CONFIG.participant.id+suffix),false);assert.equal(ROOM.test(ROOM_CODE+suffix),false);assert.throws(()=>validateConnection({token:'token'+suffix,room:ROOM_CODE}));}
});

test('maximum four-by-four product closure includes all sixteen reachable pairs',()=>{
  const input=pair(smallMachine(4,Array.from({length:4},(_,i)=>[(i+1)%4,i]).flat()),smallMachine(4,Array.from({length:4},(_,i)=>[i,(i+1)%4]).flat()));
  const labels=labelsFor(input,Array(8).fill(false)),result=compareMachines(input,labels);
  assert.equal(result.equivalent,true);assert.equal(result.productStateBound,16);assert.equal(result.reachablePairCount,16);assert.equal(new Set(result.reachablePairs.map(row=>`${row.oldState}:${row.newState}`)).size,16);assert.equal(partitionOracle(input,labels),true);
  labels['new:q3']=true;const changed=compareMachines(input,labels);assert.equal(changed.equivalent,false);assert.deepEqual(changed.counterexample.word,['b','b','b']);assert.equal(partitionOracle(input,labels),false);
});
