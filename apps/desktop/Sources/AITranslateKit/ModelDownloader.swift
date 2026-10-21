// 下载模型文件（Goal 8）：先下到 models/<文件名>.part，中断（取消、断网、退出 App）后再下时用 Range 接着下；
// 下完按 Hugging Face 记录的 sha256 校验，通过才改名成 .gguf，不通过就删掉 .part。
// 走系统网络设置（系统代理自动生效）；只写 models/ 目录，不带任何翻译内容。
import CryptoKit
import Foundation

public enum ModelDownloadError: Error, Equatable, Sendable {
  /** 服务器返回了意外的状态码 */
  case http(Int)
  /** 网络出错：断网、超时、代理不通等 */
  case network(String)
  /** 磁盘空间不够：还要多少字节、剩多少 */
  case noSpace(needed: Int64, available: Int64)
  /** 下完的文件和 Hugging Face 记录的 sha256 对不上（已删掉 .part） */
  case checksumMismatch
  /** 下完的大小不对 */
  case sizeMismatch

  public var message: String {
    switch self {
    case let .http(status): status == 0 ? "下载地址没有响应" : "下载地址返回 \(status)"
    case let .network(text): "网络出错：\(text)"
    case let .noSpace(needed, available): "磁盘空间不够：还要 \(formatBytes(needed))，只剩 \(formatBytes(available))"
    case .checksumMismatch: "下载的文件校验不通过（sha256 对不上），已删掉，请重新下载"
    case .sizeMismatch: "下载的文件大小不对，请重新下载"
    }
  }
}

public struct ModelDownloader: Sendable {
  /** 下载前至少多留的磁盘空间 */
  public static let spaceMargin: Int64 = 500_000_000

  public let directory: URL
  let configuration: @Sendable () -> URLSessionConfiguration
  let freeSpace: @Sendable (URL) -> Int64?

  /** configuration、freeSpace 只在单测里替换（假的下载服务、假的剩余空间） */
  public init(
    directory: URL = ModelSource.modelsDirectory,
    configuration: @escaping @Sendable () -> URLSessionConfiguration = { .default },
    freeSpace: @escaping @Sendable (URL) -> Int64? = ModelDownloader.availableSpace
  ) {
    self.directory = directory
    self.configuration = configuration
    self.freeSpace = freeSpace
  }

  public func partFile(_ quant: String) -> URL { directory.appending(path: ModelSource.fileName(quant) + ".part") }
  public func finalFile(_ quant: String) -> URL { directory.appending(path: ModelSource.fileName(quant)) }

  /** 这个卷还能用多少字节 */
  @Sendable public static func availableSpace(_ url: URL) -> Int64? {
    let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    return values?.volumeAvailableCapacityForImportantUsage
  }

  /** 已经下了多少字节（.part 的大小） */
  public func downloadedBytes(_ quant: String) -> Int64 {
    ((try? FileManager.default.attributesOfItem(atPath: partFile(quant).path)[.size]) as? Int64) ?? 0
  }

  /**
   * 下载一个版本：接着 .part 下，每收到一批数据回调 progress(已下字节)；下完回调 verifying()，校验 sha256，通过后改名成 .gguf。
   * 取消（Task 取消）时抛 CancellationError，.part 留着下次接着下
   */
  public func download(
    _ model: RemoteModel,
    from endpoint: URL,
    progress: @escaping @Sendable (Int64) -> Void,
    verifying: @escaping @Sendable () -> Void = {}
  ) async throws -> URL {
    let fm = FileManager.default
    try fm.createDirectory(at: directory, withIntermediateDirectories: true)
    let final = finalFile(model.quant)
    if fm.fileExists(atPath: final.path) { return final }
    let part = partFile(model.quant)
    var start = downloadedBytes(model.quant)
    if start > model.size {
      try? fm.removeItem(at: part)
      start = 0
    }
    if let free = freeSpace(directory), free - Self.spaceMargin < model.size - start {
      throw ModelDownloadError.noSpace(needed: model.size - start + Self.spaceMargin, available: free)
    }
    if !fm.fileExists(atPath: part.path) { fm.createFile(atPath: part.path, contents: nil) }

    if start < model.size {
      try await fetch(ModelSource.fileURL(endpoint, quant: model.quant), into: part, from: start, progress: progress)
    }
    let size = downloadedBytes(model.quant)
    guard size == model.size else {
      if size > model.size { try? fm.removeItem(at: part) }
      throw ModelDownloadError.sizeMismatch
    }
    verifying()
    try Task.checkCancellation()
    guard try Self.sha256(of: part) == model.sha256 else {
      try? fm.removeItem(at: part)
      throw ModelDownloadError.checksumMismatch
    }
    if fm.fileExists(atPath: final.path) {
      try? fm.removeItem(at: part)
    } else {
      try fm.moveItem(at: part, to: final)
    }
    return final
  }

