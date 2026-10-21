// Goal 8 CP2：「模型」页的逻辑。Hugging Face 的文件列表解析、下载地址校验、每一行的状态；
// 下载用假的下载服务（URLProtocol 拦下请求，按 Range 返回内容），不连外网：断点续传的请求头、服务器不认 Range、校验不通过、空间不够、跳转。
import CryptoKit
import Foundation
import Testing

@testable import AITranslateKit

// MARK: - 文件列表、下载地址、每一行的状态

@Suite
struct ModelSourceTests {
  @Test("文件列表：只要 Index-Translate-2B.<版本>.gguf；跳过 mmproj、README、没有 sha256 的")
  func parseTree() throws {
    let sha = String(repeating: "a", count: 64)
    let json = """
      [
        {"type":"file","path":".gitattributes","size":2457},
        {"type":"file","path":"Index-Translate-2B.Q4_K_M.gguf","size":1312164352,"lfs":{"oid":"\(sha)","size":1312164352}},
        {"type":"file","path":"Index-Translate-2B.Q8_0.gguf","size":2076674560,"lfs":{"oid":"\(sha)","size":2076674560}},
        {"type":"file","path":"Index-Translate-2B.mmproj-Q8_0.gguf","size":361518144,"lfs":{"oid":"\(sha)","size":361518144}},
        {"type":"file","path":"Index-Translate-2B.Q2_K.gguf","size":990491136,"lfs":{"oid":"not-a-sha","size":990491136}},
        {"type":"file","path":"README.md","size":6723}
      ]
      """
    let models = try ModelSource.parseTree(Data(json.utf8))
    #expect(models == [RemoteModel(quant: "Q4_K_M", size: 1_312_164_352, sha256: sha), RemoteModel(quant: "Q8_0", size: 2_076_674_560, sha256: sha)])
    #expect(throws: (any Error).self) { try ModelSource.parseTree(Data("{}".utf8)) }
  }

  @Test("下载地址：只认 https，去掉末尾的 /；拼出文件列表和下载地址")
  func endpoint() {
    #expect(ModelSource.endpoint(" https://hf-mirror.com/ ")?.absoluteString == "https://hf-mirror.com")
    #expect(ModelSource.endpoint("http://hf-mirror.com") == nil)
    #expect(ModelSource.endpoint("hf-mirror.com") == nil)
    #expect(ModelSource.endpoint("") == nil)
    #expect(ModelSource.endpoint("https://x.com/?a=1") == nil)
    let base = ModelSource.defaultEndpoint
    #expect(ModelSource.treeURL(base).absoluteString == "https://huggingface.co/api/models/IndexTeam/Index-Translate-2B-GGUF/tree/main")
    #expect(ModelSource.fileURL(base, quant: "Q4_K_M").absoluteString == "https://huggingface.co/IndexTeam/Index-Translate-2B-GGUF/resolve/main/Index-Translate-2B.Q4_K_M.gguf")
  }

  @Test("每一行：Hugging Face 和本机取并集、按大小排；正在用 > 下载中 > 已下载 > 下到一半 > 没下载；读不到 Hugging Face 时只有本机的")
  func merge() {
    let sha = String(repeating: "b", count: 64)
    let remote = [
      RemoteModel(quant: "Q8_0", size: 2000, sha256: sha), RemoteModel(quant: "Q4_K_M", size: 1300, sha256: sha),
      RemoteModel(quant: "Q2_K", size: 990, sha256: sha), RemoteModel(quant: "Q6_K", size: 1600, sha256: sha),
      RemoteModel(quant: "Q5_K_M", size: 1450, sha256: sha),
    ]
    let local = LocalModels(current: "Q8_0", pinned: false, models: [.init(quant: "Q8_0", size: 2000), .init(quant: "Q4_K_M", size: 1300), .init(quant: "LOCAL", size: 5)])
    let rows = ModelRows.merge(remote: remote, local: local, partial: ["Q6_K": 400, "Q2_K": 10], active: ["Q2_K": .downloading(500)])
    #expect(rows.map(\.quant) == ["LOCAL", "Q2_K", "Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0"])
    #expect(rows.map(\.state) == [.downloaded, .downloading(500), .downloaded, .available, .paused(400), .inUse])
    #expect(rows.first { $0.quant == "Q6_K" }?.progress == 0.25)
    #expect(rows.first { $0.quant == "Q8_0" }?.note == "默认；盲评和 Q4_K_M 打平")
    let offline = ModelRows.merge(remote: [], local: local, partial: [:], active: [:])
    #expect(offline.map(\.quant) == ["LOCAL", "Q4_K_M", "Q8_0"])
    #expect(ModelRows.merge(remote: remote, local: nil, partial: [:], active: [:]).allSatisfy { $0.state == .available })
  }

