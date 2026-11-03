// Goal 6 CP3：翻译窗口的状态。用假后端控制返回顺序、延迟和失败，编号对应施工清单 CP3 的预期 1~6。
import Foundation
import Testing

@testable import AITranslateKit

/** 假后端：译文是「【目标语言】原文」；记下每次请求、被取消的次数 */
final class FakeBackend: TranslateBackend, @unchecked Sendable {
  private let lock = NSLock()
  private var _requests: [(segments: [TranslateSegment], target: String)] = []
  private var _cancelled = 0
  var delay: Duration = .milliseconds(5)
  /** 返回顺序：默认倒序，验证显示顺序和原文一致 */
  var reversed = true
  var failing: Set<String> = []
  var streamError: Error?
  /** 最后一段额外等多久再返回，模拟前面命中缓存、最后一段要真翻译 */
  var lastDelay: Duration?

  var requests: [(segments: [TranslateSegment], target: String)] { lock.withLock { _requests } }
  var cancelled: Int { lock.withLock { _cancelled } }

  func translate(_ segments: [TranslateSegment], source: String, target: String) -> AsyncThrowingStream<SegmentResult, Error> {
    lock.withLock { _requests.append((segments, target)) }
    let (delay, order, failing, streamError, lastDelay) = (delay, reversed ? segments.reversed() : segments, failing, streamError, lastDelay)
    return AsyncThrowingStream { continuation in
      let task = Task {
        if let streamError {
          continuation.finish(throwing: streamError)
          return
        }
        for s in order {
          try? await Task.sleep(for: s.id == order.last?.id ? (lastDelay ?? delay) : delay)
          if Task.isCancelled { return }
          continuation.yield(failing.contains(s.text) ? SegmentResult(id: s.id, error: "模型服务出错") : SegmentResult(id: s.id, text: "【\(target)】\(s.text)"))
        }
        continuation.finish()
      }
      continuation.onTermination = { [weak self] reason in
        if case .cancelled = reason { self?.lock.withLock { self?._cancelled += 1 } }
        task.cancel()
      }
    }
  }
}

@MainActor
func settle(_ model: TranslateModel) async {
  await model.debounceTask?.value
  await model.translationTask?.value
}

@MainActor
@Suite
struct TranslateModelTests {
  @Test("分段：空行分段，CRLF、只有空格的空行也算；首尾空白去掉")
  func paragraphs() {
    #expect(TranslateModel.paragraphs("A one.\n\nB two.\n  \n\nC three.") == ["A one.", "B two.", "C three."])
    #expect(TranslateModel.paragraphs("Line one\r\n\r\nLine two\r\n") == ["Line one", "Line two"])
    #expect(TranslateModel.paragraphs("Same paragraph\nsecond line") == ["Same paragraph\nsecond line"])
    #expect(TranslateModel.paragraphs(" \n\n ").isEmpty)
  }

  @Test("1 粘贴三段，停止输入后一次请求翻完；返回顺序乱也按原文顺序显示")
  func threeParagraphs() async {
    let backend = FakeBackend()
    let model = TranslateModel(backend: backend, debounce: .milliseconds(20))
    model.input = "A one.\n\nB two.\n\nC three."
    model.inputChanged()
    #expect(backend.requests.isEmpty, "防抖时间内不发请求")
    await settle(model)
    #expect(backend.requests.count == 1)
    #expect(backend.requests[0].segments.map(\.text) == ["A one.", "B two.", "C three."])
    #expect(model.rows.map(\.state) == [.done("【zh】A one."), .done("【zh】B two."), .done("【zh】C three.")])
    #expect(model.progress == (3, 3))
    #expect(model.isTranslating == false)
  }

  @Test("2 连续输入只翻最后一次；正在翻的上一次被取消")
  func latestOnly() async {
    let backend = FakeBackend()
    backend.delay = .milliseconds(40)
    let model = TranslateModel(backend: backend, debounce: .milliseconds(20))
    for text in ["F", "Fi", "First draft."] {
      model.input = text
      model.inputChanged()
    }
    await model.debounceTask?.value
    #expect(backend.requests.count == 1, "防抖：连续输入只发一次")
    model.input = "Second draft."
    model.translateNow()
    await settle(model)
    #expect(backend.cancelled == 1)
    #expect(model.rows.map(\.state) == [.done("【zh】Second draft.")])
  }

