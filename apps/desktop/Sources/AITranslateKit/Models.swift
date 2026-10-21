// 「模型」页的数据（Goal 8）：Hugging Face 上有哪些量化版本（读文件列表，带大小和 sha256）、
// 本机 aitd 有哪些、用的哪个（aitd 的 /api/models），合起来成每一行的状态。
// 外网请求只有读文件列表和下载模型（见 ModelDownloader），不带任何翻译内容。
import Foundation

/** Hugging Face 上的一个量化版本 */
public struct RemoteModel: Sendable, Equatable {
  public let quant: String
  public let size: Int64
  /** Hugging Face 记录的 sha256（lfs.oid），下载完用来校验 */
  public let sha256: String

  public init(quant: String, size: Int64, sha256: String) {
    self.quant = quant
    self.size = size
    self.sha256 = sha256
  }
}

public enum ModelSource {
  public static let repo = "IndexTeam/Index-Translate-2B-GGUF"
  public static let defaultEndpoint = URL(string: "https://huggingface.co")!

  public static func fileName(_ quant: String) -> String { "Index-Translate-2B.\(quant).gguf" }

  /** 模型文件放在哪：和 aitd、scripts/download-model.sh 同一个目录 */
  public static var modelsDirectory: URL {
    AitHome.directory.appending(path: "models")
  }

  /** 新手引导推荐下的版本（主人 2026-10-21 定）：1.3 GB，盲评和 Q8_0 打平、快约两成 */
  public static let recommendedQuant = "Q4_K_M"

  /** 本机一个模型都没有：要弹新手引导（连不上 aitd 时不知道，不弹） */
  public static func needsModel(_ local: LocalModels?) -> Bool {
    local.map { $0.models.isEmpty } ?? false
  }

  /** 文件列表：GET <地址>/api/models/<仓库>/tree/main */
  public static func treeURL(_ endpoint: URL) -> URL {
    endpoint.appending(path: "api/models/\(repo)/tree/main")
  }

  /** 下载地址：<地址>/<仓库>/resolve/main/<文件名>（会跳转到 CDN） */
  public static func fileURL(_ endpoint: URL, quant: String) -> URL {
    endpoint.appending(path: "\(repo)/resolve/main/\(fileName(quant))")
  }

  /** 设置里填的下载地址：只认 https（下载的是可执行的模型文件，下完还会校验 sha256），去掉末尾的 /；不合法返回 nil */
  public static func endpoint(_ text: String) -> URL? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard let url = URL(string: trimmed), url.scheme?.lowercased() == "https", let host = url.host(), !host.isEmpty,
      url.query() == nil, url.fragment() == nil
    else { return nil }
    return url
  }

  static var quantPattern: Regex<Substring> { /^[A-Za-z0-9_]{1,32}$/ }
  static var filePattern: Regex<(Substring, Substring)> { /^Index-Translate-2B\.([A-Za-z0-9_]{1,32})\.gguf$/ }

  /** 解析文件列表：只要 Index-Translate-2B.<版本>.gguf，跳过看图用的 mmproj、README 等；没有 sha256 的跳过（没法校验） */
  public static func parseTree(_ data: Data) throws -> [RemoteModel] {
    struct Entry: Decodable {
      struct LFS: Decodable {
        let oid: String
        let size: Int64
      }
      let path: String
      let lfs: LFS?
    }
    let entries = try JSONDecoder().decode([Entry].self, from: data)
    return entries.compactMap { entry in
      guard let match = entry.path.wholeMatch(of: filePattern), let lfs = entry.lfs, lfs.oid.wholeMatch(of: /[0-9a-f]{64}/) != nil else { return nil }
      return RemoteModel(quant: String(match.1), size: lfs.size, sha256: lfs.oid)
    }
  }

  /** 读 Hugging Face（或镜像）上的版本列表；走系统网络设置（系统代理自动生效） */
  public static func fetchRemote(endpoint: URL, session: URLSession = .shared) async throws -> [RemoteModel] {
    var request = URLRequest(url: treeURL(endpoint))
    request.timeoutInterval = 15
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
      throw ModelDownloadError.http((response as? HTTPURLResponse)?.statusCode ?? 0)
    }
    return try parseTree(data)
  }
}

/** aitd GET /api/models 的返回：本机已下载的版本、当前用的、是否被 AIT_QUANT 固定 */
public struct LocalModels: Decodable, Sendable, Equatable {
  public struct Entry: Decodable, Sendable, Equatable {
    public let quant: String
    public let size: Int64

    public init(quant: String, size: Int64) {
      self.quant = quant
      self.size = size
    }
  }
  public let current: String
  public let pinned: Bool
  public let models: [Entry]

  public init(current: String, pinned: Bool, models: [Entry]) {
    self.current = current
    self.pinned = pinned
    self.models = models
  }
}

/** 「模型」页对 aitd 的调用；单测里换成假的 */
public protocol ModelsBackend: Sendable {
  func models() async throws -> LocalModels
  func useModel(_ quant: String) async throws -> LocalModels
  func deleteModel(_ quant: String) async throws -> LocalModels
}