  @Test("下到一半的：models 里的 .gguf.part 和大小；别的文件不算")
  func partial() throws {
    let dir = FileManager.default.temporaryDirectory.appending(path: "ait-partial-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    try Data(count: 7).write(to: dir.appending(path: "Index-Translate-2B.Q6_K.gguf.part"))
    try Data(count: 3).write(to: dir.appending(path: "Index-Translate-2B.Q8_0.gguf"))
    try Data(count: 3).write(to: dir.appending(path: "other.gguf.part"))
    #expect(ModelRows.partialDownloads(in: dir) == ["Q6_K": 7])
    #expect(ModelRows.partialDownloads(in: dir.appending(path: "missing")).isEmpty)
    #expect(formatBytes(1_312_164_352) == "1.31 GB")
    #expect(formatBytes(361_518_144) == "362 MB")
  }
}

// MARK: - 假的下载服务

/** 拦下 URLSession 的请求：按 Range 返回内容，也能跳转、返回错误码、故意不认 Range；记下收到的请求头 */
final class FakeDownloadServer: URLProtocol, @unchecked Sendable {
  enum Mode: Sendable {
    case normal
    case ignoreRange
    case wrongRange
    case status(Int)
  }

  struct State {
    var body = Data()
    var mode = Mode.normal
    /** 每块之间隔多少秒（0 表示一下子给完）；慢一点才能在中途取消 */
    var chunkDelay: TimeInterval = 0
    /** 这个 host 的请求先跳转到 cdn.test */
    var redirectFrom: String?
    var ranges: [String?] = []
    var hosts: [String] = []
  }

  nonisolated(unsafe) static var state = State()
  static let lock = NSLock()

  static func configure(_ body: Data, mode: Mode = .normal, redirectFrom: String? = nil, chunkDelay: TimeInterval = 0) {
    lock.withLock { state = State(body: body, mode: mode, chunkDelay: chunkDelay, redirectFrom: redirectFrom) }
  }

  static var seen: (ranges: [String?], hosts: [String]) { lock.withLock { (state.ranges, state.hosts) } }

  static func configuration() -> URLSessionConfiguration {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [FakeDownloadServer.self]
    return config
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let range = request.value(forHTTPHeaderField: "Range")
    let host = request.url?.host() ?? ""
    let s = Self.lock.withLock {
      Self.state.ranges.append(range)
      Self.state.hosts.append(host)
      return Self.state
    }
    let url = request.url!
    if host == s.redirectFrom {
      var next = URLRequest(url: URL(string: "https://cdn.test\(url.path())")!)
      next.httpMethod = request.httpMethod
      let response = HTTPURLResponse(url: url, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": next.url!.absoluteString])!
      client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: response)
      return
    }
    var status = 200
    var headers = ["Content-Type": "application/octet-stream"]
    var body = s.body
    switch s.mode {
    case let .status(code):
      status = code
      body = Data()
    case .ignoreRange:
      break
    case .normal, .wrongRange:
      if let range, let start = Int(range.dropFirst("bytes=".count).dropLast()) {
        let from = if case .wrongRange = s.mode { 0 } else { start }
        status = 206
        headers["Content-Range"] = "bytes \(from)-\(s.body.count - 1)/\(s.body.count)"
        body = s.body.subdata(in: from..<s.body.count)
      }
    }
    client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!, cacheStoragePolicy: .notAllowed)
    // 分几块给，像真的下载；慢速时用当前线程的定时器一块一块给（回调要在这个线程上）
    pending = body
    if s.chunkDelay > 0 {
      let timer = Timer(timeInterval: s.chunkDelay, repeats: true) { [weak self] _ in self?.sendChunk() }
      RunLoop.current.add(timer, forMode: .common)
      self.timer = timer
    } else {
      while sendChunk() {}
    }
  }

