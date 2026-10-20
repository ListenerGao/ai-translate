// swift-tools-version:6.0
// AI Translate 桌面应用（第三阶段）。只用系统框架，不用第三方包。
// 构建、组装 .app、签名、安装见 scripts/install-desktop.sh；单测：swift test --package-path apps/desktop
import PackageDescription

let package = Package(
  name: "AITranslate",
  platforms: [.macOS(.v14)],
  targets: [
    // 不依赖界面的逻辑：连 aitd、状态判断、流式读取，单测覆盖
    .target(name: "AITranslateKit", path: "Sources/AITranslateKit"),
    // 菜单栏和窗口
    .executableTarget(name: "AITranslate", dependencies: ["AITranslateKit"], path: "Sources/AITranslate"),
    .testTarget(name: "AITranslateKitTests", dependencies: ["AITranslateKit"], path: "Tests/AITranslateKitTests"),
  ]
)