  /** 从 start 开始下到文件末尾，追加到 file；服务器不认 Range（返回 200）时从头写 */
  func fetch(_ url: URL, into file: URL, from start: Int64, progress: @escaping @Sendable (Int64) -> Void) async throws {
    var request = URLRequest(url: url)
    request.timeoutInterval = 60
    if start > 0 { request.setValue("bytes=\(start)-", forHTTPHeaderField: "Range") }
    let handle = try FileHandle(forWritingTo: file)
    let receiver = Receiver(handle: handle, start: start, progress: progress)
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    let session = URLSession(configuration: configuration(), delegate: receiver, delegateQueue: queue)
    defer { session.finishTasksAndInvalidate() }
    let task = session.dataTask(with: request)
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        receiver.continuation = continuation
        task.resume()
      }
    } onCancel: {
      task.cancel()
    }
  }

  /** 按 4 MB 一块读，算整个文件的 sha256（小写十六进制） */
  public static func sha256(of url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while let chunk = try handle.read(upToCount: 4 << 20), !chunk.isEmpty {
      hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }
}

/** 收下载的数据，写进 .part。所有回调都在一个串行队列上，状态只在那里改 */
private final class Receiver: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  let handle: FileHandle
  let start: Int64
  let progress: @Sendable (Int64) -> Void
  var continuation: CheckedContinuation<Void, Error>?
  var written: Int64 = 0
  var failure: Error?
  var lastReport = Date.distantPast

  init(handle: FileHandle, start: Int64, progress: @escaping @Sendable (Int64) -> Void) {
    self.handle = handle
    self.start = start
    self.progress = progress
  }

  /** 跳转到 CDN 时带上 Range */
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    var next = request
    if let range = task.originalRequest?.value(forHTTPHeaderField: "Range") { next.setValue(range, forHTTPHeaderField: "Range") }
    completionHandler(next)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    let http = response as? HTTPURLResponse
    let status = http?.statusCode ?? 0
    do {
      switch status {
      case 206:
        // 只认从 start 开始的那一段（Content-Range: bytes <start>-…），否则接上去的内容是错的
        let range = http?.value(forHTTPHeaderField: "Content-Range") ?? ""
        guard range.hasPrefix("bytes \(start)-") else {
          failure = ModelDownloadError.http(status)
          return completionHandler(.cancel)
        }
        try handle.seek(toOffset: UInt64(start))
        written = start
      case 200:
        // 服务器不认 Range：整个文件从头写
        try handle.truncate(atOffset: 0)
        written = 0
      default:
        failure = ModelDownloadError.http(status)
        return completionHandler(.cancel)
      }
      completionHandler(.allow)
    } catch {
      failure = error
      completionHandler(.cancel)
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    do {
      try handle.write(contentsOf: data)
      written += Int64(data.count)
      if Date().timeIntervalSince(lastReport) > 0.2 {
        lastReport = Date()
        progress(written)
      }
    } catch {
      failure = error
      dataTask.cancel()
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    try? handle.close()
    progress(written)
    let result: Error? =
      if let failure { failure }
      else if let e = error as? URLError { e.code == .cancelled ? CancellationError() : ModelDownloadError.network(e.localizedDescription) }
      else { error }
    if let result { continuation?.resume(throwing: result) } else { continuation?.resume() }
    continuation = nil
  }
}