  private var pending = Data()
  private var offset = 0
  private var timer: Timer?

  /** 给一块；给完了返回 false */
  @discardableResult
  private func sendChunk() -> Bool {
    guard offset < pending.count else {
      timer?.invalidate()
      timer = nil
      client?.urlProtocolDidFinishLoading(self)
      return false
    }
    let end = min(offset + 4096, pending.count)
    client?.urlProtocol(self, didLoad: pending.subdata(in: offset..<end))
    offset = end
    return true
  }

  override func stopLoading() {
    timer?.invalidate()
    timer = nil
  }
}

final class ProgressLog: @unchecked Sendable {
  private let lock = NSLock()
  private var values: [Int64] = []
  private var verified = false
  func add(_ value: Int64) { lock.withLock { values.append(value) } }
  func markVerifying() { lock.withLock { verified = true } }
  var last: Int64? { lock.withLock { values.last } }
  var didVerify: Bool { lock.withLock { verified } }
}

func sha256Hex(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

/** 用假下载服务的测试共用一份静态状态：放在一个串行的套件里，彼此不并发 */
@Suite(.serialized)
enum FakeServerTests {}

extension FakeServerTests {
@Suite
struct ModelDownloaderTests {
  let dir = FileManager.default.temporaryDirectory.appending(path: "ait-download-\(UUID().uuidString)")
  let body = Data((0..<50_000).map { UInt8($0 % 251) })
  let endpoint = URL(string: "https://hf.test")!

  func downloader(free: Int64? = nil) -> ModelDownloader {
    ModelDownloader(directory: dir, configuration: { FakeDownloadServer.configuration() }, freeSpace: { _ in free })
  }

  var model: RemoteModel { RemoteModel(quant: "Q4_K_M", size: Int64(body.count), sha256: sha256Hex(body)) }

  @Test("从头下：一次 GET 不带 Range；校验通过后改名成 .gguf，.part 没了；进度报到总大小，校验前通知")
  func fresh() async throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    FakeDownloadServer.configure(body)
    let log = ProgressLog()
    let file = try await downloader().download(model, from: endpoint, progress: { log.add($0) }, verifying: { log.markVerifying() })
    #expect(try Data(contentsOf: file) == body)
    #expect(file.lastPathComponent == "Index-Translate-2B.Q4_K_M.gguf")
    #expect(!FileManager.default.fileExists(atPath: downloader().partFile("Q4_K_M").path))
    #expect(FakeDownloadServer.seen.ranges == [nil])
    #expect(log.last == Int64(body.count))
    #expect(log.didVerify)
  }

  @Test("接着下：.part 里已有前 12345 字节，请求带 Range: bytes=12345-，服务器回 206，拼起来和原文件一致")
  func resume() async throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try body.prefix(12345).write(to: downloader().partFile("Q4_K_M"))
    FakeDownloadServer.configure(body)
    let file = try await downloader().download(model, from: endpoint, progress: { _ in })
    #expect(FakeDownloadServer.seen.ranges == ["bytes=12345-"])
    #expect(try Data(contentsOf: file) == body)
  }

  @Test("跳转到 CDN 时也带着 Range")
  func redirect() async throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try body.prefix(100).write(to: downloader().partFile("Q4_K_M"))
    FakeDownloadServer.configure(body, redirectFrom: "hf.test")
    let file = try await downloader().download(model, from: endpoint, progress: { _ in })
    #expect(FakeDownloadServer.seen.hosts == ["hf.test", "cdn.test"])
    #expect(FakeDownloadServer.seen.ranges == ["bytes=100-", "bytes=100-"])
    #expect(try Data(contentsOf: file) == body)
  }

  @Test("服务器不认 Range（回 200 整个文件）：从头写，不会把整个文件接在半截后面")
  func ignoreRange() async throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try body.prefix(5000).write(to: downloader().partFile("Q4_K_M"))
    FakeDownloadServer.configure(body, mode: .ignoreRange)
    let file = try await downloader().download(model, from: endpoint, progress: { _ in })
    #expect(try Data(contentsOf: file) == body)
  }

  @Test("206 但返回的不是要的那一段：报错，不接上去")
  func wrongRange() async throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try body.prefix(5000).write(to: downloader().partFile("Q4_K_M"))
    FakeDownloadServer.configure(body, mode: .wrongRange)
    await #expect(throws: ModelDownloadError.http(206)) { try await downloader().download(model, from: endpoint, progress: { _ in }) }
    #expect(downloader().downloadedBytes("Q4_K_M") == 5000)
  }

  @Test("校验不通过：删掉 .part，不生成 .gguf，报「校验不通过」")
  func checksum() async throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    FakeDownloadServer.configure(body)
    let bad = RemoteModel(quant: "Q4_K_M", size: Int64(body.count), sha256: String(repeating: "0", count: 64))
    await #expect(throws: ModelDownloadError.checksumMismatch) { try await downloader().download(bad, from: endpoint, progress: { _ in }) }
    #expect(!FileManager.default.fileExists(atPath: downloader().partFile("Q4_K_M").path))
    #expect(!FileManager.default.fileExists(atPath: downloader().finalFile("Q4_K_M").path))
  }

  @Test("磁盘空间不够（要留 500 MB 余量）：不发请求，直接报还要多少、剩多少")
  func noSpace() async throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    FakeDownloadServer.configure(body)
    let free: Int64 = 400_000_000
    await #expect(throws: ModelDownloadError.noSpace(needed: Int64(body.count) + ModelDownloader.spaceMargin, available: free)) {
      try await downloader(free: free).download(model, from: endpoint, progress: { _ in })
    }
    #expect(FakeDownloadServer.seen.ranges.isEmpty)
  }

  @Test("下载地址返回 404：报状态码；.part 比文件还大时作废重下")
  func httpError() async throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    FakeDownloadServer.configure(body, mode: .status(404))
    await #expect(throws: ModelDownloadError.http(404)) { try await downloader().download(model, from: endpoint, progress: { _ in }) }
    try Data(count: body.count + 10).write(to: downloader().partFile("Q4_K_M"))
    FakeDownloadServer.configure(body)
    let file = try await downloader().download(model, from: endpoint, progress: { _ in })
    #expect(FakeDownloadServer.seen.ranges == [nil])
    #expect(try Data(contentsOf: file) == body)
  }
}

}

