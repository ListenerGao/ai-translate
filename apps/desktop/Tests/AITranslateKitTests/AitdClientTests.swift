// Goal 6 CP2：连 aitd 的客户端和菜单栏状态。用假 aitd（StubProtocol），编号对应施工清单 CP2 的单测预期。
import Foundation
import Testing

@testable import AITranslateKit

/** 临时密钥文件；内容为 nil 时不建文件 */
func keyFile(_ content: String?) throws -> URL {
  let dir = FileManager.default.temporaryDirectory.appending(path: "ait-desktop-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let file = dir.appending(path: "api-key")
  if let content { try content.write(to: file, atomically: true, encoding: .utf8) }
  return file
}

let health = #"{"status":"ok","version":"0.1.0","api":1}"#

func statusJSON(state: String, quant: String = "Q8_0", detail: String? = nil) -> String {
  let d = detail.map { #","detail":"\#($0)""# } ?? ""
  return #"{"version":"0.1.0","api":1,"model":{"state":"\#(state)","model":"index-translate-2b","quant":"\#(quant)"\#(d)},"queue":{"pending":2,"active":1},"cache":{"entries":716}}"#
}

/** 按路径回应的假 aitd：/health 和 /api/status */
func fakeAitd(status: String, statusCode: Int = 200, healthBody: String = health) -> URLSession {
  StubProtocol.session { req in
    switch req.url?.path() {
    case "/health": .json(healthBody)
    case "/api/status": .json(status, status: statusCode)
    default: .json(#"{"error":{"code":"not-found","message":"没有这个接口"}}"#, status: 404)
    }
  }
}

extension StubbedSuites {
@Suite
struct AitdClientTests {
  @Test("1 健康检查和状态解析；模型状态映射成菜单栏的说法")
  func statusMapping() async throws {
    let key = try keyFile("secret-key\n")
    let client = AitdClient(keyFile: key, session: fakeAitd(status: statusJSON(state: "ready")))
    let st = try await client.status()
    #expect(st.model.quant == "Q8_0")
    #expect(st.queue == .init(pending: 2, active: 1))
    #expect(st.cache.entries == 716)
    #expect(StubProtocol.requests.last?.value(forHTTPHeaderField: "Authorization") == "Bearer secret-key")

    let cases: [(String, String?, ServiceState)] = [
      ("ready", nil, .running(quant: "Q8_0")),
      ("starting", nil, .starting(quant: "Q8_0")),
      ("stopped", nil, .sleeping(quant: "Q8_0")),
      ("error", "模型文件不存在", .modelError(detail: "模型文件不存在")),
    ]
    for (state, detail, expected) in cases {
      let c = AitdClient(keyFile: key, session: fakeAitd(status: statusJSON(state: state, detail: detail)))
      #expect(await c.serviceState() == expected)
    }
    #expect(ServiceState.running(quant: "Q8_0").title == "运行中")
    #expect(ServiceState.running(quant: "Q8_0").detail == "Index-Translate-2B · Q8_0")
    #expect(ServiceState.sleeping(quant: "Q8_0").detail == "Index-Translate-2B · Q8_0 · 用到时自动启动")
    #expect(ServiceState.running(quant: nil).badge == .none)
    #expect(ServiceState.starting(quant: nil).badge == .busy)
    #expect(ServiceState.notRunning.badge == .problem)
  }

  @Test("2 密钥不对：显示「密钥不对」")
  func badKey() async throws {
    let client = AitdClient(keyFile: try keyFile("wrong"), session: fakeAitd(status: #"{"error":{"code":"unauthorized","message":"密钥不对"}}"#, statusCode: 401))
    #expect(await client.serviceState() == .badKey)
    await #expect(throws: AitdError.unauthorized) { try await client.status() }
  }

  @Test("3 连不上：显示「aitd 没启动」和启动方法")
  func notRunning() async throws {
    // 1 号端口在 macOS 上没人监听，连接立即被拒绝
    let client = AitdClient(endpoint: URL(string: "http://127.0.0.1:1")!, keyFile: try keyFile("k"), session: URLSession(configuration: .ephemeral))
    let state = await client.serviceState()
    #expect(state == .notRunning)
    #expect(state.title == "aitd 没启动")
    #expect(state.detail?.contains("scripts/aitd-service.sh install") == true)
    #expect(state.detail?.contains("npm run aitd") == true)
  }

  @Test("4 非本机地址：拒绝发送，一个请求都不发")
  func notLocal() async throws {
    let session = fakeAitd(status: statusJSON(state: "ready"))
    for endpoint in ["http://192.168.1.2:8790", "https://127.0.0.1:8790", "http://example.com:8790", "http://127.0.0.1.evil.com:8790"] {
      let client = AitdClient(endpoint: URL(string: endpoint)!, keyFile: try keyFile("k"), session: session)
      #expect(await client.serviceState() == .badEndpoint, "\(endpoint)")
      await #expect(throws: AitdError.notLocal) { try await client.status() }
    }
    #expect(StubProtocol.requests.isEmpty)
    #expect(AitdClient.isLocal(URL(string: "http://localhost:8790")!))
    #expect(AitdClient.isLocal(URL(string: "http://127.0.0.1:8790")!))
  }

  @Test("5 密钥文件不存在或是空的：提示先启动一次 aitd；/health 不带密钥也能查")
  func missingKey() async throws {
    for content in [nil, "", "  \n"] as [String?] {
      let key = try keyFile(content)
      let client = AitdClient(keyFile: key, session: fakeAitd(status: statusJSON(state: "ready")))
      let state = await client.serviceState()
      #expect(state == .noKey(path: key.path))
      #expect(state.detail?.contains("先启动一次 aitd") == true)
    }
    #expect(StubProtocol.requests.map { $0.url?.path() } == ["/health"])
    #expect(StubProtocol.requests.first?.value(forHTTPHeaderField: "Authorization") == nil)
  }

  @Test("6 NDJSON：一行被拆在两个数据块里也能拼对；空行跳过；请求带 JSON 和密钥")
  func ndjsonLines() async throws {
    struct Line: Decodable, Sendable, Equatable {
      let id: String
      let text: String
    }
    struct Body: Encodable {
      let target: String
    }
    let session = StubProtocol.session { _ in
      StubProtocol.Reply(chunks: [
        Data((#"{"id":"a","text":"你好"}"# + "\n" + #"{"id":"b","te"#).utf8),
        Data((#"xt":"世界"}"# + "\n\n").utf8),
        Data((#"{"id":"c","text":"！"}"# + "\n").utf8),
      ])
    }
    let client = AitdClient(keyFile: try keyFile("k"), session: session)
    var got: [Line] = []
    for try await line in client.ndjson("api/translate", body: Body(target: "zh"), as: Line.self) { got.append(line) }
    #expect(got == [Line(id: "a", text: "你好"), Line(id: "b", text: "世界"), Line(id: "c", text: "！")])
    let req = try #require(StubProtocol.requests.first)
    #expect(req.httpMethod == "POST")
    #expect(req.value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer k")
  }

  @Test("NDJSON 出错：aitd 返回 400 时带上错误码、说明和行号；看不懂的行报错")
  func ndjsonErrors() async throws {
    struct Line: Decodable, Sendable {
      let id: String
    }
    struct Body: Encodable {
      let format: String
    }
    let bad = StubProtocol.session { _ in
      .json(#"{"error":{"code":"format","message":"第 2 行格式不对：这里应该是时间轴","line":2}}"#, status: 400)
    }
    let client = AitdClient(keyFile: try keyFile("k"), session: bad)
    await #expect(throws: AitdError.server(status: 400, code: "format", message: "第 2 行格式不对：这里应该是时间轴", line: 2)) {
      for try await _ in client.ndjson("api/translate-document", body: Body(format: "srt"), as: Line.self) {}
    }
    let garbage = AitdClient(keyFile: try keyFile("k"), session: StubProtocol.session { _ in .json("not json\n") })
    await #expect(throws: AitdError.badResponse) {
      for try await _ in garbage.ndjson("api/translate", body: Body(format: "x"), as: Line.self) {}
    }
  }

  @Test("接口版本对不上：显示「版本对不上」")
  func versionMismatch() async throws {
    let client = AitdClient(keyFile: try keyFile("k"), session: fakeAitd(status: statusJSON(state: "ready"), healthBody: #"{"status":"ok","version":"9.0.0","api":2}"#))
    #expect(await client.serviceState() == .versionMismatch)
  }

  @Test("马上加载模型：POST /api/model/load 带密钥，202 算成功")
  func loadModel() async throws {
    let client = AitdClient(keyFile: try keyFile("k"), session: StubProtocol.session { _ in .json(#"{"model":{"state":"starting","model":"index-translate-2b","quant":"Q8_0"}}"#, status: 202) })
    try await client.loadModel()
    let req = try #require(StubProtocol.requests.first)
    #expect(req.httpMethod == "POST")
    #expect(req.url?.path() == "/api/model/load")
    #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer k")
  }

  @Test("开机自启的服务名")
  func serviceTarget() {
    #expect(AitdService.target(uid: 501) == "gui/501/com.listenergao.ai-translate.aitd")
  }
}
}
