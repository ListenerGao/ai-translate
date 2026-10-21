// Goal 7 CP3：划词卡片的位置。屏幕 1440×900（visibleFrame 从 y=0 到 875），卡片 420×240。
import CoreGraphics
import Testing

@testable import AITranslateKit

@Suite
struct CardPlacementTests {
  let screen = CGRect(x: 0, y: 0, width: 1440, height: 875)
  let size = CGSize(width: 420, height: 240)

  @Test("屏幕中间：放鼠标下方，左边比鼠标靠左 20pt，顶边离鼠标 14pt")
  func middle() {
    let mouse = CGPoint(x: 600, y: 500)
    #expect(CardPlacement.side(mouse: mouse, screen: screen, expected: 240) == .below)
    let f = CardPlacement.frame(size: size, mouse: mouse, screen: screen, side: .below)
    #expect(f == CGRect(x: 580, y: 500 - 14 - 240, width: 420, height: 240))
  }

  @Test("靠近屏幕底边：下方放不下，放上方，底边离鼠标 14pt")
  func nearBottom() {
    let mouse = CGPoint(x: 600, y: 120)
    #expect(CardPlacement.side(mouse: mouse, screen: screen, expected: 240) == .above)
    let f = CardPlacement.frame(size: size, mouse: mouse, screen: screen, side: .above)
    #expect(f.minY == 134)
    #expect(f.maxY <= screen.maxY - 8)
  }

  @Test("靠近左右边缘：左右夹在屏幕里，留 8pt")
  func horizontalEdges() {
    let right = CardPlacement.frame(size: size, mouse: CGPoint(x: 1430, y: 500), screen: screen, side: .below)
    #expect(right.maxX == 1432)
    let left = CardPlacement.frame(size: size, mouse: CGPoint(x: 5, y: 500), screen: screen, side: .below)
    #expect(left.minX == 8)
  }

  @Test("放下方后变高到放不下：往上挪，底边不出屏幕；比屏幕还高时贴着顶边")
  func growing() {
    let mouse = CGPoint(x: 600, y: 300)
    let tall = CardPlacement.frame(size: CGSize(width: 420, height: 400), mouse: mouse, screen: screen, side: .below)
    #expect(tall.minY == 8)
    let huge = CardPlacement.frame(size: CGSize(width: 420, height: 1000), mouse: mouse, screen: screen, side: .below)
    #expect(huge.maxY == screen.maxY - 8)
  }

  @Test("下方空间不够、上方也不够：放空间大的一边；副屏（原点不是 0）照样算")
  func smallScreenAndSecondary() {
    let short = CGRect(x: 0, y: 0, width: 800, height: 400)
    #expect(CardPlacement.side(mouse: CGPoint(x: 100, y: 150), screen: short, expected: 300) == .above)
    #expect(CardPlacement.side(mouse: CGPoint(x: 100, y: 250), screen: short, expected: 300) == .below)
    let secondary = CGRect(x: -1920, y: 200, width: 1920, height: 1050)
    let f = CardPlacement.frame(size: size, mouse: CGPoint(x: -10, y: 230), screen: secondary, side: .below)
    #expect(f.maxX <= -8)
    #expect(f.minY == 208)
  }

  @Test("卡片最高：屏幕可用高度的 70%，最多 560")
  func maxHeight() {
    #expect(CardPlacement.maxHeight(screen: screen) == 560)
    #expect(CardPlacement.maxHeight(screen: CGRect(x: 0, y: 0, width: 800, height: 500)) == 350)
  }
}