// MARK: - 「模型」页的状态

actor FakeModelsBackend: ModelsBackend {
  var list: LocalModels
  var failUse: AitdError?
  var down = false
  private(set) var used: [String] = []

  init(_ list: LocalModels) { self.list = list }

  func setDown(_ value: Bool) { down = value }
  func setFailUse(_ error: AitdError?) { failUse = error }

  func models() async throws -> LocalModels {
    // 和真的网络请求一样：任务已经取消时直接失败
    try Task.checkCancellation()
    if down { throw AitdError.unreachable }
    return list
  }

  func useModel(_ quant: String) async throws -> LocalModels {
    used.append(quant)
    if let failUse { throw failUse }
    list = LocalModels(current: quant, pinned: list.pinned, models: list.models)
    return list
  }

  func deleteModel(_ quant: String) async throws -> LocalModels {
    list = LocalModels(current: list.current, pinned: list.pinned, models: list.models.filter { $0.quant != quant })
    return list
  }

  /** 下载完成后 aitd 能看到新文件 */
  func add(_ quant: String, size: Int64) {
    list = LocalModels(current: list.current, pinned: list.pinned, models: list.models + [.init(quant: quant, size: size)])
  }
}

extension FakeServerTests {
@MainActor
@Suite
struct ModelsModelTests {
  let dir = FileManager.default.temporaryDirectory.appending(path: "ait-models-\(UUID().uuidString)")
  let defaults = UserDefaults(suiteName: "ait-models-\(UUID().uuidString)")!
  let sha = String(repeating: "c", count: 64)

