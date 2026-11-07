/**
 * Local OpenAI-Images-compatible test double for dsh-super-image.
 *
 *   node test/mock-openai-images.mjs [port]
 *
 * POST /v1/images/generations returns a deterministic gradient PNG whose
 * colours encode the prompt hash. POST /v1/images/edits reads the first
 * reference image out of the multipart body, tints its border and returns it,
 * so a reference-edit response visibly preserves the supplied base image
 * while remaining byte-different. This is a verification fixture only; the
 * plugin never uses it by default.
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { deflateSync, inflateSync } from 'node:zlib'

const PORT = Number(process.argv[2] ?? 8791)

function crc32(buffer) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function encodePng(rgba, width, height) {
  const rows = []
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4)
    row[0] = 0
    rgba.copy(row, 1, y * width * 4, (y + 1) * width * 4)
    rows.push(row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) return null
  let offset = 8
  let width = 0
  let height = 0
  let depth = 8
  let colorType = 6
  let interlace = 0
  const idat = []
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }
  if (depth !== 8 || interlace !== 0 || ![0, 2, 6].includes(colorType)) return null
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(width * height * channels)
  let prev = Buffer.alloc(stride)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    const line = Buffer.from(raw.subarray(pos, pos + stride))
    pos += stride
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0
      const up = prev[x]
      const upLeft = x >= channels ? prev[x - channels] : 0
      if (filter === 1) line[x] = (line[x] + left) & 255
      else if (filter === 2) line[x] = (line[x] + up) & 255
      else if (filter === 3) line[x] = (line[x] + ((left + up) >> 1)) & 255
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        const value = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
        line[x] = (line[x] + value) & 255
      }
    }
    line.copy(pixels, y * stride)
    prev = line
  }
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0, j = 0; i < width * height; i += 1, j += channels) {
    if (channels === 4) {
      rgba[i * 4] = pixels[j]
      rgba[i * 4 + 1] = pixels[j + 1]
      rgba[i * 4 + 2] = pixels[j + 2]
      rgba[i * 4 + 3] = pixels[j + 3]
    } else if (channels === 3) {
      rgba[i * 4] = pixels[j]
      rgba[i * 4 + 1] = pixels[j + 1]
      rgba[i * 4 + 2] = pixels[j + 2]
      rgba[i * 4 + 3] = 255
    } else {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = pixels[j]
      rgba[i * 4 + 3] = 255
    }
  }
  return { rgba, width, height }
}

function tintReference(info) {
  const { rgba, width, height } = info
  const ring = Math.max(6, Math.round(Math.min(width, height) * 0.025))
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const edge = Math.min(x, y, width - 1 - x, height - 1 - y)
      const strength = edge < ring ? 0.55 * (1 - edge / ring) : 0
      if (strength <= 0) continue
      const i = (y * width + x) * 4
      rgba[i] = Math.round(rgba[i] * (1 - strength) + 244 * strength)
      rgba[i + 1] = Math.round(rgba[i + 1] * (1 - strength) + 162 * strength)
      rgba[i + 2] = Math.round(rgba[i + 2] * (1 - strength) + 97 * strength)
    }
  }
  return encodePng(rgba, width, height)
}

function png(seed, width = 512, height = 512) {
  const hash = createHash('sha256').update(String(seed)).digest()
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      rgba[i] = (hash[0] + x) % 256
      rgba[i + 1] = (hash[1] + y) % 256
      rgba[i + 2] = (hash[2] + ((x * y) >> 8)) % 256
      rgba[i + 3] = 255
    }
  }
  return encodePng(rgba, width, height)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (part) => chunks.push(part))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function firstMultipartFile(body, contentType) {
  const boundaryMatch = /boundary=([^;]+)/.exec(contentType)
  if (!boundaryMatch) return null
  const boundary = Buffer.from(`--${boundaryMatch[1].trim()}`)
  let cursor = body.indexOf(boundary)
  while (cursor !== -1) {
    const headerStart = cursor + boundary.length + 2
    const headerEnd = body.indexOf('\r\n\r\n', headerStart)
    if (headerEnd === -1) break
    const headers = body.toString('latin1', headerStart, headerEnd)
    const dataStart = headerEnd + 4
    const next = body.indexOf(boundary, dataStart)
    if (next === -1) break
    if (/content-type:\s*image\//i.test(headers)) {
      return body.subarray(dataStart, next - 2)
    }
    cursor = next
  }
  return null
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }
  const auth = req.headers.authorization ?? ''
  if (!auth.startsWith('Bearer ') || auth.length < 12) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'missing bearer key' } }))
    return
  }
  if (req.method !== 'POST' || !['/v1/images/generations', '/v1/images/edits'].includes(url.pathname)) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `no route ${req.method} ${url.pathname}` } }))
    return
  }
  const body = await readBody(req)
  const text = body.toString('utf8')
  let prompt = ''
  let count = 1
  if (url.pathname === '/v1/images/generations') {
    try {
      const json = JSON.parse(text)
      prompt = String(json.prompt ?? '')
      count = Math.max(1, Math.min(4, Number(json.n ?? 1)))
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid json' } }))
      return
    }
  } else {
    const match = /name="prompt"\r?\n\r?\n([\s\S]*?)\r?\n--/.exec(text)
    prompt = match ? match[1] : text.slice(0, 200)
  }
  const data = []
  if (url.pathname === '/v1/images/edits') {
    const file = firstMultipartFile(body, String(req.headers['content-type'] ?? ''))
    const decoded = file ? decodePng(file) : null
    const image = decoded ? tintReference(decoded) : png(`${url.pathname}|${prompt}|0|${body.length}`)
    data.push({ b64_json: image.toString('base64') })
  } else {
    for (let index = 0; index < count; index += 1) {
      const seed = `${url.pathname}|${prompt}|${index}|${body.length}`
      data.push({ b64_json: png(seed).toString('base64') })
    }
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data }))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock openai images listening on http://127.0.0.1:${PORT}/v1`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
