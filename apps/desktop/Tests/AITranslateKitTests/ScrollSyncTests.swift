// 原文、译文同步滚动：按段落对齐的换算；原文每段从哪个字符开始（和分段结果一一对应）。
import Foundation
import Testing

@testable import AITranslateKit

@Suite
struct ScrollSyncTests {
  @Test("滚到某一段的顶部：另一边停在对应那段的顶部；段内按比例；开头对开头，滚到底对滚到底")
  func paragraphAligned() {
    // 原文三段顶部 0、100、300，能滚到 500；译文三段顶部 0、50、400，能滚到 600
    let anchors = ScrollSync.anchors(fromTops: [0, 100, 300], toTops: [0, 50, 400], fromMax: 500, toMax: 600)
    #expect(ScrollSync.map(0, anchors: anchors) == 0)
    #expect(ScrollSync.map(100, anchors: anchors) == 50)
    #expect(ScrollSync.map(200, anchors: anchors) == 225, "第二段中间对第二段中间")
    #expect(ScrollSync.map(300, anchors: anchors) == 400)
    #expect(ScrollSync.map(500, anchors: anchors) == 600)
    // 反过来：译文带动原文
    let back = ScrollSync.reversed(anchors)
    #expect(ScrollSync.map(50, anchors: back) == 100)
    #expect(ScrollSync.map(600, anchors: back) == 500)
  }

  @Test("最后一屏里的段不当锚点：滚到底时另一边也到底，不会卡在半路")
  func lastScreen() {
    let anchors = ScrollSync.anchors(fromTops: [0, 100, 450], toTops: [0, 80, 200], fromMax: 400, toMax: 300)
    #expect(anchors == [.init(0, 0), .init(100, 80), .init(400, 300)])
    #expect(ScrollSync.map(400, anchors: anchors) == 300)
    #expect(ScrollSync.map(250, anchors: anchors) == 190)
  }

  @Test("段数不同只用前面都有的段；乱序的段跳过；超出范围的位置夹住（回弹时）")
  func edges() {
    let anchors = ScrollSync.anchors(fromTops: [0, 100, 200, 300], toTops: [0, 120, 110], fromMax: 1000, toMax: 1000)
    #expect(anchors == [.init(0, 0), .init(100, 120), .init(1000, 1000)])
    #expect(ScrollSync.map(-30, anchors: anchors) == 0)
    #expect(ScrollSync.map(2000, anchors: anchors) == 1000)
  }

  @Test("有一边内容不够一屏（不能滚）：不同步")
  func notScrollable() {
    let anchors = ScrollSync.anchors(fromTops: [0, 100], toTops: [0, 40], fromMax: 300, toMax: 0)
    #expect(anchors.isEmpty)
    #expect(ScrollSync.map(100, anchors: anchors) == nil)
  }

  @Test("原文每段的范围：和分段结果一一对应（空白行、连续空行、CRLF、开头空行），从段首到段尾、不含换行")
  func paragraphRanges() {
    let text = "\n\nHello\r\nsecond line\r\n\r\n  \r\nWorld\n\n\n\nEnd"
    let ranges = TranslateModel.paragraphRanges(text)
    #expect(ranges.count == TranslateModel.paragraphs(text).count)
    let ns = text as NSString
    #expect(ranges.map { ns.substring(with: $0) } == ["Hello\r\nsecond line", "World", "End"])
    #expect(TranslateModel.paragraphRanges("").isEmpty)
    #expect(TranslateModel.paragraphRanges("单独一段\n第二行") == [NSRange(location: 0, length: 8)])
  }

  @Test("选中涉及哪几段：段内一段、跨段多段、只选了空行或只是光标时为空")
  func touching() {
    let text = "First para.\n\nSecond para.\n\nThird."
    let ranges = TranslateModel.paragraphRanges(text)
    let ns = text as NSString
    #expect(TranslateModel.paragraphs(touching: ns.range(of: "para"), in: ranges) == [0])
    #expect(TranslateModel.paragraphs(touching: NSRange(location: 5, length: 12), in: ranges) == [0, 1])
    #expect(TranslateModel.paragraphs(touching: NSRange(location: 11, length: 2), in: ranges).isEmpty, "只选了段落之间的空行")
    #expect(TranslateModel.paragraphs(touching: NSRange(location: 3, length: 0), in: ranges).isEmpty, "只是光标")
  }

  @Test("位置落在第几段：段顶到下一段顶之间都算这段；在第一段上方为 nil")
  func indexAt() {
    let tops: [Double] = [4, 80, 200]
    #expect(ScrollSync.index(at: 4, tops: tops) == 0)
    #expect(ScrollSync.index(at: 150, tops: tops) == 1)
    #expect(ScrollSync.index(at: 999, tops: tops) == 2)
    #expect(ScrollSync.index(at: 1, tops: tops) == nil)
  }
}