  func make(_ backend: FakeModelsBackend, remote: Result<[RemoteModel], Error>) -> ModelsModel {
    let downloader = ModelDownloader(directory: dir, configuration: { FakeDownloadServer.configuration() }, freeSpace: { _ in 10_000_000_000 })
    return ModelsModel(backend: backend, downloader: downloader, defaults: defaults, fetchRemote: { _ in try remote.get() })
  }

  var localList: LocalModels { LocalModels(current: "Q8_0", pinned: false, models: [.init(quant: "Q8_0", size: 2000), .init(quant: "Q4_K_M", size: 1300)]) }

  @Test("打开页面：合起两边的列表；读不到 Hugging Face 时说明原因、只列本机的；aitd 没启动时说明，本机已有的看目录标成已下载")
  func refresh() async {
    defer { try? FileManager.default.removeItem(at: dir) }
    let backend = FakeModelsBackend(localList)
    let online = make(backend, remote: .success([RemoteModel(quant: "Q2_K", size: 990, sha256: sha)]))
    await online.refresh()
    #expect(online.rows.map(\.quant) == ["Q2_K", "Q4_K_M", "Q8_0"])
    #expect(online.remoteProblem == nil && online.serviceProblem == nil)
    #expect(online.freeSpace == 10_000_000_000)

    let offline = make(backend, remote: .failure(URLError(.notConnectedToInternet)))
    await offline.refresh()
    #expect(offline.rows.map(\.quant) == ["Q4_K_M", "Q8_0"])
    #expect(offline.remoteProblem?.hasPrefix("读不到 huggingface.co 上的版本列表") == true)

    // aitd 没启动：自己看 models/，已有的标成已下载（不标在用）
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try? Data(count: 5).write(to: dir.appending(path: "Index-Translate-2B.Q4_K_M.gguf"))
    await backend.setDown(true)
    await online.refresh()
    #expect(online.serviceProblem?.hasPrefix("aitd 没启动") == true)
    #expect(online.rows.map(\.quant) == ["Q4_K_M", "Q2_K"])
    #expect(online.rows.map(\.state) == [.downloaded, .available])
  }

  @Test("读列表时被取消（切到别的设置页）：不报错，保留原来的列表和状态")
  func refreshCancelled() async {
    let backend = FakeModelsBackend(localList)
    let model = make(backend, remote: .success([RemoteModel(quant: "Q2_K", size: 990, sha256: sha)]))
    await model.refresh()
    let cancelled = make(backend, remote: .failure(CancellationError()))
    await cancelled.refresh()
    #expect(cancelled.remoteProblem == nil)
    let task = Task { await model.refresh() }
    task.cancel()
    await task.value
    #expect(model.serviceProblem == nil && model.remoteProblem == nil)
    #expect(model.rows.map(\.quant) == ["Q2_K", "Q4_K_M", "Q8_0"])
    #expect(model.rows.last?.state == .inUse)
  }

  @Test("下载地址改成 http：不去读，提示要 https；改回来存进设置")
  func endpointSetting() async {
    let model = make(FakeModelsBackend(localList), remote: .success([]))
    model.endpointText = "http://mirror.test"
    await model.refresh()
    #expect(model.remoteProblem?.hasPrefix("下载地址不对") == true)
    model.endpointText = "https://hf-mirror.com"
    #expect(defaults.string(forKey: ModelsModel.endpointKey) == "https://hf-mirror.com")
  }

  @Test("设为当前：调 aitd 切换，切换中标出来，成功后这一行变成「在用」；失败时这一行显示原因")
  func use() async {
    let backend = FakeModelsBackend(localList)
    let model = make(backend, remote: .success([]))
    await model.refresh()
    await model.use("Q4_K_M")
    #expect(model.rows.first { $0.quant == "Q4_K_M" }?.state == .inUse)
    #expect(model.rows.first { $0.quant == "Q8_0" }?.state == .downloaded)
    #expect(model.switching == nil)

    await backend.setFailUse(.server(status: 500, code: "switch-failed", message: "换成 Q8_0 失败，已退回 Q4_K_M：模型服务启动失败", line: nil))
    await model.use("Q8_0")
    #expect(model.errors["Q8_0"] == "换成 Q8_0 失败，已退回 Q4_K_M：模型服务启动失败")
    #expect(model.rows.first { $0.quant == "Q4_K_M" }?.state == .inUse)
  }