extension AitdClient: ModelsBackend {
  /** GET /api/models */
  public func models() async throws -> LocalModels {
    let (data, response) = try await send(request("api/models"))
    try check(response, data)
    return try decode(LocalModels.self, data)
  }

  /** PUT /api/models/current：aitd 等正在翻的段落翻完再换，新模型就绪后才返回，所以超时放长 */
  public func useModel(_ quant: String) async throws -> LocalModels {
    let body = try JSONEncoder().encode(["quant": quant])
    let (data, response) = try await send(request("api/models/current", method: "PUT", body: body, timeout: 180))
    try check(response, data)
    return try decode(LocalModels.self, data)
  }

  /** DELETE /api/models/<版本> */
  public func deleteModel(_ quant: String) async throws -> LocalModels {
    guard quant.wholeMatch(of: ModelSource.quantPattern) != nil else { throw AitdError.badResponse }
    let (data, response) = try await send(request("api/models/\(quant)", method: "DELETE"))
    try check(response, data)
    return try decode(LocalModels.self, data)
  }
}

/** 「模型」页的一行 */
public struct ModelRow: Identifiable, Sendable, Equatable {
  public enum State: Sendable, Equatable {
    /** 正在用 */
    case inUse
    /** 已下载，可以设为当前、删除 */
    case downloaded
    /** 正在下载：已下多少字节 */
    case downloading(Int64)
    /** 下完了，正在校验 sha256 */
    case verifying
    /** 下到一半停了（.part 还在），可以接着下：已下多少字节 */
    case paused(Int64)
    /** 没下载 */
    case available
  }

  public var id: String { quant }
  public let quant: String
  public let size: Int64
  public let state: State
  /** 一句说明（默认、评测过的） */
  public let note: String?

  /** 下载进度 0~1（下载中、暂停时） */
  public var progress: Double? {
    switch state {
    case let .downloading(done), let .paused(done): size > 0 ? min(1, Double(done) / Double(size)) : 0
    default: nil
    }
  }
}

public enum ModelRows {
  /** 评测过的两个版本给一句说明（2026-10-19 量化盲评：两个版本打平，Q4_K_M 快约两成） */
  public static func note(_ quant: String) -> String? {
    switch quant {
    case "Q8_0": "默认；盲评和 Q4_K_M 打平"
    case "Q4_K_M": "盲评和 Q8_0 打平，更小、快约两成"
    default: nil
    }
  }

  /**
   * 合成每一行：Hugging Face 上的版本和本机已有的版本取并集（读不到 Hugging Face 时只有本机的），按大小排。
   * 状态优先级：正在用 > 正在下载 / 校验 > 已下载 > 下到一半 > 没下载
   */
  public static func merge(
    remote: [RemoteModel],
    local: LocalModels?,
    partial: [String: Int64],
    active: [String: ModelRow.State]
  ) -> [ModelRow] {
    var sizes: [String: Int64] = [:]
    for r in remote { sizes[r.quant] = r.size }
    for m in local?.models ?? [] { sizes[m.quant] = m.size }
    let downloaded = Set(local?.models.map(\.quant) ?? [])
    return sizes.map { quant, size in
      let state: ModelRow.State =
        if quant == local?.current && downloaded.contains(quant) { .inUse }
        else if let running = active[quant] { running }
        else if downloaded.contains(quant) { .downloaded }
        else if let done = partial[quant] { .paused(done) }
        else { .available }
      return ModelRow(quant: quant, size: size, state: state, note: note(quant))
    }
    .sorted { $0.size == $1.size ? $0.quant < $1.quant : $0.size < $1.size }
  }

  /** 本机已下载的版本（aitd 连不上时用）：models/ 里的 Index-Translate-2B.<版本>.gguf 和大小 */
  public static func downloadedFiles(in dir: URL) -> [LocalModels.Entry] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
    return names.compactMap { name in
      guard let match = name.wholeMatch(of: ModelSource.filePattern) else { return nil }
      let size = (try? FileManager.default.attributesOfItem(atPath: dir.appending(path: name).path)[.size] as? Int64) ?? 0
      return LocalModels.Entry(quant: String(match.1), size: size)
    }
  }

  /** 本机下到一半的版本：models/ 里的 Index-Translate-2B.<版本>.gguf.part 和已下的字节数 */
  public static func partialDownloads(in dir: URL) -> [String: Int64] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
    var result: [String: Int64] = [:]
    for name in names where name.hasSuffix(".gguf.part") {
      guard let match = String(name.dropLast(".part".count)).wholeMatch(of: ModelSource.filePattern) else { continue }
      let size = (try? FileManager.default.attributesOfItem(atPath: dir.appending(path: name).path)[.size] as? Int64) ?? 0
      result[String(match.1)] = size
    }
    return result
  }
}

/** 文件大小的写法：1.31 GB、361 MB */
public func formatBytes(_ bytes: Int64) -> String {
  let gb = Double(bytes) / 1_000_000_000
  if gb >= 1 { return String(format: "%.2f GB", gb) }
  return String(format: "%.0f MB", Double(bytes) / 1_000_000)
}
