// 「模型」页的状态（Goal 8）：版本列表（Hugging Face 上的和本机已有的合起来）、下载（一次一个，可以取消，关掉设置窗口也接着下）、
// 设为当前、删除。切换和删除交给 aitd；下载由 App 自己做（aitd 不访问外网）。
import Foundation
import Observation

@MainActor
@Observable
public final class ModelsModel {
  public static let endpointKey = "modelEndpoint"

  public private(set) var rows: [ModelRow] = []
  /** aitd 报的本机版本、当前版本、是否被 AIT_QUANT 固定；连不上时为 nil */
  public private(set) var local: LocalModels?
  /** aitd 连不上、还没有模型接口这类问题：切换、删除用不了，下载照常 */
  public private(set) var serviceProblem: String?
  /** 读不到 Hugging Face（或镜像）上的版本列表 */
  public private(set) var remoteProblem: String?
  /** 每个版本最近一次操作失败的说明 */
  public private(set) var errors: [String: String] = [:]
  /** 正在切换到的版本 */
  public private(set) var switching: String?
  /** 模型目录所在磁盘的剩余空间 */
  public private(set) var freeSpace: Int64?
  public private(set) var refreshing = false
  /** 下载地址（设置里填的镜像），存在 UserDefaults */
  public var endpointText: String {
    didSet { defaults.set(endpointText, forKey: Self.endpointKey) }
  }

  @ObservationIgnored let backend: any ModelsBackend
  @ObservationIgnored public let downloader: ModelDownloader
  @ObservationIgnored let fetchRemote: @Sendable (URL) async throws -> [RemoteModel]
  @ObservationIgnored let defaults: UserDefaults
  @ObservationIgnored var remote: [RemoteModel] = []
  @ObservationIgnored var tasks: [String: Task<Void, Never>] = [:]
  /** 正在下载、校验的版本 */
  var active: [String: ModelRow.State] = [:]

  public init(
    backend: any ModelsBackend,
    downloader: ModelDownloader = ModelDownloader(),
    defaults: UserDefaults = .standard,
    fetchRemote: @escaping @Sendable (URL) async throws -> [RemoteModel] = { try await ModelSource.fetchRemote(endpoint: $0) }
  ) {
    self.backend = backend
    self.downloader = downloader
    self.defaults = defaults
    self.fetchRemote = fetchRemote
    endpointText = defaults.string(forKey: Self.endpointKey) ?? ModelSource.defaultEndpoint.absoluteString
  }

  /** 设置里填的下载地址，不合法（不是 https）时为 nil */
  public var endpoint: URL? { ModelSource.endpoint(endpointText) }
  /** 正在下载的版本（一次只下一个） */
  public var downloading: String? { active.keys.first }

  /** 打开「模型」页、改了下载地址时：同时读 aitd 和 Hugging Face 的列表 */
  public func refresh() async {
    refreshing = true
    defer { refreshing = false }
    // 剩余空间不用等网络，先显示
    freeSpace = Self.space(downloader)
    let (backend, fetchRemote, endpoint) = (backend, fetchRemote, endpoint)
    async let localResult = Self.capture { try await backend.models() }
    async let remoteResult = Self.capture { () async throws -> [RemoteModel]? in
      guard let endpoint else { return nil }
      return try await fetchRemote(endpoint)
    }
    apply(local: await localResult)
    switch await remoteResult {
    case .success(nil):
      remoteProblem = "下载地址不对：要 https 开头，如 https://huggingface.co"
    case let .success(list?):
      remote = list
      remoteProblem = nil
    case .failure(is CancellationError):
      // 读的时候切到了别的设置页（页面的任务被取消）：保留原来的列表
      break
    case let .failure(error):
      remoteProblem = "读不到 \(endpoint?.host() ?? "下载地址") 上的版本列表：\(Self.message(error))。只显示本机已有的版本"
    }
    rebuild()
  }

