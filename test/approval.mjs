// The approval shapes are taken from a real 8h19m turn on the other machine:
//
//   seq 172  approval/asked    {"toolName":"bash","reason":"escalate sandbox to danger-full-access: 更新 dsh"}
//   seq 178  agent/inbox/spliced
//   seq 179  approval/decided  {"outcome":"allowed-once"}
//   seq 196  approval/policy   {"policy":"never"}
//
// The point of the function is to say "this turn will not finish until a human
// clicks", so the cases that matter are the ones where a decision exists but
// belongs to a different approval.

import assert from 'node:assert/strict'
import { openApproval, promptWindow, replyFromWindow, turnOpen } from '../lib/sync.js'

const asked = (seq, id, tool = 'bash') => ({ event: { type: 'approval/asked', seq, data: { id, toolName: tool, reason: 'escalate sandbox' } }, seq })
const decided = (seq, id, outcome = 'allowed-once') => ({ event: { type: 'approval/decided', seq, data: { id, outcome } }, seq })
const policy = (seq, value) => ({ event: { type: 'approval/policy', seq, data: { policy: value } }, seq })
const spliced = (seq) => ({ event: { type: 'agent/inbox/spliced', seq, data: {} }, seq })

// The reported turn: asked, never decided inside the window.
const stuck = [asked(172, 'a1'), spliced(178)]
assert.deepEqual(openApproval(stuck), { id: 'a1', tool: 'bash', reason: 'escalate sandbox', seq: 172 })

// Same window once the owner clicked: nothing is pending any more.
assert.equal(openApproval([asked(172, 'a1'), spliced(178), decided(179, 'a1')]), null)

// A decision for a different approval must not close this one.
assert.equal(openApproval([asked(172, 'a1'), decided(179, 'a2')]).id, 'a1')

// Two pending approvals: report the newest, which is the one the turn waits on.
assert.equal(openApproval([asked(10, 'a1'), asked(20, 'a2'), decided(30, 'a1')]).id, 'a2')

// Going to `never` settles everything, even without a matched decision.
assert.equal(openApproval([asked(172, 'a1'), policy(196, 'never')]), null)

// An empty window says nothing either way: no approval is not an approval.
assert.equal(openApproval([]), null)
assert.equal(openApproval([]), null)

// Events without data, or bare event objects, must not throw.
assert.equal(openApproval([{ event: { type: 'approval/asked', seq: 5 } }]).id, null)
assert.equal(openApproval([{ event: { type: 'turn/start', seq: 1 } }]), null)

console.log('approval: 8 cases ok')

// `busyBefore` comes from the same kind of window: a turn that opened and did
// not close. The types are the ones a live window actually carries.
const kind = (type, seq) => ({ event: { type, seq, data: {} }, seq })
assert.equal(turnOpen([kind('turn/start', 1), kind('step/start', 2)]), true)
assert.equal(turnOpen([kind('turn/start', 1), kind('step/start', 2), kind('turn/end', 3)]), false)
// A window that starts mid-turn (no `turn/start` in it) proves nothing either way.
assert.equal(turnOpen([kind('step/start', 2), kind('step/end', 3)]), false)
// A closed turn followed by a new one is open, whatever came before.
assert.equal(turnOpen([kind('turn/end', 3), kind('turn/start', 4)]), true)

console.log('turnOpen: 4 cases ok')

// A tool-call step carries an `assistant/message` with no text. Treating it as
// the answer ended the wait after one poll on every tool-using turn, which is
// exactly what a live drill showed: 4.9s, reply null, reason "turn-in-progress",
// while the turn was in fact about to ask for an approval.
const said = (seq, text) => ({ event: { type: 'assistant/message', seq, data: { content: [{ type: 'text', text }] } }, seq })
const called = (seq) => ({ event: { type: 'assistant/message', seq, data: { content: [{ type: 'tool-call', name: 'bash' }] } }, seq })
const tool = (seq) => ({ event: { type: 'tool/call', seq, data: {} }, seq })
const drillAsked = (seq) => ({ event: { type: 'approval/asked', seq, data: { id: 'a1' } }, seq })

assert.equal(replyFromWindow([kind('turn/start', 1), said(2, 'done')]), 'done')
// A tool call after the text does not erase the answer.
assert.equal(replyFromWindow([kind('turn/start', 1), said(2, 'done'), called(3)]), 'done')
// Tool calls only: no answer yet.
assert.equal(replyFromWindow([kind('turn/start', 5), called(6), tool(7), drillAsked(8)]), null)
// The real drill window: a tool-call step followed by the approval it triggered.
assert.equal(replyFromWindow([kind('turn/start', 5), called(18), tool(19), drillAsked(20)]), null)
// Window with no turn/start still yields text when there is any.
assert.equal(replyFromWindow([called(1), said(2, 'late')]), 'late')
assert.equal(replyFromWindow([]), null)

console.log('replyFromWindow: 6 cases ok')

// The whole per-poll judgement, which is where the tool-call-only bug lived.
const textWindow = [kind('turn/start', 1), said(2, 'done'), kind('turn/end', 3)]
assert.deepEqual(
  (({ reply, approval, sawStart, sawEnd }) => ({ reply, approval, sawStart, sawEnd }))(promptWindow(textWindow)),
  { reply: 'done', approval: null, sawStart: true, sawEnd: true },
)
// The drill window: a step with a tool call, then the approval it triggered.
const toolWindow = [kind('turn/start', 5), called(18), tool(19), drillAsked(20)]
assert.equal(promptWindow(toolWindow).reply, null, 'a tool step is not an answer')
assert.equal(promptWindow(toolWindow).approval.id, 'a1', 'the approval is what the window is stuck on')
assert.equal(promptWindow(toolWindow).sawEnd, false, 'the turn is still open')
// Once the approval is decided, the window is clean again.
assert.equal(promptWindow([...toolWindow, { event: { type: 'approval/decided', seq: 22, data: { id: 'a1' } }, seq: 22 }]).approval, null)
// A window that begins mid-turn still reports what it can see.
assert.equal(promptWindow([called(1)]).sawStart, false)
assert.equal(promptWindow([]).reply, null)
assert.equal(promptWindow(null).replies, 0)

console.log('promptWindow: 6 cases ok')
