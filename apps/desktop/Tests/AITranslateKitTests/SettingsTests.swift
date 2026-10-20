// Goal 6 CP5：设置页。术语表接口用假 aitd，设置页的状态用假后端。
import Foundation
import Testing

@testable import AITranslateKit

/** 读 URLProtocol 拿到的请求体（URLSession 会把 httpBody 转成流） */
func bodyText(_ request: URLRequest) -> String {
  if let body = request.httpBody { return String(decoding: body, as: UTF8.self) }
  guard let stream = request.httpBodyStream else { return "" }
  stream.open()
  defer { stream.close() }
  var data = Data()
  var buffer = [UInt8](repeating: 0, count: 4096)
  while stream.hasBytesAvailable {
    let n = stream.read(&buffer, maxLength: buffer.count)
    if n <= 0 { break }
    data.append(buffer, count: n)
  }
  return String(decoding: data, as: UTF8.self)
}

extension StubbedSuites {
  @Suite
  struct GlossaryClientTests {
    @Test("术语表：GET 读纯文本；PUT 发纯文本带密钥，返回条数")
    func readAndSave() async throws {
      let session = StubProtocol.session { req in
        req.httpMethod == "PUT" ? .json(#"{"entries":2}"#) : .json("# 注释\nmockup=原型图\nprompt=提示词\n")
      }
      let client = AitdClient(keyFile: try keyFile("k"), session: session)
      #expect(try await client.glossary() == "# 注释\nmockup=原型图\nprompt=提示词\n")
      #expect(try await client.saveGlossary("mockup=原型图\nprompt=提示词\n") == 2)
      let put = try #require(StubProtocol.requests.last)
      #expect(put.httpMethod == "PUT")
      #expect(put.value(forHTTPHeaderField: "Content-Type") == "text/plain; charset=utf-8")
      #expect(put.value(forHTTPHeaderField: "Authorization") == "Bearer k")
      #expect(bodyText(put) == "mockup=原型图\nprompt=提示词\n")
    }

    @Test("术语表有写错的行：返回每一行的行号和原因；密钥不对另报")
    func invalid() async throws {
      let bad = StubProtocol.session { _ in
        .json(#"{"error":{"code":"invalid-glossary","message":"术语表有错误，没有保存","lines":[{"line":2,"message":"缺少「=」，格式应为 原文=译文"},{"line":4,"message":"原文和译文都不能为空"}]}}"#, status: 400)
      }
      let client = AitdClient(keyFile: try keyFile("k"), session: bad)
      await #expect(throws: GlossarySaveError.invalid([
        GlossaryLineError(line: 2, message: "缺少「=」，格式应为 原文=译文"),
        GlossaryLineError(line: 4, message: "原文和译文都不能为空"),
      ])) { _ = try await client.saveGlossary("a=b\noops\n\n=x\n") }

      let unauthorized = AitdClient(keyFile: try keyFile("k"), session: StubProtocol.session { _ in .json(#"{"error":{"code":"unauthorized","message":"密钥不对"}}"#, status: 401) })
      await #expect(throws: AitdError.unauthorized) { _ = try await unauthorized.saveGlossary("a=b\n") }
    }
  }
}

/** 假的设置后端：术语表存在内存里，按 parseGlossary 的规则挑错 */
final class FakeSettingsBackend: SettingsBackend, @unchecked Sendable {
  private let lock = NSLock()
  private var stored: String
  var down = false
  private(set) var saves = 0

  init(glossary: String) { stored = glossary }

  var current: String { lock.withLock { stored } }

  func glossary() async throws -> String {
    if down { throw AitdError.unreachable }
    return current
  }

  func saveGlossary(_ text: String) async throws -> Int {
    if down { throw AitdError.unreachable }
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false).enumerated().compactMap { i, raw -> GlossaryLineError? in
      let line = raw.trimmingCharacters(in: .whitespaces)
      return line.isEmpty || line.hasPrefix("#") || line.contains("=") ? nil : GlossaryLineError(line: i + 1, message: "缺少「=」，格式应为 原文=译文")
    }
    if !lines.isEmpty { throw GlossarySaveError.invalid(lines) }
    lock.withLock {
      stored = text
      saves += 1
    }
    return text.split(separator: "\n").filter { $0.contains("=") && !$0.hasPrefix("#") }.count
  }

  func serviceDetails() async -> (state: ServiceState, status: AitdStatus?) {
    if down { return (.notRunning, nil) }
    let status = AitdStatus(version: "0.1.0", api: 1, model: .init(state: "ready", model: "index-translate-2b", quant: "Q8_0", detail: nil), queue: .init(pending: 0, active: 0), cache: .init(entries: 716))
    return (.running(quant: "Q8_0"), status)
  }
}

@MainActor
@Suite
struct SettingsModelTests {
  @Test("打开设置：读到术语表和服务状态；改了才算有改动；保存后插件、命令行共用的那份跟着变")
  func loadEditSave() async {
    let backend = FakeSettingsBackend(glossary: "mockup=原型图\n")
    let model = SettingsModel(backend: backend)
    await model.load()
    #expect(model.glossaryText == "mockup=原型图\n")
    #expect(model.glossaryLoaded)
    #expect(model.isDirty == false)
    #expect(model.service == .running(quant: "Q8_0"))
    #expect(model.status?.cache.entries == 716)

    model.glossaryText = "mockup=原型图\nprompt=提示词\n"
    #expect(model.isDirty)
    await model.save()
    #expect(backend.current == "mockup=原型图\nprompt=提示词\n")
    #expect(model.isDirty == false)
    #expect(model.glossaryMessage == "已保存，共 2 条（插件和命令行马上用上）")
  }

  @Test("写错的行：标出行号，不保存；改对后能保存；还原放弃改动")
  func invalidAndRevert() async {
    let backend = FakeSettingsBackend(glossary: "a=b\n")
    let model = SettingsModel(backend: backend)
    await model.load()
    model.glossaryText = "a=b\nno equals here\n"
    await model.save()
    #expect(model.glossaryErrors == [GlossaryLineError(line: 2, message: "缺少「=」，格式应为 原文=译文")])
    #expect(model.glossaryMessage == "有 1 行写错了，没有保存")
    #expect(backend.current == "a=b\n")
    #expect(model.isDirty)

    model.revert()
    #expect(model.glossaryText == "a=b\n")
    #expect(model.glossaryErrors.isEmpty)
    #expect(model.isDirty == false)
  }

  @Test("aitd 没启动：读不到术语表就不让保存，免得把空内容存回去")
  func serviceDown() async {
    let backend = FakeSettingsBackend(glossary: "a=b\n")
    backend.down = true
    let model = SettingsModel(backend: backend)
    await model.load()
    #expect(model.service == .notRunning)
    #expect(model.glossaryLoaded == false)
    #expect(model.glossaryMessage == "读不到术语表：aitd 没启动")
    model.glossaryText = "x=y\n"
    #expect(model.isDirty == false)
    await model.save()
    #expect(backend.saves == 0)
  }
}
