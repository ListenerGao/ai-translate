// 划词翻译卡片放在哪：鼠标下方（放不下就上方），左右、上下都不出屏幕。
// 坐标是 macOS 屏幕坐标：左下角为原点、y 向上；screen 是鼠标所在屏幕去掉菜单栏和 Dock 后的区域（visibleFrame）。
import CoreGraphics

public enum CardPlacement {
  public enum Side: Sendable, Equatable {
    case below, above
  }

  /** 卡片和鼠标之间的空隙、和屏幕边缘至少留的距离 */
  public static let gap: CGFloat = 14
  public static let margin: CGFloat = 8

  /**
   * 打开时定一次放鼠标下方还是上方，之后卡片变高（译文出来）也不换边，免得跳来跳去：
   * 下方放得下 expected 高就放下方，否则放空间大的那边
   */
  public static func side(mouse: CGPoint, screen: CGRect, expected: CGFloat) -> Side {
    let below = mouse.y - gap - (screen.minY + margin)
    let above = screen.maxY - margin - (mouse.y + gap)
    return below >= expected || below >= above ? .below : .above
  }

  /**
   * 卡片的位置：左边比鼠标靠左 20pt；放下方时顶边在鼠标下面、往下长，放上方时底边在鼠标上面、往上长；
   * 最后整个夹在屏幕里（卡片比屏幕还高时贴着顶边）
   */
  public static func frame(size: CGSize, mouse: CGPoint, screen: CGRect, side: Side) -> CGRect {
    let x = clamp(mouse.x - 20, screen.minX + margin, screen.maxX - margin - size.width)
    let y = side == .below ? mouse.y - gap - size.height : mouse.y + gap
    let top = screen.maxY - margin - size.height
    return CGRect(x: x, y: min(max(y, screen.minY + margin), top), width: size.width, height: size.height)
  }

  /** 卡片最高多高：屏幕可用高度的 70%，最多 560 */
  public static func maxHeight(screen: CGRect) -> CGFloat {
    min(560, screen.height * 0.7)
  }

  public static func clamp(_ value: CGFloat, _ low: CGFloat, _ high: CGFloat) -> CGFloat {
    min(max(value, low), max(low, high))
  }
}