  @Test("3 改目标语言后重翻全部段落")
  func changeTarget() async {
    let backend = FakeBackend()
    let model = TranslateModel(backend: backend, debounce: .milliseconds(1))
    model.input = "Hello.\n\nWorld."
    model.translateNow()
    await settle(model)
    model.target = "ja"
    model.translateNow()
    await settle(model)
    #expect(backend.requests.last?.target == "ja")
    #expect(backend.requests.last?.segments.count == 2)
    #expect(model.output == "【ja】Hello.\n\n【ja】World.")
  }

  @Test("4 复制：段落之间空一行；没翻成的段落用原文并带上原因")
  func outputWithFailure() async {
    let backend = FakeBackend()
    backend.failing = ["Broken one."]
    let model = TranslateModel(backend: backend, debounce: .milliseconds(1))
    model.input = "Fine one.\n\nBroken one."
    model.translateNow()
    await settle(model)
    #expect(model.rows[1].state == .failed("模型服务出错"))
    #expect(model.output == "【zh】Fine one.\n\nBroken one.")
    #expect(model.progress == (1, 2))
  }

  @Test("5 aitd 没启动：给出启动方法，说法和菜单栏一致")
  func notRunning() async {
    let backend = FakeBackend()
    backend.streamError = AitdError.unreachable
    let model = TranslateModel(backend: backend, debounce: .milliseconds(1))
    model.input = "Hello."
    model.translateNow()
    await settle(model)
    #expect(model.problem == .notRunning)
    #expect(model.rows.isEmpty, "不留一排「翻译中」")
    #expect(model.problem?.detail?.contains("scripts/aitd-service.sh install") == true)
    #expect(model.isTranslating == false)
    #expect(ServiceState(error: AitdError.unauthorized) == .badKey)
    #expect(ServiceState(error: AitdError.server(status: 400, code: "bad-request", message: "target 缺失", line: nil)) == .modelError(detail: "target 缺失"))
  }

  @Test("6 没变的段落直接用上次的译文，只请求改过的段落")
  func onlyChanged() async {
    let backend = FakeBackend()
    let model = TranslateModel(backend: backend, debounce: .milliseconds(1))
    model.input = "Keep me.\n\nChange me."
    model.translateNow()
    await settle(model)
    model.input = "Keep me.\n\nChanged now."
    model.translateNow()
    #expect(model.rows[0].state == .done("【zh】Keep me."), "没变的段落立即显示")
    await settle(model)
    #expect(backend.requests.last?.segments.map(\.text) == ["Changed now."])
    #expect(model.output == "【zh】Keep me.\n\n【zh】Changed now.")

    // 全部没变：不发请求
    let count = backend.requests.count
    model.translateNow()
    await settle(model)
    #expect(backend.requests.count == count)
  }

  @Test("程序填入文字并立即翻译后，输入框变化触发的防抖不再重翻、不打断正在翻的请求")
  func noDoubleTranslate() async {
    let backend = FakeBackend()
    backend.delay = .milliseconds(30)
    let model = TranslateModel(backend: backend, debounce: .milliseconds(5))
    model.input = "From the clipboard."
    model.translateNow()
    model.inputChanged()
    await settle(model)
    #expect(backend.requests.count == 1)
    #expect(backend.cancelled == 0)
    #expect(model.rows.map(\.state) == [.done("【zh】From the clipboard.")])
  }

  @Test("关窗口：取消正在翻的请求，清空原文、译文和记住的段落，语言保留")
  func reset() async {
    let backend = FakeBackend()
    backend.delay = .milliseconds(30)
    let model = TranslateModel(backend: backend, debounce: .milliseconds(5))
    model.target = "ja"
    model.input = "Done before."
    model.translateNow()
    await settle(model)
    model.input = "Still translating."
    model.translateNow()
    model.reset()
    model.inputChanged()
    await settle(model)
    #expect(backend.cancelled == 1)
    #expect(model.input.isEmpty && model.rows.isEmpty && model.problem == nil && model.notice == nil)
    #expect(model.isTranslating == false)
    #expect(model.target == "ja")
    #expect(backend.requests.count == 2, "清空输入框触发的防抖不发请求")
    // 记住的段落也清掉了：同样的文字再翻会重新请求（aitd 的缓存会立即返回）
    model.input = "Done before."
    model.translateNow()
    await settle(model)
    #expect(backend.requests.count == 3)
  }

