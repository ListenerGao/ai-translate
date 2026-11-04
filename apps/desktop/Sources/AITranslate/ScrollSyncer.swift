// 翻译窗口原文、译文同步滚动（主人 2026-10-21 要求）：滚一边，另一边按段落对齐跟着滚，换算在 AITranslateKit 的 ScrollSync。
// 原文各段的位置从输入框的排版里取；译文各段的位置由 TranslateView 报上来（targetTops），选中高亮时也用它找段落。
import AITranslateKit
import AppKit
import SwiftUI

@MainActor
final class ScrollSyncer {
  private weak var source: NSScrollView?
  private weak var target: NSScrollView?
  private var sourceToken: NSObjectProtocol?
  private var targetToken: NSObjectProtocol?
  /** 译文各段顶部离内容顶部多少点，按段落顺序 */
  var targetTops: [CGFloat] = []
  /** 正在带动另一边：这时另一边发来的滚动通知不再反过来带动 */
  private var driving = false

  func attachSource(_ scroll: NSScrollView) {
    guard source !== scroll else { return }
    source = scroll
    sourceToken = observe(scroll, previous: sourceToken)
  }

  func attachTarget(_ scroll: NSScrollView) {
    guard target !== scroll else { return }
    target = scroll
    targetToken = observe(scroll, previous: targetToken)
  }

  private func observe(_ scroll: NSScrollView, previous: NSObjectProtocol?) -> NSObjectProtocol {
    if let previous { NotificationCenter.default.removeObserver(previous) }
    scroll.contentView.postsBoundsChangedNotifications = true
    // queue 为 nil：在滚动的当下同步执行，driving 标记才拦得住来回带动
    return NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: nil) { [weak self, weak clip = scroll.contentView] _ in
      MainActor.assumeIsolated { if let clip { self?.scrolled(clip) } }
    }
  }

  private func scrolled(_ clip: NSClipView) {
    guard !driving, let source, let target else { return }
    let anchors = ScrollSync.anchors(
      fromTops: sourceTops().map(Double.init),
      toTops: targetTops.map(Double.init),
      fromMax: Self.maxPosition(source),
      toMax: Self.maxPosition(target)
    )
    if clip === source.contentView, let y = ScrollSync.map(Self.position(source), anchors: anchors) {
      move(target, to: y)
    } else if clip === target.contentView, let y = ScrollSync.map(Self.position(target), anchors: ScrollSync.reversed(anchors)) {
      move(source, to: y)
    }
  }

  /** 原文各段顶部：按 paragraphRanges 找到每段第一个字所在的行 */
  private func sourceTops() -> [CGFloat] {
    guard let textView = source?.documentView as? NSTextView, let layout = textView.layoutManager else { return [] }
    let origin = textView.textContainerOrigin.y
    return TranslateModel.paragraphRanges(textView.string).map { range in
      layout.lineFragmentRect(forGlyphAt: layout.glyphIndexForCharacter(at: range.location), effectiveRange: nil).minY + origin
    }
  }

  /** 译文区里的某个视图（每段译文的文字框）属于第几段；不在译文区里时为 nil */
  func targetRow(containing view: NSView) -> Int? {
    guard let document = target?.documentView, view.isDescendant(of: document) else { return nil }
    let rect = view.convert(view.bounds, to: document)
    let y = document.isFlipped ? rect.midY : document.bounds.height - rect.midY
    return ScrollSync.index(at: y, tops: targetTops.map(Double.init))
  }

  private func move(_ scroll: NSScrollView, to y: Double) {
    let clip = scroll.contentView
    driving = true
    clip.scroll(to: NSPoint(x: clip.bounds.minX, y: y - clip.contentInsets.top))
    scroll.reflectScrolledClipView(clip)
    driving = false
  }

  /** 现在滚到了内容顶部往下多少点 */
  static func position(_ scroll: NSScrollView) -> Double {
    scroll.contentView.bounds.minY + scroll.contentView.contentInsets.top
  }

  /** 最多能滚到多少：内容高度减去可见高度 */
  static func maxPosition(_ scroll: NSScrollView) -> Double {
    let clip = scroll.contentView
    let height = scroll.documentView?.frame.height ?? 0
    return height + clip.contentInsets.top + clip.contentInsets.bottom - clip.bounds.height
  }

  /** 调试用：把一边滚到 fraction（0~1）处，另一边应该跟着滚 */
  func debugScroll(source isSource: Bool, fraction: Double) {
    guard let scroll = isSource ? source : target else { return }
    let clip = scroll.contentView
    clip.scroll(to: NSPoint(x: clip.bounds.minX, y: Self.maxPosition(scroll) * fraction - clip.contentInsets.top))
    scroll.reflectScrolledClipView(clip)
  }
}

/** 放进 SwiftUI ScrollView 的内容里，找到它背后的 NSScrollView */
struct ScrollViewFinder: NSViewRepresentable {
  let found: (NSScrollView) -> Void

  func makeNSView(context: Context) -> FinderView {
    let view = FinderView()
    view.found = found
    return view
  }

  func updateNSView(_ view: FinderView, context: Context) {
    view.found = found
    view.report()
  }

  final class FinderView: NSView {
    var found: ((NSScrollView) -> Void)?

    /** 垫在译文下面：在段落之间、文字右边的空白处按下去是要选文字，不是拖动窗口 */
    override var mouseDownCanMoveWindow: Bool { false }

    /** 空白处按下：交给上下离得最近的那段译文，从那里开始拖选（在文字右边按下就从行尾开始选） */
    override func mouseDown(with event: NSEvent) {
      let point = convert(event.locationInWindow, from: nil)
      func distance(_ field: NSTextField) -> CGFloat {
        let rect = field.convert(field.bounds, to: self)
        return point.y < rect.minY ? rect.minY - point.y : point.y > rect.maxY ? point.y - rect.maxY : 0
      }
      guard let document = enclosingScrollView?.documentView, let field = Self.textFields(in: document).min(by: { distance($0) < distance($1) }) else {
        return super.mouseDown(with: event)
      }
      field.mouseDown(with: event)
    }

    private static func textFields(in view: NSView) -> [NSTextField] {
      if let field = view as? NSTextField, field.isSelectable { return [field] }
      return view.subviews.flatMap(textFields)
    }

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      report()
    }

    func report() {
      if let scroll = enclosingScrollView { found?(scroll) }
    }
  }
}

/** 译文各段顶部的位置：段落编号 → 离内容顶部多少点 */
struct RowTopsKey: PreferenceKey {
  static let defaultValue: [Int: CGFloat] = [:]

  static func reduce(value: inout [Int: CGFloat], nextValue: () -> [Int: CGFloat]) {
    value.merge(nextValue()) { $1 }
  }
}
