// 翻译窗口的状态：左边输入，停止输入 0.5 秒后翻（⌘↩ 立即翻）；按空行分段，所有段落一个请求，哪段先翻好先显示哪段，显示顺序和原文一致。
// 再次输入时取消上一次没完成的请求（断开连接，aitd 撤销还没开始的段落）；翻过的段落记在窗口里，没变的直接显示，不再请求。
import Foundation
import Observation

@MainActor
@Observable
public final class TranslateModel {
  public struct Row: Identifiable, Equatable, Sendable {
    public enum State: Equatable, Sendable {
      case pending
      case done(String)
      /** 没翻成，带原因；复制时这一段用原文 */
      case failed(String)
    }

    public let id: Int
    public let source: String
    public var state: State
  }

  public static let maxCharacters = 20_000
  /** aitd 一个请求最多 1000 段 */
  public static let maxParagraphs = 1000
  public static let tooLongNotice = "一次最多 2 万字、1000 段：长文档请用「翻译文件」"

  public var input = ""
  public var source = "auto"
  public var target: String
  public private(set) var rows: [Row] = []
  /** 超长等提示 */
  public private(set) var notice: String?
  /** 整个请求失败（aitd 没启动、密钥不对等），说法和菜单栏一致 */
  public private(set) var problem: ServiceState?
  public private(set) var isTranslating = false

  let backend: any TranslateBackend
  let debounce: Duration
  /** 翻过的段落：原文语言 + 目标语言 + 原文 → 译文 */
  var memo: [String: String] = [:]
  var debounceTask: Task<Void, Never>?
  var translationTask: Task<Void, Never>?
  /** 上一次翻译时的输入和语言：防抖到点时没变就不重翻（程序填入文字并立即翻译后，输入框的变化还会触发一次防抖） */
  var lastRequest: String?

  public init(backend: any TranslateBackend, target: String = "zh", debounce: Duration = .milliseconds(500)) {
    self.backend = backend
    self.target = target
    self.debounce = debounce
  }

