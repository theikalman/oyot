import BackgroundTasks
import Network
import OyotRust
import Tauri
import UIKit
import WebKit

class ScheduleArgs: Decodable {
  let enabled: Bool
  let mobileData: Bool
}

/// Background time asked for on the way out, ended exactly once.
private final class BackgroundTime {
  var task: UIBackgroundTaskIdentifier = .invalid

  func end() {
    DispatchQueue.main.async {
      if self.task != .invalid {
        UIApplication.shared.endBackgroundTask(self.task)
        self.task = .invalid
      }
    }
  }
}

/// Background sync on iOS (ADR 0034, decision 6).
///
/// Two tasks, registered when this plugin is created, before the app
/// finishes launching as iOS requires: an app refresh, about 30 seconds at
/// times iOS picks, and a processing task, minutes long and usually
/// overnight. And the app coming on screen and leaving it, which the Rust
/// engine follows: foreground while on screen, and on the way out, the
/// background time to let a sync in progress finish.
///
/// Every run is the app's Rust library, called directly: a background task
/// can launch the app with no scene, and no page.
class BackgroundSyncPlugin: Plugin {
  static let refreshTask = "com.ajiyakin.oyot.sync.refresh"
  static let catchUpTask = "com.ajiyakin.oyot.sync.catch-up"
  static let enabledKey = "oyot.backgroundSync.enabled"
  static let mobileDataKey = "oyot.backgroundSync.mobileData"

  /// A little under the 30 seconds iOS gives an app refresh, and an app
  /// leaving the screen.
  static let shortBudgetMs: UInt64 = 25_000
  static let processingBudgetMs: UInt64 = 5 * 60_000

  override init() {
    super.init()
    BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshTask, using: nil) { task in
      Self.run(task, trigger: "app-refresh", budgetMs: Self.shortBudgetMs)
    }
    BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.catchUpTask, using: nil) { task in
      Self.run(task, trigger: "processing", budgetMs: Self.processingBudgetMs)
    }
    let center = NotificationCenter.default
    center.addObserver(
      self, selector: #selector(willEnterForeground),
      name: UIApplication.willEnterForegroundNotification, object: nil)
    center.addObserver(
      self, selector: #selector(didEnterBackground),
      name: UIApplication.didEnterBackgroundNotification, object: nil)
  }

  /// A scene is showing the page, so the app is on screen. Not called for a
  /// background launch, which has no scene.
  override func load(webview: WKWebView) {
    DispatchQueue.main.async { oyot_app_foreground() }
  }

  @objc func willEnterForeground() {
    oyot_app_foreground()
  }

  /// Stop being reachable, and let a sync in progress finish inside the
  /// background time iOS gives for it. The next background runs are asked
  /// for now, while the app still can.
  @objc func didEnterBackground() {
    Self.submit()
    oyot_app_leaving()
    let time = BackgroundTime()
    time.task = UIApplication.shared.beginBackgroundTask(withName: "oyot-finish-sync") {
      oyot_background_stop()
      time.end()
    }
    DispatchQueue.global(qos: .utility).async {
      oyot_app_finish_leaving(Self.shortBudgetMs)
      time.end()
    }
  }

  /// Rust says whether background runs are wanted, and on mobile data too.
  @objc public func schedule(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ScheduleArgs.self)
    UserDefaults.standard.set(args.enabled, forKey: Self.enabledKey)
    UserDefaults.standard.set(args.mobileData, forKey: Self.mobileDataKey)
    if args.enabled {
      Self.submit()
    } else {
      BGTaskScheduler.shared.cancelAllTaskRequests()
    }
    invoke.resolve()
  }

  /// Ask for the next runs. A request replaces the one pending for the same
  /// task, so asking again only moves it.
  static func submit() {
    guard UserDefaults.standard.bool(forKey: enabledKey) else { return }
    let refresh = BGAppRefreshTaskRequest(identifier: refreshTask)
    refresh.earliestBeginDate = Date(timeIntervalSinceNow: 30 * 60)
    let catchUp = BGProcessingTaskRequest(identifier: catchUpTask)
    catchUp.requiresNetworkConnectivity = true
    catchUp.earliestBeginDate = Date(timeIntervalSinceNow: 60 * 60)
    do {
      try BGTaskScheduler.shared.submit(refresh)
      try BGTaskScheduler.shared.submit(catchUp)
    } catch {
      Logger.error("[background-sync] could not ask for background runs: \(error)")
    }
  }

  static func run(_ task: BGTask, trigger: String, budgetMs: UInt64) {
    // The next one, whatever this one does.
    submit()
    let (usable, images) = networkAllows()
    guard usable else {
      task.setTaskCompleted(success: true)
      return
    }
    // What the run finished before the time ran out stands.
    task.expirationHandler = { oyot_background_stop() }
    DispatchQueue.global(qos: .utility).async {
      let record = dataDirectory().withCString { dir in
        trigger.withCString { name in
          oyot_background_run(dir, name, budgetMs, images)
        }
      }
      if let record = record {
        Logger.info("[background-sync] \(String(cString: record))")
        oyot_string_free(record)
      }
      task.setTaskCompleted(success: true)
    }
  }

  /// Whether the network allows a run, and images in it: Wi-Fi always,
  /// mobile data only if the user said so, and never for images (ADR 0034,
  /// decision 4).
  static func networkAllows() -> (usable: Bool, images: Bool) {
    let monitor = NWPathMonitor()
    let answered = DispatchSemaphore(value: 0)
    var path: NWPath?
    monitor.pathUpdateHandler = { current in
      path = current
      answered.signal()
    }
    monitor.start(queue: DispatchQueue(label: "oyot.background-sync.path"))
    _ = answered.wait(timeout: .now() + 2)
    monitor.cancel()
    guard let current = path, current.status == .satisfied else { return (false, false) }
    let metered = current.isExpensive || current.isConstrained
    if metered && !UserDefaults.standard.bool(forKey: mobileDataKey) {
      return (false, false)
    }
    return (true, !metered)
  }

  /// Where Tauri keeps the app's data on iOS: Application Support, under the
  /// bundle identifier.
  static func dataDirectory() -> String {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return base.appendingPathComponent(Bundle.main.bundleIdentifier ?? "com.ajiyakin.oyot").path
  }
}

@_cdecl("init_plugin_background_sync")
func initPlugin() -> Plugin {
  return BackgroundSyncPlugin()
}