  @Test("互换语言：原文是自动检测或两边相同不能换；译文全部翻好时搬到左边按新方向翻回去")
  func swap() async {
    let backend = FakeBackend()
    let model = TranslateModel(backend: backend, target: "zh", debounce: .milliseconds(1))
    #expect(model.canSwap == false, "原文是自动检测")
    model.swapLanguages()
    #expect(model.source == "auto" && model.target == "zh")

    model.source = "en"
    #expect(model.canSwap)
    model.input = "Hello.\n\nWorld."
    model.translateNow()
    await settle(model)
    model.swapLanguages()
    #expect(model.source == "zh" && model.target == "en")
    #expect(model.input == "【zh】Hello.\n\n【zh】World.")
    await settle(model)
    #expect(backend.requests.last?.target == "en")
    #expect(model.output == "【en】【zh】Hello.\n\n【en】【zh】World.")

    model.target = "zh"
    #expect(model.canSwap == false, "两边相同")
  }

  @Test("互换语言：有没翻成的段落时只换语言，原文不动，按新方向重翻")
  func swapWithFailure() async {
    let backend = FakeBackend()
    backend.failing = ["Broken."]
    let model = TranslateModel(backend: backend, target: "zh", debounce: .milliseconds(1))
    model.source = "en"
    model.input = "Fine.\n\nBroken."
    model.translateNow()
    await settle(model)
    model.swapLanguages()
    #expect(model.source == "zh" && model.target == "en")
    #expect(model.input == "Fine.\n\nBroken.")
    await settle(model)
    #expect(backend.requests.last?.target == "en")
  }

  @Test("超过 2 万字：不翻，提示改用翻译文件")
  func tooLong() async {
    let backend = FakeBackend()
    let model = TranslateModel(backend: backend, debounce: .milliseconds(1))
    model.input = String(repeating: "a", count: TranslateModel.maxCharacters + 1)
    model.translateNow()
    await settle(model)
    #expect(backend.requests.isEmpty)
    #expect(model.notice == TranslateModel.tooLongNotice)
    #expect(model.rows.isEmpty)
  }

  @Test("清空输入：不发请求，右边也清空")
  func empty() async {
    let backend = FakeBackend()
    let model = TranslateModel(backend: backend, debounce: .milliseconds(1))
    model.input = "Something."
    model.translateNow()
    await settle(model)
    model.input = "  \n"
    model.translateNow()
    await settle(model)
    #expect(model.rows.isEmpty)
    #expect(backend.requests.count == 1)
  }

  @Test("几十段几乎同时回来（缓存命中）：结果合并成一批，不漏段、顺序不乱、都标成翻好")
  func manySegmentsAtOnce() async {
    let backend = FakeBackend()
    backend.delay = .zero
    let model = TranslateModel(backend: backend, debounce: .milliseconds(1))
    let paragraphs = (1...120).map { "Paragraph number \($0)." }
    model.input = paragraphs.joined(separator: "\n\n")
    model.translateNow()
    await settle(model)
    #expect(model.rows.count == 120)
    #expect(model.rows.map(\.id) == Array(0..<120))
    #expect(model.rows.allSatisfy { $0.state == .done("【zh】\($0.source)") })
    #expect(model.progress == (120, 120))
    #expect(model.isTranslating == false)
  }

  @Test("一批里混着翻成和翻不成的：两种结果都落到对应的段，不会互相盖掉")
  func mixedBatch() async {
    let backend = FakeBackend()
    backend.delay = .zero
    backend.failing = ["Bad two.", "Bad four."]
    let model = TranslateModel(backend: backend, debounce: .milliseconds(1))
    model.input = "Good one.\n\nBad two.\n\nGood three.\n\nBad four."
    model.translateNow()
    await settle(model)
    #expect(model.rows[0].state == .done("【zh】Good one."))
    #expect(model.rows[1].state == .failed("模型服务出错"))
    #expect(model.rows[2].state == .done("【zh】Good three."))
    #expect(model.rows[3].state == .failed("模型服务出错"))
    #expect(model.progress == (2, 4))
  }

  @Test("前面几段马上回来、最后一段很慢：前面的不能卡在缓冲里，要先显示出来")
  func fastSegmentsShownBeforeSlowOne() async {
    let backend = FakeBackend()
    backend.delay = .zero
    backend.reversed = false
    backend.lastDelay = .seconds(2)
    let model = TranslateModel(backend: backend, debounce: .milliseconds(1))
    model.input = "One.\n\nTwo.\n\nThree.\n\nFour."
    model.translateNow()
    try? await Task.sleep(for: .milliseconds(500))
    #expect(model.rows[0].state == .done("【zh】One."))
    #expect(model.rows[1].state == .done("【zh】Two."))
    #expect(model.rows[2].state == .done("【zh】Three."))
    #expect(model.rows[3].state == .pending)
    #expect(model.isTranslating)
    await settle(model)
    #expect(model.rows[3].state == .done("【zh】Four."))
  }
}
