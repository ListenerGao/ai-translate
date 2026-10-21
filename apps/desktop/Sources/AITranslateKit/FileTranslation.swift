// 文件翻译：Markdown、SRT 交给 aitd 的 /api/translate-document（batch 通道，插件优先），拆段和重组都在 aitd 里用 core 的代码，和 ait translate 逐字一致。
// 规则和命令行相同：只认 UTF-8（BOM、换行原样保留），译文写到原文件旁边 文件.<目标语言>.<扩展名>，不经确认不覆盖。
import Foundation
import Observation

public enum DocumentFormat: String, Sendable, Encodable {
  case markdown
  case srt

  /** 按扩展名认格式：.md、.markdown、.srt，其他返回 nil */
  public static func detect(_ url: URL) -> DocumentFormat? {
    switch url.pathExtension.lowercased() {
    case "md", "markdown": .markdown
    case "srt": .srt
    default: nil
    }
  }

  public var label: String { self == .srt ? "SRT 字幕" : "Markdown" }
}

/** 没翻成的段落：第几行、原因 */
public struct FailedLine: Decodable, Sendable, Equatable {
  public let line: Int
  public let error: String

  public init(line: Int, error: String) {
    self.line = line
    self.error = error
  }
}

/** /api/translate-document 返回的一行：进度，或者最后的整份译文 */
public enum DocumentEvent: Sendable, Equatable {
  case progress(done: Int, total: Int)
  case done(text: String, failed: [FailedLine])
}

public protocol DocumentBackend: Sendable {
  func translateDocument(format: DocumentFormat, text: String, source: String, target: String, bilingual: Bool) -> AsyncThrowingStream<DocumentEvent, Error>
}