  /** 按空行分段，去掉每段首尾空白和空段；和命令行 ait 的文字翻译一致 */
  public nonisolated static func paragraphs(_ text: String) -> [String] {
    // Swift 把 \r\n 当成一个字符，正则里的 \n 匹配不到它：先统一换行
    text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
      .split(separator: #/\n\s*\n/#)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
  }

  /**
   * 每段在原文里的范围（UTF-16，从这段第一行行首到最后一行行尾，不含换行），和 paragraphs 分出来的段一一对应：
   * 同步滚动定位原文各段、选中时高亮对应段落用。按行看：只有空白的行是段落之间的空行，连续的非空行是同一段
   */
  public nonisolated static func paragraphRanges(_ text: String) -> [NSRange] {
    let ns = text as NSString
    var ranges: [NSRange] = []
    var inParagraph = false
    ns.enumerateSubstrings(in: NSRange(location: 0, length: ns.length), options: .byLines) { line, range, _, _ in
      let blank = line?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true
      if blank {
        inParagraph = false
      } else if inParagraph, let last = ranges.popLast() {
        ranges.append(NSRange(location: last.location, length: NSMaxRange(range) - last.location))
      } else {
        ranges.append(range)
        inParagraph = true
      }
    }
    return ranges
  }

  /** 选中的文字涉及哪几段（选中跨段时是多段）；只是光标、没选中文字时为空 */
  public nonisolated static func paragraphs(touching selection: NSRange, in ranges: [NSRange]) -> Set<Int> {
    guard selection.length > 0 else { return [] }
    return Set(ranges.indices.filter { NSIntersectionRange(ranges[$0], selection).length > 0 })
  }

  /** 输入变了：0.5 秒内没有新的输入才翻；和上一次翻译时一样就不重翻 */
  public func inputChanged() {
    debounceTask?.cancel()
    debounceTask = Task { [debounce] in
      try? await Task.sleep(for: debounce)
      guard !Task.isCancelled, self.lastRequest != Self.key(self.source, self.target, self.input) else { return }
      self.translateNow()
    }
  }

  /** 在窗口里显示一条提示（如剪贴板里没有文字） */
  public func show(notice: String) {
    self.notice = notice
  }

  /** 立即翻：⌘↩、改了语言、划词卡片 */
  public func translateNow() {
    debounceTask?.cancel()
    translationTask?.cancel()
    notice = nil
    problem = nil
    lastRequest = Self.key(source, target, input)
    let paragraphs = Self.paragraphs(input)
    if input.count > Self.maxCharacters || paragraphs.count > Self.maxParagraphs {
      rows = []
      notice = Self.tooLongNotice
      isTranslating = false
      return
    }
    let source = source
    let target = target
    rows = paragraphs.enumerated().map { i, text in
      Row(id: i, source: text, state: memo[Self.key(source, target, text)].map { .done($0) } ?? .pending)
    }
    let segments = rows.filter { $0.state == .pending }.map { TranslateSegment(id: String($0.id), text: $0.source) }
    guard !segments.isEmpty else {
      isTranslating = false
      return
    }
    isTranslating = true
    let stream = backend.translate(segments, source: source, target: target)
    translationTask = Task {
      do {
        for try await result in stream {
          if Task.isCancelled { return }
          guard let i = Int(result.id), rows.indices.contains(i) else { continue }
          if let text = result.text {
            rows[i].state = .done(text)
            remember(Self.key(source, target, rows[i].source), text)
          } else {
            rows[i].state = .failed(result.error ?? "没有返回")
          }
        }
        if Task.isCancelled { return }
        for i in rows.indices where rows[i].state == .pending { rows[i].state = .failed("没有返回") }
      } catch {
        if Task.isCancelled || error is CancellationError { return }
        // 整个请求失败（aitd 没启动等）：清空右边，只显示原因，免得一直显示「翻译中」
        rows = []
        problem = ServiceState(error: error)
      }
      isTranslating = false
    }
  }

  /** 两边都选了具体语言（原文不是「自动检测」）才能互换 */
  public var canSwap: Bool { source != "auto" && source != target }

  /**
   * 互换原文和目标语言（主人 2026-10-20 要求）。译文全部翻好时把译文搬到左边，按新的方向翻回去；
   * 还没翻好或有没翻成的段落时只换语言，左边原文不动，按新方向重翻。
   */
  public func swapLanguages() {
    guard canSwap else { return }
    let allDone = !rows.isEmpty && rows.allSatisfy { if case .done = $0.state { true } else { false } }
    let translated = allDone ? output : nil
    (source, target) = (target, source)
    if let translated { input = translated }
    translateNow()
  }

  /** 关窗口：取消正在翻的请求，清空原文、译文、提示和记住的段落；原文语言、目标语言保留（主人 2026-10-20 定） */
  public func reset() {
    debounceTask?.cancel()
    translationTask?.cancel()
    isTranslating = false
    input = ""
    rows = []
    notice = nil
    problem = nil
    memo.removeAll()
    // 清空输入框也会触发一次防抖：标成已经翻过，不再发请求
    lastRequest = Self.key(source, target, input)
  }

  /** 已翻好的段数 / 总段数 */
  public var progress: (done: Int, total: Int) {
    (rows.filter { if case .done = $0.state { true } else { false } }.count, rows.count)
  }

  /** 复制用的全部译文：段落之间空一行；没翻成、还没翻好的段落用原文 */
  public var output: String {
    rows.map { row in
      if case let .done(text) = row.state { text } else { row.source }
    }.joined(separator: "\n\n")
  }

  static func key(_ source: String, _ target: String, _ text: String) -> String {
    "\(source)\u{1F}\(target)\u{1F}\(text)"
  }

  private func remember(_ key: String, _ text: String) {
    if memo.count > 5000 { memo.removeAll() }
    memo[key] = text
  }
}

extension ServiceState {
  /** 请求失败时，按错误给出和菜单栏一致的说法 */
  public init(error: Error) {
    switch error as? AitdError {
    case .unreachable: self = .notRunning
    case .unauthorized: self = .badKey
    case let .noKey(path): self = .noKey(path: path)
    case .notLocal: self = .badEndpoint
    case let .server(_, _, message, _): self = .modelError(detail: message)
    default: self = .unavailable
    }
  }
}
