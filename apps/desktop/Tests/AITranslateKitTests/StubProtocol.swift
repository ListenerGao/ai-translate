// 测试用的假 aitd：拦下 URLSession 的请求，按 handler 给出状态码和分块的响应体，不开真端口。
import Foundation
import Testing

/** 用到 StubProtocol 的测试组都放在这下面：它的回应是全局的，这些组要一个接一个跑，不能并行 */
@Suite(.serialized) enum StubbedSuites {}

final class StubProtocol: URLProtocol, @unchecked Sendable {
  struct Reply {
    var status = 200
    /** 响应体按块发送，块之间停一下，模拟网络里一行被拆成两半 */
    var chunks: [Data] = []
    var chunkDelay: TimeInterval = 0.02

    static func json(_ text: String, status: Int = 200) -> Reply {
      Reply(status: status, chunks: [Data(text.utf8)])
    }
  }

  nonisolated(unsafe) static var handler: ((URLRequest) -> Reply)?
  nonisolated(unsafe) static var requests: [URLRequest] = []

  static func session(_ handler: @escaping (URLRequest) -> Reply) -> URLSession {
    self.handler = handler
    requests = []
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubProtocol.self]
    return URLSession(configuration: config)
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.requests.append(request)
    let reply = Self.handler?(request) ?? Reply(status: 500)
    let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: [:])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    for (i, chunk) in reply.chunks.enumerated() {
      if i > 0 { Thread.sleep(forTimeInterval: reply.chunkDelay) }
      client?.urlProtocol(self, didLoad: chunk)
    }
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}