  /** 下载一个版本（接着上次下到的地方）；下完校验通过后 aitd 就能看到它 */
  public func download(_ quant: String) {
    guard downloading == nil, let model = remote.first(where: { $0.quant == quant }) else { return }
    guard let endpoint else {
      errors[quant] = "下载地址不对：要 https 开头"
      return
    }
    errors[quant] = nil
    active[quant] = .downloading(downloader.downloadedBytes(quant))
    rebuild()
    tasks[quant] = Task { [downloader] in
      do {
        _ = try await downloader.download(
          model, from: endpoint,
          progress: { bytes in Task { @MainActor [weak self] in self?.progressed(quant, bytes) } },
          verifying: { Task { @MainActor [weak self] in self?.verifying(quant) } })
      } catch is CancellationError {
      } catch {
        errors[quant] = Self.message(error)
      }
      active[quant] = nil
      tasks[quant] = nil
      // 取消下载时这个任务已经是取消状态，在里面发的请求会马上被取消：另开一个任务问 aitd（主人 2026-10-21 试用发现）
      apply(local: await Task { [backend] in await Self.capture { try await backend.models() } }.value)
      rebuild()
    }
  }

  /** 取消下载：下到的部分留着，下次接着下 */
  public func cancel(_ quant: String) {
    tasks[quant]?.cancel()
  }

  /** 设为当前：aitd 等正在翻的段落翻完再换，新模型就绪后返回 */
  public func use(_ quant: String) async {
    guard switching == nil else { return }
    switching = quant
    errors[quant] = nil
    do {
      local = try await backend.useModel(quant)
    } catch {
      errors[quant] = Self.message(error)
      apply(local: await Self.capture { [backend] in try await backend.models() })
    }
    switching = nil
    rebuild()
  }

  /** 删除：已下载的交给 aitd 删（正在用的删不了）；下到一半的直接删 .part */
  public func delete(_ quant: String) async {
    errors[quant] = nil
    guard let row = rows.first(where: { $0.quant == quant }) else { return }
    switch row.state {
    case .downloaded:
      do {
        local = try await backend.deleteModel(quant)
      } catch {
        errors[quant] = Self.message(error)
      }
    case .paused:
      do {
        try FileManager.default.removeItem(at: downloader.partFile(quant))
      } catch {
        errors[quant] = "删不掉下到一半的文件：\(error.localizedDescription)"
      }
    default:
      return
    }
    rebuild()
  }

  // MARK: - 内部

  private func progressed(_ quant: String, _ bytes: Int64) {
    guard case .downloading = active[quant] else { return }
    active[quant] = .downloading(bytes)
    rebuild()
  }

  private func verifying(_ quant: String) {
    guard active[quant] != nil else { return }
    active[quant] = .verifying
    rebuild()
  }

  private func apply(local result: Result<LocalModels, Error>) {
    switch result {
    case let .success(list):
      local = list
      serviceProblem = nil
    case .failure(is CancellationError):
      // 请求被取消不是服务出问题：保留原来的状态
      break
    case let .failure(error):
      local = nil
      serviceProblem = Self.message(error)
    }
  }

  private func rebuild() {
    // aitd 连不上时自己看一眼 models/：已有的标成已下载（不知道在用哪个），免得点「下载」又下一遍
    let known = local ?? LocalModels(current: "", pinned: false, models: ModelRows.downloadedFiles(in: downloader.directory))
    rows = ModelRows.merge(remote: remote, local: known, partial: ModelRows.partialDownloads(in: downloader.directory), active: active)
    freeSpace = Self.space(downloader)
  }

  /** 模型目录所在磁盘的剩余空间；目录还没建时看上一级 */
  private static func space(_ downloader: ModelDownloader) -> Int64? {
    downloader.freeSpace(downloader.directory) ?? downloader.freeSpace(downloader.directory.deletingLastPathComponent())
  }

  nonisolated static func capture<T: Sendable>(_ body: @Sendable () async throws -> T) async -> Result<T, Error> {
    do {
      return .success(try await body())
    } catch {
      return .failure(error)
    }
  }

  /** 出错时给主人看的一句话 */
  public static func message(_ error: Error) -> String {
    switch error {
    case let e as ModelDownloadError:
      return e.message
    case AitdError.unreachable:
      return "aitd 没启动：\(ServiceState.startHint)"
    case AitdError.unauthorized:
      return "密钥不对：重启翻译服务后再试"
    case let AitdError.noKey(path):
      return "找不到 \(path)：先启动一次 aitd"
    case let AitdError.server(status, code, message, _):
      // aitd 还是旧版本，没有模型接口
      if status == 404 && code == "not-found" && message == "没有这个接口" { return "aitd 还不支持模型管理：在菜单栏点「重启翻译服务」后再试" }
      return message
    case let e as URLError:
      return e.localizedDescription
    default:
      return error.localizedDescription
    }
  }
}

