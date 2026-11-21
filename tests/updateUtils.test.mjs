import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeUpdateError } from '../src/shared/updateUtils.ts'

test('missing release metadata is reported as a concise actionable message', () => {
  const message = 'Cannot find latest.yml in the latest release artifacts (https://github.com/example/releases/download/BugFixes/latest.yml): HttpError: 404\nHeaders: verbose response details'

  assert.equal(
    summarizeUpdateError(new Error(message)),
    'The latest GitHub release has no updater files yet. Publish it through the release workflow, then retry.'
  )
})

test('other update errors omit remote-method wrappers and stack details', () => {
  const summary = summarizeUpdateError(new Error(
    "Error invoking remote method 'updates:check': Error: Network unavailable\nat internal frame"
  ))

  assert.equal(summary, 'Network unavailable')
})
