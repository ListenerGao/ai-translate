// 翻一组段落：POST /api/translate，按完成顺序一段一段返回。翻译窗口走 interactive 通道（和插件一样排在批量任务前面）。
import Foundation

public struct TranslateSegment: Encodable, Sendable, Equatable {
  public let id: String
  public let text: String

  public init(id: String, text: String) {
    self.id = id
    self.text = text
  }
}

/** 一段的结果：翻成了带 text，没翻成带 error（aitd 给的说明） */
public struct SegmentResult: Sendable, Equatable {
  public let id: String
  public let text: String?
  public let error: String?

  public init(id: String, text: String? = nil, error: String? = nil) {
    self.id = id
    self.text = text
    self.error = error
  }
}

/** 翻译后端：正式用 AitdClient，单测换成假的 */
public protocol TranslateBackend: Sendable {
  func translate(_ segments: [TranslateSegment], source: String, target: String) -> AsyncThrowingStream<SegmentResult, Error>
}

extension AitdClient: TranslateBackend {
  /** aitd 当前加载的模型，和 core 的 DEFAULT_MODEL_ID 对应 */
  public static let modelID = "index-translate-2b"

  public func translate(_ segments: [TranslateSegment], source: String, target: String) -> AsyncThrowingStream<SegmentResult, Error> {
    struct Body: Encodable {
      let segments: [TranslateSegment]
      let source: String
      let target: String
      let model: String
      let lane: String
      let priority: Int
    }
    struct Line: Decodable, Sendable {
      struct Failure: Decodable, Sendable {
        let code: String
        let message: String
      }
      let id: String
      let text: String?
      let error: Failure?
    }
    let lines = ndjson(
      "api/translate",
      body: Body(segments: segments, source: source, target: target, model: Self.modelID, lane: "interactive", priority: 0),
      as: Line.self,
    )
    return AsyncThrowingStream { continuation in
      let task = Task {
        do {
          for try await line in lines {
            continuation.yield(SegmentResult(id: line.id, text: line.error == nil ? line.text ?? "" : nil, error: line.error?.message))
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
