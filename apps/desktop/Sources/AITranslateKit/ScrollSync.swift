// 翻译窗口原文、译文两边同步滚动（主人 2026-10-21 要求）：按段落对齐，不是简单按整体比例。
// 锚点是「开头」「两边都有的各段顶部」「滚到底」；一边滚到两个锚点之间的某处，另一边按同样的比例停在对应的两个锚点之间。
// 位置都以「内容顶部往下多少点」计，max 是能滚到的最大位置（内容高度减去可见高度）。
import Foundation

public enum ScrollSync {
  public struct Anchor: Equatable, Sendable {
    public let from: Double
    public let to: Double

    public init(_ from: Double, _ to: Double) {
      self.from = from
      self.to = to
    }
  }

  /**
   * fromTops、toTops：两边各段顶部的位置，按段落顺序，段数不同时只用前面都有的段。
   * 顶部已经超出可滚动范围的段（在最后一屏里）不当锚点，免得「滚到底」时另一边到不了底；两边都要递增，乱序的段跳过。
   */
  public static func anchors(fromTops: [Double], toTops: [Double], fromMax: Double, toMax: Double) -> [Anchor] {
    guard fromMax > 0, toMax > 0 else { return [] }
    var result = [Anchor(0, 0)]
    for (a, b) in zip(fromTops, toTops) where a < fromMax && b < toMax {
      guard let last = result.last, a > last.from, b > last.to else { continue }
      result.append(Anchor(a, b))
    }
    result.append(Anchor(fromMax, toMax))
    return result
  }

  /** 一边滚到 y，另一边该滚到哪；锚点为空（有一边不能滚）时返回 nil */
  public static func map(_ y: Double, anchors: [Anchor]) -> Double? {
    guard let first = anchors.first, let last = anchors.last else { return nil }
    let y = min(max(y, first.from), last.from)
    guard let i = anchors.indices.dropLast().last(where: { anchors[$0].from <= y }) else { return first.to }
    let a = anchors[i]
    let b = anchors[i + 1]
    return a.to + (y - a.from) / (b.from - a.from) * (b.to - a.to)
  }

  /** 位置 y 落在第几段：顶部不超过 y 的最后一段；在第一段上方时为 nil */
  public static func index(at y: Double, tops: [Double]) -> Int? {
    tops.indices.last { tops[$0] <= y }
  }

  /** 反过来用：译文滚动时带动原文 */
  public static func reversed(_ anchors: [Anchor]) -> [Anchor] {
    anchors.map { Anchor($0.to, $0.from) }
  }
}
