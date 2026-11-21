import assert from 'node:assert/strict'
import test from 'node:test'
import {
  listCompatibleModrinthVersions,
  resolveFirstInstallableModrinthVersion,
  selectModrinthVersion,
  UnsupportedModrinthDependencyError
} from '../src/main/pluginUtils.ts'

const projectId = 'EsAfCjCV'

function version({ id = 'release-id', publishedAt = '2026-01-01T00:00:00.000Z', loaders = ['fabric'] } = {}) {
  return {
    id,
    project_id: projectId,
    version_number: '1.0.0',
    date_published: publishedAt,
    game_versions: ['1.21.11'],
    loaders,
    version_type: 'release',
    status: 'listed',
    dependencies: [{ project_id: 'P7dR8mSH', dependency_type: 'required' }],
    files: [{
      primary: true,
      filename: 'appleskin-fabric.jar',
      url: 'https://cdn.modrinth.com/data/project/file.jar',
      size: 12,
      hashes: { sha512: 'a'.repeat(128) }
    }]
  }
}

test('Modrinth selection chooses the newest compatible Fabric release', () => {
  const versions = [
    version({ id: 'older', publishedAt: '2025-01-01T00:00:00.000Z' }),
    version({ id: 'newer', publishedAt: '2026-01-01T00:00:00.000Z' }),
    { ...version({ id: 'wrong-loader' }), loaders: ['forge'] }
  ]
  const compatibleVersions = listCompatibleModrinthVersions(versions, projectId, '1.21.11')
  const selected = selectModrinthVersion(versions, projectId, '1.21.11')

  assert.deepEqual(compatibleVersions.map(({ id }) => id), ['newer', 'older'])
  assert.equal(selected?.id, 'newer')
  assert.equal(selected?.dependencies[0].projectId, 'P7dR8mSH')
})

test('Modrinth install selection falls back when a release has an incompatible required dependency', async () => {
  const [newest, fallback] = listCompatibleModrinthVersions([
    version({ id: 'newest', publishedAt: '2026-01-01T00:00:00.000Z' }),
    version({ id: 'fallback', publishedAt: '2025-01-01T00:00:00.000Z' })
  ], projectId, '1.21.11')
  const result = await resolveFirstInstallableModrinthVersion([newest, fallback], async (candidate) => {
    if (candidate.id === 'newest') {
      throw new UnsupportedModrinthDependencyError('No Fabric release.')
    }
    return [candidate]
  })

  assert.equal(result?.version.id, 'fallback')
  assert.equal(result?.installPlan[0].id, 'fallback')
})

test('Modrinth selection rejects downloads outside the trusted CDN', () => {
  const unsafe = version()
  unsafe.files[0].url = 'https://example.com/mod.jar'
  assert.equal(selectModrinthVersion([unsafe], projectId, '1.21.11'), undefined)
})

test('Modrinth selection ignores versions missing a SHA-512 digest', () => {
  const invalid = version()
  invalid.files[0].hashes.sha512 = 'invalid'
  assert.equal(selectModrinthVersion([invalid], projectId, '1.21.11'), undefined)
})
