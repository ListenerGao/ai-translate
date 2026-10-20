// 连本机翻译服务 aitd：和插件、命令行用同一个地址和密钥文件。
// 只连本机地址（127.0.0.1、localhost），不是就不发送；密钥只从 api-key 文件读，不另存。
import Foundation

public enum AitdError: Error, Equatable, Sendable {
  /** 服务地址不是本机 */
  case notLocal
  /** 密钥文件不存在或是空的 */
  case noKey(path: String)
  /** 连不上 aitd（没启动、端口不对） */
  case unreachable
  /** 密钥不对 */
  case unauthorized
  /** aitd 返回了错误：状态码、错误码、说明，SRT 格式错误时带行号 */
  case server(status: Int, code: String, message: String, line: Int?)
  /** 返回的内容看不懂 */
  case badResponse
}

/** GET /health 的返回 */
public struct AitdHealth: Decodable, Sendable, Equatable {
  public let status: String
  public let version: String
  public let api: Int
}

/** GET /api/status 的返回 */
public struct AitdStatus: Decodable, Sendable, Equatable {
  public struct Model: Decodable, Sendable, Equatable {
    /** stopped 已休眠 / starting 启动中 / ready 运行中 / error 出错 */
    public let state: String
    public let model: String
    public let quant: String?
    public let detail: String?
  }
  public struct Queue: Decodable, Sendable, Equatable {
    public let pending: Int
    public let active: Int
  }
  public struct Cache: Decodable, Sendable, Equatable {
    public let entries: Int
  }
  public let version: String
  public let api: Int
  public let model: Model
  public let queue: Queue
  public let cache: Cache
}

public struct AitdClient: Sendable {
  public static let defaultEndpoint = URL(string: "http://127.0.0.1:8790")!
  /** App 认的 aitd 接口版本，和 core 的 AITD_API 对应 */
  public static let supportedAPI = 1
  public static var defaultKeyFile: URL {
    FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Application Support/ai-translate/api-key")
  }

  public let endpoint: URL
  public let keyFile: URL
  let session: URLSession
  /** 健康检查、状态这类短请求的超时 */
  let shortTimeout: TimeInterval

  public init(endpoint: URL = defaultEndpoint, keyFile: URL = defaultKeyFile, session: URLSession = .shared, shortTimeout: TimeInterval = 2) {
    self.endpoint = endpoint
    self.keyFile = keyFile
    self.session = session
    self.shortTimeout = shortTimeout
  }

  /** 只认 http://127.0.0.1 和 http://localhost，和插件的检查一致 */
  public static func isLocal(_ url: URL) -> Bool {
    guard url.scheme == "http", let host = url.host()?.lowercased() else { return false }
    return host == "127.0.0.1" || host == "localhost"
  }

  func readKey() throws -> String {
    guard let data = FileManager.default.contents(atPath: keyFile.path), let text = String(data: data, encoding: .utf8) else {
      throw AitdError.noKey(path: keyFile.path)
    }
    let key = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if key.isEmpty { throw AitdError.noKey(path: keyFile.path) }
    return key
  }

  func request(_ path: String, method: String = "GET", body: Data? = nil, contentType: String = "application/json", auth: Bool = true, timeout: TimeInterval? = nil) throws -> URLRequest {
    guard Self.isLocal(endpoint) else { throw AitdError.notLocal }
    var r = URLRequest(url: endpoint.appending(path: path))
    r.httpMethod = method
    r.timeoutInterval = timeout ?? shortTimeout
    if auth { r.setValue("Bearer \(try readKey())", forHTTPHeaderField: "Authorization") }
    if let body {
      r.httpBody = body
      r.setValue(contentType, forHTTPHeaderField: "Content-Type")
    }
    return r
  }

  /** GET /health：不要密钥，看 aitd 在不在、接口版本对不对 */
  public func health() async throws -> AitdHealth {
    let (data, response) = try await send(request("health", auth: false))
    try check(response, data)
    return try decode(AitdHealth.self, data)
  }

  /** POST /api/model/load：让 aitd 马上开始加载模型（不等加载完就返回），重启翻译服务后用 */
  public func loadModel() async throws {
    let (data, response) = try await send(request("api/model/load", method: "POST"))
    try check(response, data)
  }

  /** GET /api/status：模型状态、队列、缓存 */
  public func status() async throws -> AitdStatus {
    let (data, response) = try await send(request("api/status"))
    try check(response, data)
    return try decode(AitdStatus.self, data)
  }

  /**
   * 发一个返回 NDJSON 的请求（翻译接口），按行解码；数据块在一行中间断开也能拼对。
   * 调用方取消遍历（或任务被取消）时断开连接，aitd 会撤销还没开始的段落。
   */
  public func ndjson<Line: Decodable & Sendable>(_ path: String, body: some Encodable, as _: Line.Type, timeout: TimeInterval = 600) -> AsyncThrowingStream<Line, Error> {
    let encoded = Result { try JSONEncoder().encode(body) }
    return AsyncThrowingStream { continuation in
      let task = Task {
        do {
          let req = try request(path, method: "POST", body: try encoded.get(), timeout: timeout)
          let (bytes, response) = try await mapErrors { try await session.bytes(for: req) }
          if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            var data = Data()
            for try await byte in bytes { data.append(byte) }
            try check(response, data)
          }
          for try await line in bytes.lines where !line.trimmingCharacters(in: .whitespaces).isEmpty {
            continuation.yield(try decode(Line.self, Data(line.utf8)))
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: Self.mapped(error))
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  // MARK: - 内部

  func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
    try await mapErrors { try await session.data(for: request) }
  }

  func mapErrors<T>(_ body: () async throws -> T) async throws -> T {
    do {
      return try await body()
    } catch {
      throw Self.mapped(error)
    }
  }

  static func mapped(_ error: Error) -> Error {
    if error is AitdError || error is CancellationError { return error }
    if let e = error as? URLError {
      switch e.code {
      case .cancelled: return CancellationError()
      case .cannotConnectToHost, .networkConnectionLost, .timedOut, .cannotFindHost, .notConnectedToInternet: return AitdError.unreachable
      default: return AitdError.unreachable
      }
    }
    return error
  }

  func check(_ response: URLResponse, _ data: Data) throws {
    guard let http = response as? HTTPURLResponse else { throw AitdError.badResponse }
    if (200..<300).contains(http.statusCode) { return }
    if http.statusCode == 401 { throw AitdError.unauthorized }
    struct Body: Decodable {
      struct Inner: Decodable {
        let code: String
        let message: String
        let line: Int?
      }
      let error: Inner
    }
    if let body = try? JSONDecoder().decode(Body.self, from: data) {
      throw AitdError.server(status: http.statusCode, code: body.error.code, message: body.error.message, line: body.error.line)
    }
    throw AitdError.server(status: http.statusCode, code: "http", message: "aitd 返回 \(http.statusCode)", line: nil)
  }

  func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
    do {
      return try JSONDecoder().decode(type, from: data)
    } catch {
      throw AitdError.badResponse
    }
  }
}