  @Test("删除：已下载的交给 aitd 删；下到一半的直接删 .part")
  func delete() async throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    try Data(count: 10).write(to: dir.appending(path: "Index-Translate-2B.Q6_K.gguf.part"))
    let backend = FakeModelsBackend(localList)
    let model = make(backend, remote: .success([RemoteModel(quant: "Q6_K", size: 1600, sha256: sha)]))
    await model.refresh()
    #expect(model.rows.first { $0.quant == "Q6_K" }?.state == .paused(10))
    await model.delete("Q6_K")
    #expect(model.rows.first { $0.quant == "Q6_K" }?.state == .available)
    await model.delete("Q4_K_M")
    #expect(model.rows.map(\.quant) == ["Q6_K", "Q8_0"])
  }

  @Test("下载：一次只下一个；下完 aitd 列表里有了，这一行变成「已下载」；校验不通过时这一行显示原因")
  func download() async throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    let body = Data((0..<20_000).map { UInt8($0 % 13) })
    FakeDownloadServer.configure(body)
    let backend = FakeModelsBackend(localList)
    let good = RemoteModel(quant: "Q2_K", size: Int64(body.count), sha256: sha256Hex(body))
    let bad = RemoteModel(quant: "Q3_K_S", size: Int64(body.count), sha256: sha)
    let model = make(backend, remote: .success([good, bad]))
    await model.refresh()
    model.download("Q2_K")
    model.download("Q3_K_S")
    #expect(model.downloading == "Q2_K", "一次只下一个")
    await backend.add("Q2_K", size: Int64(body.count))
    while model.downloading != nil { try await Task.sleep(for: .milliseconds(20)) }
    #expect(model.rows.first { $0.quant == "Q2_K" }?.state == .downloaded)
    #expect(model.errors["Q2_K"] == nil)

    model.download("Q3_K_S")
    while model.downloading != nil { try await Task.sleep(for: .milliseconds(20)) }
    #expect(model.errors["Q3_K_S"] == ModelDownloadError.checksumMismatch.message)
    #expect(model.rows.first { $0.quant == "Q3_K_S" }?.state == .available)
  }

  @Test("取消下载：这一行变成「下到一半」，在用的版本照常显示，不会误报连不上翻译服务（主人 2026-10-21 试用发现）")
  func cancel() async throws {
    defer { try? FileManager.default.removeItem(at: dir) }
    let body = Data((0..<40_000).map { UInt8($0 % 7) })
    FakeDownloadServer.configure(body, chunkDelay: 0.03)
    let backend = FakeModelsBackend(localList)
    let model = make(backend, remote: .success([RemoteModel(quant: "Q2_K", size: Int64(body.count), sha256: sha256Hex(body))]))
    await model.refresh()
    model.download("Q2_K")
    while model.downloader.downloadedBytes("Q2_K") == 0 { try await Task.sleep(for: .milliseconds(5)) }
    model.cancel("Q2_K")
    while model.downloading != nil { try await Task.sleep(for: .milliseconds(10)) }
    #expect(model.serviceProblem == nil)
    #expect(model.errors["Q2_K"] == nil)
    #expect(model.rows.first { $0.quant == "Q8_0" }?.state == .inUse)
    let state = model.rows.first { $0.quant == "Q2_K" }?.state
    guard case let .paused(done)? = state else {
      Issue.record("应该是下到一半，实际是 \(String(describing: state))")
      return
    }
    #expect(done > 0 && done < Int64(body.count))
  }

  @Test("aitd 还是旧版本（没有模型接口）：提示重启翻译服务")
  func oldAitd() {
    let message = ModelsModel.message(AitdError.server(status: 404, code: "not-found", message: "没有这个接口", line: nil))
    #expect(message == "aitd 还不支持模型管理：在菜单栏点「重启翻译服务」后再试")
  }
}
}
