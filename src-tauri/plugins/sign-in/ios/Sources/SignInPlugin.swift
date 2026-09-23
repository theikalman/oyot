import AuthenticationServices
import Tauri
import UIKit

class WebAuthArgs: Decodable {
  let url: String
  let callbackScheme: String
}

/// Apple's web authentication session, for signing in to a backup provider.
///
/// The session shows the provider's page in a sheet over the app, and when
/// the page redirects to `callbackScheme`, hands that address to this app
/// alone, even if another app claims the same scheme. It goes back to Rust,
/// never to the webview.
class SignInPlugin: Plugin, ASWebAuthenticationPresentationContextProviding {
  // Held while the sheet is up: nothing else keeps the session alive.
  private var session: ASWebAuthenticationSession?
  // The call waiting on it, answered exactly once however the session ends.
  private var pending: Invoke?

  @objc public func webAuth(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(WebAuthArgs.self)
    guard let url = URL(string: args.url) else {
      invoke.reject("the sign-in address is not valid", code: "failed")
      return
    }
    // Commands arrive on a background queue; a session starts on the main
    // one.
    DispatchQueue.main.async {
      if self.pending != nil {
        invoke.reject("a sign-in is already open", code: "failed")
        return
      }
      self.pending = invoke

      let finished: (URL?, Error?) -> Void = { callbackURL, error in
        DispatchQueue.main.async {
          if let callbackURL = callbackURL {
            self.finish { $0.resolve(["url": callbackURL.absoluteString]) }
          } else if let error = error as? ASWebAuthenticationSessionError,
            error.code == .canceledLogin
          {
            self.finish { $0.reject("the sign-in was cancelled", code: "cancelled") }
          } else {
            let message = error?.localizedDescription ?? "the sign-in failed"
            self.finish { $0.reject(message, code: "failed") }
          }
        }
      }

      let session: ASWebAuthenticationSession
      if #available(iOS 17.4, *) {
        session = ASWebAuthenticationSession(
          url: url, callback: .customScheme(args.callbackScheme), completionHandler: finished)
      } else {
        session = ASWebAuthenticationSession(
          url: url, callbackURLScheme: args.callbackScheme, completionHandler: finished)
      }
      // The provider property is weak, and the plugin lives as long as the
      // app does.
      session.presentationContextProvider = self
      // Reuse the sign-in Safari already has, so the user is not asked for
      // their password again.
      session.prefersEphemeralWebBrowserSession = false
      self.session = session
      if !session.start() {
        self.finish { $0.reject("could not open the sign-in", code: "failed") }
      }
    }
  }

  /// Close the sheet a `webAuth` call is waiting on. That call then ends as
  /// cancelled.
  @objc public func cancelWebAuth(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.session?.cancel()
      self.finish { $0.reject("the sign-in was cancelled", code: "cancelled") }
      invoke.resolve()
    }
  }

  /// Answer the waiting call, once. Only ever on the main queue.
  private func finish(_ answer: (Invoke) -> Void) {
    session = nil
    if let pending = pending {
      self.pending = nil
      answer(pending)
    }
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    return manager.viewController?.view.window ?? ASPresentationAnchor()
  }
}

@_cdecl("init_plugin_sign_in")
func initPlugin() -> Plugin {
  return SignInPlugin()
}
