// Goal 6 CP4：文件翻译。格式、输出位置、编码、接口解码用真实文件和假 aitd；翻译过程用假后端。编号对应施工清单 CP4 的预期。
import Foundation
import Testing

@testable import AITranslateKit

/** 假文档后端：按给定事件逐个返回；记下请求和被取消的次数 */
final class FakeDocumentBackend: DocumentBackend, @unchecked Sendable {
  private let lock = NSLock()
  private var _requests: [(format: DocumentFormat, text: String, target: String, bilingual: Bool)] = []
  private var _cancelled = 0
  var events: [DocumentEvent] = []
  var error: Error?
  var delay: Duration = .milliseconds(5)

  var requests: [(format: DocumentFormat, text: String, target: String, bilingual: Bool)] { lock.withLock { _requests } }
  var cancelled: Int { lock.withLock { _cancelled } }

  func translateDocument(format: DocumentFormat, text: String, source: String, target: String, bilingual: Bool) -> AsyncThrowingStream<DocumentEvent, Error> {
    lock.withLock { _requests.append((format, text, target, bilingual)) }
    let (events, error, delay) = (events, error, delay)
    return AsyncThrowingStream { continuation in
      let task = Task {
        for event in events {
          try? await Task.sleep(for: delay)
          if Task.isCancelled { return }
          continuation.yield(event)
        }
        if let error { continuation.finish(throwing: error) } else { continuation.finish() }
      }
      continuation.onTermination = { [weak self] reason in
        if case .cancelled = reason { self?.lock.withLock { self?._cancelled += 1 } }
        task.cancel()
      }
    }
  }
}

