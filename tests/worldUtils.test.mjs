import assert from 'node:assert/strict'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import { getWorldGameMode, parseWorldMetadata } from '../src/main/worldUtils.ts'

function namedTag(type, name, payload) {
  const encodedName = Buffer.from(name)
  const nameLength = Buffer.alloc(2)
  nameLength.writeUInt16BE(encodedName.length)
  return Buffer.concat([Buffer.from([type]), nameLength, encodedName, payload])
}

function stringPayload(value) {
  const encoded = Buffer.from(value)
  const length = Buffer.alloc(2)
  length.writeUInt16BE(encoded.length)
  return Buffer.concat([length, encoded])
}

function createLevelData({ name, lastPlayed, gameType, hardcore }) {
  const lastPlayedPayload = Buffer.alloc(8)
  lastPlayedPayload.writeBigInt64BE(BigInt(lastPlayed))
  const gameTypePayload = Buffer.alloc(4)
  gameTypePayload.writeInt32BE(gameType)
  const data = Buffer.concat([
    namedTag(10, 'WorldGenSettings', Buffer.concat([
      namedTag(9, 'settings', Buffer.concat([
        Buffer.from([8]),
        Buffer.from([0, 0, 0, 1]),
        stringPayload('value')
      ])),
      Buffer.from([0])
    ])),
    namedTag(8, 'LevelName', stringPayload(name)),
    namedTag(4, 'LastPlayed', lastPlayedPayload),
    namedTag(3, 'GameType', gameTypePayload),
    namedTag(1, 'hardcore', Buffer.from([hardcore ? 1 : 0])),
    Buffer.from([0])
  ])
  return gzipSync(Buffer.concat([
    Buffer.from([10, 0, 0]),
    namedTag(10, 'Data', data),
    Buffer.from([0])
  ]))
}

test('world metadata reads the name, last played time, game mode, and hardcore flag', () => {
  assert.deepEqual(parseWorldMetadata(createLevelData({
    name: 'My World',
    lastPlayed: 1_700_000_000_000,
    gameType: 1,
    hardcore: true
  })), {
    name: 'My World',
    lastPlayed: 1_700_000_000_000n,
    gameType: 1,
    hardcore: true
  })
})

test('world metadata rejects invalid NBT rather than reporting misleading details', () => {
  assert.throws(() => parseWorldMetadata(Buffer.from([10, 0])), /truncated or invalid/)
})

test('world game modes include hardcore and all standard modes', () => {
  assert.equal(getWorldGameMode(0, false), 'Survival')
  assert.equal(getWorldGameMode(1, false), 'Creative')
  assert.equal(getWorldGameMode(2, false), 'Adventure')
  assert.equal(getWorldGameMode(3, false), 'Spectator')
  assert.equal(getWorldGameMode(0, true), 'Hardcore')
  assert.equal(getWorldGameMode(undefined, false), 'Unknown')
})
