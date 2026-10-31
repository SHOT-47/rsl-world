import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '../src/main/task-store.ts'

const boundary = {
  checkpointDurable: true,
  operationInFlight: false,
  sideEffectState: 'known_complete' as const,
  pendingApprovalCount: 0
}

test('TaskStore persists context ledger records and activates/restores immutable snapshots', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'rsl-context-ledger-'))
  const projectRoot = join(tempRoot, 'workspace')
  mkdirSync(projectRoot, { recursive: true })
  const store = new TaskStore(join(tempRoot, 'workbench.sqlite'), join(process.cwd(), 'resources/schema/001_initial.sql'))

  try {
    store.registerProject(projectRoot)
    const task = store.createTask(
      { projectRoot, title: 'Context ledger integration', prompt: 'Preserve task requirements and evidence.', mode: 'coding' },
      { ready: false, reason: 'Test fixture is intentionally blocked.' }
    )

    const first = store.appendContextRecord(task.id, {
      kind: 'user_requirement', preservation: 'P1', text: 'Do not change the authentication boundary.',
      sourceRefs: ['task:prompt'], factualClaim: false, required: true
    })
    const second = store.appendContextRecord(task.id, {
      kind: 'verified_finding', preservation: 'P3', text: 'The regression is reproduced by test case R-12.',
      sourceRefs: ['evidence:test-R-12'], factualClaim: true, required: true
    })
    const listed = store.listContextRecords(task.id)
    assert.deepEqual(listed.map(record => record.id), [first.id, second.id])
    assert.equal(listed[1]?.sequence, 2)

    const proposed1 = store.createContextSnapshot(task.id, {
      expectedActiveVersion: 0, activeRecordIds: [first.id], archivedRecordIds: [second.id],
      reason: 'Keep the user requirement active and archive the completed finding from the working set.',
      auditPassed: true, boundary
    })
    assert.equal(proposed1.status, 'proposed')
    const active1 = store.activateContextSnapshot(task.id, proposed1.version, 0, boundary, true)
    assert.equal(active1.status, 'active')
    assert.equal(store.getActiveContextSnapshot(task.id)?.version, 1)

    const proposed2 = store.createContextSnapshot(task.id, {
      expectedActiveVersion: 1, activeRecordIds: [first.id, second.id], archivedRecordIds: [],
      reason: 'Bring the verified regression finding back into the active context.',
      auditPassed: true, boundary
    })
    const active2 = store.activateContextSnapshot(task.id, proposed2.version, 1, boundary, true)
    assert.equal(active2.version, 2)

    const restore = store.restoreContextSnapshot(task.id, 1, 2, boundary, true)
    assert.equal(restore.status, 'proposed')
    assert.deepEqual(restore.activeRecordIds, [first.id])
    const restored = store.activateContextSnapshot(task.id, restore.version, 2, boundary, true)
    assert.equal(restored.version, 3)
    assert.deepEqual(store.getActiveContextSnapshot(task.id)?.activeRecordIds, [first.id])

    const history = store.listContextSnapshots(task.id)
    assert.deepEqual(history.map(snapshot => snapshot.version), [3, 2, 1])
    assert.deepEqual(history.map(snapshot => snapshot.status), ['active', 'superseded', 'superseded'])
  } finally {
    store.close()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('TaskStore rejects unproven factual records and unsafe context snapshot boundaries', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'rsl-context-gates-'))
  const projectRoot = join(tempRoot, 'workspace')
  mkdirSync(projectRoot, { recursive: true })
  const store = new TaskStore(join(tempRoot, 'workbench.sqlite'), join(process.cwd(), 'resources/schema/001_initial.sql'))

  try {
    store.registerProject(projectRoot)
    const task = store.createTask(
      { projectRoot, title: 'Context gate integration', prompt: 'Test hard gates.', mode: 'coding' },
      { ready: false, reason: 'Test fixture is intentionally blocked.' }
    )
    assert.throws(() => store.appendContextRecord(task.id, {
      kind: 'finding', preservation: 'P3', text: 'Unsupported factual claim.', sourceRefs: [], factualClaim: true
    }), /provenance source/)
    assert.throws(() => store.createContextSnapshot(task.id, {
      expectedActiveVersion: 0, activeRecordIds: [], archivedRecordIds: [],
      reason: 'Unsafe proposal must fail.', auditPassed: true,
      boundary: { ...boundary, sideEffectState: 'possible' }
    }), /safe lifecycle boundary/)
    assert.throws(() => store.createContextSnapshot(task.id, {
      expectedActiveVersion: 0, activeRecordIds: [], archivedRecordIds: [],
      reason: 'Pending approval must fail.', auditPassed: true,
      boundary: { ...boundary, pendingApprovalCount: 1 }
    }), /safe lifecycle boundary/)
  } finally {
    store.close()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
