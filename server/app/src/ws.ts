import {createHash} from 'crypto'
import flow from 'lodash/fp/flow'
import map from 'lodash/fp/map'
import range from 'lodash/fp/range'
import toString from 'lodash/fp/toString'

import {PayloadHandshake} from './types/Payload'

import * as $tcp from './tcp'

interface Headers {
  [key: string]: string
}

// TODO find external lib
function parseHttpRequest(data: string) {
  const [header, body] = data.split('\r\n\r\n')
  if (!header.length) return null

  const header_lines = header.split('\r\n')
  if (!header.length) return null

  const [method, url, protocol] = header_lines[0].split(' ')
  if (method.toUpperCase() !== 'GET') return null
  if (url.toUpperCase() !== '/') return null
  if (protocol.toUpperCase() !== 'HTTP/1.1') return null

  const headers = header_lines.reduce(
    (H, h) => {
      if (h.indexOf(':') === -1) return H
      const [key, val] = h.split(': ')
      return {...H, [key]: val}
    },
    {} as Headers,
  )

  return {
    body,
    headers,
    method,
    protocol,
    url,
  }
}

function parseFrame(frame: Buffer): [Buffer, Buffer] {
  const frameLength = frame[1] & 0b01111111

  // frameLength = 127
  if (frameLength === 0b1111111) {
    return [frame.slice(8, 12), frame.slice(12)]
  }

  // frameLength = 126
  if (frameLength === 0b1111110) {
    return [frame.slice(4, 8), frame.slice(8)]
  }

  // frameLength <= 125
  return [frame.slice(2, 6), frame.slice(6)]
}

function parsePayload(maskAndPayload: [Buffer, Buffer]) {
  const [mask, payload] = maskAndPayload

  return flow(
    range(0),
    map(bit => payload[bit] ^ mask[bit % 4]),
    Buffer.from,
    toString,
  )(payload.length)
}

export function parse(payloadStr: string) {
  const frame = Buffer.from(payloadStr || '')
  const request = parseHttpRequest(frame.toString())

  if (request) {
    const input_key = request.headers['Sec-WebSocket-Key'] as string
    const output_key = createHash('sha1')
      .update(input_key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', 'utf8')
      .digest('base64')

    return {type: 'handshake', key: output_key} as PayloadHandshake
  }

  const payload = flow(
    parseFrame,
    parsePayload,
  )(frame)

  return $tcp.parse(payload)
}

// TODO refactor
export function format(payload: object) {
  const payload_str = $tcp.format(payload)
  const payload_len = payload_str.length

  let frame_header

  if (payload_len <= 125) {
    frame_header = Buffer.from([0b010000001, payload_len])
  } else if (payload_len < Math.pow(2, 16)) {
    const payload_len_16 = Buffer.alloc(2)
    payload_len_16.writeUInt16BE(payload_len, 0)

    frame_header = Buffer.concat([
      Buffer.from([0b010000001, 126]),
      payload_len_16,
    ])
  } else {
    const payload_len_64 = Buffer.alloc(8)
    payload_len_64.writeUInt32BE(payload_len >> 8, 0)
    payload_len_64.writeUInt32BE(payload_len & 0x00ff, 4)

    frame_header = Buffer.concat([
      Buffer.from([0b010000001, 127]),
      payload_len_64,
    ])
  }

  const frame_payload = Buffer.from(payload_str)
  return Buffer.concat([frame_header, frame_payload])
}