func tempDir() throws -> URL {
  let dir = FileManager.default.temporaryDirectory.appending(path: "ait-file-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  return dir
}

@MainActor
func finish(_ job: FileJob) async {
  await job.task?.value
}

extension StubbedSuites {
@Suite
struct FileTranslationTests {
  @Test("格式按扩展名认，不分大小写；输出写到原文件旁边，和 ait 相同")
  func formatAndOutput() {
    #expect(DocumentFormat.detect(URL(fileURLWithPath: "/a/guide.md")) == .markdown)
    #expect(DocumentFormat.detect(URL(fileURLWithPath: "/a/Notes.MARKDOWN")) == .markdown)
    #expect(DocumentFormat.detect(URL(fileURLWithPath: "/a/talk.srt")) == .srt)
    #expect(DocumentFormat.detect(URL(fileURLWithPath: "/a/page.html")) == nil)
    #expect(FileTranslation.outputURL(for: URL(fileURLWithPath: "/a/guide.md"), target: "zh").path == "/a/guide.zh.md")
    #expect(FileTranslation.outputURL(for: URL(fileURLWithPath: "/a/talk.srt"), target: "ja").path == "/a/talk.ja.srt")
    #expect(FileTranslation.outputURL(for: URL(fileURLWithPath: "/a/notes.v2.md"), target: "zh").path == "/a/notes.v2.zh.md")
  }

  @Test("4 只认 UTF-8：BOM 和 CRLF 原样保留；GBK 提示转码；太大、读不了给出原因")
  func reading() throws {
    let dir = try tempDir()
    let bom = dir.appending(path: "bom.md")
    try Data([0xEF, 0xBB, 0xBF] + Array("# Title\r\n\r\nBody.\r\n".utf8)).write(to: bom)
    let text = try FileTranslation.read(bom)
    #expect(text.unicodeScalars.first == "\u{FEFF}")
    #expect(Data(text.utf8) == (try Data(contentsOf: bom)), "读进来再写回去，字节不变")

    let gbk = dir.appending(path: "gbk.srt")
    try Data([0x31, 0x0A, 0xC4, 0xE3, 0xBA, 0xC3, 0x0A]).write(to: gbk)  // 「你好」的 GBK 编码
    #expect(throws: FileTranslationError.notUTF8) { try FileTranslation.read(gbk) }
    #expect(FileTranslationError.notUTF8.message.contains("iconv -f GBK -t UTF-8"))

    let big = dir.appending(path: "big.md")
    try Data(repeating: 0x61, count: FileTranslation.maxBytes + 1).write(to: big)
    #expect(throws: FileTranslationError.tooLarge) { try FileTranslation.read(big) }
    #expect(throws: FileTranslationError.unreadable("missing.md")) { try FileTranslation.read(dir.appending(path: "missing.md")) }
  }

  @Test("接口解码：进度行和最后一行；SRT 格式错误变成「第 N 行格式不对」")
  func decoding() async throws {
    let lines = [
      #"{"type":"progress","done":1,"total":2}"#,
      #"{"type":"progress","done":2,"total":2}"#,
      ##"{"type":"done","text":"# 【译】Title\n","failed":[{"line":3,"error":"模型服务出错"}]}"##,
    ].joined(separator: "\n") + "\n"
    let client = AitdClient(keyFile: try keyFile("k"), session: StubProtocol.session { _ in .json(lines) })
    var events: [DocumentEvent] = []
    for try await e in client.translateDocument(format: .markdown, text: "# Title\n", source: "auto", target: "zh", bilingual: false) { events.append(e) }
    #expect(events == [.progress(done: 1, total: 2), .progress(done: 2, total: 2), .done(text: "# 【译】Title\n", failed: [FailedLine(line: 3, error: "模型服务出错")])])
    #expect(StubProtocol.requests.first?.url?.path() == "/api/translate-document")

    let bad = AitdClient(keyFile: try keyFile("k"), session: StubProtocol.session { _ in
      .json(#"{"error":{"code":"format","message":"第 2 行格式不对：这里应该是时间轴","line":2}}"#, status: 400)
    })
    do {
      for try await _ in bad.translateDocument(format: .srt, text: "1\nHi\n", source: "auto", target: "zh", bilingual: false) {}
      Issue.record("应该报格式错误")
    } catch {
      #expect(FileTranslationError(error: error) == .format(line: 2, message: "第 2 行格式不对：这里应该是时间轴"))
    }
    #expect(FileTranslationError(error: AitdError.server(status: 413, code: "too-large", message: "请求体超过 1024KB", line: nil)) == .tooLarge)
    #expect(FileTranslationError(error: AitdError.unreachable) == .service(.notRunning))
  }

  @Test("1、2 进度从 0 到段数；最后把 aitd 给的整份译文原样写到原文件旁边；双语和目标语言带给 aitd")
  @MainActor
  func translateAndWrite() async throws {
    let dir = try tempDir()
    let source = dir.appending(path: "talk.srt")
    try "1\n00:00:01,000 --> 00:00:02,000\nHello.\n".write(to: source, atomically: true, encoding: .utf8)
    let backend = FakeDocumentBackend()
    let translated = "1\n00:00:01,000 --> 00:00:02,000\nHello.\n【译】Hello.\n"
    backend.events = [.progress(done: 1, total: 1), .done(text: translated, failed: [])]
    let job = try FileJob(source: source, target: "ja", bilingual: true, backend: backend)
    #expect(job.output.lastPathComponent == "talk.ja.srt")
    #expect(job.outputExists == false)
    job.start(sourceLanguage: "auto", target: "ja")
    #expect(job.phase == .translating(done: 0, total: 0))
    await finish(job)
    #expect(job.phase == .finished(failed: [], empty: false))
    #expect(try String(contentsOf: job.output, encoding: .utf8) == translated)
    #expect(backend.requests.first?.format == .srt)
    #expect(backend.requests.first?.bilingual == true)
    #expect(backend.requests.first?.target == "ja")
    #expect(job.outputExists)
  }

  @Test("有段落没翻成：照样写出，列出行号；没有要翻的文字时原样写出并说明")
  @MainActor
  func failedAndEmpty() async throws {
    let dir = try tempDir()
    let source = dir.appending(path: "part.md")
    try "# Fine\n\nBroken.\n".write(to: source, atomically: true, encoding: .utf8)
    let backend = FakeDocumentBackend()
    backend.events = [.progress(done: 1, total: 2), .progress(done: 2, total: 2), .done(text: "# 【译】Fine\n\nBroken.\n", failed: [FailedLine(line: 3, error: "模型服务出错")])]
    let job = try FileJob(source: source, target: "zh", bilingual: false, backend: backend)
    job.start(sourceLanguage: "auto", target: "zh")
    await finish(job)
    #expect(job.phase == .finished(failed: [FailedLine(line: 3, error: "模型服务出错")], empty: false))

    let code = dir.appending(path: "code.md")
    try "```\nx = 1\n```\n".write(to: code, atomically: true, encoding: .utf8)
    let empty = FakeDocumentBackend()
    empty.events = [.done(text: "```\nx = 1\n```\n", failed: [])]
    let job2 = try FileJob(source: code, target: "zh", bilingual: false, backend: empty)
    job2.start(sourceLanguage: "auto", target: "zh")
    await finish(job2)
    #expect(job2.phase == .finished(failed: [], empty: true))
    #expect(try String(contentsOf: job2.output, encoding: .utf8) == "```\nx = 1\n```\n")
  }

  @Test("5 取消：断开连接，不写文件，回到准备状态")
  @MainActor
  func cancel() async throws {
    let dir = try tempDir()
    let source = dir.appending(path: "long.md")
    try "One.\n\nTwo.\n".write(to: source, atomically: true, encoding: .utf8)
    let backend = FakeDocumentBackend()
    backend.delay = .milliseconds(80)
    backend.events = [.progress(done: 1, total: 2), .progress(done: 2, total: 2), .done(text: "x", failed: [])]
    let job = try FileJob(source: source, target: "zh", bilingual: false, backend: backend)
    job.start(sourceLanguage: "auto", target: "zh")
    try await Task.sleep(for: .milliseconds(120))
    #expect(job.phase == .translating(done: 1, total: 2))
    job.cancel()
    try await Task.sleep(for: .milliseconds(250))
    #expect(job.phase == .ready)
    #expect(backend.cancelled == 1)
    #expect(job.outputExists == false)
  }

  @Test("4 出错：SRT 格式错误带行号、aitd 没启动给出启动方法、不是 UTF-8 不发请求；不支持的扩展名建不了任务")
  @MainActor
  func errors() async throws {
    let dir = try tempDir()
    let srt = dir.appending(path: "bad.srt")
    try "1\nHello there.\n".write(to: srt, atomically: true, encoding: .utf8)
    let formatError = FakeDocumentBackend()
    formatError.error = AitdError.server(status: 400, code: "format", message: "第 2 行格式不对：这里应该是时间轴", line: 2)
    let job = try FileJob(source: srt, target: "zh", bilingual: false, backend: formatError)
    job.start(sourceLanguage: "auto", target: "zh")
    await finish(job)
    #expect(job.phase == .failed(.format(line: 2, message: "第 2 行格式不对：这里应该是时间轴")))

    let down = FakeDocumentBackend()
    down.error = AitdError.unreachable
    let job2 = try FileJob(source: srt, target: "zh", bilingual: false, backend: down)
    job2.start(sourceLanguage: "auto", target: "zh")
    await finish(job2)
    #expect(job2.phase == .failed(.service(.notRunning)))
    if case let .failed(e) = job2.phase { #expect(e.message.contains("scripts/aitd-service.sh install")) }

    let gbk = dir.appending(path: "gbk.md")
    try Data([0xC4, 0xE3, 0xBA, 0xC3]).write(to: gbk)
    let unused = FakeDocumentBackend()
    let job3 = try FileJob(source: gbk, target: "zh", bilingual: false, backend: unused)
    job3.start(sourceLanguage: "auto", target: "zh")
    #expect(job3.phase == .failed(.notUTF8))
    #expect(unused.requests.isEmpty)

    #expect(throws: FileTranslationError.unsupported("page.html")) {
      _ = try FileJob(source: dir.appending(path: "page.html"), target: "zh", bilingual: false, backend: unused)
    }
  }

  @Test("3 输出文件已存在：能看出来，要主人确认")
  @MainActor
  func outputExists() throws {
    let dir = try tempDir()
    let source = dir.appending(path: "guide.md")
    try "# Guide\n".write(to: source, atomically: true, encoding: .utf8)
    try "keep me\n".write(to: dir.appending(path: "guide.zh.md"), atomically: true, encoding: .utf8)
    let job = try FileJob(source: source, target: "zh", bilingual: false, backend: FakeDocumentBackend())
    #expect(job.outputExists)
    job.output = dir.appending(path: "guide.another.md")
    #expect(job.outputExists == false)
  }
}
}
