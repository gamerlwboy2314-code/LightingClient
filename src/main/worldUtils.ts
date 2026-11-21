import { gunzipSync } from 'node:zlib'

type WorldMetadata = {
  name?: string
  lastPlayed?: bigint
  gameType?: number
  hardcore?: boolean
}

const MAX_LEVEL_DATA_BYTES = 16 * 1024 * 1024
const WORLD_METADATA_TAGS = new Set(['LevelName', 'LastPlayed', 'GameType', 'hardcore'])

export function getWorldGameMode(gameType: number | undefined, hardcore: boolean | undefined): string {
  if (hardcore) return 'Hardcore'
  return ['Survival', 'Creative', 'Adventure', 'Spectator'][gameType ?? -1] ?? 'Unknown'
}

export function parseWorldMetadata(input: Buffer): WorldMetadata {
  if (input.length > MAX_LEVEL_DATA_BYTES) throw new Error('The world metadata file is too large to read.')

  const data = input[0] === 0x1f && input[1] === 0x8b
    ? gunzipSync(input, { maxOutputLength: MAX_LEVEL_DATA_BYTES })
    : input
  let offset = 0

  function requireBytes(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > data.length) {
      throw new Error('The world metadata file is truncated or invalid.')
    }
  }

  function readByte(): number {
    requireBytes(1)
    return data.readUInt8(offset++)
  }

  function readInt32(): number {
    requireBytes(4)
    const value = data.readInt32BE(offset)
    offset += 4
    return value
  }

  function readString(): string {
    requireBytes(2)
    const length = data.readUInt16BE(offset)
    offset += 2
    requireBytes(length)
    const value = data.toString('utf8', offset, offset + length)
    offset += length
    return value
  }

  function skipPayload(type: number, depth = 0): void {
    if (depth > 64) throw new Error('The world metadata file is nested too deeply.')

    switch (type) {
      case 1:
        requireBytes(1)
        offset += 1
        return
      case 2:
        requireBytes(2)
        offset += 2
        return
      case 3:
      case 5:
        requireBytes(4)
        offset += 4
        return
      case 4:
      case 6:
        requireBytes(8)
        offset += 8
        return
      case 7: {
        const length = readInt32()
        requireBytes(length)
        offset += length
        return
      }
      case 8:
        readString()
        return
      case 9: {
        const elementType = readByte()
        const length = readInt32()
        if (length < 0) throw new Error('The world metadata file contains an invalid list.')
        for (let index = 0; index < length; index += 1) {
          skipPayload(elementType, depth + 1)
        }
        return
      }
      case 10:
        while (true) {
          const childType = readByte()
          if (childType === 0) return
          readString()
          skipPayload(childType, depth + 1)
        }
      case 11:
      case 12: {
        const length = readInt32()
        const elementSize = type === 11 ? 4 : 8
        if (length < 0 || length > Math.floor(data.length / elementSize)) {
          throw new Error('The world metadata file contains an invalid array.')
        }
        const byteLength = length * elementSize
        requireBytes(byteLength)
        offset += byteLength
        return
      }
      default:
        throw new Error(`The world metadata file contains an unknown tag type (${type}).`)
    }
  }

  function readMetadataCompound(depth = 0): WorldMetadata {
    if (depth > 64) throw new Error('The world metadata file is nested too deeply.')
    const metadata: WorldMetadata = {}

    while (true) {
      const type = readByte()
      if (type === 0) return metadata
      const name = readString()

      if (!WORLD_METADATA_TAGS.has(name)) {
        skipPayload(type, depth + 1)
        continue
      }

      if (name === 'LevelName' && type === 8) metadata.name = readString()
      else if (name === 'LastPlayed' && type === 4) {
        requireBytes(8)
        metadata.lastPlayed = data.readBigInt64BE(offset)
        offset += 8
      } else if (name === 'GameType' && type === 3) metadata.gameType = readInt32()
      else if (name === 'hardcore' && type === 1) metadata.hardcore = readByte() !== 0
      else skipPayload(type, depth + 1)
    }
  }

  const rootType = readByte()
  if (rootType !== 10) throw new Error('The world metadata file does not contain a root compound.')
  readString()

  let result: WorldMetadata | undefined
  while (true) {
    const type = readByte()
    if (type === 0) break
    const name = readString()
    if (name === 'Data' && type === 10) result = readMetadataCompound()
    else skipPayload(type)
  }

  if (!result) throw new Error('The world metadata file does not contain world data.')
  return result
}
