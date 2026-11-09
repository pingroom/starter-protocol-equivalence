import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, exportComparison } from './engine.js';
import { readJson } from './storage.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const input = await readJson(new URL('../examples/protocol.json', import.meta.url));
for (const scenario of [
  { title: 'Renamed states preserve the accepted language', labels: ['Nonaccepting','Accepting','Nonaccepting','Accepting'], equivalent: true },
  { title: 'One event distinguishes the revised machine', labels: ['Nonaccepting','Accepting','Nonaccepting','Nonaccepting'], equivalent: false, word: ['on'] },
  { title: 'Initial acceptance differs even before any event', labels: ['Accepting','Accepting','Nonaccepting','Accepting'], equivalent: false, word: [] },
  { title: 'Unknown state meaning withholds comparison', labels: ['Nonaccepting','Accepting','Nonaccepting','Unknown'] },
]) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-protocol-demo-'));
  try {
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    let result;
    for (const label of scenario.labels) {
      result = await step(options); api.answer(result.answers.find(answer => answer.status === 'pending').questionId, label); result = await step(options);
    }
    if (scenario.equivalent !== undefined) {
      assert.equal(result.status, 'complete'); assert.equal(result.comparison.equivalent, scenario.equivalent);
      if (scenario.word) assert.deepEqual(result.comparison.counterexample.word, scenario.word);
      assert.deepEqual((await exportComparison(directory, input)).comparison, result.comparison);
    } else { assert.equal(result.status, 'incomplete'); assert.equal(result.comparison, null); await assert.rejects(exportComparison(directory, input)); }
    console.log(JSON.stringify({ scenario: scenario.title, status: result.status, comparison: result.comparison }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log('Offline demo used the pinned SDK with local mock transport. No live phone delivery, application execution or deployment.');