extension AitdClient: DocumentBackend {
  public func translateDocument(format: DocumentFormat, text: String, source: String, target: String, bilingual: Bool) -> AsyncThrowingStream<DocumentEvent, Error> {
    struct Body: Encodable {
      let format: DocumentFormat
      let text: String
      let source: String
      let target: String
      let model: String
      let bilingual: Bool
      let lane: String
    }
    struct Line: Decodable, Sendable {
      let type: String
      let done: Int?
      let total: Int?
      let text: String?
      let failed: [FailedLine]?
    }
    let lines = ndjson(
      "api/translate-document",
      body: Body(format: format, text: text, source: source, target: target, model: Self.modelID, bilingual: bilingual, lane: "batch"),
      as: Line.self
    )
    return AsyncThrowingStream { continuation in
      let task = Task {
        do {
          for try await line in lines {
            if line.type == "done" {
              continuation.yield(.done(text: line.text ?? "", failed: line.failed ?? []))
            } else {
              continuation.yield(.progress(done: line.done ?? 0, total: line.total ?? 0))
            }
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }
}

public enum FileTranslation {
  /** aitd 的请求体上限是 1MB，文字转成 JSON 还会变长一点：原文件超过 900KB 就不发 */
  public static let maxBytes = 900 * 1024

  /** 原文件旁边的输出位置：guide.md → guide.zh.md，和 ait translate 相同 */
  public static func outputURL(for source: URL, target: String) -> URL {
    let ext = source.pathExtension
    let name = source.deletingPathExtension().lastPathComponent
    return source.deletingLastPathComponent().appending(path: "\(name).\(target).\(ext)")
  }

  /** 读原文件：只认 UTF-8；BOM 留在内容里，写回时原样保留 */
  public static func read(_ url: URL) throws(FileTranslationError) -> String {
    let data: Data
    do {
      data = try Data(contentsOf: url)
    } catch {
      throw .unreadable(url.lastPathComponent)
    }
    if data.count > maxBytes { throw .tooLarge }
    guard String(data: data, encoding: .utf8) != nil else { throw .notUTF8 }
    return String(decoding: data, as: UTF8.self)
  }
}

public enum FileTranslationError: Error, Equatable, Sendable {
  case unsupported(String)
  case unreadable(String)
  case notUTF8
  case tooLarge
  /** SRT 格式不对：第几行、说明 */
  case format(line: Int, message: String)
  case service(ServiceState)
  case writeFailed(String)

  public var message: String {
    switch self {
    case let .unsupported(name): "不支持这个文件：\(name)（只支持 .md、.markdown、.srt）"
    case let .unreadable(name): "读不了 \(name)"
    case .notUTF8: "不是 UTF-8 编码：先转成 UTF-8 再翻（如 iconv -f GBK -t UTF-8 原文件 > 新文件）"
    case .tooLarge: "文件太大：桌面应用一次最多翻 900 KB，更大的文件用命令行 ait translate"
    case let .format(_, message): message
    case let .service(state): [state.title, state.detail].compactMap { $0 }.joined(separator: "：")
    case let .writeFailed(reason): "写不进译文文件：\(reason)"
    }
  }

  init(error: Error) {
    if case let .server(_, code, message, line)? = error as? AitdError {
      if code == "format" {
        self = .format(line: line ?? 0, message: message)
        return
      }
      if code == "too-large" {
        self = .tooLarge
        return
      }
    }
    self = .service(ServiceState(error: error))
  }
}

/** 一个文件的翻译过程：准备（确认输出位置、双语）→ 翻译中（进度，可取消）→ 写好了 / 出错了 */
@MainActor
@Observable
public final class FileJob: Identifiable {
  public enum Phase: Equatable {
    case ready
    case translating(done: Int, total: Int)
    /** 写好了：没翻成的段落；empty 表示文件里没有要翻的文字，原样写出 */
    case finished(failed: [FailedLine], empty: Bool)
    case failed(FileTranslationError)
  }

  public nonisolated let id = UUID()
  public let source: URL
  public let format: DocumentFormat
  public var output: URL
  public var bilingual: Bool
  public private(set) var phase: Phase = .ready

  let backend: any DocumentBackend
  var task: Task<Void, Never>?

  /** 不支持的扩展名直接报错，不建任务 */
  public init(source: URL, target: String, bilingual: Bool, backend: any DocumentBackend) throws(FileTranslationError) {
    guard let format = DocumentFormat.detect(source) else { throw .unsupported(source.lastPathComponent) }
    self.source = source
    self.format = format
    self.output = FileTranslation.outputURL(for: source, target: target)
    self.bilingual = bilingual
    self.backend = backend
  }

  /** 输出文件已经存在：开始前要主人确认覆盖或另存 */
  public var outputExists: Bool { FileManager.default.fileExists(atPath: output.path) }

  public func start(sourceLanguage: String, target: String) {
    task?.cancel()
    let text: String
    do {
      text = try FileTranslation.read(source)
    } catch {
      phase = .failed(error)
      return
    }
    phase = .translating(done: 0, total: 0)
    let stream = backend.translateDocument(format: format, text: text, source: sourceLanguage, target: target, bilingual: bilingual)
    let output = output
    task = Task {
      do {
        var sawProgress = false
        for try await event in stream {
          if Task.isCancelled { return }
          switch event {
          case let .progress(done, total):
            sawProgress = true
            phase = .translating(done: done, total: total)
          case let .done(result, failed):
            do {
              try Data(result.utf8).write(to: output, options: .atomic)
            } catch {
              phase = .failed(.writeFailed(error.localizedDescription))
              return
            }
            phase = .finished(failed: failed, empty: !sawProgress)
            return
          }
        }
        if !Task.isCancelled { phase = .failed(.service(.unavailable)) }
      } catch {
        if Task.isCancelled || error is CancellationError { return }
        phase = .failed(FileTranslationError(error: error))
      }
    }
  }

  /** 取消：断开连接，aitd 撤销还没开始的段落；不写文件 */
  public func cancel() {
    task?.cancel()
    task = nil
    if case .translating = phase { phase = .ready }
  }
}
