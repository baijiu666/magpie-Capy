import test from "node:test"
import assert from "node:assert/strict"

import {
  clearAttachmentCache,
  collectAttachments,
  uploadAttachments,
  _internal,
} from "../src/attachments.mjs"

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2Zb8AAAAASUVORK5CYII="

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}

test("collectAttachments 把 data URL 图片抽出来，并保留可读标记", async () => {
  const result = await collectAttachments([
    {
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
      ],
    },
  ])
  assert.equal(result.attachments.length, 1)
  assert.equal(result.attachments[0].mediaType, "image/png")
  assert.ok(result.attachments[0].bytes.length > 0)
  assert.match(result.messages[0].content, /\[图片: /)
  assert.match(result.messages[0].content, /What is this\?/)
})

test("collectAttachments 支持 file part 的 data URL", async () => {
  const result = await collectAttachments([
    {
      role: "user",
      content: [
        { type: "text", text: "read this" },
        {
          type: "file",
          file: {
            filename: "note.txt",
            media_type: "text/plain",
            file_data: `data:text/plain;base64,${Buffer.from("hello").toString("base64")}`,
          },
        },
      ],
    },
  ])
  assert.equal(result.attachments.length, 1)
  assert.equal(result.attachments[0].name, "note.txt")
  assert.equal(result.attachments[0].bytes.toString(), "hello")
  assert.match(result.messages[0].content, /\[附件: note.txt\]/)
})

test("collectAttachments 拒绝本机/内网 URL（SSRF）", async () => {
  await assert.rejects(
    collectAttachments([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "http://127.0.0.1/secret.png" } }],
      },
    ]),
    (error) => error.status === 400 && /内网/u.test(error.message),
  )
})

test("collectAttachments 拒绝把 HTML 当图片", async () => {
  const fetchImpl = async () => new Response("<html>not an image</html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  })
  await assert.rejects(
    collectAttachments([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/page" } }],
      },
    ], { fetchImpl }),
    (error) => error.status === 400 && /不是 image/u.test(error.message),
  )
})

test("uploadAttachments：POST /files → PUT 预签名 URL → jam files[]", async () => {
  clearAttachmentCache()
  const seen = []
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, init })
    if (url.endsWith("/api/v1/files")) {
      return json({ targets: [{ fileId: "file_1", url: "https://s3.example/put", expiresAt: "later" }] })
    }
    if (url === "https://s3.example/put") return new Response("", { status: 200 })
    return json({}, 404)
  }
  const files = await uploadAttachments(fetchImpl, `capy_${"a".repeat(43)}`, [
    { name: "a.png", mediaType: "image/png", bytes: Buffer.from([1, 2, 3]) },
  ])
  assert.deepEqual(files, [{
    fileId: "file_1",
    name: "a.png",
    mediaType: "image/png",
    sizeBytes: 3,
  }])
  const put = seen.find((item) => item.url === "https://s3.example/put")
  assert.equal(put.init.method, "PUT")
  assert.equal(put.init.headers["content-type"], "image/png")
  assert.equal(put.init.headers["content-length"], "3")
})

test("uploadAttachments：同一 API key + 同一字节复用 fileId", async () => {
  clearAttachmentCache()
  let posts = 0
  const fetchImpl = async (url) => {
    if (url.endsWith("/api/v1/files")) {
      posts += 1
      return json({ targets: [{ fileId: `file_${posts}`, url: "https://s3.example/put" }] })
    }
    return new Response("", { status: 200 })
  }
  const apiKey = `capy_${"b".repeat(43)}`
  const attachment = { name: "a.png", mediaType: "image/png", bytes: Buffer.from([9, 8, 7]) }
  const first = await uploadAttachments(fetchImpl, apiKey, [attachment])
  const second = await uploadAttachments(fetchImpl, apiKey, [attachment])
  assert.equal(posts, 1)
  assert.equal(first[0].fileId, second[0].fileId)
})

test("媒体类型/文件名助手", () => {
  assert.equal(_internal.mediaTypeOf("image/png; charset=binary"), "image/png")
  assert.equal(_internal.safeName("../../evil.png", "image/png", 0), "evil.png")
  assert.equal(_internal.decodeDataUrl("data:text/plain;base64,aGk=").bytes.toString(), "hi")
})
