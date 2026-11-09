# PingRoom protocol equivalence starter

Compare two versions of a finite workflow after a named domain owner identifies their accepting states through PingRoom. Export either language-equivalence evidence or a shortest event sequence that the two versions judge differently.

Use it when revising a small workflow model. The practice switch example writes local JSON; it never inspects or executes an application, changes a device or deploys anything.

## Try it offline

Choose **Use this template**, clone your repository, and use Node.js 22 or newer:

```sh
npm ci
npm test
npm run demo
```

Four demos use the real SDK with local mock transport: equivalent renamed states, a one-event difference, an empty-sequence difference and Unknown. They require no credentials and do not test phone delivery. `@pingroom/sdk` 0.7.1 is pinned with a lockfile; `.npmrc` requests a 14-day minimum release age where npm supports it. GitHub Actions checks Node 22 and 24.

## Define the two models

```sh
cp examples/protocol.json protocol.json
cp config.example.json config.json
npm run validate
```

Edit `protocol.json` before collecting judgments:

- `comparisonId`, `title` and `acceptanceDefinition` identify the comparison and one common acceptance criterion.
- `events` declares one to three `{id,label}` records shared by both machines.
- `old` and `new` each contain `label`, `initialState`, one to four `states` and `transitions`.
- Each state has `{id,meaning}`. Each transition has `{from,event,to}`.

Every state needs exactly one transition per event, using self-loops or explicit rejecting sinks where appropriate. Missing transitions, duplicate state/event pairs and undeclared references are rejected. State IDs may repeat across machines; the machine role distinguishes them. Epsilon transitions, guards, payload conditions, nondeterminism and implicit error behavior are unsupported.

Acceptance means the common criterion holds **when a finite sequence ends in that state**. Execution need not stop there; accepting states still have outgoing transitions. In the example, the criterion is that the practice lamp is on. Describe each state so the owner can judge it under the common criterion.

IDs begin with a lowercase ASCII letter, followed by letters, digits, `_` or `-`: comparison IDs allow 40 characters, state IDs 16 and event IDs 12. State/event IDs exclude prototype-related names. Trimmed single-line Unicode limits are title 40, acceptance definition 100, machine/event labels 30, and state meanings 70 UTF-16 units. Controls, formatting characters, malformed Unicode and extra properties are rejected.

Events and states are sorted by ID; transitions by `from`, then `event`. Array reordering preserves the session. Changed transitions, labels, meanings or acceptance definitions invalidate saved evidence.

## Connect the owner

Install [PingRoom](https://pingroom.io/i), then:

```sh
npm run connect
npm run inspect
```

Open the pairing link, approve the connection and grant a standard private room containing the owner. Verify the person in the app, then copy their exact member UUID into `config.json`. Names alone do not establish identity. The connection needs room/Question access; preserve the original asking registration for later reads.

Pairing resumes pending requests and saves credentials under `.pingroom/`. For an existing connection, copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. Complete environment pairs override saved credentials. Partial or blank shell pairs cannot borrow missing values.

## Collect and export

```sh
npm start
# Answer in PingRoom, then record the answer:
npm start
# Repeat for each declared state.
npm run status
npm run report
npm run export
```

Each invocation creates at most one Question or reads the active one once. After recording an answer, run it again for the next state: ID order, old machine first. Prompts include the machine role/label, state ID/meaning and full acceptance definition. At most eight direct Questions last 900 seconds each. Prompts fit 500 characters, context fits 40, and text input allows 60. There is no background polling.

Reply exactly `Accepting`, `Nonaccepting` or `Unknown`. The example's answers are `Nonaccepting`, `Accepting`, `Nonaccepting`, `Accepting`. Parsing checks PingRoom's normalized text and cannot detect whitespace trimmed by the server.

Every declared state needs a valid known answer, including unreachable states. Unknown, missing, invalid, expired or cancelled judgments withhold the whole comparison. Later states can still be collected, but failed Questions are never automatically reissued.

`status` prints evidence offline; `report` saves `.protocol/report.json`. `export` writes `.protocol/comparison.json` only when complete, retaining canonical source, policy hashes, owner, room, attributed answers, Question IDs and timestamps. Repeated exports are identical. Failed exports preserve existing files; require success for the expected source hash.

## Interpret the result

The [University of Miami's DFA equivalence notes](https://www.cs.miami.edu/~ogihara/csc527/new04-1.pdf) reduce equivalence to finding an accepting state in a symmetric-difference automaton. This starter explores reachable old/new state pairs from the initial pair. A pair differs when exactly one state accepts.

Breadth-first search follows event IDs in ASCII order, including a check of the initial pair: `counterexample.word: []` means a difference before any event. The first mismatch gives a shortest distinguishing sequence, choosing lexicographically smallest event IDs among equal-length alternatives. `oldTrace` and `newTrace` include the initial state and every successor; `oldAccepts` and `newAccepts` give the final judgments.

`comparison.equivalent: true` means every reachable pair agrees; `counterexample` is null. Even after a mismatch, `reachablePairs` records the full reachable closure, shortest access words, acceptance judgments and outgoing paired transitions. There are at most `old.states.length * new.states.length` pairs, or 16. A shortest distinguishing sequence cannot repeat a pair and has length at most that bound minus one.

A complete difference is exportable and exits successfully: inspect `comparison.equivalent`. Equality concerns accepted finite event sequences, not graph isomorphism or application behavior. It establishes neither timing, side-effect equivalence, security nor implementation conformance. Acceptance judgments for unreachable states cannot change the language, but are required for a complete record.

## Recover and adapt

Preserve the source, configuration, connection and `.protocol/` directory. Creation intent is saved before POST. Recover uncertain creation with:

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

An empty recent-list search does not prove creation failed. Recovery verifies the original Question without another POST. Resolve or revoke uncertain/expired pairing in Connected Agents before archiving its pairing record.

Use persistent storage on one machine. Restore corrupt state from backup; remove stale locks only after confirming their process stopped. Credentials, inputs and state are Git-ignored. Writes are private and atomic. Limits: source 64 KiB, config 16 KiB, state/reports 1 MiB and HTTP responses 512 KiB. Evidence is historical, not tamper-proof.

Collection exits `0` for complete comparisons, `1` on error, `2` for incomplete/newly failed outcomes, `3` while ready/pending/interrupted and `4` for uncertain creation. Successful offline commands exit `0`; refused exports exit `1`.

Adapt the models and acceptance definition before collecting answers. Keep deterministic rules in code and version `POLICY` when semantics change. The [SDK contract](https://github.com/pingroom/sdk) was checked on 2026-11-09. Tests include 4,096 independently enumerated DFA comparisons, 512 partition-refinement comparisons, recovery, pairing and CLI subprocesses. [MIT license](LICENSE).
